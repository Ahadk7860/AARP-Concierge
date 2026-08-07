import Foundation

/// A deterministic, local-only summary of a two-way conversation.
///
/// This is deliberately an internal staging DTO. `digest.v2` and `voice_pack.v2` are
/// frozen foundation contracts, so this builder must not create a competing serialised
/// shape before their Swift mirrors are amended. It reads both directions in memory and
/// emits only closed-vocabulary values and fixed descriptions. In particular, it never
/// copies a counterpart's text into its result.
///
/// `unknown` is a first-class answer in both closed vocabularies below. The previous
/// implementation had no way to say "not enough evidence", so a one-message thread still
/// produced a confident-looking `terse` / `logistics` pair. Absence reported as a
/// finding is worse than no finding: a consumer cannot tell the two apart.
enum UnderstandingRegister: String, Sendable, Equatable {
    case casual, warm, terse, formal, unknown
}

enum UnderstandingRelationshipKind: String, Sendable, Equatable {
    case closeFriend = "close_friend"
    case logistics, work, family, dormantClose = "dormant_close"
    case unknown
}

enum UnderstandingLastExchangeShape: String, Sendable, Equatable {
    case questionFromThem = "question_from_them"
    case statementFromThem = "statement_from_them"
    case statementFromYou = "statement_from_you"
    case planUnresolved = "plan_unresolved"
    case none
}

/// All strings in this value are drawn from constants in this file, never from a
/// message body. This keeps a future serializer from accidentally turning a helpful
/// local analysis into an upload of the other person's words.
struct RelationshipUnderstanding: Sendable, Equatable {
    let contactID: String
    let register: UnderstandingRegister
    let relationshipKind: UnderstandingRelationshipKind
    let openThread: String?
    let lastExchangeShape: UnderstandingLastExchangeShape
    let topics: [String]
    let cadenceNorm: String
}

/// The first, intentionally boring implementation of the two-way reading seam.
///
/// A later local model can replace the classification methods while retaining the same
/// bounded output discipline. This implementation sees conversation text only long
/// enough to count recognised topic markers, style markers, and terminal question/plan
/// shapes.
struct UnderstandingBuilder {
    static let maximumTopics = 5
    static let maximumTopicWords = 3
    static let maximumTopicCharacters = 40

    /// Below this many messages in a thread, no share or rate below is stable enough to
    /// name a relationship, so `relationshipKind` returns `.unknown`. A balance figure
    /// computed over four messages is noise wearing the shape of a measurement.
    static let relationshipEvidenceFloor = 12

    /// Below this many USER-authored messages, register returns `.unknown`. On the real
    /// corpus this floor sends 68% of raw threads to `unknown` but costs only 5% of the
    /// threads with 20 or more messages — nearly free where it matters, and it is
    /// exactly the population the old code was confidently labelling `terse`.
    static let registerEvidenceFloor = 10

    private static let topicMarkers: [(token: String, markers: [String])] = [
        ("apartment", ["apartment", "apartments", "lease", "leases", "rent", "rented",
                       "renting"]),
        ("climbing", ["climb", "climbed", "climbing", "climbs", "boulder", "bouldering"]),
        ("family", ["dad", "father", "family", "mom", "mother", "parents"]),
        ("plans", ["coming", "plan", "planned", "planning", "plans", "tonight", "weekend",
                   "weekends"]),
        ("school", ["class", "classes", "exam", "exams", "homework", "school", "schools"]),
        ("work", ["meeting", "meetings", "office", "offices", "work", "worked", "working",
                  "works"])
    ]

    /// The closed vocabulary that may be interpolated into `openThread`. It is exactly
    /// the `topicMarkers` token set; `scripts/check_voice_pack_leak.py` carries the same
    /// list and rejects any `open_thread` outside the grammar, so a token added here and
    /// not there fails loudly rather than passing silently.
    static var openThreadTopicVocabulary: [String] { topicMarkers.map(\.token) }

    /// Calendar used for the time-of-day signals. Held as a static so a test can pin it;
    /// a relationship reading must not silently change meaning because the machine moved
    /// timezone halfway through a corpus.
    static var calendar: Calendar = {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = .current
        return value
    }()

    func build(mirror: MirrorDatabase,
               identities: [ContactResolver.Identity]) throws -> [RelationshipUnderstanding] {
        var messages: [MirrorDatabase.StoredMessage] = []
        try mirror.forEachMessage { messages.append($0) }
        return build(messages: messages, identities: identities)
    }

