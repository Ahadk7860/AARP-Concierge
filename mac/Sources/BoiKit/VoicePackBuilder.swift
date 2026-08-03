import CryptoKit
import Foundation

/// Extracts the user's voice from the mirror.
///
/// THE ONE PROPERTY THIS FILE EXISTS TO HOLD: **every exemplar comes from a row the user
/// wrote.** This is what lets drafting happen without breaking the digest boundary — the
/// voice we imitate is the user's, the content we must understand is somebody else's,
/// and those separate cleanly. One inbound message riding along here makes every privacy
/// claim in the architecture false, and nobody would notice for months.
///
/// **Corrected 2 Aug, CONTRACTS.md § 7: this is guard ONE, and it is the only guard that
/// can see provenance.** The upload boundary is a redaction scan over free text — four
/// regexes cannot tell a message the user wrote from one they received, and a redacted
/// inbound message passes it with a `202`. The leak checker is a verbatim string match,
/// so anything redaction rewrote no longer matches. Neither is a second opinion on
/// `is_from_me`. So guard one is a single point of failure and it carries the canary
/// alone. Do not weaken it on the theory that two more guards are behind it. There are
/// not two more.
///
/// **Corrected 3 Aug: guard one is `is_from_me = 1` AND NOT A TAPBACK.** `is_from_me`
/// alone does not keep the other person's words out — a tapback the user sent carries
/// `is_from_me = 1` and a body of `Loved "<their sentence>"`, which is inbound prose
/// verbatim inside a row the user genuinely wrote. Guard two finds no PII in it. Guard
/// three cannot match `Loved "…"` against the row it quotes. And until the generator was
/// fixed no fixture could produce the case, so the property was protected by one
/// unasserted line that nothing else could see. Both conditions are now in the SQL and
/// both are re-asserted here.
public struct VoicePackBuilder {

    // MARK: - Tunables, all stated

    /// Beyond this the model gets no better and the blast radius gets worse.
    public static let maximumExemplars = 40
    public static let maximumExemplarLength = 200
    /// Below this there is not enough of somebody's voice to imitate, and a pack built
    /// from four messages is a caricature. Those contacts fall back to the global pack.
    public static let minimumSentMessagesForContactPack = 5
    /// Consecutive sent messages closer together than this are one burst — the thing
    /// `avg_msgs_per_burst` counts, and the reason a single draft standing in for a
    /// burst is legitimately longer than one median message.
    public static let burstGapSeconds = 300.0
    /// Exemplars are sampled across this many contiguous time buckets, so a pack is not
    /// forty messages from one week in 2025.
    public static let exemplarTimeBuckets = 8

    public struct Options: Sendable {
        public var now: Date
        public var redactor: Redactor
        public init(now: Date = Date(), redactor: Redactor = Redactor()) {
            self.now = now
            self.redactor = redactor
        }
    }

    public enum Error: Swift.Error, CustomStringConvertible {
        /// The serializer's own re-assertion of guard one. Unreachable unless the SQL
        /// filter has been removed, which is exactly when it must not be silent.
        case inboundMessageInExemplars(count: Int)
        /// **The re-assertion that was missing.** Checking `isFromMe` alone let a tapback
        /// the user sent through, carrying the other person's sentence verbatim inside
        /// `Loved "…"`. CONTRACTS.md § 7, corrected 3 Aug.
        case tapbackInExemplars(count: Int)
        case unredactedSpecific(field: String)

        public var description: String {
            switch self {
            case .inboundMessageInExemplars(let count):
                return "\(count) exemplar(s) did not come from a row the user wrote. "
                    + "This is the failure that makes every privacy claim in the "
                    + "architecture false. Refusing to serialize."
            case .tapbackInExemplars(let count):
                return "\(count) row(s) are tapbacks the user sent. A tapback carries "
                    + "is_from_me = 1 and a body of Loved \"<their sentence>\" — the other "
                    + "person's words, verbatim, in a row the user wrote. Neither the "
                    + "upload boundary nor the leak checker can see it. Refusing to "
                    + "serialize."
            case .unredactedSpecific(let field):
                return "\(field) still contains something redaction should have removed. "
                    + "Refusing to serialize a pack that carries specifics."
            }
        }
    }

