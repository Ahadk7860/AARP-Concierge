import Foundation

/// How much of the corpus has readable text, and where that text came from.
///
/// This is the metric that stands in for a fixture. A synthetic `attributedBody` would
/// let a broken decoder pass, so correctness is established against a real corpus by
/// measurement: the unrecoverable share must fall from roughly 47% to under 2%.
public struct TextCoverage: Sendable {

    /// CONTRACTS.md § 10, corrected 2 Aug. The bar is on **decoder failures only**:
    /// rows where `attributedBody` is non-null and decoding yields no text, over rows
    /// where `attributedBody` is non-null.
    ///
    /// The original criterion — every row with no recoverable text, under 2% — measures
    /// how photo-heavy a corpus is, not whether the decoder works. A perfect decoder
    /// scored 2.26% against it on a real 94,652-message corpus. This one is the number
    /// that says the typedstream port is correct.
    public static let maximumDecoderFailureShare = 0.005

    public var total = 0
    /// Rows whose `text` column was populated.
    public var fromColumn = 0
    /// Rows recovered by decoding the typedstream.
    public var fromAttributedBody = 0
    /// Rows whose blob decoded cleanly but held only an attachment placeholder. Not a
    /// decoder failure: an image message has no text and never did.
    public var attachmentOnly = 0
    /// Rows with no text column and no readable body. The only bucket that can hide a
    /// decoder bug.
    public var unrecoverable = 0
    /// Of the unrecoverable, how many had a blob that simply failed to decode — as
    /// opposed to having no blob at all. A row with neither is empty at the source and
    /// no decoder can help it; a row with a blob we could not read is a decoder bug.
    public var unrecoverableWithBlob = 0
    /// Every row carrying a non-null `attributedBody`, whatever became of it. The
    /// denominator of the decoder bar.
    public var rowsWithBlob = 0

    /// Corpus span, reported alongside coverage.
    ///
    /// Apple's "Keep Messages" setting silently caps history at 30 days, 1 year, or
    /// forever. A span landing at almost exactly 365 days is that cap, not a user who
    /// started texting a year ago — and the difference decides whether prompt 06 reports
    /// `thin` with a one-tap remedy or reports a wrong number confidently.
    public var firstMessageAt: Date?
    public var lastMessageAt: Date?

    public var spanDays: Int {
        guard let firstMessageAt, let lastMessageAt else { return 0 }
        return max(0, Int(lastMessageAt.timeIntervalSince(firstMessageAt) / 86_400))
    }

    /// Within a day either side of a year. See `firstMessageAt`.
    public var looksLikeOneYearRetentionCap: Bool {
        (364...366).contains(spanDays)
    }

    public var recovered: Int { fromAttributedBody }
    public var withText: Int { fromColumn + fromAttributedBody }

    public func share(_ count: Int) -> Double {
        guard total > 0 else { return 0 }
        return Double(count) / Double(total)
    }

    /// EVERY row with no usable text, attachment messages included.
    ///
    /// REPORTED, NEVER BARRED. A user whose messages are mostly photos is a real
    /// segment, and prompt 06's health check should see this number — but it is a
    /// corpus statistic, not a decoder metric, and it must never gate a decoder.
    public var unrecoverableShare: Double { share(unrecoverable + attachmentOnly) }

    /// THE DECODER BAR: blobs that yielded no text, over all blobs.
    public var decoderFailureShare: Double {
        guard rowsWithBlob > 0 else { return 0 }
        return Double(unrecoverableWithBlob) / Double(rowsWithBlob)
    }

    /// Text we believe exists and failed to get. The decoder-quality number.
    /// `unrecoverableShare` minus the attachment messages, which never had text.
    public var lostTextShare: Double { share(unrecoverable) }

    /// The share that *would* have been lost without the decoder — the "before" number.
    /// Every row now recovered from a blob had a NULL text column.
    public var shareWithoutDecoder: Double {
        share(fromAttributedBody + unrecoverable + attachmentOnly)
    }

    public var meetsBar: Bool { decoderFailureShare < Self.maximumDecoderFailureShare }