    func build(messages: [MirrorDatabase.StoredMessage],
               identities: [ContactResolver.Identity]) -> [RelationshipUnderstanding] {
        let perContact = Self.group(messages: messages, identities: identities)

        // The user's own style, measured across every thread at once. Register is a
        // comparison against this and never against an absolute character count:
        // "terse FOR YOU" is the only reading that means anything. This user writes 82%
        // of their messages in all lowercase and ends 0.4% of them with a full stop, so
        // a formality test keyed on absolute constants would call every thread informal.
        // Computed once for the whole corpus, not per thread.
        let baseline = StyleProfile(
            userBodies: perContact.values.flatMap { thread in
                thread.filter(\.isFromMe).compactMap(\.text)
            })

        // The newest message anywhere in the corpus is the clock. Using `Date()` would
        // make a thread's classification depend on WHEN the sync ran, so re-reading the
        // same corpus tomorrow would silently reclassify people.
        let asOf = messages.compactMap(\.sentAt).max()

        return identities.sorted { $0.contact_id < $1.contact_id }.compactMap { identity in
            guard let conversation = perContact[identity.contact_id], !conversation.isEmpty else {
                return nil
            }
            return understand(contactID: identity.contact_id, messages: conversation,
                              baseline: baseline, asOf: asOf)
        }
    }

    static func group(messages: [MirrorDatabase.StoredMessage],
                      identities: [ContactResolver.Identity])
        -> [String: [MirrorDatabase.StoredMessage]] {
        var byHandle: [String: ContactResolver.Identity] = [:]
        for identity in identities {
            for handle in identity.handles {
                byHandle[ContactResolver.normalize(handle)] = identity
            }
        }

        var perContact: [String: [MirrorDatabase.StoredMessage]] = [:]
        for message in messages where !message.isTapback && !message.isGroup {
            guard let rawHandle = message.chatIdentifier,
                  let identity = byHandle[ContactResolver.normalize(rawHandle)] else { continue }
            perContact[identity.contact_id, default: []].append(message)
        }

        return perContact
    }

    private func understand(contactID: String,
                            messages: [MirrorDatabase.StoredMessage],
                            baseline: StyleProfile,
                            asOf: Date?) -> RelationshipUnderstanding {
        let ordered = messages.sorted {
            let lhs = $0.sentAt ?? .distantPast
            let rhs = $1.sentAt ?? .distantPast
            return lhs == rhs ? $0.guid < $1.guid : lhs < rhs
        }
        let userBodies = ordered.filter(\.isFromMe).compactMap(\.text)

        // ROOT 5. One pass over the thread's text yields BOTH the bounded token list and
        // the per-token density the classifier needs. The old code called `topics(in:)`
        // twice per relationship — two full passes over every message in every thread,
        // for the same answer.
        let topicReading = Self.topicReading(in: ordered)
        let structure = ThreadStructure(ordered: ordered, asOf: asOf)
        let outstanding = Self.outstandingThread(in: ordered)

        return RelationshipUnderstanding(
            contactID: contactID,
            register: Self.threadRegister(userBodies: userBodies, baseline: baseline),
            relationshipKind: Self.relationshipKind(structure: structure,
                                                    topicDensity: topicReading.density),
            openThread: outstanding.description,
            lastExchangeShape: outstanding.shape,
            topics: topicReading.tokens,
            cadenceNorm: Self.cadenceDescription(typicalGapDays: structure.medianGapDays)
        )
    }

    // MARK: - Root 1: structural relationship classification