    private let options: Options

    public init(options: Options = Options()) { self.options = options }

    // MARK: - Building

    /// One pack per contact with enough sent messages, plus the global fallback.
    ///
    /// `identities` comes from the metric library, so a person merged across two handles
    /// gets one pack rather than two half-packs — the same merge-on-record-id rule, and
    /// it matters more here: two thin packs may both fall below the threshold and
    /// produce no pack at all for somebody the user texts constantly.
    public func build(mirror: MirrorDatabase,
                      identities: [ContactResolver.Identity]) throws -> [VoicePack] {
        var byHandle: [String: ContactResolver.Identity] = [:]
        for identity in identities {
            for handle in identity.handles { byHandle[handle] = identity }
        }

        var perContact: [String: [MirrorDatabase.StoredMessage]] = [:]
        var everything: [MirrorDatabase.StoredMessage] = []

        // GUARD ONE. The filter is in the SQL, not in a Swift predicate downstream of it,
        // so no later refactor can accidentally route around it.
        try mirror.forEachSentMessage { message in
            everything.append(message)
            guard let raw = message.chatIdentifier, !message.isGroup,
                  let identity = byHandle[ContactResolver.normalize(raw)] else { return }
            perContact[identity.contact_id, default: []].append(message)
        }

        var packs: [VoicePack] = []
        for identity in identities.sorted(by: { $0.contact_id < $1.contact_id }) {
            let messages = perContact[identity.contact_id] ?? []
            guard messages.count >= Self.minimumSentMessagesForContactPack else { continue }
            packs.append(try pack(from: messages, contactID: identity.contact_id,
                                  scope: "contact"))
        }
        // The global fallback always exists: a brand-new contact still needs a voice,
        // and "no pack" would mean the drafter writes in nobody's voice at all.
        packs.append(try pack(from: everything, contactID: nil, scope: "global"))
        return packs
    }

