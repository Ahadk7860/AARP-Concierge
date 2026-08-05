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

    private func messageAt(_ guid: String, _ text: String?, fromMe: Bool,
                           seconds: Int) -> MirrorDatabase.StoredMessage {
        MirrorDatabase.StoredMessage(
            guid: guid, text: text, handle: handle, service: "iMessage",
            sentAt: Date(timeIntervalSinceReferenceDate: TimeInterval(seconds)),
            isFromMe: fromMe, associatedMessageType: 0,
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

    func testEveryBubbleInAReplyBurstRetainsTheInboundQuestionContext() {
        XCTAssertEqual(ContextualVoiceExemplarBuilder.replyBurstGapSeconds, 300)
        let output = ContextualVoiceExemplarBuilder().build(messages: [
            messageAt("1", "are you coming?", fromMe: false, seconds: 0),
            messageAt("2", "yes", fromMe: true, seconds: 60),
            messageAt("3", "leaving now", fromMe: true, seconds: 360),
            messageAt("4", "separate thought", fromMe: true, seconds: 661),
            messageAt("5", "plain inbound update", fromMe: false, seconds: 700),
            messageAt("6", "got it", fromMe: true, seconds: 701)
        ])
        let byText = Dictionary(uniqueKeysWithValues: output.exemplars.map { ($0.text, $0.answered) })

        XCTAssertEqual(byText["yes"], .questionFromThem)
        XCTAssertEqual(byText["leaving now"], .questionFromThem,
                       "the second bubble is inside the same five-minute user turn")
        XCTAssertEqual(byText["separate thought"], UnderstandingLastExchangeShape.none,
                       "a gap beyond the bound starts a new user turn")
        XCTAssertEqual(byText["got it"], .statementFromThem,
                       "an inbound→user direction transition starts fresh context")
    }

    func testInboundBurstAggregatesQuestionBeforePlainChatter() {
        let output = ContextualVoiceExemplarBuilder().build(messages: [
            messageAt("1", "are you free?", fromMe: false, seconds: 0),
            messageAt("2", "hello", fromMe: false, seconds: 10),
            messageAt("3", "yes", fromMe: true, seconds: 20)
        ])
        XCTAssertEqual(output.exemplars[0].answered, .questionFromThem)
    }

    func testSelectionSpansTimeAndDeduplicatesFinalText() throws {
        var messages: [MirrorDatabase.StoredMessage] = []
        for index in 1...100 {
            let text = index.isMultiple(of: 9) ? "repeated safe line" : "unique line \(index)"
            messages.append(message("\(index)", text, fromMe: true, day: index))
        }
        let output = ContextualVoiceExemplarBuilder().build(messages: messages)
        let uniqueNumbers = output.exemplars.compactMap { exemplar -> Int? in
            Int(exemplar.text.split(separator: " ").last ?? "")
        }

        XCTAssertEqual(output.exemplars.count, ContextualVoiceExemplarBuilder.maximumExemplars)
        XCTAssertEqual(Set(output.exemplars.map(\.text)).count, output.exemplars.count)
        XCTAssertLessThanOrEqual(try XCTUnwrap(uniqueNumbers.min()), 10)
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(uniqueNumbers.max()), 90)
    }

    private func rendered(_ output: ContextualVoiceExemplarSet) -> String {
        output.exemplars.map { "\($0.text)|\($0.answered.rawValue)|\($0.register.rawValue)" }
            .joined(separator: "\n") + "|\(output.contentHash)"
    }
}
