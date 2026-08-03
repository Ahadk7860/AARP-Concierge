import Foundation

/// The metric library. Aggregates over the mirror, and nothing else.
///
/// No model, no network, no cost. On 84,000 messages the whole library runs in well
/// under a second, which is the reason the product has no upload, no progress bar and
/// no drop-off window in the funnel — the expensive-looking part is free.
///
/// **What is deliberately not here:** any ratio of one person's messages to another's
/// as a measure of a relationship's balance. Across 25 real relationships that spread
/// was 0.465–0.615, sd 0.034 — it distinguishes nobody, and it is the most legally
/// dangerous number in the category. Momentum spans 0.0× to 13.9× on the same
/// relationships. That is where the signal is, and it is the one this file computes.
///
/// **What is also not here:** a score attached to a person. Every number below is a
/// count, a share of that person's own conversation, or a comparison of one window to
/// the previous one. None of them rank a human being on a scale.
public struct MetricLibrary {

    // MARK: - Tunables, all stated rather than buried

    /// Momentum compares this window against the one before it.
    public static let momentumWindowDays = 90

    /// A message starting a conversation is one sent after a lull this long. Six hours
    /// separates "she replied the next morning" from "she replied", which is the
    /// distinction initiation is trying to make.
    public static let conversationGapSeconds = 6 * 3600.0

    /// A reply is a direction change inside this window. Beyond it the two messages are
    /// not a reply pair at all — they are the end of one conversation and the start of
    /// another, and counting the gap as latency reports somebody's sleep as rudeness.
    public static let replyWindowSeconds = 24 * 3600.0

    /// A question is unanswered if nothing came back inside this window.
    public static let answerWindowSeconds = 48 * 3600.0

    /// Beyond this, a relationship is counted as gone quiet.
    public static let quietAfterDays = 90

    /// Messages sent in these hours, in the user's own timezone.
    public static let lateNightHours = 0...4

    // MARK: - Inputs

    public struct Options: Sendable {
        /// The clock. Injected so a test can place every window deterministically.
        public var now: Date
        /// Late-night is a wall-clock idea, so it needs a wall clock. Defaults to this
        /// Mac's, because this Mac belongs to the person the digest is about.
        public var timeZone: TimeZone
        public var callHistory: CallHistory?

        public init(now: Date = Date(),
                    timeZone: TimeZone = .current,
                    callHistory: CallHistory? = nil) {
            self.now = now
            self.timeZone = timeZone
            self.callHistory = callHistory
        }
    }

    // MARK: - Outputs

    /// Everything computed for one person. A superset of `digest.v1`'s relationship:
    /// the three effort-asymmetry counts at the bottom have no field in the frozen
    /// schema, so they stay on the Mac and feed archetype classification.
    public struct RelationshipMetrics: Sendable {
        public var identity: ContactResolver.Identity
        public var messageCount = 0
        public var sentCount = 0
        public var receivedCount = 0
        public var firstContactAt: Date?
        public var lastContactAt: Date?
        public var daysSinceLastContact = 0
        public var momentum90d = 0.0
        public var recentWindowCount = 0
        public var priorWindowCount = 0
        public var initiationRatio = 0.0
        public var conversationsOpened = 0
        public var conversationsOpenedByUser = 0
        public var medianReplyLatency = LatencyPair()
        public var p90ReplyLatency = LatencyPair()
        public var tapbacksGiven = 0
        public var tapbacksReceived = 0
        public var mutedByThem: Bool?
        public var greenShare = 0.0
        public var calls: CallHistory.Summary?
        public var longestGapDays = 0
        public var currentStreakDays = 0

        /// Questions the user asked that nothing came back to. Never leaves the Mac —
        /// `digest.v1` has no field for it — but it is what separates a friend who is
        /// slow from a friend who is gone.
        public var unansweredQuestionsFromUser = 0
        public var unansweredQuestionsFromThem = 0
        /// Who sent the last message before the thread went quiet.
        public var userSentLastMessage = false

        public var archetype: Archetype?
    }

