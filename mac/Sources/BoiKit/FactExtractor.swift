import Foundation

/// The fabrication-gate allowlist, extracted on the Mac.
///
/// **A port of `intelligence/boi_intel/facts.py`, and the only new work AMENDMENT-001
/// asks for.** It is written to be *diffed against* that file rather than merely to
/// behave like it: same pattern order, same nesting in the scan loop, same dedupe rules,
/// same names where Swift allows them. Two implementations that must agree
/// token-for-token stay agreeing only if a reader can put them side by side.
///
/// Why it exists at all: `gist.sql_gist_text` and `gist.deadline_for` read this
/// allowlist, and the drafter's fabrication gate rejects any specific a draft names that
/// is not in it. Only the Mac has the messages, so only the Mac can build it — and
/// `recent_inbound_text`, the other person's prose, must never leave.
///
/// The rules that are load-bearing, each of which has already cost somebody once:
///
/// - **Case sensitivity is signal.** The place and capitalised-name patterns run
///   case-*sensitively* on purpose. Under `.caseInsensitive` the name pattern degrades
///   into "any two to four words" and starts harvesting whole sentences.
/// - **Scan each message separately, never a joined blob.** A pattern that runs across
///   the seam between two messages emits a splice of two people's sentences as one
///   "fact". `[^\S\n]` — whitespace that is not a newline — is the same guard inside a
///   single message.
/// - **Maximal, then dropped whole.** The place pattern is deliberately unbounded and
///   `isAToken` then rejects anything over three words rather than keeping a prefix.
///   Bounding the pattern instead slices `Jenny And Marks Wedding Reception` into two
///   plausible three-word spans and emits both — still the other person's prose, now
///   wearing the shape of a legitimate fact.
public enum FactExtractor {

    // MARK: - Patterns, in `facts.py` order

    /// `(pattern, caseSensitive)`. The flag is spelled out at every site because it is
    /// the single most consequential thing on the line.
    typealias Rule = (pattern: String, caseSensitive: Bool)

    static let monthsAlternation = FactVocabulary.months.joined(separator: "|")
    static let weekdaysAlternation = FactVocabulary.weekdays.joined(separator: "|")
    static let relativeDaysAlternation = FactVocabulary.relativeDays.joined(separator: "|")