    /// ROOT 1. The previous implementation classified on TOKEN PRESENCE:
    ///
    ///     if topics.contains("family") { return .family }
    ///     if topics.contains("work")   { return .work }
    ///     if userShare < 0.2 || userShare > 0.8 { return .logistics }
    ///     return .closeFriend
    ///
    /// The probability that the word "work" or "family" appears SOMEWHERE in a thread
    /// rises toward 1 with its length, so those two branches were length detectors.
    /// `logistics` was `userShare` outside [0.2, 0.8], which a one-message thread always
    /// satisfies — the thin-thread default, not a category. `closeFriend` was the
    /// residual, reached only when three other tests failed, never positively evidenced.
    /// The output inverted under a volume filter: `logistics` 170→1, `family` 65→57.
    ///
    /// Every signal below was measured against thread length on the real corpus and kept
    /// only where |Spearman rho| stayed near or under 0.2 within the population this
    /// classifier actually sees. That rules out several intuitive candidates:
    /// `active_days` (0.90), `sessions` (0.91), `burstiness` (0.67),
    /// `messages_per_active_day` (0.57), `lifespan_days` (0.52) and `profanity_rate`
    /// (0.66) are all re-encodings of volume and are deliberately NOT used, however
    /// plausible they sound as relationship evidence.
    ///
    /// Topic evidence enters as DENSITY — the share of messages carrying a marker —
    /// which is the same fix applied to vocabulary: presence saturates with length, a
    /// rate does not. Each density term is weighted below the margin any category needs
    /// to win, so a topic can move a thread between two readings it already fits and
    /// cannot conjure a category on its own.
    static func relationshipKind(structure: ThreadStructure,
                                 topicDensity: [String: Double]) -> UnderstandingRelationshipKind {
        guard structure.total >= relationshipEvidenceFloor,
              structure.sentCount > 0, structure.receivedCount > 0 else {
            return .unknown
        }

        // How evenly the two sides carry the thread. Derived from `userShare`, whose
        // correlation with thread length is -0.07 — the cleanest structural signal in
        // the corpus.
        //
        // NOTE FOR ANYONE EXTENDING THIS. The obvious neighbouring signal — the min/max
        // ratio of the two sides' message counts — is the metric CONTRACTS.md section 6
        // bans BY NAME, and `DigestGuardTests` fails the build if it appears anywhere
        // under `mac/`. It is also the worse of the two here: it tracks thread length at
        // rho +0.21 against this one's -0.07. Do not reach for it.
        let balance = 1.0 - min(1.0, abs(structure.userShare - 0.5) / 0.5)
        let offHours = min(1.0, 0.6 * (structure.nightShare / 0.35)
                                + 0.4 * (structure.weekendShare / 0.40))
        let workHours = min(1.0, max(0.0, (structure.businessHoursShare - 0.15) / 0.45))
        let familyDensity = min(1.0, (topicDensity["family"] ?? 0) / 0.05)
        let workDensity = min(1.0, (topicDensity["work"] ?? 0) / 0.05)

        // How far past its own silence threshold the thread has drifted. Zero for any
        // thread still in contact, which is what keeps this out of the ordinary case.
        let dormancy = structure.daysSinceLast >= dormancyFloorDays
            ? min(1.0, Double(structure.daysSinceLast) / 240.0) : 0.0

        var scores: [(kind: UnderstandingRelationshipKind, score: Double)] = []

        // A balanced thread that lives outside working hours and is not dominated by
        // family or work vocabulary. Dormancy counts AGAINST it, because `closeFriend`
        // claims an ongoing friendship — otherwise a fully dormant thread scores
        // identically to `dormantClose` and the two cancel each other into `unknown`.
        scores.append((.closeFriend,
                       0.50 * balance
                           + 0.35 * offHours
                           + 0.15 * (1.0 - max(familyDensity, workDensity))
                           - 0.25 * dormancy))

        // Family: the same two-way balance, off the clock, returning repeatedly to
        // family vocabulary. The density term cannot exceed the winning margin alone.
        scores.append((.family,
                       0.45 * balance
                           + 0.25 * (1.0 - workHours)
                           + 0.30 * familyDensity))

        // Work: business hours, and not the off-hours sociality of a friendship.
        scores.append((.work,
                       0.45 * workHours
                           + 0.30 * (1.0 - offHours)
                           + 0.25 * workDensity))

        // Logistics is now POSITIVELY evidenced: a lopsided thread that runs on business
        // hours and never spills into evenings or weekends is a transactional exchange.
        // It is no longer the value a thin thread falls into — thin threads return
        // `.unknown` above, which is why its 170 unfiltered hits collapse.
        scores.append((.logistics,
                       0.55 * (1.0 - balance)
                           + 0.25 * (1.0 - offHours)
                           + 0.20 * workHours))

        // Dormant-close: close-friend structure that has stopped. The old gate was
        // `typicalGapDays >= 30 && total >= 20`, which fired 0 times in 417 — and CANNOT
        // fire, because median gap and message count are mechanically anti-correlated.
        // The largest median gap among all 140 threads with 20+ messages is 0.13 days.
        // Any thread with enough messages to clear the volume half of that gate is by
        // construction burst-textual, so the cadence half can never also be true.
        //
        // The replacement asks the question the name implies — has a real two-way thread
        // gone quiet — using silence since the thread's last message, measured against
        // the newest message in the corpus rather than the wall clock.
        if dormancy > 0 {
            scores.append((.dormantClose, 0.45 * balance + 0.20 * offHours + 0.35 * dormancy))
        }

        let ranked = scores.sorted {
            $0.score == $1.score ? $0.kind.rawValue < $1.kind.rawValue : $0.score > $1.score
        }
        guard let best = ranked.first else { return .unknown }
        let runnerUp = ranked.dropFirst().first?.score ?? 0

        // Below either bar the evidence does not name a relationship, and saying so is
        // the entire point of `unknown`. No density term above is large enough to clear
        // the separation margin by itself.
        guard best.score >= relationshipScoreFloor,
              best.score - runnerUp >= relationshipSeparation else { return .unknown }
        return best.kind
    }

    static let relationshipScoreFloor = 0.35
    static let relationshipSeparation = 0.03