    public struct CorpusMetrics: Sendable {
        public var messageCount = 0
        public var threadCount = 0
        public var firstMessageAt: Date?
        public var lastMessageAt: Date?
        public var spanDays = 0
        public var greenShare = 0.0
        public var daysSinceNewest = 0
        /// The date every truncated `first_contact_at` would otherwise report. Set only
        /// when the corpus really is floored — see `RetentionBoundary`.
        public var retentionBoundaryAt: Date?
        public var retentionBoundary: String?
        public var threadsOnBoundary = 0
    }

    public struct WholeLifeMetrics: Sendable {
        public var totalMessages = 0
        public var uniquePeople = 0
        public var globalMedianReplySeconds: Int?
        public var concentrationTop1 = 0.0
        public var concentrationTop5 = 0.0
        public var concentrationTop10 = 0.0
        public var relationshipsGoneQuiet = 0
        public var relationshipsRanked = 0
        public var lateNightShare = 0.0
    }

    public struct Result: Sendable {
        public var corpus: CorpusMetrics
        public var relationships: [RelationshipMetrics]
        public var wholeLife: WholeLifeMetrics
        public var elapsed: TimeInterval
    }

    // MARK: - Computation

    private let resolver: ContactResolver
    private let options: Options

    public init(resolver: ContactResolver, options: Options = Options()) {
        self.resolver = resolver
        self.options = options
    }

    public func compute(mirror: MirrorDatabase) throws -> Result {
        let started = Date()

        var rows: [MirrorDatabase.StoredMessage] = []
        try mirror.forEachMessage { rows.append($0) }

        // Identity first: every later pass attributes a row to a person, and that has
        // to be the same person each time.
        //
        // The counterparty of a 1:1 thread is its `chat_identifier`, not the row's
        // `handle`. Outbound rows carry no handle at all — `handle_id` is 0 — so keying
        // on the handle silently drops every message the user sent, which is the half of
        // the corpus that initiation and reply latency are computed from.
        let oneToOne = rows.filter { !$0.isGroup && $0.chatIdentifier != nil }
        let index = resolver.index(handles: Array(Set(oneToOne.compactMap(\.chatIdentifier))))

        var grouped: [String: [MirrorDatabase.StoredMessage]] = [:]
        for row in oneToOne {
            guard let raw = row.chatIdentifier,
                  let identity = index[ContactResolver.normalize(raw)] else { continue }
            grouped[identity.contact_id, default: []].append(row)
        }

        var relationships = grouped.compactMap { contactID, messages -> RelationshipMetrics? in
            guard let identity = index.values.first(where: { $0.contact_id == contactID })
            else { return nil }
            return metrics(for: identity, messages: messages)
        }
        relationships.sort {
            $0.messageCount == $1.messageCount
                ? $0.identity.contact_id < $1.identity.contact_id
                : $0.messageCount > $1.messageCount
        }

        let corpus = corpusMetrics(rows: rows, relationships: relationships)

        // The truncation rule, CONTRACTS.md § 10. Applied after the boundary is known,
        // because whether a first-contact date is a fact or an artefact of Apple's
        // deletion policy is not a property of the relationship — it is a property of
        // the corpus the relationship was measured in.
        for offset in relationships.indices {
            if isTruncated(relationships[offset].firstContactAt, corpus: corpus) {
                relationships[offset].firstContactAt = nil
            }
        }

        for offset in relationships.indices {
            relationships[offset].archetype = Self.classify(relationships[offset])
        }

        return Result(corpus: corpus,
                      relationships: relationships,
                      wholeLife: wholeLifeMetrics(rows: rows, relationships: relationships),
                      elapsed: Date().timeIntervalSince(started))
    }

    /// **The one rule that turns a number into a lie.**
    ///
    /// When the corpus is floored by Apple's Keep Messages setting, every relationship
    /// older than the floor reports its first message *on the floor*. A friendship that
    /// began in 2019 reads as beginning a year ago — not a rounding error, a false claim
    /// about someone's life, on a card whose entire value is that the user can check it
    /// against their own memory.
    public func isTruncated(_ firstContactAt: Date?, corpus: CorpusMetrics) -> Bool {
        guard corpus.retentionBoundary != nil,
              let boundary = corpus.retentionBoundaryAt,
              let firstContactAt else { return false }
        return firstContactAt.timeIntervalSince(boundary) <= 86_400
    }