    static var datePatterns: [Rule] {
        [
            // "the 14th", "the 3rd"
            (#"\bthe[^\S\n]+\d{1,2}(?:st|nd|rd|th)\b"#, false),
            // bare ordinal day: "14th"
            (#"\b\d{1,2}(?:st|nd|rd|th)\b"#, false),
            // "aug 3", "August 3rd", "3 aug"
            (#"\b(?:\#(monthsAlternation))\.?[^\S\n]+\d{1,2}(?:st|nd|rd|th)?\b"#, false),
            (#"\b\d{1,2}[^\S\n]+(?:\#(monthsAlternation))\.?\b"#, false),
            // 8/14, 8-14-2026
            (#"\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b"#, false),
            // weekdays, with an optional qualifier
            (#"\b(?:next[^\S\n]+|this[^\S\n]+|last[^\S\n]+)?(?:\#(weekdaysAlternation))\b"#, false),
            (#"\b(?:\#(relativeDaysAlternation))\b"#, false),
        ]
    }

    static let timePatterns: [Rule] = [
        (#"\b\d{1,2}:\d{2}[^\S\n]*(?:am|pm)?\b"#, false),
        (#"\b\d{1,2}[^\S\n]*(?:am|pm)\b"#, false),
        (#"\b(?:noon|midnight)\b"#, false),
        // Capture the clock reading only: "at 3pm" is anchored on "at", but the fact the
        // drafter may name is "3pm".
        (#"\bat[^\S\n]+(\d{1,2}(?:[^\S\n]*(?:am|pm))?)\b"#, false),
    ]

    static let amountPatterns: [Rule] = [
        (#"[$£€][^\S\n]?\d[\d,]*(?:\.\d{1,2})?"#, false),
        (#"\b\d[\d,]*(?:\.\d{1,2})?[^\S\n]?(?:dollars?|bucks|usd|euros?|quid)\b"#, false),
    ]

    /// A place is anchored on a preposition, because an unanchored capitalised word is
    /// more often a brand, a product, or a sentence opener than somewhere you can go.
    static let placePatterns: [Rule] = [
        (#"\b(?:at|in|to|near|by)[^\S\n]+(?:the[^\S\n]+)?([A-Z][\w'&-]+(?:[^\S\n]+[A-Z][\w'&-]+)*)\b"#, true),
        (#"\b(?:at|in|to)[^\S\n]+(the[^\S\n]+(?:office|airport|station|gym|park|bar|restaurant|hotel|library|museum|beach|house|apartment|hospital|studio|cafe|coffee[^\S\n]+shop))\b"#, false),
        (#"\b((?:your|my|their|his|her)[^\S\n]+(?:place|house|apartment|office))\b"#, false),
    ]

    /// Capitalised full name. **Case-sensitive on purpose** — see the type doc.
    static let namePatterns: [Rule] = [
        (#"\b[A-Z][a-z]{1,20}(?:[^\S\n]+[A-Z][a-z]{1,20})+\b"#, true),
    ]

    // MARK: - What the extractor is allowed to read

    /// How much inbound history the extractor may look at. `threads.py`'s
    /// `RECENT_INBOUND_LIMIT`.
    public static let recentInboundLimit = 25
    /// The fallback window when the user spoke last. `threads.py:_pending_inbound`.
    public static let noPendingFallbackLimit = 10

    /// `threads.py:_pending_inbound` — the inbound run since the user last wrote.
    ///
    /// **This is the scope of "what you owe", so it is the right scope for facts.**
    /// Reading the whole inbound history instead would sweep up a date somebody
    /// mentioned a year ago and present it as a live deadline, which is a fabricated
    /// commitment sent in the user's own name.
    ///
    /// If the user spoke last there is no pending run, so it falls back to a short
    /// recent window — a fading or dormant thread still needs something to draft from.
    static func pendingInbound(_ ordered: [MirrorDatabase.StoredMessage]) -> [String] {
        var pending: [String] = []
        for message in ordered.reversed() {
            if message.isFromMe { break }
            if let text = message.text, !text.isEmpty { pending.append(text) }
        }
        if !pending.isEmpty { return Array(pending.prefix(recentInboundLimit)) }
        return Array(ordered.reversed()
            .filter { !$0.isFromMe }
            .compactMap { $0.text }
            .filter { !$0.isEmpty }
            .prefix(noPendingFallbackLimit))
    }

    /// `threads.py:QUESTION_WORDS`. Interrogative openers, because a corpus of real
    /// texting is full of "wondering if youre around" and requiring `?` would
    /// under-count exactly the messages that need a reply.
    static let questionWords = [
        "who", "what", "when", "where", "why", "how", "which", "are you", "did you",
        "do you", "can you", "could you", "would you", "will you", "are we", "should we",
        "you free", "you around", "you still", "any chance", "let me know",
    ]

    /// `threads.py:_looks_like_a_question`.
    static func looksLikeAQuestion(_ text: String) -> Bool {
        let low = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if low.isEmpty { return false }
        if low.contains("?") { return true }
        return questionWords.contains { low.hasPrefix($0) || low.contains(" \($0)") }
    }

    /// **The PENDING question, which is not the same as a historical one.**
    ///
    /// `threads.py`: `unanswered = last.is_from_me == 0 and _looks_like_a_question(last.text)`
    /// — the *final* message, from them, wanting an answer.
    ///
    /// `Metrics.unansweredQuestions` counts something different and reasonable: every
    /// question either party ever asked that got no reply inside a window. Mapping the
    /// digest field to that was wrong, and the Swift↔Python agreement test caught it on
    /// its first run. The two disagree on any thread where they asked something months
    /// ago, the user never answered *that*, and the conversation moved on — historical
    /// says yes, pending says no, and `sql_gist_text` would then render "they asked you a
    /// question 3 days ago and you have not replied" about a question from March.
    ///
    /// NULL-text rows cannot be inspected, so a thread ending in one is not claimed to
    /// hold a question. Degrade, never fabricate.
    static func hasPendingQuestion(_ ordered: [MirrorDatabase.StoredMessage]) -> Bool {
        guard let last = ordered.last else { return false }
        return !last.isFromMe && looksLikeAQuestion(last.text ?? "")
    }

    /// The allowlist for every ranked contact, read from the mirror.
    ///
    /// Tapbacks are excluded for the same reason the voice pack excludes them: a
    /// tapback body is `Loved "<their sentence>"`, so extracting facts from one harvests
    /// the quoted prose it wraps.
    /// What one mirror pass yields per contact: the allowlist, and whether the thread
    /// ends on a question they are waiting on.
    public struct ThreadSignals: Sendable, Equatable {
        public var facts: Facts
        public var pendingQuestion: Bool

        public init(facts: Facts = .empty, pendingQuestion: Bool = false) {
            self.facts = facts
            self.pendingQuestion = pendingQuestion
        }

        public static let empty = ThreadSignals()
    }

    public static func factsByContact(
        mirror: MirrorDatabase,
        identities: [ContactResolver.Identity]
    ) throws -> [String: Facts] {
        try signalsByContact(mirror: mirror, identities: identities)
            .mapValues { $0.facts }
    }

    /// One pass over the mirror for both signals — the corpus is large and reading it
    /// twice to answer two questions about the same messages is a waste.
    public static func signalsByContact(
        mirror: MirrorDatabase,
        identities: [ContactResolver.Identity]
    ) throws -> [String: ThreadSignals] {
        var handleToContact: [String: String] = [:]
        for identity in identities {
            for handle in identity.handles {
                handleToContact[ContactResolver.normalize(handle)] = identity.contact_id
            }
        }

        var byContact: [String: [MirrorDatabase.StoredMessage]] = [:]
        try mirror.forEachMessage { message in
            guard !message.isTapback, message.chatStyle != 43 else { return }
            guard let handle = message.handle,
                  let contact = handleToContact[ContactResolver.normalize(handle)] else { return }
            byContact[contact, default: []].append(message)
        }

        var signals: [String: ThreadSignals] = [:]
        for (contact, messages) in byContact {
            let ordered = messages.sorted {
                ($0.sentAt ?? .distantPast) < ($1.sentAt ?? .distantPast)
            }
            signals[contact] = ThreadSignals(
                facts: FactExtractor.extract(from: pendingInbound(ordered)),
                pendingQuestion: hasPendingQuestion(ordered))
        }
        return signals
    }

    // MARK: - The scan

    /// `facts.py:_findall`. Each message separately; each pattern in order; a capturing
    /// group means the pattern anchored on context it must not keep.
    static func findAll(_ rules: [Rule], in messages: [String]) -> [String] {
        var out: [String] = []
        for message in messages where !message.isEmpty {
            for rule in rules {
                guard let regex = compiled(rule) else { continue }
                let range = NSRange(message.startIndex..., in: message)
                regex.enumerateMatches(in: message, range: range) { match, _, _ in
                    guard let match else { return }
                    // Group 1 when the pattern has one, else the whole match.
                    let wanted = match.numberOfRanges > 1 ? 1 : 0
                    guard let r = Range(match.range(at: wanted), in: message) else { return }
                    let value = String(message[r])
                        .trimmingCharacters(in: .whitespaces)
                        .trimmingCharacters(in: CharacterSet(charactersIn: ".,;:!?"))
                    if isAToken(value) { out.append(value) }
                }
            }
        }
        return out
    }

    static func isAToken(_ value: String) -> Bool {
        !value.isEmpty
            && !value.contains("\n")
            && value.split(separator: " ", omittingEmptySubsequences: true).count
                <= FactVocabulary.maxFactWords
    }

    /// `facts.py:_dedupe_preserving_order`. Case-insensitive dedupe, capped, with
    /// redundant substrings suppressed.
    ///
    /// Substring suppression matters more than it looks: `"the 14th"` and `"14th"` are
    /// one date wearing two hats, and keeping both spends two of the eight slots on one
    /// fact while making the gate look broader than it is.
    static func dedupePreservingOrder(_ values: [String], limit: Int, maxLength: Int) -> [String] {
        var kept: [String] = []
        var seen: Set<String> = []
        for raw in values {
            let v = raw.trimmingCharacters(in: .whitespaces)
            if v.isEmpty || v.count > maxLength { continue }
            let key = v.lowercased()
            if !seen.contains(key) {
                seen.insert(key)
                kept.append(v)
            }
        }

        // Longest first, so the specific spelling is the one that survives.
        let bySpecificity = kept.sorted {
            $0.count != $1.count ? $0.count > $1.count : $0.lowercased() < $1.lowercased()
        }
        var survivors: [String] = []
        for v in bySpecificity {
            let low = v.lowercased()
            if survivors.contains(where: { low != $0.lowercased() && $0.lowercased().contains(low) }) {
                continue
            }
            survivors.append(v)
        }

        let survivorSet = Set(survivors)
        return Array(kept.filter { survivorSet.contains($0) }.prefix(limit))
    }

    /// `facts.py:_lowercase_names`. The target corpus is lowercase texting, so a
    /// capitalised-only rule finds nothing — the same blind spot the voice pack had.
    static func lowercaseNames(in messages: [String]) -> [String] {
        guard let regex = try? NSRegularExpression(
            pattern: #"\b([a-z][a-z'-]{1,20})[^\S\n]+([a-z][a-z'-]{1,20})\b"#) else { return [] }
        var out: [String] = []
        for message in messages where !message.isEmpty {
            let range = NSRange(message.startIndex..., in: message)
            regex.enumerateMatches(in: message, range: range) { match, _, _ in
                guard let match,
                      let whole = Range(match.range(at: 0), in: message),
                      let firstRange = Range(match.range(at: 1), in: message),
                      let secondRange = Range(match.range(at: 2), in: message) else { return }
                let first = String(message[firstRange])
                let second = String(message[secondRange])
                if FactVocabulary.commonGivenNames.contains(first),
                   !FactVocabulary.notASurname.contains(second) {
                    out.append(String(message[whole]))
                }
            }
        }
        return out
    }

    // MARK: - The allowlist

    /// `facts.py:extract_facts`. Always returns all five keys.
    public static func extract(from messages: [String]) -> Facts {
        let messages = messages.filter { !$0.isEmpty }

        let dates = findAll(datePatterns, in: messages)
            .filter { !FactVocabulary.dateStopwords.contains($0.lowercased()) }
        let times = findAll(timePatterns, in: messages)
        let places = findAll(placePatterns, in: messages)
        let amounts = findAll(amountPatterns, in: messages)
        var names = findAll(namePatterns, in: messages) + lowercaseNames(in: messages)

        let cap = FactVocabulary.maxPerCategory
        let chars = FactVocabulary.maxFactChars
        let resolvedPlaces = dedupePreservingOrder(places, limit: cap, maxLength: chars)

        // A capitalised venue matches the full-name pattern too. Listing "Ferry Building"
        // as both a place and a person is not harmful — the allowlist permits the string
        // either way — but it spends two slots on one referent and misreports what the
        // gate actually covers.
        let placeKeys = Set(resolvedPlaces.map { $0.lowercased() })
        names = names.filter { !placeKeys.contains($0.lowercased()) }

        return Facts(
            dates: dedupePreservingOrder(dates, limit: cap, maxLength: chars),
            times: dedupePreservingOrder(times, limit: cap, maxLength: chars),
            places: resolvedPlaces,
            amounts: dedupePreservingOrder(amounts, limit: cap, maxLength: chars),
            names: dedupePreservingOrder(names, limit: cap, maxLength: chars))
    }

    // MARK: - Compilation cache

    private static let cacheLock = NSLock()
    private nonisolated(unsafe) static var cache: [String: NSRegularExpression] = [:]

    static func compiled(_ rule: Rule) -> NSRegularExpression? {
        let key = "\(rule.caseSensitive ? "cs" : "ci")\u{1}\(rule.pattern)"
        cacheLock.lock()
        defer { cacheLock.unlock() }
        if let hit = cache[key] { return hit }
        // `.caseInsensitive` is the DEFAULT here and case sensitivity is opt-in, matching
        // `facts.py`, where `_I` is the common flag and `_CS = 0` the exception.
        let options: NSRegularExpression.Options = rule.caseSensitive ? [] : [.caseInsensitive]
        guard let regex = try? NSRegularExpression(pattern: rule.pattern, options: options) else {
            return nil
        }
        cache[key] = regex
        return regex
    }
}


// GENERATED from `intelligence/boi_intel/facts.py` and `redact.py`. Do not hand-edit.
//
//     python3 scripts/generate_fact_vocabulary.py
//
// AMENDMENT-001 requires the Swift and Python fact extractors to agree token-for-token,
// and 800 words copied by hand is the obvious way for them to stop agreeing. These are
// generated, and `FactsTests.testVocabularyMatchesPython` re-reads the Python sets at
// test time and fails if either side moves.