    /// Silence, in days since the thread's last message, before dormancy is considered
    /// at all. 90 days splits the real 20+-message population roughly 29/71.
    static let dormancyFloorDays = 90

    // MARK: - Root 2: register measured against the user's own baseline

    /// ROOT 2. The previous implementation was a message-length histogram:
    ///
    ///     guard !userBodies.isEmpty else { return .terse }         // absence as finding
    ///     if warmSignals * 4 >= userBodies.count { return .warm }  // 25% ❤️/love/miss
    ///     if averageLength <= 24 { return .terse }
    ///     if averageLength >= 120 { return .formal }
    ///     return .casual
    ///
    /// `terse` had a median of ONE message — it was the no-evidence branch wearing a
    /// finding's name. `warm` needed a quarter of the user's messages in a thread to
    /// carry one of three tokens; the real 99th percentile is 8.5%, so the bar sat above
    /// everything and fired once in 140. `casual` was the 25–119 character band, which
    /// is where all ordinary texting lives — 125 of 140, a field that did not
    /// discriminate at all.
    ///
    /// The replacement measures the marks that actually carry register and scores each
    /// against THIS USER'S OWN corpus-wide rate, because absolutes cannot work here: 82%
    /// of this user's messages are all-lowercase and 0.4% end in a period. Someone who
    /// never capitalises is not being informal with one particular person.
    static func threadRegister(userBodies: [String],
                               baseline: StyleProfile) -> UnderstandingRegister {
        guard userBodies.count >= registerEvidenceFloor else { return .unknown }
        let thread = StyleProfile(userBodies: userBodies)

        // Warmth first, on a wide vocabulary and a bar set from the real distribution
        // rather than from nothing: at least `warmthFloor` of the user's messages in the
        // thread, AND at least `warmthMultiple` times their own rate. Both halves matter
        // — the floor stops a user who never uses affection vocabulary from having their
        // least-cold thread promoted, and the multiple stops a uniformly affectionate
        // user from having every thread called warm.
        if thread.affectionRate >= warmthFloor,
           thread.affectionRate >= baseline.affectionRate * warmthMultiple {
            return .warm
        }

        let lengthRatio = thread.lengthRatio(over: baseline)
        let longer = min(1.0, max(0.0, lengthRatio - 1.0))
        let shorter = min(1.0, max(0.0, 1.0 - lengthRatio))

        let capitals = Self.lift(thread.capitalisedRate, over: baseline.capitalisedRate, at: 3.0)
        let stops = Self.lift(thread.terminalPunctuationRate,
                              over: baseline.terminalPunctuationRate, at: 2.5)
        let openers = Self.lift(thread.greetingRate + thread.signOffRate,
                                over: baseline.greetingRate + baseline.signOffRate, at: 2.5)
        let formal = 0.35 * capitals + 0.30 * stops + 0.20 * longer + 0.15 * openers

        let bareness = Self.drop(thread.terminalPunctuationRate,
                                 under: baseline.terminalPunctuationRate)
        let plainness = Self.drop(thread.emojiRate, under: baseline.emojiRate)
        let clipped = Self.drop(thread.contractionRate, under: baseline.contractionRate)
        let terse = 0.45 * shorter + 0.25 * bareness + 0.20 * plainness + 0.10 * clipped

        if formal >= formalCut, formal >= terse { return .formal }
        if terse >= terseCut { return .terse }
        return .casual
    }

    static let warmthFloor = 0.04
    static let warmthMultiple = 2.0

    /// How far from the user's own baseline a thread must sit to earn a name other than
    /// `casual`. Fixed constants, tuned once against a real corpus — deliberately NOT
    /// per-run percentiles, so a thread's register cannot change because some unrelated
    /// thread changed.
    static let formalCut = 0.42
    static let terseCut = 0.34

    /// `value` as a share of `base`, saturating at `at` times base. The floor on the
    /// denominator keeps a user whose baseline rate is near zero from having every
    /// thread read as an infinite lift.
    static func lift(_ value: Double, over base: Double, at multiple: Double) -> Double {
        min(1.0, max(0.0, (value / max(base, 0.01)) / multiple))
    }

    /// How far `value` falls short of `base`, as a share of base. 1.0 means absent where
    /// this user normally would not be.
    static func drop(_ value: Double, under base: Double) -> Double {
        min(1.0, max(0.0, 1.0 - value / max(base, 0.01)))
    }

    /// Register of a bounded set of user-authored messages judged on its own, with no
    /// corpus baseline to compare against. This is the SINGLE-MESSAGE path used by the
    /// contextual voice exemplars, where the question is "what register is this one
    /// message in", not "how does this thread differ from the user's norm". Thread-level
    /// callers want `threadRegister(userBodies:baseline:)`.
    static func register(for userBodies: [String]) -> UnderstandingRegister {
        guard !userBodies.isEmpty else { return .unknown }
        let profile = StyleProfile(userBodies: userBodies)
        if profile.affectionRate >= 0.25 { return .warm }
        if profile.medianLength <= 24 { return .terse }
        if profile.medianLength >= 120 { return .formal }
        return .casual
    }

