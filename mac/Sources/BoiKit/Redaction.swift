import Foundation

/// Strips specifics out of a string that is about to leave the Mac.
///
/// A voice pack teaches **cadence, not facts**. "sorry been mia this week" and "call me
/// at 555-0100" are equally good style samples and only one of them is a phone number in
/// somebody's cloud storage. So every free-text field in the pack goes through here.
///
/// THE ORDER MATTERS AND IT IS NOT THE OBVIOUS ONE. Redaction runs on the strings that
/// get serialized, **after** the register has been computed from the raw messages —
/// CONTRACTS.md § 7. Redacting the corpus first corrupts the very statistics the pack
/// exists to carry: `"Hey Sarah how are you"` becomes `"[name] how are you"`, which stops
/// counting as a greeting and flips the first character to lowercase, so a sentence-case
/// writer who opens with a name is reported as `lowercase_no_period` with a third of
/// their true greeting rate. Every register test still passes and the register is wrong.
public struct Redactor: Sendable {

    /// Names from the user's own AddressBook. **Matched case-insensitively**, which is
    /// the whole reason this input exists: CONTRACTS.md § 7 says name redaction must not
    /// assume capitalization, because the target corpus is lowercase texting — the
    /// fixture register is literally `lowercase_no_period`. A pattern requiring `[A-Z]`
    /// passes every test written against capitalized samples and leaks
    /// `"ill ask john smith about it"` untouched.
    private let knownNames: [String]

    public init(knownNames: [String] = []) {
        // Longest first, so "john smith" is consumed before the "john" inside it.
        let expanded: [String] = Self.expand(knownNames)
            .sorted { $0.count == $1.count ? $0 < $1 : $0.count > $1.count }
        self.knownNames = expanded
        self.compiledNames = Self.compileNames(expanded)
        self.nameTokens = Self.tokenize(expanded)
    }

    /// A directory contributes both the full display name and each of its parts, because
    /// people are named in messages either way.
    public init(directory: AddressBookDirectory) {
        self.init(knownNames: directory.displayNames)
    }

    private static func expand(_ names: [String]) -> [String] {
        var expanded: Set<String> = []
        for name in names {
            let cleaned = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard cleaned.count >= 3 else { continue }
            expanded.insert(cleaned)
            let parts = cleaned.split(separator: " ").map(String.init)
            // A single part is only redacted when it is long enough not to be a word
            // somebody might have meant, AND is not an ordinary English word in its own
            // right. Length alone is not enough: a contact named Will, Mark, Hope, Grace
            // or April turns "i will be there" into "i [name] be there" in every
            // exemplar, which is a name list smuggled in through the AddressBook — the
            // very thing NOTES.md declined to build directly and for exactly this reason.
            if parts.count > 1 {
                for part in parts where part.count >= 4 && !alsoOrdinaryWords.contains(part) {
                    expanded.insert(part)
                }
            }
        }
        return Array(expanded)
    }

    /// Given names that are also common English words.
    ///
    /// Redacting one of these costs the register a real word in every message that uses
    /// it; **not** redacting it costs a first name that the full-name pattern still
    /// catches whenever both parts appear together. The full name is always redacted —
    /// only the bare given name is spared — so the exposure is "Grace" alone, not
    /// "Grace Kim".
    static let alsoOrdinaryWords: Set<String> = [
        "will", "mark", "hope", "grace", "april", "may", "june", "july", "august",
        "art", "bill", "chase", "dawn", "drew", "faith", "frank", "gene", "hunter",
        "jack", "joy", "mercy", "miles", "olive", "page", "paige", "pat", "penny",
        "rich", "rose", "ruby", "sky", "summer", "sunny", "wade", "ward", "young",
        "brook", "brooke", "carol", "cliff", "dale", "dean", "don", "earl", "guy",
        "holly", "jean", "jay", "lane", "mason", "nick", "noel", "pearl", "reed",
        "rob", "royal", "sage", "sonny", "sterling", "stone", "van", "victor", "wren",
    ]

    public static let placeholder = "[redacted]"
    public static let namePlaceholder = "[name]"

