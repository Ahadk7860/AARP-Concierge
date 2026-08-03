import Foundation

/// What the watermark did between two consecutive scans.
public enum WatermarkStatus: Sendable, Equatable {
    case first(Int64)
    case advanced(from: Int64, to: Int64)
    /// `MAX(ROWID)` did not move. Benign on a quiet Mac, and the symptom of a reader
    /// that has silently stopped seeing the database.
    case stalled(at: Int64, forSeconds: Int)
    /// The watermark went backwards. The database was replaced underneath us — a
    /// restore, a fresh sync, or a snapshot taken from a stale copy.
    case regressed(from: Int64, to: Int64)

    public var isAlarm: Bool {
        switch self {
        case .stalled, .regressed: return true
        case .first, .advanced: return false
        }
    }
}

/// Tracks `MAX(ROWID)` across scans and raises an alarm when it does not advance.
public struct WatermarkTracker: Sendable {
    public private(set) var lastROWID: Int64?
    public private(set) var lastAdvanceAt: Date?

    public init(lastROWID: Int64? = nil, lastAdvanceAt: Date? = nil) {
        self.lastROWID = lastROWID
        self.lastAdvanceAt = lastAdvanceAt
    }

    public mutating func observe(maxROWID: Int64, at now: Date) -> WatermarkStatus {
        defer {
            if lastROWID == nil || maxROWID > (lastROWID ?? 0) {
                lastAdvanceAt = now
            }
            lastROWID = maxROWID
        }
        guard let previous = lastROWID else { return .first(maxROWID) }
        if maxROWID > previous { return .advanced(from: previous, to: maxROWID) }
        if maxROWID < previous { return .regressed(from: previous, to: maxROWID) }
        let since = lastAdvanceAt ?? now
        return .stalled(at: maxROWID, forSeconds: Int(now.timeIntervalSince(since).rounded()))
    }
}

/// Persists the watermark between process runs.
///
/// Without this the alarm is decorative. A tracker built fresh inside the poll loop
/// always reports `.first` on a single-pass run, so `boi-cli scan` — the default path,
/// and the one a LaunchAgent invokes once every interval — could never observe a stall.
/// "Between runs" only means anything if something outlives the run.
public struct WatermarkStore {

    private struct State: Codable {
        var last_rowid: Int64
        /// ISO 8601 UTC, per CONTRACTS.md section 6. No epoch integers on a boundary.
        var last_advance_at: String
    }

    public let url: URL

    public init(url: URL) { self.url = url }

    /// A tracker seeded from disk, or an empty one when there is no readable state.
    /// Unreadable state is not fatal: the next scan re-establishes it.
    public func load() -> WatermarkTracker {
        guard let data = try? Data(contentsOf: url),
              let state = try? JSONDecoder().decode(State.self, from: data) else {
            return WatermarkTracker()
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return WatermarkTracker(lastROWID: state.last_rowid,
                                lastAdvanceAt: formatter.date(from: state.last_advance_at))
    }

    public func save(_ tracker: WatermarkTracker) throws {
        guard let rowID = tracker.lastROWID else { return }
        let state = State(last_rowid: rowID,
                          last_advance_at: StructuredLog.timestamp(tracker.lastAdvanceAt ?? Date()))
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try JSONEncoder().encode(state).write(to: url, options: .atomic)
    }
}

/// Polls the database on a fixed interval.
///
/// POLLING IS THE DESIGN, NOT A SHORTCUT. The tempting alternative is a file-system
/// event stream or a vnode watcher on `chat.db-wal`. Both bind to an inode, and SQLite
/// deletes and recreates the `-wal` and `-shm` files on every checkpoint. The watcher
/// survives the first checkpoint attached to a file that no longer exists, never fires
/// again, and reports no error. There is no correct file-watching implementation of
/// this; poll.
public struct ScanPoller {

    /// 30s while the app is foregrounded, one pass otherwise.
    public static let foregroundInterval: TimeInterval = 30

    /// One hour. See `Configuration.stallAlarmAfterSeconds`.
    public static let defaultStallAlarmSeconds = 3600

    public struct Configuration: Sendable {
        public var interval: TimeInterval
        /// `nil` runs until interrupted.
        public var iterations: Int?
        /// Emit the stall alarm once a stall has lasted at least this long.
        ///
        /// Defaults to an hour, not to zero. A flat `MAX(ROWID)` across two polls 30
        /// seconds apart is the *normal* state of a Mac whose owner is asleep, so a
        /// zero grace period warns on essentially every poll and the alarm becomes
        /// something you learn to ignore. An hour with no new message on any thread is
        /// still unremarkable for one user, but it is the point where a reader that has
        /// genuinely stopped seeing the database starts to look different from a quiet
        /// one.
        public var stallAlarmAfterSeconds: Int

        public init(interval: TimeInterval = ScanPoller.foregroundInterval,
                    iterations: Int? = 1,
                    stallAlarmAfterSeconds: Int = ScanPoller.defaultStallAlarmSeconds) {
            self.interval = interval
            self.iterations = iterations
            self.stallAlarmAfterSeconds = stallAlarmAfterSeconds
        }

        /// A single pass — the default when nothing is watching.
        public static let once = Configuration(interval: 0, iterations: 1)
        /// Foregrounded: every 30s, forever.
        public static let foreground = Configuration(interval: ScanPoller.foregroundInterval,
                                                     iterations: nil)
    }

    public struct Pass: Sendable {
        public let index: Int
        public let result: ScanResult
        public let watermark: WatermarkStatus
        /// True when `watermark` is an alarm that has also outlasted the configured
        /// grace period.
        public let raisesAlarm: Bool
    }

    public let configuration: Configuration

    public init(configuration: Configuration = .once) {
        self.configuration = configuration
    }

    /// Runs the poll loop, handing each pass to `onPass`.
    ///
    /// Pass a `store` to carry the watermark across process runs — without one, a
    /// single-pass run can only ever report `.first` and the stall alarm is dead code.
    ///
    /// `sleep` and `now` are injected so the suite can exercise many passes without
    /// waiting on a wall clock.
    public func run(options: ScanOptions = .oneToOne,
                    store: WatermarkStore? = nil,
                    scan: (Int) throws -> ScanResult,
                    now: () -> Date = { Date() },
                    sleep: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) },
                    onPass: (Pass) -> Void) throws {
        var tracker = store?.load() ?? WatermarkTracker()
        var index = 0
        while configuration.iterations.map({ index < $0 }) ?? true {
            if index > 0, configuration.interval > 0 { sleep(configuration.interval) }
            let result = try scan(index)
            let status = tracker.observe(maxROWID: result.maxROWID, at: now())
            try store?.save(tracker)
            onPass(Pass(index: index,
                        result: result,
                        watermark: status,
                        raisesAlarm: Self.raisesAlarm(status, after: configuration.stallAlarmAfterSeconds)))
            index += 1
        }
    }

    static func raisesAlarm(_ status: WatermarkStatus, after graceSeconds: Int) -> Bool {
        switch status {
        case .stalled(_, let forSeconds): return forSeconds >= graceSeconds
        case .regressed: return true
        case .first, .advanced: return false
        }
    }
}
