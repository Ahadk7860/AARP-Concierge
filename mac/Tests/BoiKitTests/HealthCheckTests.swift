import XCTest
@testable import BoiKit

final class HealthCheckTests: XCTestCase {

    // MARK: - Corpora, built to be exactly one shape each

    /// A corpus with an explicit shape and nothing incidental about it.
    private func corpus(messages: Int = 9_000,
                        threads: Int = 7,
                        spanDays: Int = 400,
                        daysSinceNewest: Int = 0,
                        greenShare: Double = 0.18,
                        boundary: String? = nil,
                        threadsOnBoundary: Int = 0) -> MetricLibrary.CorpusMetrics {
        var corpus = MetricLibrary.CorpusMetrics()
        corpus.messageCount = messages
        corpus.threadCount = threads
        corpus.spanDays = spanDays
        corpus.daysSinceNewest = daysSinceNewest
        corpus.greenShare = greenShare
        corpus.retentionBoundary = boundary
        corpus.threadsOnBoundary = threadsOnBoundary
        return corpus
    }

    // MARK: - The three fixture cases the Definition of Done names

    /// Case one: a span landing on precisely 365 days, with threads piled on the floor.
    /// That is Apple's Keep Messages setting trimming, not a person who started texting
    /// a year ago.
    func testAOneYearExactSpanIsFixableForKeepMessages() {
        let result = HealthCheck.evaluate(
            corpus: corpus(spanDays: 365, boundary: "1y_exact", threadsOnBoundary: 3))
        XCTAssertEqual(result.health, .fixable)
        XCTAssertEqual(result.reasons, ["keep_messages_1y"])
        XCTAssertTrue(result.producesReport)

        let remedy = try? XCTUnwrap(result.remedies.first)
        XCTAssertEqual(remedy?.id, "keep_messages")
        XCTAssertFalse(remedy?.fallbackInstructions.isEmpty ?? true)
        // Invitation, never verdict: the reveal names a setting, not a failing.
        XCTAssertTrue(result.headline.contains("more it could see"), result.headline)
    }

    /// Case two: 412 messages over 24 days. Thin, and no setting can fix it.
    func testASmallRecentCorpusIsThinAndOffersNoRemedy() {
        let result = HealthCheck.evaluate(corpus: corpus(messages: 412, threads: 9,
                                                         spanDays: 24))
        XCTAssertEqual(result.health, .thin)
        XCTAssertEqual(result.reasons, ["new_mac"])
        XCTAssertTrue(result.remedies.isEmpty,
                      "there is nothing the user did wrong and nothing to fix but time")
    }

    /// Case three: the real fixture, classified from its own metrics rather than from a
    /// hand-built corpus — so this is the end-to-end answer, whatever it turns out to be.
    func testTheFullFixtureClassifiesWithItsReasonStated() throws {
        try MetricsFixture.ensureCappedChatDatabase()
        let mirror = try MetricsFixture.mirror(of: MetricsFixture.cappedChatDatabasePath,
                                               label: "health-fixture")
        let now = try MetricsFixture.newestMessage(in: mirror)
        let metrics = try MetricLibrary(resolver: ContactResolver(salt: MetricsFixture.salt),
                                        options: .init(now: now,
                                                       timeZone: TimeZone(identifier: "UTC")!))
            .compute(mirror: mirror)
        let result = HealthCheck.evaluate(corpus: metrics.corpus)

        XCTAssertEqual(result.health, .fixable)
        XCTAssertEqual(result.reasons, ["keep_messages_1y"])
        XCTAssertEqual(metrics.corpus.spanDays, 365)
        XCTAssertTrue(RetentionBoundary.isExactBoundary(spanDays: metrics.corpus.spanDays))
        XCTAssertTrue(result.producesReport)
    }

    // MARK: - The exact-boundary signature

