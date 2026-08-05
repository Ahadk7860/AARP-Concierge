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

    private func rendered(_ value: RelationshipUnderstanding) -> String {
        [value.contactID, value.register.rawValue, value.relationshipKind.rawValue,
         value.openThread ?? "", value.lastExchangeShape.rawValue,
         value.topics.joined(separator: " "), value.cadenceNorm].joined(separator: "|")
    }
}
