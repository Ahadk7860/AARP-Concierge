import CryptoKit
import Foundation

/// One contextual voice exemplar awaiting the frozen `voice_pack.v2` Swift mirror.
///
/// `text` is exclusively a redacted, non-tapback row written by the user. `answered`
/// is a closed enum inferred from the immediately preceding local turn; it is never a
/// description copied from that turn. This internal DTO is intentionally not Codable:
/// no Phase 2 contract is created or changed by this prompt.
struct ContextualVoiceExemplar: Sendable, Equatable {
    let text: String
    let answered: UnderstandingLastExchangeShape
    let register: UnderstandingRegister
}

struct ContextualVoiceExemplarSet: Sendable, Equatable {
    let exemplars: [ContextualVoiceExemplar]
    /// Changes when either a selected user-authored message or its answer context
    /// changes. It is an opaque cache key, not an input-derived text field.
    let contentHash: String
}

/// Builds contextual exemplars from a relationship's local turn ordering.
///
/// It intentionally does not call `VoicePackBuilder`: that builder and its v1 wire DTO
/// are frozen until the foundation amendment introduces `voice_pack.v2`.
struct ContextualVoiceExemplarBuilder {
    static let maximumExemplars = 40
    static let maximumExemplarLength = 200

    private let redactor: Redactor

    init(redactor: Redactor = Redactor()) { self.redactor = redactor }

    func build(messages: [MirrorDatabase.StoredMessage]) -> ContextualVoiceExemplarSet {
        let ordered = messages
            .filter { !$0.isTapback && !$0.isGroup }
            .sorted {
                let lhs = $0.sentAt ?? .distantPast
                let rhs = $1.sentAt ?? .distantPast
                return lhs == rhs ? $0.guid < $1.guid : lhs < rhs
            }

        var seen: Set<String> = []
        var output: [ContextualVoiceExemplar] = []
        for (index, message) in ordered.enumerated() where message.isFromMe {
            guard output.count < Self.maximumExemplars,
                  let source = message.text?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !source.isEmpty else { continue }

            let text = redactor.redact(source)
            guard !text.isEmpty, text.count <= Self.maximumExemplarLength,
                  !redactor.containsSpecifics(text), seen.insert(text).inserted else { continue }

            let answered = index == 0 ? .none : shape(of: ordered[index - 1])
            output.append(ContextualVoiceExemplar(
                text: text,
                answered: answered,
                register: UnderstandingBuilder.register(for: [source])
            ))
        }
        return ContextualVoiceExemplarSet(exemplars: output, contentHash: Self.contentHash(for: output))
    }

    static func contentHash(for exemplars: [ContextualVoiceExemplar]) -> String {
        let canonical = exemplars.map {
            "\($0.text.utf8.count):\($0.text)|\($0.answered.rawValue)|\($0.register.rawValue)"
        }.joined(separator: "\n")
        let digest = SHA256.hash(data: Data(canonical.utf8))
        return "cve_" + digest.map { String(format: "%02x", $0) }.joined().prefix(16)
    }

    private func shape(of preceding: MirrorDatabase.StoredMessage) -> UnderstandingLastExchangeShape {
        let text = preceding.text?.lowercased() ?? ""
        if !preceding.isFromMe && text.contains("?") { return .questionFromThem }
        let words = Set(text.split(whereSeparator: { !$0.isLetter }).map(String.init))
        if !preceding.isFromMe
            && !words.isDisjoint(with: ["plan", "coming", "tonight", "weekend"]) {
            return .planUnresolved
        }
        if preceding.isFromMe { return .statementFromYou }
        return .statementFromThem
    }
}