    // MARK: - Root 3 and 4: the outstanding turn

    /// ROOT 3. `open_thread` used to be a four-entry lookup table with no subject in it,
    /// which is why it added nothing beyond `last_exchange_shape` and why exactly
    /// 38 + 2 = 40 relationships carried one. The contract asks for "asked twice whether
    /// you're coming, unanswered"; the subject was missing entirely.
    ///
    /// The subject now comes from the SAME bounded allowlist as `gist.facts`. These eight
    /// shapes — four bare, four with one allowlisted token — are the only strings this
    /// field can ever hold. `scripts/check_voice_pack_leak.py` carries the same grammar
    /// and rejects anything else, so an unrecognised token is a loud failure rather than
    /// a silent widening.
    private static func repeatedQuestionDescription(_ topic: String?) -> String {
        topic.map { "asked more than once about the \($0), unanswered" }
            ?? "asked more than once, unanswered"
    }

    private static func singleQuestionDescription(_ topic: String?) -> String {
        topic.map { "unanswered question from them about the \($0)" }
            ?? "unanswered question from them"
    }

    private static func repeatedPlanDescription(_ topic: String?) -> String {
        topic.map { "raised the plan more than once about the \($0), unresolved" }
            ?? "raised the plan more than once, unresolved"
    }

    private static func singlePlanDescription(_ topic: String?) -> String {
        topic.map { "plan about the \($0) appears unresolved" }
            ?? "plan appears unresolved"
    }

    static func outstandingThread(
        in ordered: [MirrorDatabase.StoredMessage]
    ) -> (shape: UnderstandingLastExchangeShape, description: String?) {
        guard let last = ordered.last else { return (.none, nil) }
        guard !last.isFromMe else { return (.statementFromYou, nil) }

        // Any user-authored turn resolves everything before it. Only the trailing
        // inbound burst can still be outstanding, even if its final bubble is merely
        // "hello" after an earlier question.
        let trailingInbound = Array(ordered.reversed().prefix { !$0.isFromMe }.reversed())
        let shaped = trailingInbound.map { ($0, semanticShape($0)) }
        let planTurns = shaped.filter { $0.1 == .planUnresolved }.map(\.0)
        let questionTurns = shaped.filter { $0.1 == .questionFromThem }.map(\.0)

        // The subject is read from the WHOLE trailing inbound burst, not only the bubble
        // that carried the question or plan marker. The burst is the outstanding
        // exchange — every message in it is unanswered — and people routinely split the
        // subject from the ask across two bubbles ("about the apartment" / "can you look
        // tonight?"). Reading only the marked bubble finds a subject far less often.
        let subject = topicReading(in: trailingInbound).tokens

        // ROOT 4. Plans are read before questions. The old order tested
        // `looksLikeQuestion` first, and in texting a plan is almost always PHRASED as a
        // question — "want to grab dinner saturday?" — so `plan_unresolved` was reachable
        // only when a plan was NOT a question, which is rare. It fired twice in 417.
        // A plan is the more specific and the more actionable of the two readings.
        if planTurns.count > 1 {
            return (.planUnresolved, repeatedPlanDescription(planSubject(subject)))
        }
        if planTurns.count == 1 {
            return (.planUnresolved, singlePlanDescription(planSubject(subject)))
        }
        if questionTurns.count > 1 {
            return (.questionFromThem, repeatedQuestionDescription(subject.first))
        }
        if questionTurns.count == 1 {
            return (.questionFromThem, singleQuestionDescription(subject.first))
        }
        return (.statementFromThem, nil)
    }

    /// HARD CONSTRAINT ON THIS PATH: `topicReading` returns only members of
    /// `topicMarkers`, each already inside the 3-word / 40-character cap. No span of the
    /// counterpart's text can reach `openThread`, because no span of it is ever carried
    /// anywhere — the only thing extracted from a message is the yes/no answer to
    /// "did a marker for this closed token appear".
    ///
    /// For a plan-shaped turn, `plans` is the one token that says nothing — "plan about
    /// the plans appears unresolved" is noise. Prefer any other token, and fall back to
    /// the bare template rather than emit it.
    private static func planSubject(_ tokens: [String]) -> String? {
        tokens.first { $0 != "plans" }
    }

    static func semanticShape(
        _ message: MirrorDatabase.StoredMessage
    ) -> UnderstandingLastExchangeShape {
        if message.isFromMe { return .statementFromYou }
        let text = message.text?.lowercased() ?? ""
        let question = looksLikeQuestion(text)
        if containsPlanMarker(text, isQuestion: question) { return .planUnresolved }
        if question { return .questionFromThem }
        return .statementFromThem
    }

