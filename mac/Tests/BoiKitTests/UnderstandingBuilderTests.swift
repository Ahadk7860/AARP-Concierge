import XCTest
@testable import BoiKit

final class UnderstandingBuilderTests: XCTestCase {
    private let canary = "zzq-counterparty-prose-must-never-leave-memory"
    private let handle = "+15550100001"
    private let contactID = "h_00000000"

    /// The time-of-day signals read a calendar, so the suite pins one. Without this a
    /// machine in Auckland and a machine in Los Angeles disagree about which fixtures
    /// are "night", and the failure looks like a classifier bug rather than a clock.
    override func setUp() {
        super.setUp()
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        UnderstandingBuilder.calendar = utc
    }

    override func tearDown() {
        var local = Calendar(identifier: .gregorian)
        local.timeZone = .current
        UnderstandingBuilder.calendar = local
        super.tearDown()
    }

    private func message(_ guid: String, _ text: String?, fromMe: Bool,
                         tapback: Bool = false, day: Int,
                         hour: Int = 0) -> MirrorDatabase.StoredMessage {
        MirrorDatabase.StoredMessage(
            guid: guid, text: text, handle: handle, service: "iMessage",
            sentAt: Date(timeIntervalSinceReferenceDate:
                            TimeInterval(day * 86_400 + hour * 3_600)),
            isFromMe: fromMe, associatedMessageType: tapback ? 2000 : 0,
            chatIdentifier: handle, chatStyle: 45, wasDeliveredQuietly: false
        )
    }

    private var identity: ContactResolver.Identity {
        ContactResolver.Identity(contact_id: contactID, display: "Person", handles: [handle],
                                 addressBookRecordID: nil)
    }

    /// 2001-01-01, the reference date, is a Monday. Keeps generated fixtures off
    /// weekends so `weekendShare` stays a deliberate choice rather than an accident.
    private func weekday(_ index: Int) -> Int { (index / 5) * 7 + (index % 5) }

    // MARK: - Existing bounded-output and privacy proofs

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
        // ROOT 4. "are you still coming?" is a question AND an unresolved plan, and the
        // plan is the more specific reading. Under the old ordering this returned
        // `question_from_them` purely because `looksLikeQuestion` was tested first.
        XCTAssertEqual(first[0].lastExchangeShape, .planUnresolved)
        XCTAssertEqual(first[0].openThread, "plan appears unresolved")
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

