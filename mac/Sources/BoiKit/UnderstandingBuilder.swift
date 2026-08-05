import Foundation

/// A deterministic, local-only summary of a two-way conversation.
///
/// This is deliberately an internal staging DTO. `digest.v2` and `voice_pack.v2` are
/// frozen foundation contracts, so this builder must not create a competing serialised
/// shape before their Swift mirrors are amended. It reads both directions in memory and
/// emits only closed-vocabulary values and fixed descriptions. In particular, it never
/// copies a counterpart's text into its result.
enum UnderstandingRegister: String, Sendable, Equatable {
    case casual, warm, terse, formal
}

enum UnderstandingRelationshipKind: String, Sendable, Equatable {
    case closeFriend = "close_friend"
    case logistics, work, family, dormantClose = "dormant_close"
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
/// enough to count recognised topic markers and terminal question/plan shapes.
struct UnderstandingBuilder {
    static let maximumTopics = 5
    static let maximumTopicWords = 3
    static let maximumTopicCharacters = 40

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

    func build(mirror: MirrorDatabase,
               identities: [ContactResolver.Identity]) throws -> [RelationshipUnderstanding] {
        var messages: [MirrorDatabase.StoredMessage] = []
        try mirror.forEachMessage { messages.append($0) }
        return build(messages: messages, identities: identities)
    }

    func build(messages: [MirrorDatabase.StoredMessage],
               identities: [ContactResolver.Identity]) -> [RelationshipUnderstanding] {
        let perContact = Self.group(messages: messages, identities: identities)

        return identities.sorted { $0.contact_id < $1.contact_id }.compactMap { identity in
            guard let conversation = perContact[identity.contact_id], !conversation.isEmpty else {
                return nil
            }
            return understand(contactID: identity.contact_id, messages: conversation)
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
                            messages: [MirrorDatabase.StoredMessage]) -> RelationshipUnderstanding {
        let ordered = messages.sorted {
            let lhs = $0.sentAt ?? .distantPast
            let rhs = $1.sentAt ?? .distantPast
            return lhs == rhs ? $0.guid < $1.guid : lhs < rhs
        }
        let userBodies = ordered.filter(\.isFromMe).compactMap(\.text)
        let outstanding = outstandingThread(in: ordered)
        let typicalGap = typicalGapDays(from: ordered)
        let total = ordered.count
        let userShare = Double(userBodies.count) / Double(max(total, 1))

        return RelationshipUnderstanding(
            contactID: contactID,
            register: Self.register(for: userBodies),
            relationshipKind: relationshipKind(total: total, typicalGapDays: typicalGap,
                                               userShare: userShare, topics: topics(in: ordered)),
            openThread: outstanding.description,
            lastExchangeShape: outstanding.shape,
            topics: topics(in: ordered),
            cadenceNorm: cadenceDescription(typicalGapDays: typicalGap)
        )
    }

    static func register(for userBodies: [String]) -> UnderstandingRegister {
        guard !userBodies.isEmpty else { return .terse }
        let averageLength = userBodies.map(\.count).reduce(0, +) / userBodies.count
        let warmSignals = userBodies.reduce(0) { count, text in
            count + (text.contains("❤️") || text.contains("love") || text.contains("miss") ? 1 : 0)
        }
        if warmSignals * 4 >= userBodies.count { return .warm }
        if averageLength <= 24 { return .terse }
        if averageLength >= 120 { return .formal }
        return .casual
    }

    private func relationshipKind(total: Int, typicalGapDays: Int,
                                  userShare: Double, topics: [String]) -> UnderstandingRelationshipKind {
        if typicalGapDays >= 30 && total >= 20 { return .dormantClose }
        if topics.contains("family") { return .family }
        if topics.contains("work") { return .work }
        if userShare < 0.2 || userShare > 0.8 { return .logistics }
        return .closeFriend
    }

    private func outstandingThread(
        in ordered: [MirrorDatabase.StoredMessage]
    ) -> (shape: UnderstandingLastExchangeShape, description: String?) {
        guard let last = ordered.last else { return (.none, nil) }
        guard !last.isFromMe else { return (.statementFromYou, nil) }

        // Any user-authored turn resolves everything before it. Only the trailing
        // inbound burst can still be outstanding, even if its final bubble is merely
        // "hello" after an earlier question.
        let trailingInbound = ordered.reversed().prefix { !$0.isFromMe }.reversed()
        let shapes = trailingInbound.map(Self.semanticShape)
        let questions = shapes.filter { $0 == .questionFromThem }.count
        let plans = shapes.filter { $0 == .planUnresolved }.count
        if questions > 1 { return (.questionFromThem, "asked more than once, unanswered") }
        if questions == 1 { return (.questionFromThem, "unanswered question from them") }
        if plans > 1 { return (.planUnresolved, "raised the plan more than once, unresolved") }
        if plans == 1 { return (.planUnresolved, "plan appears unresolved") }
        return (.statementFromThem, nil)
    }

    static func semanticShape(
        _ message: MirrorDatabase.StoredMessage
    ) -> UnderstandingLastExchangeShape {
        if message.isFromMe { return .statementFromYou }
        let text = message.text?.lowercased() ?? ""
        if looksLikeQuestion(text) { return .questionFromThem }
        if containsPlanMarker(text) { return .planUnresolved }
        return .statementFromThem
    }

    static func aggregateInboundShape(
        _ shapes: [UnderstandingLastExchangeShape]
    ) -> UnderstandingLastExchangeShape {
        if shapes.contains(.questionFromThem) { return .questionFromThem }
        if shapes.contains(.planUnresolved) { return .planUnresolved }
        return shapes.isEmpty ? .none : .statementFromThem
    }

    private static func looksLikeQuestion(_ text: String) -> Bool {
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

    private static func containsPlanMarker(_ text: String) -> Bool {
        let words = Set(lexicalWords(in: text))
        // Directional confirmations such as "I'm coming tonight" close uncertainty;
        // they do not create it. The stronger plan nouns/verbs are the bounded signal.
        return !words.isDisjoint(with: ["plan", "planned", "planning", "plans"])
    }

    private func topics(in messages: [MirrorDatabase.StoredMessage]) -> [String] {
        let words = Set(messages.compactMap(\.text).flatMap(Self.lexicalWords))
        let recognised = Self.topicMarkers.compactMap { candidate in
            candidate.markers.contains { words.contains($0) } ? candidate.token : nil
        }
        let bounded = recognised.filter { token in
            token.split(separator: " ").count <= Self.maximumTopicWords
                && token.count <= Self.maximumTopicCharacters
        }
        return Array(bounded.prefix(Self.maximumTopics))
    }

    private func typicalGapDays(from messages: [MirrorDatabase.StoredMessage]) -> Int {
        let dates = messages.compactMap(\.sentAt).sorted()
        guard dates.count > 1 else { return 0 }
        let gaps = zip(dates, dates.dropFirst()).map { Int($1.timeIntervalSince($0) / 86_400) }
            .sorted()
        return max(0, gaps[gaps.count / 2])
    }

    private func cadenceDescription(typicalGapDays: Int) -> String {
        switch typicalGapDays {
        case 0...1: return "recently active"
        case 2...6: return "usually active within a week"
        case 7...29: return "usually active within a month"
        default: return "long-running quiet period"
        }
    }
}
