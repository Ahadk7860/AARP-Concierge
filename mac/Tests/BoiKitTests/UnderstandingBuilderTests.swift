import XCTest
@testable import BoiKit

final class UnderstandingBuilderTests: XCTestCase {
    private let canary = "zzq-counterparty-prose-must-never-leave-memory"
    private let handle = "+15550100001"
    private let contactID = "h_00000000"

    private func message(_ guid: String, _ text: String?, fromMe: Bool,
                         tapback: Bool = false, day: Int) -> MirrorDatabase.StoredMessage {
        MirrorDatabase.StoredMessage(
            guid: guid, text: text, handle: handle, service: "iMessage",
            sentAt: Date(timeIntervalSinceReferenceDate: TimeInterval(day * 86_400)),
            isFromMe: fromMe, associatedMessageType: tapback ? 2000 : 0,
            chatIdentifier: handle, chatStyle: 45, wasDeliveredQuietly: false
        )
    }

    private var identity: ContactResolver.Identity {
        ContactResolver.Identity(contact_id: contactID, display: "Person", handles: [handle],
                                 addressBookRecordID: nil)
    }

    func testBuildsBoundedTwoWayDescriptionDeterministically() {
        let messages = [
            message("1", "want to go climbing this weekend?", fromMe: false, day: 1),
            message("2", "yes lets do it", fromMe: true, day: 2),
            message("3", "are you still coming?", fromMe: false, day: 3)
        ]

        let first = UnderstandingBuilder().build(messages: messages, identities: [identity])
        let second = UnderstandingBuilder().build(messages: messages.reversed(), identities: [identity])

        XCTAssertEqual(first, second)
        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(first[0].contactID, contactID)
        XCTAssertEqual(first[0].lastExchangeShape, .questionFromThem)
        XCTAssertEqual(first[0].openThread, "unanswered question from them")
        XCTAssertEqual(first[0].topics, ["climbing", "plans"])
        XCTAssertLessThanOrEqual(first[0].topics.count, UnderstandingBuilder.maximumTopics)
        XCTAssertTrue(first[0].topics.allSatisfy {
            $0.count <= UnderstandingBuilder.maximumTopicCharacters
                && $0.split(separator: " ").count <= UnderstandingBuilder.maximumTopicWords
        })
    }

    /// The core two-way privacy proof: incoming text affects only a closed-vocabulary
    /// shape and token. It cannot appear in any derived string.
    func testInboundCanaryCannotAppearInDerivedOutput() {
        let result = UnderstandingBuilder().build(messages: [
            message("1", canary + " are you coming?", fromMe: false, day: 1),
            message("2", "yes", fromMe: true, day: 2)
        ], identities: [identity])

        XCTAssertEqual(result.count, 1)
        XCTAssertFalse(rendered(result[0]).contains(canary))
    }

    /// A sent tapback is a user-authored row but commonly contains a quoted inbound
    /// body. It is excluded before any two-way interpretation, not merely omitted at
    /// the final output step.
    func testSentTapbackQuotingInboundCanaryCannotAppearInDerivedOutput() {
        let result = UnderstandingBuilder().build(messages: [
            message("1", "normal inbound", fromMe: false, day: 1),
            message("2", "Loved \"" + canary + "\"", fromMe: true, tapback: true, day: 2),
            message("3", "ok", fromMe: true, day: 3)
        ], identities: [identity])

        XCTAssertEqual(result.count, 1)
        XCTAssertFalse(rendered(result[0]).contains(canary))
        XCTAssertEqual(result[0].lastExchangeShape, .statementFromYou)
    }

    func testTrailingQuestionSurvivesLaterInboundChatterUntilAUserTurnClosesIt() {
        let open = UnderstandingBuilder().build(messages: [
            message("1", "are you free?", fromMe: false, day: 1),
            message("2", "hello again", fromMe: false, day: 2)
        ], identities: [identity])
        XCTAssertEqual(open[0].lastExchangeShape, .questionFromThem)
        XCTAssertEqual(open[0].openThread, "unanswered question from them")

        let closed = UnderstandingBuilder().build(messages: [
            message("1", "are you free?", fromMe: false, day: 1),
            message("2", "hello again", fromMe: false, day: 2),
            message("3", "yes", fromMe: true, day: 3)
        ], identities: [identity])
        XCTAssertEqual(closed[0].lastExchangeShape, .statementFromYou)
        XCTAssertNil(closed[0].openThread)
    }

    func testRepeatedQuestionsProduceOnlyABoundedDerivedDescription() {
        let output = UnderstandingBuilder().build(messages: [
            message("1", "first secret question?", fromMe: false, day: 1),
            message("2", "second unrelated secret question?", fromMe: false, day: 2),
            message("3", "checking in", fromMe: false, day: 3)
        ], identities: [identity])

        XCTAssertEqual(output[0].lastExchangeShape, .questionFromThem)
        XCTAssertEqual(output[0].openThread, "asked more than once, unanswered")
        XCTAssertFalse(rendered(output[0]).contains("secret"))
    }