    static func aggregateInboundShape(
        _ shapes: [UnderstandingLastExchangeShape]
    ) -> UnderstandingLastExchangeShape {
        // Same ordering as `outstandingThread` — the more specific shape wins.
        if shapes.contains(.planUnresolved) { return .planUnresolved }
        if shapes.contains(.questionFromThem) { return .questionFromThem }
        return shapes.isEmpty ? .none : .statementFromThem
    }

    static func looksLikeQuestion(_ text: String) -> Bool {
        if text.contains("?") { return true }
        let words = lexicalWords(in: text)
        guard words.count >= 2 else { return false }

        // Without punctuation, a leading modal is not enough: "can confirm I'm
        // coming" and "will be there" are ordinary assertions. Accept only the
        // bounded inversion shapes where the next word is a subject-like pronoun.
        let auxiliaries: Set<String> = [
            "am", "are", "can", "could", "did", "do", "does", "has", "have", "is",
            "should", "was", "were", "will", "would"
        ]
        let subjectOpeners: Set<String> = [
            "he", "i", "it", "she", "that", "there", "they", "this", "we", "you"
        ]
        if auxiliaries.contains(words[0]) { return subjectOpeners.contains(words[1]) }

        // Wh-forms are accepted only when their next token pins an interrogative
        // construction. Ambiguous fragments such as "what a day" require `?`.
        let whWords: Set<String> = ["how", "what", "when", "where", "which", "who", "why"]
        if whWords.contains(words[0]), auxiliaries.contains(words[1]) { return true }
        if words[0] == "what" && ["date", "day", "time"].contains(words[1]) { return true }
        if words[0] == "how"
            && ["far", "late", "long", "many", "much", "old", "soon"].contains(words[1]) {
            return true
        }
        return false
    }

    static func lexicalWords(in text: String) -> [String] {
        text.lowercased().split(whereSeparator: { !$0.isLetter }).map(String.init)
    }

    /// A concrete arranged thing: a named day, or an activity somebody has to show up
    /// to. Deliberately narrow, because this set is consulted for QUESTIONS, where a
    /// loose word list would turn every interrogative into an unresolved plan. "Can you
    /// come tonight" stays a question; "want to grab dinner saturday?" does not.
    private static let arrangementWords: Set<String> = [
        "brunch", "breakfast", "coffee", "dinner", "drinks", "hang", "hangout", "hangs",
        "lunch", "movie", "party", "trip", "weekend", "weekends",
        "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"
    ]

    /// Explicit invitation framing. "want to ... tonight?" proposes something; "are you
    /// coming tonight" merely asks about something already proposed.
    private static let invitationOpeners: Set<String> = ["down", "wana", "wanna", "want"]

    static func containsPlanMarker(_ text: String, isQuestion: Bool) -> Bool {
        let words = Set(lexicalWords(in: text))
        // Explicit plan language remains a bounded signal on its own.
        let explicitPlanWords: Set<String> = ["plan", "planned", "planning", "plans"]
        if !words.isDisjoint(with: explicitPlanWords) { return true }

        let planContextWords: Set<String> = [
            "come", "coming", "meet", "meeting", "tomorrow", "tonight", "weekend",
            "weekends"
        ]

        // ROOT 4. A question that names a concrete arrangement IS an unresolved plan.
        // This is precisely the case the old ordering could never reach, because
        // `looksLikeQuestion` consumed it first.
        if isQuestion {
            if !words.isDisjoint(with: arrangementWords) { return true }
            if !words.isDisjoint(with: invitationOpeners),
               !words.isDisjoint(with: planContextWords) { return true }
        }

        // Directional confirmations such as "I'm coming tonight" are statements: time or
        // movement words become unresolved only when the same bubble also carries one of
        // this deliberately small set of uncertainty markers.
        let uncertaintyWords: Set<String> = [
            "maybe", "perhaps", "possibly", "still", "tentative", "tentatively",
            "uncertain", "unsure"
        ]
        return !words.isDisjoint(with: uncertaintyWords)
            && !words.isDisjoint(with: planContextWords)
    }

    // MARK: - Root 5: one pass for both topic readings

    /// The bounded token list AND the per-token density, from a single pass over the
    /// thread. `density` is the share of messages carrying at least one marker for the
    /// token — a rate, so unlike presence it does not climb toward 1 with thread length.
    struct TopicReading: Sendable, Equatable {
        let tokens: [String]
        let density: [String: Double]
    }

