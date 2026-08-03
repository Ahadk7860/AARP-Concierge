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
    public static let defaultTrailingWindowDays = 30

    /// Widen it after a long outage, or when a restore is known to have renumbered the
    /// source. Fixed at 30 there was no way to reach further back at all.
    public let trailingWindowDays: Int

    public struct Stats: Sendable {
        public var scanned = 0
        public var inserted = 0
        public var updated = 0
        /// Rows already present, byte-identical. The number that must be everything on
        /// a second run over unchanged input.
        public var duplicatesSkipped = 0
        public var watermarkBefore: Int64 = 0
        public var watermarkAfter: Int64 = 0
        public var trailingWindowDays = MirrorSync.defaultTrailingWindowDays
        /// The date the window actually started at, which is not always `now - window`.
        public var windowStart: Date?
        /// `last_sync_at` as read at the top of this run, before it was overwritten.
        public var previousSyncAt: Date?
        public var startedAt = Date()
    }

    private let reader: MessageReader
    private let mirror: MirrorDatabase

    public init(reader: MessageReader,
                mirror: MirrorDatabase,
                trailingWindowDays: Int = MirrorSync.defaultTrailingWindowDays) {
        self.reader = reader
        self.mirror = mirror
        self.trailingWindowDays = max(0, trailingWindowDays)
    }

    /// One ingest pass.
    ///
    /// `now` is injected so the suite can place the trailing window deterministically.
    @discardableResult
    public func run(now: Date = Date()) throws -> Stats {
        var stats = Stats()
        stats.startedAt = now
        stats.trailingWindowDays = trailingWindowDays
        stats.watermarkBefore = try mirror.watermarkROWID()
        stats.previousSyncAt = try mirror.meta("last_sync_at").flatMap(StructuredLog.date(from:))

        // ANCHOR THE WINDOW ON THE LAST SYNC, NOT ONLY ON THE CLOCK.
        //
        // `now - 30d` alone leaves a hole whenever the Mac was away longer than the
        // window. Shut for two months, it resumes scanning [now-30d, now] and never
        // looks at the two months in between -- so a row that landed during the outage
        // is covered only by the ROWID half of the watermark, and any row that arrives
        // below the high-water mark is lost permanently. Those are precisely the rows
        // the trailing re-scan exists for: restores, iCloud renumbering, out-of-order
        // commits. The architecture's premise is that the Mac is allowed to be asleep,
        // and a campus beachhead means summer breaks.
        //
        // So the window starts at whichever is earlier: one window before now, or one
        // window before the last successful sync. Overlapping the previous run by a
        // full window is the point -- gaps are unrecoverable, overlap is just dedup.
        let cutoff = min(windowStart(before: now),
                         stats.previousSyncAt.map(windowStart(before:)) ?? windowStart(before: now))
        stats.windowStart = cutoff

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
            // Written last, and now actually read at the top of the next run.
            try mirror.setMeta("last_sync_at", StructuredLog.timestamp(now))
            try mirror.setMeta("trailing_window_days", String(trailingWindowDays))
        }

        return stats
    }

    private func windowStart(before date: Date) -> Date {
        Calendar(identifier: .gregorian)
            .date(byAdding: .day, value: -trailingWindowDays, to: date)
            ?? date.addingTimeInterval(-Double(trailingWindowDays) * 86_400)
    }
}