    // MARK: - Per relationship

    private func metrics(for identity: ContactResolver.Identity,
                         messages: [MirrorDatabase.StoredMessage]) -> RelationshipMetrics {
        var metrics = RelationshipMetrics(identity: identity)

        // Tapbacks are reactions, not messages: they belong in the warmth count and
        // nowhere else. Counting them as messages inflates every volume metric and
        // moves whoever uses them most to the top of the ranking.
        let real = messages.filter { !$0.isTapback }
        for tapback in messages where tapback.isTapback {
            if tapback.isFromMe { metrics.tapbacksGiven += 1 } else { metrics.tapbacksReceived += 1 }
        }

        metrics.messageCount = real.count
        metrics.sentCount = real.filter(\.isFromMe).count
        metrics.receivedCount = metrics.messageCount - metrics.sentCount

        let dates = real.compactMap(\.sentAt).sorted()
        metrics.firstContactAt = dates.first
        metrics.lastContactAt = dates.last
        metrics.daysSinceLastContact = dates.last.map(daysBetween) ?? 0

        // Momentum: this quarter against the previous one.
        let window = Double(Self.momentumWindowDays) * 86_400
        let recentStart = options.now.addingTimeInterval(-window)
        let priorStart = options.now.addingTimeInterval(-2 * window)
        metrics.recentWindowCount = dates.filter { $0 >= recentStart }.count
        metrics.priorWindowCount = dates.filter { $0 >= priorStart && $0 < recentStart }.count
        metrics.momentum90d = Self.momentum(recent: metrics.recentWindowCount,
                                            prior: metrics.priorWindowCount)

        (metrics.longestGapDays, metrics.currentStreakDays) = Self.gapAndStreak(dates: dates)

        let ordered = real.filter { $0.sentAt != nil }.sorted { lhs, rhs in
            lhs.sentAt! == rhs.sentAt! ? lhs.guid < rhs.guid : lhs.sentAt! < rhs.sentAt!
        }

        // Initiation: who breaks the silence. Not who sends more messages — somebody
        // who answers at length looks identical to somebody who starts everything if
        // you only count volume.
        for (offset, message) in ordered.enumerated() {
            let previous = offset > 0 ? ordered[offset - 1].sentAt : nil
            let opensConversation = previous.map {
                message.sentAt!.timeIntervalSince($0) > Self.conversationGapSeconds
            } ?? true
            guard opensConversation else { continue }
            metrics.conversationsOpened += 1
            if message.isFromMe { metrics.conversationsOpenedByUser += 1 }
        }
        metrics.initiationRatio = metrics.conversationsOpened > 0
            ? Double(metrics.conversationsOpenedByUser) / Double(metrics.conversationsOpened)
            : 0

        var userLatencies: [Double] = []
        var theirLatencies: [Double] = []
        for (offset, message) in ordered.enumerated() where offset > 0 {
            let previous = ordered[offset - 1]
            guard previous.isFromMe != message.isFromMe else { continue }
            let latency = message.sentAt!.timeIntervalSince(previous.sentAt!)
            guard latency >= 0, latency <= Self.replyWindowSeconds else { continue }
            if message.isFromMe { userLatencies.append(latency) } else { theirLatencies.append(latency) }
        }
        metrics.medianReplyLatency = LatencyPair(user: Self.percentileSeconds(userLatencies, 50),
                                                 them: Self.percentileSeconds(theirLatencies, 50))
        metrics.p90ReplyLatency = LatencyPair(user: Self.percentileSeconds(userLatencies, 90),
                                              them: Self.percentileSeconds(theirLatencies, 90))

        (metrics.unansweredQuestionsFromUser, metrics.unansweredQuestionsFromThem) =
            Self.unansweredQuestions(ordered)
        metrics.userSentLastMessage = ordered.last?.isFromMe ?? false

        // Warmth, from their device rather than ours. Only outbound rows carry it, and
        // a person we have never texted gets nil rather than false: "not muted" and "no
        // evidence either way" are different answers and the schema has room for both.
        let outbound = real.filter(\.isFromMe)
        metrics.mutedByThem = outbound.isEmpty ? nil : outbound.contains(where: \.wasDeliveredQuietly)

        let green = real.filter { ($0.service ?? "iMessage") != "iMessage" }.count
        metrics.greenShare = real.isEmpty ? 0 : Double(green) / Double(real.count)

        metrics.calls = options.callHistory?.summary(forHandles: identity.handles)
        return metrics
    }