    /// **The edges.** A rolling deletion window produces a span that lands *on* the cap.
    /// 364 and 366 are a person, not a policy — friendships do not start and stop on a
    /// schedule and no deletion rule produces an off-by-one window.
    func testTheExactBoundarySignatureHoldsOnlyAtTheCap() {
        XCTAssertFalse(RetentionBoundary.isExactBoundary(spanDays: 364))
        XCTAssertTrue(RetentionBoundary.isExactBoundary(spanDays: 365))
        XCTAssertFalse(RetentionBoundary.isExactBoundary(spanDays: 366))

        XCTAssertFalse(RetentionBoundary.isExactBoundary(spanDays: 29))
        XCTAssertTrue(RetentionBoundary.isExactBoundary(spanDays: 30))
        XCTAssertFalse(RetentionBoundary.isExactBoundary(spanDays: 31))
    }

    /// And the confident classification needs the span *and* the pile-up. A near-miss
    /// with several threads on the same floor is still a cap — that is what `365d` is
    /// for — but it is not the exact signature and must not be reported as one.
    func testOnlyTheCapPlusThePileUpEarnsTheExactLabel() {
        XCTAssertEqual(RetentionBoundary.detect(spanDays: 365, threadsOnBoundary: 3), "1y_exact")
        XCTAssertEqual(RetentionBoundary.detect(spanDays: 364, threadsOnBoundary: 3), "365d")
        XCTAssertEqual(RetentionBoundary.detect(spanDays: 366, threadsOnBoundary: 3), "365d")
        XCTAssertEqual(RetentionBoundary.detect(spanDays: 365, threadsOnBoundary: 1), "365d")
        XCTAssertNil(RetentionBoundary.detect(spanDays: 364, threadsOnBoundary: 1))
        XCTAssertNil(RetentionBoundary.detect(spanDays: 366, threadsOnBoundary: 1))
        XCTAssertNil(RetentionBoundary.detect(spanDays: 200, threadsOnBoundary: 5))
    }

    // MARK: - The other signals

    func testMessagesInICloudBeingOffIsFixableAndUnknownIsNot() {
        let off = HealthCheck.evaluate(corpus: corpus(),
                                       system: .init(messagesInICloud: false))
        XCTAssertEqual(off.health, .fixable)
        XCTAssertTrue(off.reasons.contains("icloud_off"))

        // Unknown is not off. A Mac that has never opened Messages has no preference
        // key, and sending that user to switch on something already on is the kind of
        // wrong answer that costs trust.
        let unknown = HealthCheck.evaluate(corpus: corpus(), system: .init(messagesInICloud: nil))
        XCTAssertEqual(unknown.health, .healthy)
        XCTAssertEqual(unknown.reasons, ["none"])
    }

    /// SMS reaches a Mac only through Text Message Forwarding, which has no queue. An
    /// all-blue corpus on a Mac whose owner has green-bubble contacts is forwarding
    /// switched off, and those messages are gone.
    func testAnAllBlueCorpusIsOnlySuspiciousWhenContactsSayItShouldNotBe() {
        let flagged = HealthCheck.evaluate(corpus: corpus(messages: 9_000, greenShare: 0.0),
                                           system: .init(hasNonIMessageContacts: true))
        XCTAssertTrue(flagged.reasons.contains("low_green_share"))
        XCTAssertEqual(flagged.remedies.first?.id, "text_message_forwarding")

        // With no AddressBook there is no evidence either way, so no claim.
        let noEvidence = HealthCheck.evaluate(corpus: corpus(messages: 9_000, greenShare: 0.0),
                                              system: .init(hasNonIMessageContacts: nil))
        XCTAssertFalse(noEvidence.reasons.contains("low_green_share"))

        // And a small corpus legitimately has no SMS in it.
        let tooSmall = HealthCheck.evaluate(
            corpus: corpus(messages: HealthCheck.greenShareMinimumMessages - 1,
                           spanDays: 400, greenShare: 0.0),
            system: .init(hasNonIMessageContacts: true))
        XCTAssertFalse(tooSmall.reasons.contains("low_green_share"))
    }

    /// The Mac is allowed to be asleep — CONTRACTS.md § 0 — but staleness is a visible
    /// state, never a silent wrong answer.
    func testAStaleCorpusIsFixableAtTheStatedThreshold() {
        XCTAssertEqual(HealthCheck.evaluate(
            corpus: corpus(daysSinceNewest: HealthCheck.staleSyncDays)).health, .fixable)
        XCTAssertEqual(HealthCheck.evaluate(
            corpus: corpus(daysSinceNewest: HealthCheck.staleSyncDays - 1)).health, .healthy)
    }