    static func topicReading(in messages: [MirrorDatabase.StoredMessage]) -> TopicReading {
        var hits: [String: Int] = [:]
        var withText = 0
        for message in messages {
            guard let text = message.text, !text.isEmpty else { continue }
            withText += 1
            let words = Set(lexicalWords(in: text))
            for candidate in topicMarkers where candidate.markers.contains(where: words.contains) {
                hits[candidate.token, default: 0] += 1
            }
        }

        let denominator = Double(max(withText, 1))
        let density = hits.mapValues { Double($0) / denominator }
        let recognised = topicMarkers.compactMap { hits[$0.token] != nil ? $0.token : nil }
        let bounded = recognised.filter { token in
            token.split(separator: " ").count <= maximumTopicWords
                && token.count <= maximumTopicCharacters
        }
        return TopicReading(tokens: Array(bounded.prefix(maximumTopics)), density: density)
    }

    static func cadenceDescription(typicalGapDays: Int) -> String {
        switch typicalGapDays {
        case 0...1: return "recently active"
        case 2...6: return "usually active within a week"
        case 7...29: return "usually active within a month"
        default: return "long-running quiet period"
        }
    }
}

// MARK: - Structural signals

/// Every classification signal here is a SHARE — a quantity divided by the thread's own
/// size — with the deliberate exception of the raw counts the evidence floor is checked
/// against and the day-scale measure used for dormancy. That is the property Root 1
/// turns on: a signal that grows with thread length cannot compare threads of different
/// lengths.
///
/// Signals considered and REJECTED as classification inputs because they measure volume
/// in disguise, with their measured Spearman rho against thread length inside the
/// 20+-message population: `active_days` (0.90), `sessions` (0.91), `burstiness` (0.67),
/// `messages_per_active_day` (0.57), `lifespan_days` (0.52), `median_gap_days` (-0.35).
struct ThreadStructure: Sendable, Equatable {
    let total: Int
    let sentCount: Int
    let receivedCount: Int
    /// rho vs thread length: -0.07. The cleanest structural signal in the corpus.
    let userShare: Double
    /// Retained for `cadenceNorm` only. NOT a classification input: it is mechanically
    /// anti-correlated with volume, which is exactly what made the old `dormantClose`
    /// gate dead on arrival.
    let medianGapDays: Int
    /// rho vs thread length: +0.02.
    let maxGapDays: Int
    /// Silence since this thread's last message, measured against the newest message in
    /// the whole corpus rather than the wall clock, so re-reading the same corpus later
    /// cannot reclassify anybody.
    let daysSinceLast: Int
    /// rho +0.15, +0.16, -0.11 respectively.
    let nightShare: Double
    let weekendShare: Double
    let businessHoursShare: Double

    init(ordered: [MirrorDatabase.StoredMessage], asOf: Date?) {
        let calendar = UnderstandingBuilder.calendar
        total = ordered.count
        sentCount = ordered.filter(\.isFromMe).count
        receivedCount = total - sentCount
        userShare = Double(sentCount) / Double(max(total, 1))

        let dates = ordered.compactMap(\.sentAt).sorted()
        let gapDays = zip(dates, dates.dropFirst())
            .map { Int($1.timeIntervalSince($0) / 86_400) }.sorted()
        medianGapDays = gapDays.isEmpty ? 0 : max(0, gapDays[gapDays.count / 2])
        maxGapDays = gapDays.last.map { max(0, $0) } ?? 0

        if let newest = asOf, let last = dates.last {
            daysSinceLast = max(0, Int(newest.timeIntervalSince(last) / 86_400))
        } else {
            daysSinceLast = 0
        }

        var night = 0, business = 0, weekend = 0
        for date in dates {
            let parts = calendar.dateComponents([.hour, .weekday], from: date)
            let hour = parts.hour ?? 12
            let isWeekend = parts.weekday == 1 || parts.weekday == 7
            if hour >= 22 || hour < 6 { night += 1 }
            if !isWeekend && hour >= 9 && hour < 18 { business += 1 }
            if isWeekend { weekend += 1 }
        }
        let denominator = Double(max(dates.count, 1))
        nightShare = Double(night) / denominator
        businessHoursShare = Double(business) / denominator
        weekendShare = Double(weekend) / denominator
    }
}

// MARK: - Style signals

/// The marks that actually carry register, each as a SHARE of the messages measured, so
/// a long thread and a short one land on the same scale. The same initialiser builds the
/// profile for one thread and for the user's whole corpus, because register is nothing
/// but the comparison between those two.
struct StyleProfile: Sendable, Equatable {
    let count: Int
    let medianLength: Int
    let contractionRate: Double
    let capitalisedRate: Double
    let emojiRate: Double
    let terminalPunctuationRate: Double
    let questionRate: Double
    let greetingRate: Double
    let signOffRate: Double
    let profanityRate: Double
    let affectionRate: Double