    /// Recent 90 days over the 90 before them.
    ///
    /// A prior window of zero has no ratio. Reporting it as a huge multiple would put a
    /// brand-new acquaintance at the top of "rising fastest" every time, so a first
    /// conversation counts as growth from one rather than from nothing, and the whole
    /// thing is capped at the top of the observed real range.
    public static func momentum(recent: Int, prior: Int) -> Double {
        if prior > 0 { return min(Double(recent) / Double(prior), maximumMomentum) }
        return recent == 0 ? 0 : min(Double(recent), maximumMomentum)
    }

    /// The real corpus topped out at 13.9×. Anything above this is arithmetic, not a
    /// relationship, and the card would be quoting a number nobody can check.
    public static let maximumMomentum = 13.9

    static func gapAndStreak(dates: [Date]) -> (longestGapDays: Int, streakDays: Int) {
        guard let first = dates.first else { return (0, 0) }
        var longest = 0.0
        for (offset, date) in dates.enumerated() where offset > 0 {
            longest = max(longest, date.timeIntervalSince(dates[offset - 1]))
        }
        // The streak is the current run of consecutive days with at least one message,
        // counted back from the newest. It answers "how long has this been going" in the
        // one unit the user experiences.
        var days = Set<Int>()
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        for date in dates {
            days.insert(Int(date.timeIntervalSince(first) / 86_400))
        }
        var streak = 0
        if let newest = days.max() {
            var day = newest
            while days.contains(day) { streak += 1; day -= 1 }
        }
        return (Int(longest / 86_400), streak)
    }

    /// Questions with nothing coming back inside the answer window, per direction.
    static func unansweredQuestions(_ ordered: [MirrorDatabase.StoredMessage]) -> (user: Int, them: Int) {
        var user = 0
        var them = 0
        for (offset, message) in ordered.enumerated() {
            guard let text = message.text,
                  text.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix("?"),
                  let asked = message.sentAt else { continue }
            let answered = ordered[(offset + 1)...].contains { candidate in
                guard let when = candidate.sentAt,
                      when.timeIntervalSince(asked) <= answerWindowSeconds else { return false }
                return candidate.isFromMe != message.isFromMe
            }
            guard !answered else { continue }
            if message.isFromMe { user += 1 } else { them += 1 }
        }
        return (user, them)
    }

    /// Nearest-rank, half-up — CONTRACTS.md § 6.
    ///
    /// Pinned because Track B computes the same statistic in Python, and a language's
    /// default rounding is not a shared definition: `round()` there is banker's and
    /// `rounded()` here is half-away-from-zero, so `n = 20` picks a different element in
    /// each. The result is two implementations disagreeing on a number neither is wrong
    /// about, which is the worst kind of integration bug to debug.
    public static func percentileIndex(count: Int, percentile: Int) -> Int {
        guard count > 0 else { return 0 }
        let rank = (Double(percentile) / 100.0 * Double(count)).rounded(.up)
        return min(max(Int(rank) - 1, 0), count - 1)
    }

    static func percentileSeconds(_ values: [Double], _ percentile: Int) -> Int? {
        guard !values.isEmpty else { return nil }
        let sorted = values.sorted()
        return Int(sorted[percentileIndex(count: sorted.count, percentile: percentile)].rounded())
    }

    // MARK: - Corpus