    func pack(from messages: [MirrorDatabase.StoredMessage],
              contactID: String?,
              scope: String) throws -> VoicePack {
        // GUARD ONE, RE-ASSERTED AT THE SERIALIZER — **BOTH HALVES OF IT**.
        //
        // The `isFromMe` half was here from the start. The tapback half was not, and its
        // absence was the hole: a tapback the user sent satisfies `isFromMe` and carries
        // `Loved "<their sentence>"`, so this assertion passed while the property it
        // exists to guarantee — no inbound prose in an exemplar — did not.
        //
        // Asserting rather than filtering is deliberate. Filtering here would make the
        // SQL clause redundant and therefore deletable; refusing means a mirror query
        // that lost its `WHERE` turns into a loud failure instead of a quiet leak.
        let inbound = messages.filter { !$0.isFromMe }.count
        guard inbound == 0 else { throw Error.inboundMessageInExemplars(count: inbound) }
        let tapbacks = messages.filter(\.isTapback).count
        guard tapbacks == 0 else { throw Error.tapbackInExemplars(count: tapbacks) }

        let bodies = messages
            .compactMap { $0.text }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        // REGISTER FIRST, FROM THE RAW TEXT. See Redactor's doc comment: computing it
        // after redaction reports a sentence-case writer as lowercase with a third of
        // their true greeting rate, and every register test still passes.
        let register = Self.register(for: bodies, messages: messages)

        // Redact, then dedup, then cap — in that order, and the order is the point.
        // Capping first fills the pack with forty copies of "ok that works for me" and
        // teaches the drafter nothing; deduping after redaction also collapses two
        // messages that differed only in the phone number now removed from both.
        var seen: Set<String> = []
        var kept: [(order: Int, text: String)] = []
        for candidate in Self.selectExemplars(from: messages) {
            guard kept.count < Self.maximumExemplars else { break }
            let redacted = options.redactor.redact(candidate.text)
            guard !redacted.isEmpty, redacted.count <= Self.maximumExemplarLength,
                  seen.insert(redacted).inserted else { continue }
            kept.append((candidate.order, redacted))
        }
        // Back into send order: a pack that reads chronologically is easier for a human
        // to check against their own memory, which is the only audit this ever gets.
        let final = kept.sorted { $0.order < $1.order }.map(\.text)

        // Redaction covers EVERY free-text field, not just exemplars. CONTRACTS.md § 7:
        // `apology_openers` holds verbatim message prefixes, so a pack whose exemplars
        // are spotless can still carry a phone number into storage through that array.
        var redactedRegister = register
        redactedRegister.apology_openers = register.apology_openers?
            .map(options.redactor.redact).filter { !$0.isEmpty }
        redactedRegister.abbreviations = register.abbreviations?
            .map(options.redactor.redact).filter { !$0.isEmpty }

        for exemplar in final where options.redactor.containsSpecifics(exemplar) {
            throw Error.unredactedSpecific(field: "exemplars")
        }
        for opener in redactedRegister.apology_openers ?? []
        where options.redactor.containsSpecifics(opener) {
            throw Error.unredactedSpecific(field: "register.apology_openers")
        }

        var pack = VoicePack(voice_pack_version: "",
                             contact_id: contactID,
                             scope: scope,
                             n_exemplars: final.count,
                             register: redactedRegister,
                             exemplars: final,
                             as_of: StructuredLog.timestamp(options.now))
        pack.voice_pack_version = Self.version(for: pack)
        return pack
    }

    // MARK: - Register

    static func register(for bodies: [String],
                         messages: [MirrorDatabase.StoredMessage]) -> Register {
        // The schema floors these at 1, and a pack built from nothing has no voice to
        // describe. `build` never reaches here with an empty set for a contact pack;
        // this keeps the global pack honest on a brand-new Mac.
        guard !bodies.isEmpty else {
            return Register(median_len_chars: 1, p90_len_chars: 1, emoji_rate: 0,
                            top_emoji: [], punctuation: .lowercaseNoPeriod,
                            greeting_rate: 0, signoff_rate: 0, abbreviations: [],
                            avg_msgs_per_burst: 1, question_rate: 0, apology_openers: [])
        }

        let lengths = bodies.map(\.count).sorted()
        func percentile(_ p: Int) -> Int {
            max(1, lengths[MetricLibrary.percentileIndex(count: lengths.count, percentile: p)])
        }

        var emojiCounts: [String: Int] = [:]
        var withEmoji = 0
        for body in bodies {
            var seen = false
            for scalar in body.unicodeScalars where scalar.properties.isEmojiPresentation
                || (scalar.properties.isEmoji && scalar.value > 0x238C) {
                emojiCounts[String(scalar), default: 0] += 1
                seen = true
            }
            if seen { withEmoji += 1 }
        }
        let topEmoji = emojiCounts.sorted {
            $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value
        }.prefix(5).map(\.key)

        var abbreviationCounts: [String: Int] = [:]
        var greetings = 0, signoffs = 0, questions = 0
        var openerCounts: [String: Int] = [:]
        for body in bodies {
            let lower = body.lowercased()
            let words = lower.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
                .map(String.init)
            for word in words where knownAbbreviations.contains(word) {
                abbreviationCounts[word, default: 0] += 1
            }
            if let first = words.first, greetingWords.contains(first) { greetings += 1 }
            if let last = words.last, signoffWords.contains(last) { signoffs += 1 }
            if body.contains("?") { questions += 1 }
            if let opener = apologyOpener(in: words) { openerCounts[opener, default: 0] += 1 }
        }

        let dates = messages.compactMap(\.sentAt).sorted()
        var bursts = dates.isEmpty ? 0 : 1
        for (offset, date) in dates.enumerated() where offset > 0 {
            if date.timeIntervalSince(dates[offset - 1]) > VoicePackBuilder.burstGapSeconds {
                bursts += 1
            }
        }

        func rate(_ count: Int) -> Double {
            (Double(count) / Double(bodies.count) * 10_000).rounded() / 10_000
        }

        return Register(
            median_len_chars: percentile(50),
            p90_len_chars: percentile(90),
            emoji_rate: rate(withEmoji),
            top_emoji: topEmoji,
            punctuation: punctuation(of: bodies),
            greeting_rate: rate(greetings),
            signoff_rate: rate(signoffs),
            abbreviations: abbreviationCounts.sorted {
                $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value
            }.prefix(20).map(\.key),
            avg_msgs_per_burst: bursts > 0
                ? max(1, (Double(dates.count) / Double(bursts) * 100).rounded() / 100)
                : 1,
            question_rate: rate(questions),
            apology_openers: openerCounts.sorted {
                $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value
            }.prefix(5).map(\.key)
        )
    }