    /// Still questions, and still NOT plans: none of these names a concrete arrangement,
    /// and none carries invitation framing. This is the boundary Root 4 had to widen
    /// without swallowing — "can you come tonight" asks about a plan somebody else
    /// already made, which is a different act from proposing one.
    func testDefensiblePunctuationlessInterrogativePatternsRemainQuestions() {
        for (offset, text, expected) in [
            ("Can you come tonight", "unanswered question from them about the plans"),
            ("Will you be there at 8", "unanswered question from them"),
            ("When are you coming", "unanswered question from them about the plans"),
            ("What time works", "unanswered question from them about the work"),
            ("How long will it take", "unanswered question from them")
        ].enumerated().map({ ($0.offset, $0.element.0, $0.element.1) }) {
            let output = UnderstandingBuilder().build(messages: [
                message("\(offset)", text, fromMe: false, day: offset + 1)
            ], identities: [identity])
            XCTAssertEqual(output[0].lastExchangeShape, .questionFromThem, text)
            XCTAssertEqual(output[0].openThread, expected, text)
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

    // MARK: - Root 4: a plan phrased as a question is a plan

    /// The fixture named in the fix prompt. Under the old ordering `looksLikeQuestion`
    /// ran first and consumed every plan that carried a `?`, which is nearly all of
    /// them — `plan_unresolved` fired on 2 of 417 real relationships.
    func testAPlanPhrasedAsAQuestionIsAnUnresolvedPlan() {
        let output = UnderstandingBuilder().build(messages: [
            message("1", "want to grab dinner saturday?", fromMe: false, day: 1)
        ], identities: [identity])

        XCTAssertEqual(output[0].lastExchangeShape, .planUnresolved,
                       "a plan phrased as a question is still a plan")
        XCTAssertNotEqual(output[0].lastExchangeShape, .questionFromThem)
    }

    func testAggregateInboundShapePrefersThePlanOverTheQuestion() {
        XCTAssertEqual(
            UnderstandingBuilder.aggregateInboundShape([.questionFromThem, .planUnresolved]),
            .planUnresolved,
            "the same ordering must hold in both places, or the two disagree")
        XCTAssertEqual(UnderstandingBuilder.aggregateInboundShape([.questionFromThem]),
                       .questionFromThem)
        XCTAssertEqual(UnderstandingBuilder.aggregateInboundShape([]), .none)
    }

    // MARK: - Root 3: the outstanding turn carries its subject

    func testOpenThreadCarriesTheSubjectOfTheOutstandingTurn() {
        let output = UnderstandingBuilder().build(messages: [
            message("1", "did you hear back about the apartment?", fromMe: false, day: 1),
            message("2", "any news on the lease?", fromMe: false, day: 2)
        ], identities: [identity])

        XCTAssertEqual(output[0].lastExchangeShape, .questionFromThem)
        XCTAssertEqual(output[0].openThread,
                       "asked more than once about the apartment, unanswered",
                       "the subject is what the old four-entry lookup table could not say")
    }

    /// The privacy proof for the widened field, stated as the guard states it: the only
    /// strings this field can hold are the four templates, optionally carrying ONE token
    /// from the closed vocabulary at the documented slot.
    func testEveryOpenThreadStringStaysInsideTheClosedGrammar() {
        let corpus: [String] = [
            "did you hear back about the apartment?",
            canary + " are we still on for saturday?",
            "how did the exam go?",
            "did you talk to your mom about it?",
            "want to grab dinner saturday?",
            "still coming tonight?",
            "any word from the office?",
            "are you climbing this weekend?"
        ]

        for (offset, text) in corpus.enumerated() {
            let output = UnderstandingBuilder().build(messages: [
                message("g-\(offset)", text, fromMe: false, day: offset + 1)
            ], identities: [identity])
            guard let openThread = output[0].openThread else { continue }

            XCTAssertFalse(openThread.contains(canary))
            XCTAssertTrue(Self.matchesClosedGrammar(openThread),
                          "open_thread escaped the closed grammar: \(openThread)")
            XCTAssertLessThanOrEqual(openThread.count, 140,
                                     "the schema caps open_thread at 140 characters")
        }
    }

    /// Mirrors `OPEN_THREAD_TEMPLATES` in `scripts/check_voice_pack_leak.py`. Two
    /// implementations of one grammar is the deliberate design: the Python guard exists
    /// to fail when the Swift drifts, so the Swift asserting its own shape here is the
    /// cheap half of the same check.
    private static func matchesClosedGrammar(_ value: String) -> Bool {
        let templates = [
            ("asked more than once", ", unanswered"),
            ("unanswered question from them", ""),
            ("raised the plan more than once", ", unresolved"),
            ("plan", " appears unresolved")
        ]
        let vocabulary = Set(UnderstandingBuilder.openThreadTopicVocabulary)

        for (head, tail) in templates {
            if value == head + tail { return true }
            let prefix = head + " about the "
            guard value.hasPrefix(prefix), value.hasSuffix(tail) else { continue }
            let start = value.index(value.startIndex, offsetBy: prefix.count)
            let end = value.index(value.endIndex, offsetBy: -tail.count)
            guard start <= end else { continue }
            let token = String(value[start..<end])
            if vocabulary.contains(token), token.count <= 40,
               token.split(separator: " ").count <= 3 {
                return true
            }
        }
        return false
    }

    // MARK: - Root 1: structure, not vocabulary

    func testRelationshipKindIsUnknownBelowTheEvidenceFloor() {
        let thin = balancedThread(messages: UnderstandingBuilder.relationshipEvidenceFloor - 1,
                                  hour: 23, body: "hey")
        XCTAssertEqual(UnderstandingBuilder().build(messages: thin,
                                                    identities: [identity])[0].relationshipKind,
                       .unknown,
                       "absence of evidence must not be reported as a relationship")

        let enough = balancedThread(messages: UnderstandingBuilder.relationshipEvidenceFloor,
                                    hour: 23, body: "hey")
        XCTAssertNotEqual(UnderstandingBuilder().build(messages: enough,
                                                       identities: [identity])[0].relationshipKind,
                          .unknown)
    }

    /// THE property Root 1 exists to restore. The old classifier's output inverted under
    /// a volume filter because `topics.contains("work")` grows more likely the longer a
    /// thread is. Lengthening a thread WITHOUT changing any of its proportions must not
    /// change what it is. A mutation that reintroduces a count-based signal — active
    /// days, burstiness, messages per day, lifespan — fails here.
    func testLengtheningAThreadDoesNotChangeWhatItIs() {
        for hour in [10, 23] {
            let short = UnderstandingBuilder().build(
                messages: balancedThread(messages: 20, hour: hour, body: "sounds good"),
                identities: [identity])[0].relationshipKind
            let long = UnderstandingBuilder().build(
                messages: balancedThread(messages: 400, hour: hour, body: "sounds good"),
                identities: [identity])[0].relationshipKind

            XCTAssertEqual(short, long,
                           "a 20x longer thread with identical proportions is the same "
                           + "relationship; if it is not, some signal is counting")
            XCTAssertNotEqual(short, .unknown)
        }
    }

    /// A topic token may contribute to a score. It may not conjure a category out of a
    /// structure that contradicts it.
    func testAFamilyTokenCannotMakeAWorkShapedThreadFamily() {
        let businessHours = balancedThread(messages: 40, hour: 10,
                                           body: "my mom said the same about family")
        let kind = UnderstandingBuilder().build(messages: businessHours,
                                                identities: [identity])[0].relationshipKind
        XCTAssertNotEqual(kind, .family,
                          "saturating a 9-to-5 weekday thread with family vocabulary must "
                          + "not make it family — that is the token deciding on its own")
    }

    /// The other half of the same rule: where the structure already fits, the token is
    /// allowed to be the thing that separates two readings.
    func testAFamilyTokenSeparatesTwoReadingsTheStructureAlreadyFits() {
        let withFamily = UnderstandingBuilder().build(
            messages: balancedThread(messages: 40, hour: 23, body: "mom said hi"),
            identities: [identity])[0].relationshipKind
        let without = UnderstandingBuilder().build(
            messages: balancedThread(messages: 40, hour: 23, body: "sounds good"),
            identities: [identity])[0].relationshipKind

        XCTAssertEqual(withFamily, .family)
        XCTAssertEqual(without, .closeFriend)
    }

    /// The fix prompt asks outright whether `dormant_close` can fire. The old gate was
    /// `typicalGapDays >= 30 && total >= 20`, which fired 0 times in 417 relationships
    /// and cannot fire at all: across all 140 threads with 20+ messages the largest
    /// median gap is 0.13 days, because a thread long enough to clear the volume half is
    /// by construction burst-textual.
    func testDormantCloseCanFire() {
        var messages = balancedThread(messages: 40, hour: 23, body: "sounds good")
        // A second, still-active thread makes the corpus clock later than this thread's
        // last message, which is what "dormant" has to mean.
        let otherHandle = "+15550100002"
        let other = ContactResolver.Identity(contact_id: "h_00000001", display: "Other",
                                             handles: [otherHandle], addressBookRecordID: nil)
        messages.append(MirrorDatabase.StoredMessage(
            guid: "recent", text: "hi", handle: otherHandle, service: "iMessage",
            sentAt: Date(timeIntervalSinceReferenceDate: TimeInterval(900 * 86_400)),
            isFromMe: false, associatedMessageType: 0,
            chatIdentifier: otherHandle, chatStyle: 45, wasDeliveredQuietly: false))

        let output = UnderstandingBuilder().build(messages: messages,
                                                  identities: [identity, other])
        let mine = output.first { $0.contactID == contactID }
        XCTAssertEqual(mine?.relationshipKind, .dormantClose)
    }

    // MARK: - Root 2: register against the user's own baseline

    func testRegisterIsUnknownUntilTheUserHasWrittenEnough() {
        let baseline = StyleProfile(userBodies: Array(repeating: "ok", count: 200))
        let justUnder = Array(repeating: "sure thing",
                              count: UnderstandingBuilder.registerEvidenceFloor - 1)
        let justOver = Array(repeating: "sure thing",
                             count: UnderstandingBuilder.registerEvidenceFloor)

        XCTAssertEqual(UnderstandingBuilder.threadRegister(userBodies: justUnder,
                                                           baseline: baseline),
                       .unknown)
        XCTAssertNotEqual(UnderstandingBuilder.threadRegister(userBodies: justOver,
                                                              baseline: baseline),
                          .unknown)
    }

    /// The old code returned `.terse` for an EMPTY set of user messages, which is why
    /// `terse` covered 205 of 417 relationships with a median of one message.
    func testNoUserMessagesIsUnknownRatherThanTerse() {
        let baseline = StyleProfile(userBodies: Array(repeating: "ok", count: 200))
        XCTAssertEqual(UnderstandingBuilder.threadRegister(userBodies: [], baseline: baseline),
                       .unknown,
                       "silence is not a register")
    }

    /// The heart of Root 2. The SAME thread reads differently against different users,
    /// because register is a comparison and not a character count. A mutation that
    /// restores absolute thresholds returns the same answer for both and fails here.
    func testRegisterIsRelativeToTheUsersOwnBaseline() {
        let thread = Array(repeating: "Thanks for the update. I will follow up shortly.",
                           count: 12)

        let terseWriter = StyleProfile(userBodies: Array(repeating: "ok", count: 200))
        let formalWriter = StyleProfile(
            userBodies: Array(repeating: "Thanks for the update. I will follow up shortly.",
                              count: 200))

        XCTAssertEqual(
            UnderstandingBuilder.threadRegister(userBodies: thread, baseline: terseWriter),
            .formal,
            "against somebody who writes 'ok', this thread is formal")
        XCTAssertEqual(
            UnderstandingBuilder.threadRegister(userBodies: thread, baseline: formalWriter),
            .casual,
            "against somebody who always writes this way, it is just how they write")
    }

    /// The old bar was 25% of the user's messages in a thread carrying one of ❤️, "love"
    /// or "miss". The real 99th percentile is 8.5%, so it fired on 1 relationship in 140.
    func testWarmDoesNotRequireAQuarterOfMessagesToCarryAffection() {
        var thread = Array(repeating: "sounds good", count: 11)
        thread.append("love you, see you soon")
        let baseline = StyleProfile(userBodies: Array(repeating: "sounds good", count: 200))

        XCTAssertEqual(UnderstandingBuilder.threadRegister(userBodies: thread,
                                                           baseline: baseline),
                       .warm,
                       "1 affectionate message in 12 is 8%, which the old 25% bar missed")
    }

    /// Warmth is a lift over the user's OWN rate, so a uniformly affectionate writer does
    /// not have every thread promoted.
    func testWarmthIsALiftOverTheUsersOwnRateNotAnAbsolute() {
        let thread = ["love you", "sounds good", "ok", "sure", "yep", "nice",
                      "great", "cool", "fine", "yes", "sure thing", "alright"]
        let affectionateWriter = StyleProfile(
            userBodies: Array(repeating: "love you", count: 200))

        XCTAssertNotEqual(UnderstandingBuilder.threadRegister(userBodies: thread,
                                                              baseline: affectionateWriter),
                          .warm)
    }

    // MARK: - Root 5: one pass, both readings

    func testTopicReadingReturnsTokensAndDensityFromASinglePass() {
        let reading = UnderstandingBuilder.topicReading(in: [
            message("1", "mom called", fromMe: false, day: 1),
            message("2", "ok", fromMe: true, day: 2),
            message("3", "dad too", fromMe: false, day: 3),
            message("4", "work thing", fromMe: false, day: 4)
        ])

        XCTAssertEqual(reading.tokens, ["family", "work"])
        // Density is a SHARE of the messages, which is what makes it usable as a
        // classification signal: unlike presence it does not climb with thread length.
        XCTAssertEqual(reading.density["family"] ?? 0, 0.5, accuracy: 0.0001)
        XCTAssertEqual(reading.density["work"] ?? 0, 0.25, accuracy: 0.0001)
        XCTAssertNil(reading.density["climbing"])
    }

    func testTopicDensityDoesNotClimbWithThreadLengthTheWayPresenceDoes() {
        let short = UnderstandingBuilder.topicReading(in: (0..<10).map {
            message("s-\($0)", $0 == 0 ? "work thing" : "ok", fromMe: false, day: $0)
        })
        let long = UnderstandingBuilder.topicReading(in: (0..<200).map {
            message("l-\($0)", $0 % 10 == 0 ? "work thing" : "ok", fromMe: false, day: $0)
        })

        // Presence says "work" for both and therefore separates nothing.
        XCTAssertEqual(short.tokens, ["work"])
        XCTAssertEqual(long.tokens, ["work"])
        // Density says the same thing about both, which is the point: it is a rate.
        XCTAssertEqual(short.density["work"] ?? 0, long.density["work"] ?? 0, accuracy: 0.0001)
    }

    // MARK: - Helpers

    /// A thread with an even split of turns, all at one hour on weekdays, so every
    /// share-based signal is a deliberate property of the fixture.
    private func balancedThread(messages count: Int, hour: Int,
                                body: String) -> [MirrorDatabase.StoredMessage] {
        (0..<count).map { index in
            message("b-\(index)", body, fromMe: index % 2 == 0,
                    day: weekday(index), hour: hour)
        }
    }

    private func rendered(_ value: RelationshipUnderstanding) -> String {
        [value.contactID, value.register.rawValue, value.relationshipKind.rawValue,
         value.openThread ?? "", value.lastExchangeShape.rawValue,
         value.topics.joined(separator: " "), value.cadenceNorm].joined(separator: "|")
    }
}
