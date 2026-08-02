import Foundation

/// Turns the metric library's output into a `digest.v1` document.
///
/// The schema is frozen and `additionalProperties` is false, so this file is a
/// projection rather than a serializer: everything the metric library computes that has
/// no field in `digest.v1` — unanswered questions, who had the last word, streaks,
/// window counts — stops here and stays on the Mac. That is the correct direction. The
/// digest is the abstraction that crosses the boundary, and it gets wider only by
/// amending the contract.
public struct DigestBuilder {

    public struct Options: Sendable {
        public var userID: String?
        public var deviceID: String?
        public var generatedAt: Date
        /// Relationships with less than this in the mirror are left out of the ranking.
        /// A single exchanged text is not a relationship, and padding the digest with
        /// them makes concentration meaningless.
        public var minimumMessages: Int

        public init(userID: String? = nil,
                    deviceID: String? = nil,
                    generatedAt: Date = Date(),
                    minimumMessages: Int = 1) {
            self.userID = userID
            self.deviceID = deviceID
            self.generatedAt = generatedAt
            self.minimumMessages = minimumMessages
        }
    }

    private let resolver: ContactResolver
    private let options: Options

    public init(resolver: ContactResolver, options: Options = Options()) {
        self.resolver = resolver
        self.options = options
    }

    public func build(from result: MetricLibrary.Result) -> Digest {
        // ONE `as_of`, TAKEN ONCE, STAMPED EVERYWHERE. CONTRACTS.md § 6 requires it on
        // every fact end to end, and the reason it is one value rather than several
        // `Date()` calls is that a document whose parts disagree by two milliseconds is
        // a document nobody can reason about downstream.
        let asOf = StructuredLog.timestamp(options.generatedAt)

        let relationships = result.relationships
            .filter { $0.messageCount >= options.minimumMessages }
            .map { metrics in
                Relationship(
                    contact_id: metrics.identity.contact_id,
                    display: Self.truncateDisplay(metrics.identity.display),
                    is_group: false,
                    message_count: metrics.messageCount,
                    sent_count: metrics.sentCount,
                    received_count: metrics.receivedCount,
                    first_contact_at: metrics.firstContactAt.map(StructuredLog.timestamp),
                    last_contact_at: metrics.lastContactAt.map(StructuredLog.timestamp),
                    days_since_last_contact: metrics.daysSinceLastContact,
                    momentum_90d: Self.round(metrics.momentum90d),
                    initiation_ratio: Self.round(metrics.initiationRatio),
                    median_reply_latency_s: metrics.medianReplyLatency,
                    p90_reply_latency_s: metrics.p90ReplyLatency,
                    tapbacks: Tapbacks(given: metrics.tapbacksGiven,
                                       received: metrics.tapbacksReceived),
                    muted_by_them: metrics.mutedByThem,
                    green_share: Self.round(metrics.greenShare),
                    calls: metrics.calls.map {
                        CallStats(count: $0.count, total_seconds: $0.totalSeconds,
                                  initiated_by_user: $0.initiatedByUser, missed: $0.missed)
                    },
                    archetype: metrics.archetype,
                    as_of: asOf
                )
            }

        let health = Self.provisionalHealth(result.corpus)
        let corpus = CorpusSummary(
            message_count: result.corpus.messageCount,
            thread_count: result.corpus.threadCount,
            first_message_at: result.corpus.firstMessageAt.map(StructuredLog.timestamp),
            last_message_at: result.corpus.lastMessageAt.map(StructuredLog.timestamp),
            span_days: result.corpus.spanDays,
            green_share: Self.round(result.corpus.greenShare),
            // Whether Messages in iCloud is on cannot be read from chat.db. Null is the
            // honest answer and the schema allows it; prompt 06 has the account state.
            messages_in_icloud: nil,
            retention_boundary: result.corpus.retentionBoundary,
            days_since_newest: result.corpus.daysSinceNewest,
            health: health.health,
            health_reasons: health.reasons,
            as_of: asOf
        )

        let life = result.wholeLife
        let wholeLife = WholeLife(
            total_messages: life.totalMessages,
            unique_people: life.uniquePeople,
            global_median_reply_s: life.globalMedianReplySeconds,
            concentration_top1: Self.round(life.concentrationTop1),
            concentration_top5: Self.round(life.concentrationTop5),
            concentration_top10: Self.round(life.concentrationTop10),
            relationships_gone_quiet: life.relationshipsGoneQuiet,
            relationships_ranked: life.relationshipsRanked,
            late_night_share: Self.round(life.lateNightShare),
            as_of: asOf
        )

        return Digest(user_id: options.userID ?? resolver.localUserIdentifier(),
                      device_id: options.deviceID ?? resolver.localDeviceIdentifier(),
                      generated_at: asOf,
                      corpus: corpus,
                      relationships: relationships,
                      whole_life: wholeLife)
    }

    /// **Provisional, and prompt 06 replaces it.**
    ///
    /// `digest.v1` requires `corpus.health`, so something has to be written here, and
    /// the alternative — defaulting to `healthy` — would be a confident claim made by
    /// code that does not check anything. This uses only what the mirror can prove and
    /// errs toward `fixable`, which is the state with a remedy attached.
    public static func provisionalHealth(
        _ corpus: MetricLibrary.CorpusMetrics
    ) -> (health: CorpusHealth, reasons: [String]) {
        var reasons: [String] = []
        var health = CorpusHealth.healthy

        if corpus.messageCount < thinMessageCount || corpus.spanDays < thinSpanDays {
            health = .thin
            reasons.append("new_mac")
        }

        switch corpus.retentionBoundary {
        case "1y_exact", "365d":
            if health != .thin { health = .fixable }
            reasons.append("keep_messages_1y")
        case "30d_exact", "30d":
            if health != .thin { health = .fixable }
            reasons.append("keep_messages_30d")
        default:
            break
        }

        if corpus.daysSinceNewest >= staleSyncDays {
            if health == .healthy { health = .fixable }
            reasons.append("stale_sync")
        }

        return (health, reasons.isEmpty ? ["none"] : reasons)
    }

    public static let thinMessageCount = 500
    public static let thinSpanDays = 30
    public static let staleSyncDays = 7

    /// `display` is capped at 64 characters by the schema. Truncating beats emitting a
    /// document that fails validation because somebody's contact card has a long name.
    static func truncateDisplay(_ display: String) -> String {
        let trimmed = display.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "unknown" }
        return trimmed.count <= 64 ? trimmed : String(trimmed.prefix(64))
    }

    /// Four decimals. Not for looks: a ratio printed to sixteen digits invites a reader
    /// to believe the last twelve of them.
    static func round(_ value: Double) -> Double {
        (value * 10_000).rounded() / 10_000
    }

    // MARK: - Writing

    /// Writes the digest as pretty-printed JSON with sorted keys.
    ///
    /// Sorted because the same mirror should produce the same bytes: a digest that
    /// reorders its keys between runs cannot be diffed against the previous one, and
    /// diffing it is how anybody notices a metric quietly changing.
    @discardableResult
    public static func write(_ digest: Digest, to path: String) throws -> Int {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(digest)
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        return data.count
    }
}