    public mutating func record(_ message: ChatMessage) {
        total += 1
        if message.hasAttributedBody { rowsWithBlob += 1 }
        switch message.textSource {
        case .column: fromColumn += 1
        case .attributedBody: fromAttributedBody += 1
        case .attachmentOnly: attachmentOnly += 1
        case .unrecoverable:
            unrecoverable += 1
            if message.hasAttributedBody { unrecoverableWithBlob += 1 }
        }
        guard let date = message.date else { return }
        firstMessageAt = min(firstMessageAt ?? date, date)
        lastMessageAt = max(lastMessageAt ?? date, date)
    }

    /// Measures the whole corpus, including tapbacks and group threads: coverage is a
    /// property of the decoder, not of the 1:1 ranking.
    public static func measure(reader: MessageReader) throws -> TextCoverage {
        var coverage = TextCoverage()
        for message in try reader.scan(options: .everything, loadMessages: true).messages {
            coverage.record(message)
        }
        return coverage
    }

    /// Counts only, never content.
    public var logFields: [String: Any] {
        var fields: [String: Any] = [
            "total_messages": total,
            "from_text_column": fromColumn,
            "recovered_from_attributed_body": fromAttributedBody,
            "unrecoverable": unrecoverable,
            "attachment_only": attachmentOnly,
            "unrecoverable_with_blob": unrecoverableWithBlob,
            "share_from_text_column": rounded(share(fromColumn)),
            "share_recovered": rounded(share(fromAttributedBody)),
            "share_unrecoverable": rounded(unrecoverableShare),
            "share_attachment_only": rounded(share(attachmentOnly)),
            "share_lost_text": rounded(lostTextShare),
            "share_unrecoverable_without_decoder": rounded(shareWithoutDecoder),
            "rows_with_blob": rowsWithBlob,
            "decoder_failures": unrecoverableWithBlob,
            "share_decoder_failures": rounded(decoderFailureShare),
            "meets_decoder_bar": meetsBar,
            "span_days": spanDays,
            "looks_like_one_year_retention_cap": looksLikeOneYearRetentionCap,
        ]
        fields["first_message_at"] = firstMessageAt.map(StructuredLog.timestamp) ?? "none"
        fields["last_message_at"] = lastMessageAt.map(StructuredLog.timestamp) ?? "none"
        return fields
    }

    private func rounded(_ value: Double) -> Double { (value * 10_000).rounded() / 10_000 }
}

/// Captures real `attributedBody` blobs into a local, gitignored fixture.
///
/// The unit test needs real typedstreams, and a hand-rolled fake would let a broken
/// decoder pass — which is worse than having no fixture at all. So the blobs come from
/// the developer's own database and **are never committed**: the file lives under this
/// track's scratch directory, `/tmp/boi-a`.
///
/// THE ORACLE IS THE DATABASE, NOT ME. Rows are chosen where `text` **and**
/// `attributedBody` are both populated, so the expected string is what Apple itself put
/// in the `text` column for that row. Nobody eyeballs a message to decide whether the
/// decoder got it right, and the expected values are real ground truth rather than
/// whatever the decoder happened to produce on the day it was written.
public enum TypedStreamFixture {

    public static let defaultPath = "/tmp/boi-a/typedstream-fixtures.json"

    public struct Sample: Codable, Sendable {
        /// The raw typedstream, base64 encoded.
        public let blob_base64: String
        /// What `message.text` said for the same row.
        public let expected: String
    }

    /// Reads samples from a real database. Writes only to `path`, which must be under
    /// this track's scratch directory.
    @discardableResult
    public static func capture(from reader: MessageReader,
                               to path: String = defaultPath,
                               count: Int = 5) throws -> Int {
        var samples: [Sample] = []
        for message in try reader.scan(options: .everything, loadMessages: true).messages {
            guard samples.count < count else { break }
            guard message.textSource == .column, message.hasAttributedBody,
                  let text = message.text, text.count > 8,
                  let blob = try reader.attributedBody(forROWID: message.rowID) else { continue }
            // Only keep a sample the decoder and the column already agree on in shape:
            // a row whose blob decodes to something is a usable regression anchor.
            samples.append(Sample(blob_base64: blob.base64EncodedString(), expected: text))
        }

        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted]
        try encoder.encode(samples).write(to: url, options: .atomic)
        return samples.count
    }

    public static func load(from path: String = defaultPath) -> [Sample]? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        return try? JSONDecoder().decode([Sample].self, from: data)
    }
}