    func testTrailingPlanSurvivesAPlainInboundBubble() {
        let output = UnderstandingBuilder().build(messages: [
            message("1", "plans for tonight", fromMe: false, day: 1),
            message("2", "hello", fromMe: false, day: 2)
        ], identities: [identity])
        XCTAssertEqual(output[0].lastExchangeShape, .planUnresolved)
        XCTAssertEqual(output[0].openThread, "plan appears unresolved")
    }

    func testTopicMatchingUsesWholeNormalisedWordsRatherThanSubstrings() {
        let mutation = UnderstandingBuilder().build(messages: [
            message("1", "current homework moment", fromMe: false, day: 1)
        ], identities: [identity])
        XCTAssertEqual(mutation[0].topics, ["school"])
        XCTAssertFalse(mutation[0].topics.contains("apartment"), "current must not match rent")
        XCTAssertFalse(mutation[0].topics.contains("work"), "homework must not match work")
        XCTAssertFalse(mutation[0].topics.contains("family"), "moment must not match mom")

        let variants = UnderstandingBuilder().build(messages: [
            message("1", "renting bouldering with parents this weekend while working",
                    fromMe: false, day: 1)
        ], identities: [identity])
        XCTAssertEqual(variants[0].topics,
                       ["apartment", "climbing", "family", "plans", "work"])
    }

    func testPunctuationlessModalAssertionsAreNotOutstandingQuestions() {
        for (offset, text) in [
            "Can confirm I’m coming",
            "Will be there at 8",
            "Should be fine",
            "Could work tomorrow"
        ].enumerated() {
            let output = UnderstandingBuilder().build(messages: [
                message("\(offset)", text, fromMe: false, day: offset + 1)
            ], identities: [identity])
            XCTAssertEqual(output[0].lastExchangeShape, .statementFromThem, text)
            XCTAssertNil(output[0].openThread, text)
        }
    }

    func testDefensiblePunctuationlessInterrogativePatternsRemainQuestions() {
        for (offset, text) in [
            "Can you come tonight",
            "Will you be there at 8",
            "When are you coming",
            "What time works",
            "How long will it take"
        ].enumerated() {
            let output = UnderstandingBuilder().build(messages: [
                message("\(offset)", text, fromMe: false, day: offset + 1)
            ], identities: [identity])
            XCTAssertEqual(output[0].lastExchangeShape, .questionFromThem, text)
            XCTAssertEqual(output[0].openThread, "unanswered question from them", text)
        }
    }

    func testBoundedUncertaintyAndPlanPatternsRemainOpen() {
        for (offset, text) in [
            "still coming",
            "tonight still good",
            "weekend maybe",
            "perhaps meet tomorrow",
            "plans for tonight"
        ].enumerated() {
            let output = UnderstandingBuilder().build(messages: [
                message("open-\(offset)", text, fromMe: false, day: offset + 1)
            ], identities: [identity])
            XCTAssertEqual(output[0].lastExchangeShape, .planUnresolved, text)
            XCTAssertEqual(output[0].openThread, "plan appears unresolved", text)
        }
    }

    func testPlanLexemesWithoutUncertaintyAndUncertaintyWithoutPlanRemainStatements() {
        for (offset, text) in [
            "I’m coming tonight",
            "will be there at 8",
            "weekend was great",
            "still working",
            "maybe"
        ].enumerated() {
            let output = UnderstandingBuilder().build(messages: [
                message("closed-\(offset)", text, fromMe: false, day: offset + 1)
            ], identities: [identity])
            XCTAssertEqual(output[0].lastExchangeShape, .statementFromThem, text)
            XCTAssertNil(output[0].openThread, text)
        }
    }

    func testUnresolvedPlanCanaryCannotAppearInDerivedOutput() {
        let output = UnderstandingBuilder().build(messages: [
            message("open-canary", canary + " weekend maybe", fromMe: false, day: 1)
        ], identities: [identity])

        XCTAssertEqual(output[0].lastExchangeShape, .planUnresolved)
        XCTAssertEqual(output[0].openThread, "plan appears unresolved")
        XCTAssertFalse(rendered(output[0]).contains(canary))
    }

    private func rendered(_ value: RelationshipUnderstanding) -> String {
        [value.contactID, value.register.rawValue, value.relationshipKind.rawValue,
         value.openThread ?? "", value.lastExchangeShape.rawValue,
         value.topics.joined(separator: " "), value.cadenceNorm].joined(separator: "|")
    }
}