    private func corpusMetrics(rows: [MirrorDatabase.StoredMessage],
                               relationships: [RelationshipMetrics]) -> CorpusMetrics {
        var corpus = CorpusMetrics()
        let real = rows.filter { !$0.isTapback }
        corpus.messageCount = real.count
        corpus.threadCount = Set(rows.compactMap(\.chatIdentifier)).count

        let dates = real.compactMap(\.sentAt).sorted()
        corpus.firstMessageAt = dates.first
        corpus.lastMessageAt = dates.last
        if let first = dates.first, let last = dates.last {
            // ROUNDED, NOT TRUNCATED, and the exact-boundary signature depends on it. A
            // retention-capped corpus spans 364.996 days — the cap, less the few hours
            // between the oldest surviving message and the deletion cutoff. Truncating
            // reports 364, which is not the boundary and is not what any human would
            // call that span either.
            corpus.spanDays = max(0, Int((last.timeIntervalSince(first) / 86_400).rounded()))
        }
        corpus.daysSinceNewest = dates.last.map(daysBetween) ?? 0

        let green = real.filter { ($0.service ?? "iMessage") != "iMessage" }.count
        corpus.greenShare = real.isEmpty ? 0 : Double(green) / Double(real.count)

        // The retention boundary. See `RetentionBoundary` for why a span alone is not
        // enough evidence.
        if let first = dates.first {
            let onBoundary = relationships.filter {
                ($0.firstContactAt?.timeIntervalSince(first) ?? .infinity) <= 86_400
            }.count
            corpus.threadsOnBoundary = onBoundary
            if let detected = RetentionBoundary.detect(spanDays: corpus.spanDays,
                                                       threadsOnBoundary: onBoundary) {
                corpus.retentionBoundary = detected
                corpus.retentionBoundaryAt = first
            }
        }
        return corpus
    }

    // MARK: - Whole life

    private func wholeLifeMetrics(rows: [MirrorDatabase.StoredMessage],
                                  relationships: [RelationshipMetrics]) -> WholeLifeMetrics {
        var life = WholeLifeMetrics()
        let real = rows.filter { !$0.isTapback }
        life.totalMessages = real.count
        life.uniquePeople = relationships.count
        life.relationshipsRanked = relationships.count
        life.relationshipsGoneQuiet = relationships.filter {
            $0.daysSinceLastContact >= Self.quietAfterDays
        }.count

        let volumes = relationships.map(\.messageCount)
        let total = volumes.reduce(0, +)
        func concentration(_ top: Int) -> Double {
            guard total > 0 else { return 0 }
            return Double(volumes.prefix(top).reduce(0, +)) / Double(total)
        }
        life.concentrationTop1 = concentration(1)
        life.concentrationTop5 = concentration(5)
        life.concentrationTop10 = concentration(10)

        let userMedians = relationships.compactMap { $0.medianReplyLatency.user }.map(Double.init)
        life.globalMedianReplySeconds = Self.percentileSeconds(userMedians, 50)

        // Late night is about the user's own habits, so it is computed over the messages
        // the user sent. Counting inbound messages would report other people's hours.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = options.timeZone
        let sent = real.filter(\.isFromMe).compactMap(\.sentAt)
        let late = sent.filter { Self.lateNightHours.contains(calendar.component(.hour, from: $0)) }
        life.lateNightShare = sent.isEmpty ? 0 : Double(late.count) / Double(sent.count)
        return life
    }

    private func daysBetween(_ date: Date) -> Int {
        max(0, Int(options.now.timeIntervalSince(date) / 86_400))
    }

    // MARK: - Archetypes

