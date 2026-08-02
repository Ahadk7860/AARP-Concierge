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
        self.knownNames = Self.expand(knownNames)
            .sorted { $0.count == $1.count ? $0 < $1 : $0.count > $1.count }
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
            // somebody might have meant. "Al" would eat the middle of "already".
            if parts.count > 1 {
                for part in parts where part.count >= 4 { expanded.insert(part) }
            }
        }
        return Array(expanded)
    }

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
        // Phone numbers, in the shapes people actually type them. Ten or more digits
        // with any of the usual separators, or an explicit country code.
        ("phone", #"(\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b"#, placeholder),
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

    /// Redacts one string. Idempotent: running it twice changes nothing the second time.
    public func redact(_ text: String) -> String {
        var result = text
        for entry in Self.compiled {
            let range = NSRange(result.startIndex..., in: result)
            result = entry.regex.stringByReplacingMatches(in: result, range: range,
                                                          withTemplate: entry.replacement)
        }
        result = redactKnownNames(in: result)
        return result.replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Case-insensitive, on word boundaries, longest name first.
    private func redactKnownNames(in text: String) -> String {
        var result = text
        for name in knownNames {
            let escaped = NSRegularExpression.escapedPattern(for: name)
            guard let regex = try? NSRegularExpression(pattern: "\\b\(escaped)\\b",
                                                      options: [.caseInsensitive])
            else { continue }
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
}

public extension AddressBookDirectory {
    /// Every display name the AddressBook knows. Feeds name redaction, and never leaves
    /// the Mac.
    var displayNames: [String] { Array(namesByRecordForRedaction.values) }
}