    func testLowPowerModeIsReportedAsFixable() {
        let result = HealthCheck.evaluate(corpus: corpus(), system: .init(lowPowerMode: true))
        XCTAssertEqual(result.health, .fixable)
        XCTAssertTrue(result.reasons.contains("low_power_mode"))
    }

    func testAGoodCorpusIsHealthyWithNoReasonsAndNoRemedies() {
        let result = HealthCheck.evaluate(corpus: corpus(),
                                          system: .init(messagesInICloud: true,
                                                        hasNonIMessageContacts: true))
        XCTAssertEqual(result.health, .healthy)
        XCTAssertEqual(result.reasons, ["none"])
        XCTAssertTrue(result.remedies.isEmpty)
        XCTAssertTrue(result.producesReport)
    }

    /// Thin wins over everything. A corpus this small cannot be made trustworthy by
    /// changing a setting, and attaching a remedy would imply it could.
    func testThinIsNotDowngradedToFixableByAnOtherwiseFixableSignal() {
        let result = HealthCheck.evaluate(
            corpus: corpus(messages: 412, spanDays: 24, boundary: "1y_exact",
                           threadsOnBoundary: 3),
            system: .init(messagesInICloud: false, lowPowerMode: true))
        XCTAssertEqual(result.health, .thin)
        XCTAssertTrue(result.remedies.isEmpty)
        XCTAssertFalse(result.producesReport)
        // The reasons are still recorded — the classification is simplified, the
        // evidence is not.
        XCTAssertTrue(result.reasons.contains("new_mac"))
        XCTAssertTrue(result.reasons.contains("keep_messages_1y"))
    }

    // MARK: - Copy

    /// **The thin path must not produce a report.** Never hand somebody a bad report and
    /// call it their year in messages.
    func testTheThinPathIsHonestAndProducesNoReport() {
        let result = HealthCheck.evaluate(corpus: corpus(messages: 412, spanDays: 24))
        XCTAssertFalse(result.producesReport)
        XCTAssertEqual(result.headline, HealthCheck.thinHeadline)

        // Honest: it says there is not enough, it does not blame the user, and it offers
        // to come back rather than dressing 412 messages up as a year.
        XCTAssertTrue(HealthCheck.thinBody.contains("Nothing is broken"))
        XCTAssertTrue(HealthCheck.thinBody.contains("week"))
        for verdict in ["you don't", "you didn't", "failed", "problem with you"] {
            XCTAssertFalse(HealthCheck.thinBody.lowercased().contains(verdict),
                           "thin copy must be an invitation, not a verdict")
        }
    }