    /// The mode, unless no style holds a clear majority — in which case the honest
    /// answer is `mixed` rather than whichever style won by two messages.
    static let punctuationMajority = 0.6

    static func punctuation(of bodies: [String]) -> Punctuation {
        var counts: [Punctuation: Int] = [:]
        for body in bodies {
            guard let first = body.first else { continue }
            let lowercaseStart = !first.isUppercase
            let period = body.hasSuffix(".")
            let style: Punctuation
            switch (lowercaseStart, period) {
            case (true, false): style = .lowercaseNoPeriod
            case (true, true): style = .lowercasePeriod
            case (false, false): style = .sentenceCaseNoPeriod
            case (false, true): style = .sentenceCasePeriod
            }
            counts[style, default: 0] += 1
        }
        let total = counts.values.reduce(0, +)
        guard total > 0, let top = counts.max(by: {
            $0.value == $1.value ? $0.key.rawValue > $1.key.rawValue : $0.value < $1.value
        }) else { return .lowercaseNoPeriod }
        return Double(top.value) / Double(total) >= punctuationMajority ? top.key : .mixed
    }

    /// The first three words of a message that opens with an apology. Three because the
    /// tell is `"sorry been mia"`, not `"sorry"` — the shape of the apology is the part
    /// that sounds like the user.
    static func apologyOpener(in words: [String]) -> String? {
        guard let first = words.first else { return nil }
        let isApology = apologyWords.contains(first)
            || (words.count > 1 && apologyWords.contains(words[1])
                && interjections.contains(first))
        guard isApology else { return nil }
        return words.prefix(3).joined(separator: " ")
    }

    static let apologyWords: Set<String> = ["sorry", "sry", "apologies", "oops", "whoops"]
    static let interjections: Set<String> = ["omg", "ah", "ugh", "oh", "ok", "okay"]
    static let greetingWords: Set<String> = ["hi", "hey", "heyy", "heyyy", "hello", "yo",
                                             "morning", "gm", "sup", "hiya", "howdy"]
    static let signoffWords: Set<String> = ["thanks", "ty", "thx", "bye", "later", "cya",
                                            "night", "goodnight", "xo", "love"]
    static let knownAbbreviations: Set<String> = [
        "lmk", "rn", "ngl", "tmrw", "prob", "u", "ur", "im", "idk", "tbh", "omw", "brb",
        "lol", "lmao", "smh", "ttyl", "nvm", "btw", "fr", "ily", "wyd", "hbu", "ikr",
        "afaik", "imo", "asap", "pls", "plz", "thx", "abt", "rly", "def", "obv",
    ]

    // MARK: - Exemplars