    /// The five shapes a relationship takes, in priority order.
    ///
    /// Every threshold is a constant on this type rather than a literal in the branch,
    /// because these are product decisions that will be argued about and each one has to
    /// be findable. Classification is deliberately conservative: `nil` is a perfectly
    /// good answer, and a relationship labelled wrongly is worse than one not labelled
    /// at all — the label is what the morning text says out loud.
    public static func classify(_ metrics: RelationshipMetrics) -> Archetype? {
        // Too little to say anything about. Two people who exchanged nine messages do
        // not have an arc.
        guard metrics.messageCount >= minimumMessagesToClassify else { return nil }

        // A closed chapter: substantial once, and nothing for half a year. Distinct from
        // a fade because it is not still happening — there is nothing to intervene in,
        // and the honest reveal is "this was a season of your life", not "text them".
        if metrics.daysSinceLastContact >= chapterQuietDays { return .chapter }

        // Still alive, and falling. This is the one worth a morning text.
        if metrics.momentum90d < fadeMomentum, metrics.daysSinceLastContact >= fadeQuietDays {
            return .fade
        }

        // You keep asking; the answers stop coming.
        if metrics.unansweredQuestionsFromUser >= waitingUnansweredQuestions,
           metrics.userSentLastMessage,
           metrics.initiationRatio >= waitingInitiationRatio {
            return .theOneYouKeepWaiting
        }

        // You start nearly every conversation. Stated as what the user does, never as
        // what the other person fails to do — the reveal has to be survivable.
        if metrics.initiationRatio >= oneWayInitiationRatio,
           metrics.conversationsOpened >= minimumConversationsToClassify {
            return .oneWayEnthusiasm
        }

        if metrics.momentum90d >= risingMomentum,
           metrics.daysSinceLastContact <= risingRecencyDays {
            return .risingFastest
        }
        return nil
    }

    public static let minimumMessagesToClassify = 20
    public static let minimumConversationsToClassify = 8
    public static let chapterQuietDays = 180
    /// Fewer than half as many messages this quarter as last.
    public static let fadeMomentum = 0.5
    public static let fadeQuietDays = 30
    public static let waitingUnansweredQuestions = 3
    public static let waitingInitiationRatio = 0.6
    public static let oneWayInitiationRatio = 0.7
    public static let risingMomentum = 1.5
    public static let risingRecencyDays = 14
}

/// Whether the corpus has a floor, and what kind.
///
/// A 365-day span is not enough evidence on its own: somebody who genuinely started
/// texting a year ago has the same span and no floor at all. The tell is that *several
/// unrelated threads begin on the same day* — friendships do not synchronize, deletion
/// policies do. So the exact variants require the pile-up and the span; the plain ones
/// record a span that is suspicious but unproven.
///
/// Note what this does **not** try to decide: whether the floor is Apple's Keep Messages
/// setting or a Mac that has only existed for a year. Those have different remedies and
/// prompt 06 tells them apart. They have the same consequence here — a first-contact
/// date read off the floor is an artefact either way — and that is the only question
/// this type is entitled to answer.
public enum RetentionBoundary {

    /// Threads whose first message lands on the corpus floor, before it counts as a cap.
    ///
    /// Two is enough. One thread starting on the oldest day in the corpus is a
    /// tautology — some thread has to be the oldest.
    public static let minimumThreadsOnBoundary = 2

    public static let oneYearDays = 365
    public static let thirtyDayDays = 30
    /// How far off the cap a span may land and still be called a boundary — but only
    /// with the pile-up behind it. A rolling deletion window produces a span that lands
    /// on the cap; a day or two of slack covers a corpus whose oldest surviving message
    /// sits a few hours inside it.
    public static let nearBoundarySlackDays = 2

    /// `1y_exact` / `30d_exact` are the confident answer: the span lands on the cap
    /// **and** several unrelated threads begin on the same day. `365d` / `30d` are the
    /// hedge — one of the two signals, not both.
    public static func detect(spanDays: Int, threadsOnBoundary: Int) -> String? {
        let piledUp = threadsOnBoundary >= minimumThreadsOnBoundary
        for (cap, exact, loose) in [(oneYearDays, "1y_exact", "365d"),
                                    (thirtyDayDays, "30d_exact", "30d")] {
            let onCap = spanDays == cap
            let near = abs(spanDays - cap) <= nearBoundarySlackDays
            if onCap && piledUp { return exact }
            // A span landing exactly on the cap with no pile-up is suspicious but
            // unproven; a pile-up a day off the cap is proven but not exact. Both are
            // real, and neither is the confident answer.
            if onCap || (near && piledUp) { return loose }
        }
        return nil
    }
}