    /// Every pattern, applied in a fixed order. Money before numbers, so `$120` does not
    /// first lose its digits to the phone-number rule and survive as `$[redacted]`.
    ///
    /// Each is deliberately greedy. Over-redaction costs a little style fidelity;
    /// under-redaction is the incident.
    static let patterns: [(name: String, pattern: String, replacement: String)] = [
        ("email", #"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"#, placeholder),
        ("money", #"[$£€]\s?\d[\d,]*(\.\d{1,2})?(?i:\s?(k|m|bucks|dollars))?"#, placeholder),
        ("money_worded", #"(?i)\b\d[\d,]*(\.\d{1,2})?\s?(dollars|bucks|usd)\b"#, placeholder),
        // A long unbroken digit run — an order number, a tracking number, a verification
        // code. Redacted wholesale and BEFORE the phone rule, which is what keeps that
        // rule idempotent: matched on a 20-digit run, `phone` consumes the last ten and
        // leaves the first ten sitting against the placeholder, where a word boundary now
        // exists that did not before, so the next pass matches again. Found on the real
        // corpus by `boi-cli redaction-selftest` — 4 messages in 30,399, and every
        // hand-written test message missed it.
        ("long_digit_run", #"(?<!\d)\d{11,}(?!\d)"#, placeholder),
        // Phone numbers, in the shapes people actually type them. Bounded by lookarounds
        // rather than `\b` so a match can never be adjacent to more digits.
        ("phone", #"(?<!\d)(\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)"#,
         placeholder),
        // Street addresses. The number-then-words shape, case-insensitive because the
        // corpus is lowercase.
        ("street", #"(?i)\b\d{1,5}\s+([A-Za-z0-9'.-]+\s+){0,3}"#
            + #"(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|"#
            + #"place|pl|way|terrace|ter|circle|cir|parkway|pkwy|highway|hwy)\b\.?"#,
         placeholder),
        // Capitalized "First Last". Catches the sentence-case half of the corpus; the
        // lowercase half is covered by `knownNames`, and the gap between them is stated
        // in NOTES.md rather than papered over.
        ("name_capitalized", #"\b[A-Z][a-z]{1,15}\s+[A-Z][a-z]{1,15}\b"#, namePlaceholder),
    ]

    private static let compiled: [(name: String, regex: NSRegularExpression, replacement: String)] =
        patterns.compactMap { entry in
            guard let regex = try? NSRegularExpression(pattern: entry.pattern) else { return nil }
            return (entry.name, regex, entry.replacement)
        }

    /// How many times the whole pattern set may be re-applied before giving up.
    ///
    /// Belt and braces on top of individually idempotent patterns: replacing text can
    /// create adjacencies that did not exist before, and a future pattern that does so
    /// must not be able to turn `containsSpecifics` into a permanent false alarm. Three
    /// is generous — every case seen on the real corpus converges on the second pass.
    static let maximumPasses = 3

    /// Redacts one string. **Idempotent** — running it again changes nothing, which
    /// matters because `containsSpecifics` is defined as "redaction would change this"
    /// and the serializer refuses to write a pack that reports specifics.
    public func redact(_ text: String) -> String {
        var result = text
        for _ in 0..<Self.maximumPasses {
            let before = result
            result = onePass(result)
            if result == before { break }
        }
        return result
    }

    private func onePass(_ text: String) -> String {
        var result = text
        for entry in Self.compiled {
            let range = NSRange(result.startIndex..., in: result)
            result = entry.regex.stringByReplacingMatches(in: result, range: range,
                                                          withTemplate: entry.replacement)
        }
        result = redactKnownNames(in: result)
        return Self.collapseWhitespace(result)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Every run of whitespace becomes one space, in a single pass.
    ///
    /// **THIS HAS TO BE IDEMPOTENT AND THE OBVIOUS VERSION IS NOT.** Replacing `"  "`
    /// with `" "` leaves a double space behind on any run of four, so a second pass
    /// changes the string again — which made `containsSpecifics`, defined as "redaction
    /// would change this", report a leak on text that had nothing to redact. Caught by
    /// running against a real 94k corpus, where runs of spaces and embedded newlines are
    /// ordinary; every synthetic test message had single spaces and none of them saw it.
    static func collapseWhitespace(_ text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: #"\s+"#) else { return text }
        return regex.stringByReplacingMatches(
            in: text, range: NSRange(text.startIndex..., in: text), withTemplate: " ")
    }

    /// Every known name compiled ONCE, not once per message.
    ///
    /// This used to build an NSRegularExpression per name inside the per-message loop.
    /// With an empty AddressBook the loop body never ran and nobody noticed. The moment
    /// contacts resolved — 547 records expanding to ~1,000 name variants — it became
    /// ~1,000 regex compilations plus ~1,000 full-string scans PER MESSAGE, across ~95,000
    /// messages. Sync went from ~55 seconds to over 15 minutes and got killed before it
    /// could upload, which read as "contacts still broken" rather than "redaction is
    /// quadratic".
    ///
    /// Compiling once is the whole fix; the scan itself is unchanged, so redaction output
    /// is byte-identical.
    private let compiledNames: [NSRegularExpression]

    private static func compileNames(_ knownNames: [String]) -> [NSRegularExpression] {
        knownNames.compactMap { name in
            let escaped = NSRegularExpression.escapedPattern(for: name)
            return try? NSRegularExpression(pattern: "\\b\(escaped)\\b",
                                            options: [.caseInsensitive])
        }
    }

    /// The set of first tokens across every known name, lowercased.
    ///
    /// A cheap pre-filter: a message whose words share NOTHING with any known name cannot
    /// match any of the compiled patterns, so it skips the scan entirely. Most messages in
    /// a real corpus mention nobody, so most messages pay one tokenise instead of ~1,000
    /// regex scans. Conservative by construction — it can only skip work that provably
    /// could not have matched.
    private let nameTokens: Set<String>

    private static func tokenize(_ knownNames: [String]) -> Set<String> {
        var tokens: Set<String> = []
        for name in knownNames {
            for part in name.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }) {
                tokens.insert(String(part))
            }
        }
        return tokens
    }

    /// Case-insensitive, on word boundaries, longest name first.
    private func redactKnownNames(in text: String) -> String {
        if compiledNames.isEmpty { return text }
        // Pre-filter: no shared token means no possible match.
        let words = text.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        guard words.contains(where: { nameTokens.contains(String($0)) }) else { return text }

        var result = text
        for regex in compiledNames {
            let range = NSRange(result.startIndex..., in: result)
            result = regex.stringByReplacingMatches(in: result, range: range,
                                                    withTemplate: Self.namePlaceholder)
        }
        return result
    }

    /// True when the string still contains something this redactor was supposed to
    /// remove. Used as an assertion at the serializer, not as a substitute for redacting.
    public func containsSpecifics(_ text: String) -> Bool {
        redact(text) != text
    }

    /// Which named pattern still fires on an already-redacted string, if any.
    ///
    /// Diagnostic for exactly one failure mode: a pattern that is not idempotent, so the
    /// serializer's guard refuses a pack that is in fact clean. Returns the pattern's
    /// **name** and never the text, so it is safe to log — see
    /// `boi-cli redaction-selftest`.
    public func nonIdempotentPattern(_ text: String) -> String? {
        for entry in Self.compiled {
            let range = NSRange(text.startIndex..., in: text)
            let after = entry.regex.stringByReplacingMatches(in: text, range: range,
                                                             withTemplate: entry.replacement)
            if after != text { return entry.name }
        }
        if redactKnownNames(in: text) != text { return "known_name" }
        if Self.collapseWhitespace(text) != text { return "whitespace" }
        if text.trimmingCharacters(in: .whitespacesAndNewlines) != text { return "trim" }
        return nil
    }
}

public extension AddressBookDirectory {
    /// Every display name the AddressBook knows. Feeds name redaction, and never leaves
    /// the Mac.
    var displayNames: [String] { Array(namesByRecordForRedaction.values) }
}
