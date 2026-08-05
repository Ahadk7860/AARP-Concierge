import XCTest
@testable import BoiKit

final class UnderstandingVoiceExemplarsTests: XCTestCase {
    private let canary = "zzq-counterparty-prose-must-not-enter-contextual-exemplars"
    private let handle = "+15550100001"

    private func message(_ guid: String, _ text: String?, fromMe: Bool,
                         tapback: Bool = false, day: Int) -> MirrorDatabase.StoredMessage {
        MirrorDatabase.StoredMessage(
            guid: guid, text: text, handle: handle, service: "iMessage",
            sentAt: Date(timeIntervalSinceReferenceDate: TimeInterval(day * 86_400)),
            isFromMe: fromMe, associatedMessageType: tapback ? 2000 : 0,
            chatIdentifier: handle, chatStyle: 45, wasDeliveredQuietly: false
        )
    }

    func testPairsSentTextWithImmediatelyPrecedingAnswerShape() {
        let output = ContextualVoiceExemplarBuilder().build(messages: [
            message("1", "are you coming climbing tonight?", fromMe: false, day: 1),
            message("2", "yeah ill be there", fromMe: true, day: 2)
        ])

        XCTAssertEqual(output.exemplars.count, 1)
        XCTAssertEqual(output.exemplars[0].text, "yeah ill be there")
        XCTAssertEqual(output.exemplars[0].answered, .questionFromThem)
        XCTAssertEqual(output.exemplars[0].register, .terse)
        XCTAssertTrue(output.contentHash.hasPrefix("cve_"))
    }

    func testDirectInboundCanaryCannotAppearInOutput() {
        let output = ContextualVoiceExemplarBuilder().build(messages: [
            message("1", canary + " are you free?", fromMe: false, day: 1),
            message("2", "yes im free", fromMe: true, day: 2)
        ])

        XCTAssertFalse(rendered(output).contains(canary))
        XCTAssertEqual(output.exemplars[0].answered, .questionFromThem)
    }

    func testSentTapbackQuotingInboundCanaryCannotAppearInOutput() {
        let output = ContextualVoiceExemplarBuilder().build(messages: [
            message("1", "normal inbound", fromMe: false, day: 1),
            message("2", "Loved \"" + canary + "\"", fromMe: true, tapback: true, day: 2),
            message("3", "ok", fromMe: true, day: 3)
        ])

        XCTAssertEqual(output.exemplars.map(\.text), ["ok"])
        XCTAssertFalse(rendered(output).contains(canary))
    }

    func testSentMessageWithoutPriorTurnGetsNoneContext() {
        let output = ContextualVoiceExemplarBuilder().build(messages: [
            message("1", "starting a new thread", fromMe: true, day: 1)
        ])

        XCTAssertEqual(output.exemplars.count, 1)
        XCTAssertEqual(output.exemplars[0].answered, .none)
    }

    func testContentHashChangesWhenOnlyAnswerContextChanges() {
        let questionContext = ContextualVoiceExemplarBuilder().build(messages: [
            message("1", "are you free?", fromMe: false, day: 1),
            message("2", "yeah", fromMe: true, day: 2)
        ])
        let neutralContext = ContextualVoiceExemplarBuilder().build(messages: [
            message("1", "see you later", fromMe: false, day: 1),
            message("2", "yeah", fromMe: true, day: 2)
        ])

        XCTAssertEqual(questionContext.exemplars.map(\.text), neutralContext.exemplars.map(\.text))
        XCTAssertNotEqual(questionContext.exemplars.map(\.answered), neutralContext.exemplars.map(\.answered))
        XCTAssertNotEqual(questionContext.contentHash, neutralContext.contentHash)
    }

    func testBoundsAndRedactsUserAuthoredText() {
        let long = String(repeating: "x", count: 201)
        let output = ContextualVoiceExemplarBuilder().build(messages: [
            message("1", "call 555-010-0001", fromMe: true, day: 1),
            message("2", long, fromMe: true, day: 2)
        ])

        XCTAssertEqual(output.exemplars.map(\.text), ["call [redacted]"])
        XCTAssertLessThanOrEqual(output.exemplars.count, ContextualVoiceExemplarBuilder.maximumExemplars)
        XCTAssertTrue(output.exemplars.allSatisfy { $0.text.count <= ContextualVoiceExemplarBuilder.maximumExemplarLength })
    }

    private func rendered(_ output: ContextualVoiceExemplarSet) -> String {
        output.exemplars.map { "\($0.text)|\($0.answered.rawValue)|\($0.register.rawValue)" }
            .joined(separator: "\n") + "|\(output.contentHash)"
    }
}