    /// Candidate exemplars in **priority order**, sampled across the time range and
    /// across message lengths, deterministically.
    ///
    /// No model, by design. Forty messages from one week in 2025 describe who somebody
    /// was during one week; forty of their shortest describe somebody who only says
    /// "ok". Bucketing by time and then spreading by length inside each bucket gets both
    /// axes without ranking anything.
    ///
    /// Returns *every* candidate, not forty, because the caller redacts and dedups
    /// before capping and needs somewhere to draw replacements from. `order` is the
    /// message's position in send order, so the caller can restore chronology after.
    static func selectExemplars(
        from messages: [MirrorDatabase.StoredMessage]
    ) -> [(order: Int, text: String)] {
        let candidates = messages
            // A STATISTICS FILTER, AND NOTHING MORE. Say so out loud: this same line used
            // to be the only thing keeping a user-sent tapback's `Loved "<their
            // sentence>"` out of an exemplar, and its privacy role was incidental and
            // undocumented — so a cleanup done for statistical reasons would have removed
            // the last real protection without anyone noticing. The privacy guard now
            // lives in the SQL (`forEachSentMessage`) and in the serializer's assertion,
            // both of which run before this. Deleting this line costs accuracy in the
            // length and burst statistics; it no longer costs anybody their privacy.
            .filter { !$0.isTapback }
            .compactMap { message -> (Date, String, String)? in
                guard let text = message.text?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !text.isEmpty, text.count <= maximumExemplarLength,
                      let sentAt = message.sentAt else { return nil }
                return (sentAt, message.guid, text)
            }
            .sorted { $0.0 == $1.0 ? $0.1 < $1.1 : $0.0 < $1.0 }

        guard !candidates.isEmpty else { return [] }

        let bucketCount = min(exemplarTimeBuckets, candidates.count)
        let perBucket = Int((Double(maximumExemplars) / Double(bucketCount)).rounded(.up))
        var picked: [(Int, String)] = []
        var takenIndices: Set<Int> = []

        for bucket in 0..<bucketCount {
            let start = candidates.count * bucket / bucketCount
            let end = candidates.count * (bucket + 1) / bucketCount
            guard start < end else { continue }
            // Inside the bucket, order by length so the picks below spread across short
            // and long rather than clustering on whatever came first.
            let byLength = (start..<end).sorted {
                candidates[$0].2.count == candidates[$1].2.count
                    ? candidates[$0].1 < candidates[$1].1
                    : candidates[$0].2.count < candidates[$1].2.count
            }
            let take = min(perBucket, byLength.count)
            for step in 0..<take {
                let index = byLength[step * (byLength.count - 1) / max(take - 1, 1)]
                guard takenIndices.insert(index).inserted else { continue }
                picked.append((index, candidates[index].2))
            }
        }

        // Everything else, in send order, as the reservoir the caller draws from when
        // redaction empties a pick or dedup collapses two.
        for index in candidates.indices {
            guard takenIndices.insert(index).inserted else { continue }
            picked.append((index, candidates[index].2))
        }
        return picked.map { (order: $0.0, text: $0.1) }
    }

    // MARK: - Version

    /// `"vp_" + sha256(canonical_json)[:8]` over `{contact_id, scope, register,
    /// exemplars}` — CONTRACTS.md § 6, `as_of` deliberately excluded so a pack whose
    /// contents did not change does not invalidate the drafter's prompt cache every
    /// morning.
    ///
    /// Sorted keys, no whitespace, non-ASCII left unescaped. Emoji in `top_emoji` are
    /// why that last one is stated rather than assumed.
    public static func version(for pack: VoicePack) -> String {
        let canonical = CanonicalJSON.string(payload(for: pack))
        let digest = SHA256.hash(data: Data(canonical.utf8))
        return "vp_" + String(digest.map { String(format: "%02x", $0) }.joined().prefix(8))
    }

