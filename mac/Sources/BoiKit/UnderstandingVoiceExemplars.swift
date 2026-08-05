import CryptoKit
import Foundation

/// One contextual voice exemplar awaiting the frozen `voice_pack.v2` Swift mirror.
/// Only its first three fields cross the wire. Source identity and time exist solely so
/// the local selector can preserve diversity without losing answer context.
struct ContextualVoiceExemplar: Sendable, Equatable {
    let text: String
    let answered: UnderstandingLastExchangeShape
    let register: UnderstandingRegister
    let sourceDate: Date
    let sourceGUID: String
    let sourceConversation: String
}

struct ContextualVoiceExemplarSet: Sendable, Equatable {
    let exemplars: [ContextualVoiceExemplar]
    let contentHash: String
}

struct ContextualVoiceExemplarBuilder {
    static let maximumExemplars = 40
    static let maximumExemplarLength = 200
    static let timeBuckets = 8
    /// Consecutive user bubbles inside five minutes are one reply turn. A direction
    /// transition always starts a new turn regardless of clock distance.
    static let replyBurstGapSeconds = 300.0

    private let redactor: Redactor

    init(redactor: Redactor = Redactor()) { self.redactor = redactor }

    func build(messages: [MirrorDatabase.StoredMessage],
               sourceConversation: String = "") -> ContextualVoiceExemplarSet {
        let selected = Self.select(
            candidates(messages: messages, sourceConversation: sourceConversation),
            maximum: Self.maximumExemplars)
        return ContextualVoiceExemplarSet(
            exemplars: selected,
            contentHash: Self.contentHash(for: selected))
    }

    /// Produces every safe candidate before time/source selection. Counterpart prose is
    /// consumed only by `semanticShape`; it has no path into the returned value.
    func candidates(messages: [MirrorDatabase.StoredMessage],
                    sourceConversation: String) -> [ContextualVoiceExemplar] {
        let ordered = messages
            .filter { !$0.isTapback && !$0.isGroup }
            .sorted(by: Self.messageOrder)

        var inboundTurnShapes: [UnderstandingLastExchangeShape] = []
        var replyContext: UnderstandingLastExchangeShape = .none
        var previous: MirrorDatabase.StoredMessage?
        var output: [ContextualVoiceExemplar] = []

        for message in ordered {
            if !message.isFromMe {
                if previous?.isFromMe != false { inboundTurnShapes.removeAll(keepingCapacity: true) }
                inboundTurnShapes.append(UnderstandingBuilder.semanticShape(message))
                replyContext = .none
                previous = message
                continue
            }

            if previous?.isFromMe == false {
                replyContext = UnderstandingBuilder.aggregateInboundShape(inboundTurnShapes)
            } else if previous?.isFromMe == true && !Self.sameBurst(previous!, message) {
                replyContext = .none
            }

            defer { previous = message }
            guard let source = message.text?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !source.isEmpty, let sentAt = message.sentAt else { continue }
            let text = redactor.redact(source)
            guard !text.isEmpty, text.count <= Self.maximumExemplarLength,
                  !redactor.containsSpecifics(text) else { continue }
            output.append(ContextualVoiceExemplar(
                text: text,
                answered: replyContext,
                register: UnderstandingBuilder.register(for: [source]),
                sourceDate: sentAt,
                sourceGUID: message.guid,
                sourceConversation: sourceConversation
            ))
        }
        return output
    }

    /// Time-bucket priority adapted from v1, followed by a per-conversation soft quota.
    /// The second pass fills spare capacity, so thin conversations do not leave holes.
    static func select(_ candidates: [ContextualVoiceExemplar],
                       maximum: Int) -> [ContextualVoiceExemplar] {
        guard maximum > 0, !candidates.isEmpty else { return [] }
        let ordered = candidates.sorted(by: exemplarOrder)
        let bucketCount = min(timeBuckets, ordered.count)
        let perBucket = Int((Double(maximum) / Double(bucketCount)).rounded(.up))
        var priority: [ContextualVoiceExemplar] = []
        var used: Set<String> = []

        for bucket in 0..<bucketCount {
            let start = ordered.count * bucket / bucketCount
            let end = ordered.count * (bucket + 1) / bucketCount
            let byLength = Array(ordered[start..<end]).sorted {
                $0.text.count == $1.text.count
                    ? exemplarOrder($0, $1) : $0.text.count < $1.text.count
            }
            let take = min(perBucket, byLength.count)
            for step in 0..<take {
                let item = byLength[step * (byLength.count - 1) / max(take - 1, 1)]
                if used.insert(item.sourceGUID).inserted { priority.append(item) }
            }
        }
        for item in ordered where used.insert(item.sourceGUID).inserted { priority.append(item) }

        let sources = Set(priority.map(\.sourceConversation).filter { !$0.isEmpty })
        let quota = sources.isEmpty ? maximum : Int(ceil(Double(maximum) / Double(sources.count)))
        var counts: [String: Int] = [:]
        var seenText: Set<String> = []
        var selected: [ContextualVoiceExemplar] = []

        func append(_ item: ContextualVoiceExemplar, enforcingQuota: Bool) {
            guard selected.count < maximum, seenText.insert(item.text).inserted else { return }
            let key = item.sourceConversation
            if enforcingQuota, !key.isEmpty, counts[key, default: 0] >= quota {
                seenText.remove(item.text)
                return
            }
            selected.append(item)
            counts[key, default: 0] += 1
        }
        for item in priority { append(item, enforcingQuota: true) }
        if selected.count < maximum {
            for item in priority { append(item, enforcingQuota: false) }
        }
        return selected.sorted(by: exemplarOrder)
    }

    static func contentHash(for exemplars: [ContextualVoiceExemplar]) -> String {
        let canonical = exemplars.map {
            "\($0.text.utf8.count):\($0.text)|\($0.answered.rawValue)|\($0.register.rawValue)"
        }.joined(separator: "\n")
        let digest = SHA256.hash(data: Data(canonical.utf8))
        return "cve_" + digest.map { String(format: "%02x", $0) }.joined().prefix(16)
    }

    private static func sameBurst(_ lhs: MirrorDatabase.StoredMessage,
                                  _ rhs: MirrorDatabase.StoredMessage) -> Bool {
        guard lhs.isFromMe == rhs.isFromMe,
              let first = lhs.sentAt, let second = rhs.sentAt else { return false }
        return second.timeIntervalSince(first) >= 0
            && second.timeIntervalSince(first) <= replyBurstGapSeconds
    }

    private static func messageOrder(_ lhs: MirrorDatabase.StoredMessage,
                                     _ rhs: MirrorDatabase.StoredMessage) -> Bool {
        let left = lhs.sentAt ?? .distantPast
        let right = rhs.sentAt ?? .distantPast
        return left == right ? lhs.guid < rhs.guid : left < right
    }

    private static func exemplarOrder(_ lhs: ContextualVoiceExemplar,
                                      _ rhs: ContextualVoiceExemplar) -> Bool {
        lhs.sourceDate == rhs.sourceDate
            ? lhs.sourceGUID < rhs.sourceGUID : lhs.sourceDate < rhs.sourceDate
    }
}