    /// Deliberately wide, and far wider than the three tokens the old `warm` branch
    /// used. Requiring a quarter of a thread's messages to carry ❤️, "love" or "miss" is
    /// a bar whose real 99th percentile is 8.5% — it fired on 1 relationship in 140.
    static let affectionMarkers: [String] = [
        "❤", "♥", "❣", "🥰", "😍", "😘", "😗", "😙", "😚", "💕", "💖", "💗", "💘",
        "💙", "💚", "💛", "💜", "💝", "💞", "💟", "🧡", "🤍", "🖤", "🤗", "🫶", "<3",
        "xo", "xoxo", "love", "loved", "loves", "loving", "luv", "miss", "missed",
        "missing", "hug", "hugs", "hugging", "proud", "sweet", "sweetie", "sweetheart",
        "dear", "babe", "baby", "honey", "hun", "darling", "adore", "cherish"
    ]

    static let greetingWords: Set<String> = [
        "dear", "gm", "good", "greetings", "hello", "hey", "heyy", "heya", "hi", "hii",
        "hiya", "howdy", "morning", "sup", "yo", "yoo"
    ]

    static let signOffWords: Set<String> = [
        "best", "bye", "cheers", "gn", "goodnight", "night", "peace", "regards",
        "sincerely", "thanks", "thx", "ttyl", "ty", "xo", "xoxo"
    ]

    static let profanityWords: Set<String> = [
        "af", "ass", "asshole", "bitch", "bullshit", "crap", "damn", "dick", "fml",
        "fuck", "fucked", "fuckin", "fucking", "goddamn", "hell", "shit", "shitty",
        "stfu", "wtf"
    ]

    init(userBodies: [String]) {
        let bodies = userBodies.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        count = bodies.count
        guard !bodies.isEmpty else {
            medianLength = 0
            contractionRate = 0; capitalisedRate = 0; emojiRate = 0
            terminalPunctuationRate = 0; questionRate = 0
            greetingRate = 0; signOffRate = 0; profanityRate = 0; affectionRate = 0
            return
        }

        let lengths = bodies.map(\.count).sorted()
        medianLength = lengths[lengths.count / 2]

        var contractions = 0, capitalised = 0, emoji = 0
        var terminal = 0, questions = 0
        var greetings = 0, signOffs = 0, profanity = 0, affection = 0

        for body in bodies {
            let lowered = body.lowercased()
            let words = UnderstandingBuilder.lexicalWords(in: body)

            if Self.hasContraction(lowered) { contractions += 1 }
            if let first = body.first(where: { $0.isLetter }), first.isUppercase {
                capitalised += 1
            }
            if body.unicodeScalars.contains(where: Self.isEmojiScalar) { emoji += 1 }

            let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
            if let last = trimmed.last, last == "." || last == "!" || last == "?" {
                terminal += 1
            }
            if body.contains("?") { questions += 1 }
            if let first = words.first, Self.greetingWords.contains(first) { greetings += 1 }
            if let last = words.last, Self.signOffWords.contains(last) { signOffs += 1 }
            if words.contains(where: Self.profanityWords.contains) { profanity += 1 }
            if Self.affectionMarkers.contains(where: lowered.contains) { affection += 1 }
        }

        let denominator = Double(bodies.count)
        contractionRate = Double(contractions) / denominator
        capitalisedRate = Double(capitalised) / denominator
        emojiRate = Double(emoji) / denominator
        terminalPunctuationRate = Double(terminal) / denominator
        questionRate = Double(questions) / denominator
        greetingRate = Double(greetings) / denominator
        signOffRate = Double(signOffs) / denominator
        profanityRate = Double(profanity) / denominator
        affectionRate = Double(affection) / denominator
    }

    /// Typical message length as a multiple of a baseline's. 1.0 is "exactly how this
    /// user normally writes".
    func lengthRatio(over baseline: StyleProfile) -> Double {
        guard baseline.medianLength > 0 else { return 1.0 }
        return Double(medianLength) / Double(baseline.medianLength)
    }

    private static func hasContraction(_ lowered: String) -> Bool {
        let suffixes = ["t", "s", "re", "ve", "ll", "d", "m"]
        let scalars = Array(lowered)
        for (index, character) in scalars.enumerated()
        where character == "'" || character == "\u{2019}" {
            guard index > 0, scalars[index - 1].isLetter else { continue }
            let tail = String(scalars[(index + 1)...].prefix(2))
            if suffixes.contains(where: { tail.hasPrefix($0) }) { return true }
        }
        return false
    }

    private static func isEmojiScalar(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x1F000...0x1FAFF, 0x2600...0x27BF, 0x2190...0x21FF, 0x2B00...0x2BFF,
             0xFE0F:
            return true
        default:
            return scalar.properties.isEmojiPresentation
        }
    }
}