    static func payload(for pack: VoicePack) -> CanonicalJSON.Value {
        .object([
            "contact_id": pack.contact_id.map(CanonicalJSON.Value.string) ?? .null,
            "scope": .string(pack.scope),
            "register": .object([
                "median_len_chars": .int(pack.register.median_len_chars),
                "p90_len_chars": pack.register.p90_len_chars.map(CanonicalJSON.Value.int) ?? .null,
                "emoji_rate": .double(pack.register.emoji_rate),
                "top_emoji": .array((pack.register.top_emoji ?? []).map(CanonicalJSON.Value.string)),
                "punctuation": .string(pack.register.punctuation.rawValue),
                "greeting_rate": pack.register.greeting_rate.map(CanonicalJSON.Value.double) ?? .null,
                "signoff_rate": pack.register.signoff_rate.map(CanonicalJSON.Value.double) ?? .null,
                "abbreviations": .array((pack.register.abbreviations ?? []).map(CanonicalJSON.Value.string)),
                "avg_msgs_per_burst": .double(pack.register.avg_msgs_per_burst),
                "question_rate": pack.register.question_rate.map(CanonicalJSON.Value.double) ?? .null,
                "apology_openers": .array((pack.register.apology_openers ?? []).map(CanonicalJSON.Value.string)),
            ]),
            "exemplars": .array(pack.exemplars.map(CanonicalJSON.Value.string)),
        ])
    }

    // MARK: - Writing

    /// `voice_pack_<contact_id>.json`, or `global_fallback.json` for the fallback.
    public static func fileName(for pack: VoicePack) -> String {
        pack.contact_id.map { "voice_pack_\($0).json" } ?? "global_fallback.json"
    }

    @discardableResult
    public static func write(_ pack: VoicePack, toDirectory directory: String) throws -> String {
        let url = URL(fileURLWithPath: directory).appendingPathComponent(fileName(for: pack))
        try FileManager.default.createDirectory(at: URL(fileURLWithPath: directory),
                                                withIntermediateDirectories: true)
        // `contact_id` is in the schema's `required` list AND permitted to be null —
        // that is how the global fallback is spelled. An omitted key fails validation.
        let data = try ExplicitNullJSON.data(encoding: pack) { object in
            ExplicitNullJSON.fillNull(&object, ["contact_id"])
        }
        try data.write(to: url, options: .atomic)
        return url.path
    }
}

/// JSON serialized the way Python's `json.dumps(sort_keys=True, separators=(",", ":"),
/// ensure_ascii=False)` serializes it.
///
/// Hand-rolled rather than `JSONSerialization` because the version hash has to be
/// **byte-identical** to Track B's, and the two places Foundation and Python diverge are
/// both in this file's control: `JSONSerialization` renders the Double `1.0` as `1`
/// where Python renders `1.0`, and it escapes forward slashes. A one-character
/// difference in the canonical string is a completely different `voice_pack_version` and
/// a `--compare` diff nobody can explain.
public enum CanonicalJSON {

    public indirect enum Value: Sendable {
        case null
        case bool(Bool)
        case int(Int)
        case double(Double)
        case string(String)
        case array([Value])
        case object([String: Value])
    }

    public static func string(_ value: Value) -> String {
        switch value {
        case .null: return "null"
        case .bool(let flag): return flag ? "true" : "false"
        case .int(let number): return String(number)
        // Swift and Python both print the shortest representation that round-trips, and
        // both keep the trailing `.0` on a whole number.
        case .double(let number): return "\(number)"
        case .string(let text): return quote(text)
        case .array(let values): return "[" + values.map(string).joined(separator: ",") + "]"
        case .object(let fields):
            let body = fields.keys.sorted()
                .map { quote($0) + ":" + string(fields[$0]!) }
                .joined(separator: ",")
            return "{" + body + "}"
        }
    }

    /// Escapes exactly what Python escapes with `ensure_ascii=False`: quotes,
    /// backslashes and the C0 control characters. Not slashes, and not anything
    /// non-ASCII — emoji go through as themselves.
    static func quote(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }
}