    /// The Definition of Done pins this string exactly. Full Disk Access is the only one
    /// of these settings that lives in System Settings and so the only one with a real
    /// deep link — the rest carry plain instructions rather than a link that opens the
    /// wrong pane.
    func testTheFullDiskAccessDeepLinkIsExactAndHasAPlainTextFallback() {
        XCTAssertEqual(
            HealthCheck.fullDiskAccessDeepLink,
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles")
        XCTAssertEqual(HealthCheck.fullDiskAccessRemedy.deepLink,
                       HealthCheck.fullDiskAccessDeepLink)
        XCTAssertFalse(HealthCheck.fullDiskAccessRemedy.fallbackInstructions.isEmpty)
        XCTAssertTrue(HealthCheck.fullDiskAccessRemedy.fallbackInstructions
            .contains("Full Disk Access"))
        // The relaunch is load-bearing, not a nicety: macOS does not apply the grant to
        // a process that was already running when it was made.
        XCTAssertTrue(HealthCheck.fullDiskAccessRemedy.fallbackInstructions
            .lowercased().contains("reopen"))
        XCTAssertTrue(HealthCheck.fullDiskAccessRemedy.rescanAvailable)
    }

    /// Every remedy is actionable without a deep link, because most of these settings
    /// have no deep link to give.
    func testEveryRemedyCarriesInstructionsThatStandOnTheirOwn() {
        let remedies = [HealthCheck.fullDiskAccessRemedy,
                        HealthCheck.keepMessagesRemedy(window: "year"),
                        HealthCheck.iCloudRemedy,
                        HealthCheck.textForwardingRemedy,
                        HealthCheck.staleSyncRemedy,
                        HealthCheck.lowPowerRemedy]
        for remedy in remedies {
            XCTAssertFalse(remedy.id.isEmpty)
            XCTAssertFalse(remedy.title.isEmpty)
            XCTAssertFalse(remedy.body.isEmpty)
            XCTAssertGreaterThan(remedy.fallbackInstructions.count, 30,
                                 "\(remedy.id) has no usable instructions")
            if let link = remedy.deepLink {
                XCTAssertTrue(link.hasPrefix("x-apple.systempreferences:"), link)
            }
        }
    }

    // MARK: - The digest cannot disagree with the CLI

    /// One function, two callers. `boi-cli health` and `DigestBuilder` both call
    /// `HealthCheck.evaluate`, so there is no second implementation for them to diverge
    /// from — and this asserts it across every corpus shape rather than on one example.
    func testTheDigestsHealthIsAlwaysTheHealthCheckSAnswer() throws {
        let shapes: [(MetricLibrary.CorpusMetrics, HealthCheck.SystemState)] = [
            (corpus(), .init()),
            (corpus(messages: 412, spanDays: 24), .init()),
            (corpus(spanDays: 365, boundary: "1y_exact", threadsOnBoundary: 3), .init()),
            (corpus(spanDays: 30, boundary: "30d_exact", threadsOnBoundary: 4), .init()),
            (corpus(daysSinceNewest: 30), .init(messagesInICloud: false)),
            (corpus(greenShare: 0.0), .init(lowPowerMode: true, hasNonIMessageContacts: true)),
        ]
        let resolver = ContactResolver(salt: MetricsFixture.salt)

        for (corpus, system) in shapes {
            let expected = HealthCheck.evaluate(corpus: corpus, system: system)
            let result = MetricLibrary.Result(corpus: corpus, relationships: [],
                                              wholeLife: .init(), elapsed: 0)
            let digest = DigestBuilder(resolver: resolver,
                                       options: .init(generatedAt: MetricsFixture.now,
                                                      system: system)).build(from: result)
            XCTAssertEqual(digest.corpus.health, expected.health,
                           "digest and health check disagree on \(corpus.messageCount) messages")
            XCTAssertEqual(digest.corpus.health_reasons, expected.reasons)
            XCTAssertEqual(digest.corpus.messages_in_icloud, system.messagesInICloud)
        }
    }

    /// And the reasons that ship are the frozen enum's values, not free text. A reason
    /// outside the enum fails the schema, which is a validation error nobody would see
    /// until the digest reached Track D.
    func testEveryReasonIsAFrozenEnumValue() throws {
        let permitted: Set<String> = ["icloud_off", "keep_messages_30d", "keep_messages_1y",
                                      "new_mac", "low_green_share", "stale_sync",
                                      "low_power_mode", "none"]
        let everything = HealthCheck.evaluate(
            corpus: corpus(messages: 9_000, spanDays: 365, daysSinceNewest: 30,
                           greenShare: 0.0, boundary: "1y_exact", threadsOnBoundary: 3),
            system: .init(messagesInICloud: false, lowPowerMode: true,
                          hasNonIMessageContacts: true))
        XCTAssertEqual(everything.reasons.count, 5, "expected every signal to fire at once")
        for reason in everything.reasons {
            XCTAssertTrue(permitted.contains(reason), "\(reason) is not in the frozen enum")
        }
    }

    /// Messages in iCloud is read from an ordinary user preference, so it works *before*
    /// Full Disk Access is granted — which is the only reason it is usable on the
    /// onboarding screen at all.
    func testTheICloudProbeReadsARealPreferenceDomain() {
        XCTAssertEqual(HealthCheck.SystemState.messagesCloudDomain, "com.apple.madrid")
        XCTAssertEqual(HealthCheck.SystemState.messagesCloudKey, "CloudKitSyncingEnabled")
        // An absent domain must be nil, not false.
        XCTAssertNil(HealthCheck.SystemState.cloudKitSyncingEnabled(
            domain: "com.boi.definitely.not.a.real.domain", key: "Nope"))
    }
}
