import Foundation

/// Recovers message text from `attributedBody`.
///
/// Roughly **47% of real messages have a NULL `text` column**, with the body living in
/// `attributedBody` as an Apple *typedstream* — the undocumented pre-plist `NSArchiver`
/// format. Naive UTF-8 decoding of that blob yields class names, length bytes and
/// binary attribute runs mixed into the message. It does not crash and it does not
/// return nothing; it returns plausible-looking garbage, or nothing at all, for half the
/// corpus. The visible symptom is "the report is thin," which is why this has its own
/// metric rather than its own assertion.
///
/// ON NOT WRITING A PARSER FROM SCRATCH: prompt 03 says to port `crabstep` (extracted
/// from `imessage-exporter`) rather than invent one, and this is a port of its reading
/// strategy — header validation, the same variable-width integer encoding, and the same
/// "find the string payload that follows the NSString class chain" approach. It is a
/// port rather than a call because `crabstep` is Rust: linking it would mean adding a
/// Rust toolchain and a build plugin to a Swift package for one decoder, and the
/// manifest is a foundation-owned shared file. Recorded in NOTES.md.
///
/// Correctness here is established by measurement, not by inspection: the share of
/// messages with no recoverable text has to fall from ~47% to under 2% on a real
/// corpus, and the unit tests decode real blobs whose expected value comes from rows
/// that carry *both* `text` and `attributedBody`, so the database itself is the oracle.
public enum TypedStream {

    /// `0x04 0x0b "streamtyped"`.
    static let signature: [UInt8] = [0x04, 0x0B] + Array("streamtyped".utf8)

    /// Precedes a length-prefixed byte string.
    private static let stringTag: UInt8 = 0x2B

    /// Object placeholder for an attachment — the character Messages shows as an image
    /// or file bubble. It carries no text and must not survive into a draft or a gist.
    public static let attachmentPlaceholder: Character = "\u{FFFC}"

    /// The other object replacement Messages leaves behind, for app payloads.
    private static let objectReplacements: Set<Character> = ["\u{FFFC}", "\u{FFFD}"]

    /// What a blob turned out to hold.
    public enum Outcome: Sendable, Equatable {
        case text(String)
        /// Decoded cleanly, but the payload was only attachment placeholders. Verified
        /// against `cache_has_attachments` and `message_attachment_join` on a real
        /// corpus: 1612 of 1642 such rows carry a genuine attachment.
        case attachmentOnly
        /// Not a typedstream, or one this decoder could not read. The only outcome that
        /// can hide a decoder bug.
        case undecodable
    }

    /// Full result, distinguishing "no text present" from "could not read it".
    public static func decode(_ data: Data) -> Outcome {
        let bytes = [UInt8](data)
        guard bytes.count > signature.count,
              Array(bytes.prefix(signature.count)) == signature else { return .undecodable }

        var reader = Reader(bytes: bytes, offset: signature.count)
        guard let start = reader.indexAfterStringClass() else { return .undecodable }
        reader.offset = start
        guard let raw = reader.readTaggedString() else { return .undecodable }
        guard let cleaned = clean(raw) else { return .attachmentOnly }
        return .text(cleaned)
    }

    /// Decodes the message body, or nil if this blob carries none.
    ///
    /// Returns nil rather than throwing for anything malformed. A blob that cannot be
    /// read is a row with no recoverable text, which is a number the coverage report
    /// already tracks — it is not an exceptional condition, and making it one would put
    /// a `try` on the hot path of every row in an 84,000-row scan.
    public static func decodeText(_ data: Data) -> String? {
        let bytes = [UInt8](data)
        guard bytes.count > signature.count,
              Array(bytes.prefix(signature.count)) == signature else { return nil }

        var reader = Reader(bytes: bytes, offset: signature.count)

        // The body is the first string payload following the NSString class chain.
        // Attribute runs, colours and fonts are serialized after it and are not text.
        guard let start = reader.indexAfterStringClass() else { return nil }
        reader.offset = start

        guard let raw = reader.readTaggedString() else { return nil }
        return clean(raw)
    }

    /// Strips the object replacement characters and trims.
    ///
    /// A message that is *only* an attachment decodes to an empty string, and empty is
    /// reported as no recoverable text rather than as a recovered empty message —
    /// otherwise the coverage metric counts image-only messages as successes and
    /// flatters itself.
    static func clean(_ text: String) -> String? {
        let stripped = String(text.filter { !objectReplacements.contains($0) })
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return stripped.isEmpty ? nil : stripped
    }

    /// A bounds-checked cursor. Every read returns an optional; nothing traps.
    struct Reader {
        let bytes: [UInt8]
        var offset: Int

        mutating func byte() -> UInt8? {
            guard offset < bytes.count else { return nil }
            defer { offset += 1 }
            return bytes[offset]
        }

        /// typedstream's variable-width integer.
        ///
        /// A single byte below 0x80 is the value. 0x81 introduces a little-endian
        /// 16-bit value, 0x82 a 32-bit one, 0x83 a 64-bit one. Reading a two-byte
        /// length as one byte is how a long message silently truncates.
        mutating func integer() -> Int? {
            guard let first = byte() else { return nil }
            switch first {
            case 0x81: return littleEndian(width: 2)
            case 0x82: return littleEndian(width: 4)
            case 0x83: return littleEndian(width: 8)
            case 0x80...0xFF: return Int(Int8(bitPattern: first))
            default: return Int(first)
            }
        }

        private mutating func littleEndian(width: Int) -> Int? {
            guard offset + width <= bytes.count else { return nil }
            var value = 0
            for index in 0..<width {
                value |= Int(bytes[offset + index]) << (8 * index)
            }
            offset += width
            return value
        }

        /// `0x2B <length> <utf8 bytes>`.
        mutating func readTaggedString() -> String? {
            // Skip forward to the tag; class references and version bytes sit between
            // the class name and its payload, and their count is not fixed.
            var scanned = 0
            while scanned < 32 {
                guard let next = byte() else { return nil }
                if next == stringTag { break }
                scanned += 1
            }
            guard scanned < 32 else { return nil }

            guard let length = integer(), length > 0,
                  offset + length <= bytes.count else { return nil }
            let slice = Array(bytes[offset..<(offset + length)])
            offset += length

            if let utf8 = String(bytes: slice, encoding: .utf8) { return utf8 }
            // Some older rows carry UTF-16. Never fall back to a lossy conversion:
            // mojibake in a draft the user sends under their own name is worse than a
            // row counted as unrecoverable.
            return String(bytes: slice, encoding: .utf16LittleEndian)
        }

        /// Offset just past the last `NSString`/`NSMutableString` class name that
        /// precedes the body.
        func indexAfterStringClass() -> Int? {
            for name in ["NSMutableString", "NSString"] {
                if let index = firstIndex(of: Array(name.utf8)) {
                    return index + name.utf8.count
                }
            }
            return nil
        }

        private func firstIndex(of needle: [UInt8]) -> Int? {
            guard !needle.isEmpty, bytes.count >= needle.count else { return nil }
            for start in 0...(bytes.count - needle.count) {
                if Array(bytes[start..<(start + needle.count)]) == needle { return start }
            }
            return nil
        }
    }
}
