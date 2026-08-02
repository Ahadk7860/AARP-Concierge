import Foundation

/// Ingests `chat.db` into the durable mirror.
///
/// THE WATERMARK IS TWO THINGS, AND IT HAS TO BE.
///
/// `MAX(ROWID)` alone is the obvious design and it loses messages silently. Backfill —
/// an iCloud resync, a restore, a device that was offline for a week — arrives with
/// *fresh* ROWIDs and *old* dates. A date-based watermark skips it because the dates
/// are old. And a ROWID-based watermark skips any row that commits after a row with a
/// larger id, which is routine when several transactions land at once.
///
/// So: take everything above the ROWID watermark, **or** dated inside a trailing
/// window, and dedup by `guid`. Thirty days because that is iMessage's server-side
/// queue depth — a device offline longer than that has lost the messages at the source
/// too, and no watermark can recover what is not there.
///
/// The re-scan costs one indexed pass over a month of messages. On the 84k-message
/// corpus that is milliseconds, which is the entire reason this defence is affordable
/// enough to leave on permanently.
public struct MirrorSync {

    /// iMessage's server-side queue depth.
    public static let trailingWindowDays = 30

    public struct Stats: Sendable {
        public var scanned = 0
        public var inserted = 0
        public var updated = 0
        /// Rows already present, byte-identical. The number that must be everything on
        /// a second run over unchanged input.
        public var duplicatesSkipped = 0
        public var watermarkBefore: Int64 = 0
        public var watermarkAfter: Int64 = 0
        public var trailingWindowDays = MirrorSync.trailingWindowDays
        public var startedAt = Date()
    }

    private let reader: MessageReader
    private let mirror: MirrorDatabase

    public init(reader: MessageReader, mirror: MirrorDatabase) {
        self.reader = reader
        self.mirror = mirror
    }

    /// One ingest pass.
    ///
    /// `now` is injected so the suite can place the trailing window deterministically.
    @discardableResult
    public func run(now: Date = Date()) throws -> Stats {
        var stats = Stats()
        stats.startedAt = now
        stats.watermarkBefore = try mirror.watermarkROWID()

        let cutoff = Calendar(identifier: .gregorian)
            .date(byAdding: .day, value: -Self.trailingWindowDays, to: now)
            ?? now.addingTimeInterval(-Double(Self.trailingWindowDays) * 86_400)

        // Everything, not just 1:1: the mirror is the durable record, so tapbacks,
        // group threads and rows joined to no chat all belong in it. Filtering is a
        // query concern for the metrics in prompt 04, not an ingest concern -- a row
        // dropped at ingest is gone the moment chat.db prunes it.
        var options = ScanOptions.everything
        options.afterROWID = stats.watermarkBefore > 0 ? stats.watermarkBefore : nil
        options.newerThan = stats.watermarkBefore > 0 ? cutoff : nil

        let scan = try reader.scan(options: options, loadMessages: true, now: now)
        stats.scanned = scan.messages.count

        try mirror.transaction {
            for message in scan.messages {
                switch try mirror.upsert(message, seenAt: now) {
                case .inserted: stats.inserted += 1
                case .updated: stats.updated += 1
                case .unchanged: stats.duplicatesSkipped += 1
                }
            }

            // Advance, never retreat. A restore that renumbers rows downward must not
            // drag the watermark back and cause the whole corpus to be re-read as new.
            stats.watermarkAfter = max(stats.watermarkBefore, scan.maxROWID)
            try mirror.setWatermarkROWID(stats.watermarkAfter)
            try mirror.setMeta("last_sync_at", StructuredLog.timestamp(now))
            try mirror.setMeta("trailing_window_days", String(Self.trailingWindowDays))
        }

        return stats
    }
}
