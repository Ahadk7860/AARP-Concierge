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
        /// State the mirror cannot supply — Messages in iCloud, Low Power Mode. Passed
        /// through to the one health function, never re-derived here.
        public var system: HealthCheck.SystemState

        /// AMENDMENT-001. The allowlist, per `contact_id`, extracted from the other
        /// person's recent messages by `FactExtractor`.
        ///
        /// Passed in rather than computed here because `MetricLibrary.Result` carries no
        /// messages — deliberately, since the corpus is the thing that must not travel.
        /// `FactExtractor.factsByContact(mirror:identities:)` builds this from the
        /// mirror, and the caller hands it over. A contact with no entry gets `.empty`,
        /// which is a valid and common answer.
        public var signalsByContact: [String: FactExtractor.ThreadSignals]
        /// Used only by the v2 contextual exemplars. Register classification sees raw
        /// user text first; the only prose placed on the wire is then redacted here.
        public var understandingRedactor: Redactor

        public init(userID: String? = nil,
                    deviceID: String? = nil,
                    generatedAt: Date = Date(),
                    minimumMessages: Int = 1,
                    system: HealthCheck.SystemState = HealthCheck.SystemState(),
                    signalsByContact: [String: FactExtractor.ThreadSignals] = [:],
                    understandingRedactor: Redactor = Redactor()) {
            self.userID = userID
            self.deviceID = deviceID
            self.generatedAt = generatedAt
            self.minimumMessages = minimumMessages
            self.system = system
            self.signalsByContact = signalsByContact
            self.understandingRedactor = understandingRedactor
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
                    // AMENDMENT-001. Three of these the metric library already computed
                    // and this projection used to throw away — the comment at the top of
                    // this file listed "unanswered questions, who had the last word" as
                    // things that stop here. They stop here no longer, because the gist
                    // producer cannot classify `action_needed` without them.
                    last_from_me: metrics.userSentLastMessage,
                    max_gap_days: metrics.longestGapDays,
                    // THE PENDING QUESTION, NOT A HISTORICAL ONE. This first read
                    // `metrics.unansweredQuestionsFromThem > 0`, which counts every
                    // question either party ever left unanswered — a different and
                    // perfectly reasonable metric, and the wrong one here. `threads.py`
                    // asks whether the LAST message is one of theirs wanting an answer,
                    // and the Swift↔Python agreement test caught the difference on its
                    // first run. See `FactExtractor.hasPendingQuestion`.
                    unanswered_question: options
                        .signalsByContact[metrics.identity.contact_id]?.pendingQuestion ?? false,
                    facts: options
                        .signalsByContact[metrics.identity.contact_id]?.facts ?? .empty,
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

        // ONE HEALTH FUNCTION, TWO CALLERS. `boi-cli health` calls the same
        // `HealthCheck.evaluate`, so the classification the user is shown on the
        // onboarding screen and the one that ships inside `corpus.health` cannot
        // disagree — there is no second implementation for them to disagree with.
        let health = HealthCheck.evaluate(corpus: result.corpus, system: options.system)
        let corpus = CorpusSummary(
            message_count: result.corpus.messageCount,
            thread_count: result.corpus.threadCount,
            first_message_at: result.corpus.firstMessageAt.map(StructuredLog.timestamp),
            last_message_at: result.corpus.lastMessageAt.map(StructuredLog.timestamp),
            span_days: result.corpus.spanDays,
            green_share: Self.round(result.corpus.greenShare),
            // Not from chat.db — it does not know. Prompt 06 reads it from
            // `com.apple.madrid`, and nil when that is absent is the honest answer
            // rather than a guess in either direction.
            messages_in_icloud: options.system.messagesInICloud,
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

    /// Builds the Phase 2 wire document from the same metric result as v1 plus the
    /// local mirror that holds the two-way turn ordering. The v1 path above remains
    /// unchanged and continues to emit `digest.v1`.
    public func buildV2(from result: MetricLibrary.Result,
                        mirror: MirrorDatabase) throws -> DigestV2 {
        let legacy = build(from: result)
        let identities = result.relationships.map(\.identity)
        var messages: [MirrorDatabase.StoredMessage] = []
        try mirror.forEachMessage { messages.append($0) }

        let localUnderstanding = UnderstandingBuilder()
            .build(messages: messages, identities: identities)
        let understandingByContact = Dictionary(uniqueKeysWithValues:
            localUnderstanding.map { ($0.contactID, $0) })
        let grouped = UnderstandingBuilder.group(messages: messages, identities: identities)
        let contextualBuilder = ContextualVoiceExemplarBuilder(
            redactor: options.understandingRedactor)

        let relationships = legacy.relationships.map { relationship -> RelationshipV2 in
            let local = understandingByContact[relationship.contact_id]
            let contextual = contextualBuilder
                .build(messages: grouped[relationship.contact_id] ?? [])
                .exemplars.map(Self.wireExemplar)
            let understanding = RelationshipUnderstandingV2(
                register: local.map { Self.wireRegister($0.register) } ?? .mixed,
                relationship_kind: local.map { Self.wireRelationshipKind($0.relationshipKind) }
                    ?? .other,
                open_thread: local?.openThread,
                last_exchange_shape: local.map { Self.wireLastShape($0.lastExchangeShape) }
                    ?? .none,
                topics: local?.topics ?? [],
                cadence_norm: local?.cadenceNorm,
                voice_exemplars: contextual
            )
            return RelationshipV2(
                contact_id: relationship.contact_id,
                display: relationship.display,
                is_group: relationship.is_group,
                message_count: relationship.message_count,
                sent_count: relationship.sent_count,
                received_count: relationship.received_count,
                days_since_last_contact: relationship.days_since_last_contact,
                momentum_90d: relationship.momentum_90d,
                initiation_ratio: relationship.initiation_ratio,
                last_from_me: relationship.last_from_me,
                max_gap_days: relationship.max_gap_days,
                unanswered_question: relationship.unanswered_question,
                facts: relationship.facts,
                as_of: relationship.as_of,
                understanding: understanding
            )
        }

        let newest = messages.compactMap(\.sentAt).max() ?? options.generatedAt
        return DigestV2(
            user_id: legacy.user_id,
            device_id: legacy.device_id,
            generated_at: legacy.generated_at,
            synced_through: StructuredLog.timestamp(newest),
            corpus: legacy.corpus,
            relationships: relationships,
            whole_life: legacy.whole_life
        )
    }

    private static func wireRegister(_ value: UnderstandingRegister) -> UnderstandingRegisterV2 {
        switch value {
        case .casual: return .casual
        case .warm: return .warm
        case .terse: return .terse
        case .formal: return .formal
        }
    }

    private static func wireRelationshipKind(
        _ value: UnderstandingRelationshipKind
    ) -> RelationshipKindV2 {
        switch value {
        case .closeFriend: return .closeFriend
        case .logistics: return .logistics
        case .work: return .work
        case .family: return .family
        case .dormantClose: return .dormantClose
        }
    }

    private static func wireLastShape(
        _ value: UnderstandingLastExchangeShape
    ) -> LastExchangeShapeV2 {
        switch value {
        case .questionFromThem: return .questionFromThem
        case .statementFromThem: return .statementFromThem
        case .statementFromYou: return .statementFromYou
        case .planUnresolved: return .planUnresolved
        case .none: return .none
        }
    }

    private static func wireExemplar(
        _ value: ContextualVoiceExemplar
    ) -> ContextualVoiceExemplarV2 {
        ContextualVoiceExemplarV2(
            text: value.text,
            answered: VoicePackBuilder.wireAnsweredShape(value.answered),
            register: wireRegister(value.register)
        )
    }

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
    /// Keys that must appear as an explicit `null` rather than be omitted.
    ///
    /// `first_contact_at` is the one that matters: CONTRACTS.md § 10 says to **emit**
    /// null when the corpus is retention-capped, and the schema makes the key optional —
    /// so omitting it validates while saying something different to Track D. A missing
    /// key reads as "this build did not compute it"; an explicit null reads as
    /// "computed, and the truthful answer is that we cannot know". The rule exists to
    /// say the second thing out loud.
    public static let relationshipExplicitNulls = ["first_contact_at", "last_contact_at",
                                                   "muted_by_them", "archetype"]
    public static let corpusExplicitNulls = ["first_message_at", "last_message_at",
                                             "messages_in_icloud", "retention_boundary"]

    @discardableResult
    public static func write(_ digest: Digest, to path: String) throws -> Int {
        let data = try ExplicitNullJSON.data(encoding: digest) { object in
            if var corpus = object["corpus"] as? [String: Any] {
                ExplicitNullJSON.fillNull(&corpus, corpusExplicitNulls)
                object["corpus"] = corpus
            }
            if let relationships = object["relationships"] as? [[String: Any]] {
                object["relationships"] = relationships.map { relationship in
                    var patched = relationship
                    ExplicitNullJSON.fillNull(&patched, relationshipExplicitNulls)
                    return patched
                }
            }
        }
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        return data.count
    }

    @discardableResult
    public static func write(_ digest: DigestV2, to path: String) throws -> Int {
        let data = try ExplicitNullJSON.data(encoding: digest) { object in
            if var corpus = object["corpus"] as? [String: Any] {
                ExplicitNullJSON.fillNull(&corpus, corpusExplicitNulls)
                object["corpus"] = corpus
            }
            if let relationships = object["relationships"] as? [[String: Any]] {
                object["relationships"] = relationships.map { relationship in
                    var patched = relationship
                    if var understanding = patched["understanding"] as? [String: Any] {
                        ExplicitNullJSON.fillNull(&understanding,
                                                  ["open_thread", "cadence_norm"])
                        patched["understanding"] = understanding
                    }
                    return patched
                }
            }
        }
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        return data.count
    }
}
