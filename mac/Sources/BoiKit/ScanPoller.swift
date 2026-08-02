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

    public init() {}

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

    public struct Configuration: Sendable {
        public var interval: TimeInterval
        /// `nil` runs until interrupted.
        public var iterations: Int?
        /// Emit the stall alarm once a stall has lasted at least this long.
        public var stallAlarmAfterSeconds: Int

        public init(interval: TimeInterval = ScanPoller.foregroundInterval,
                    iterations: Int? = 1,
                    stallAlarmAfterSeconds: Int = 0) {
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
    /// `sleep` and `now` are injected so the suite can exercise many passes without
    /// waiting on a wall clock.
    public func run(options: ScanOptions = .oneToOne,
                    scan: (Int) throws -> ScanResult,
                    now: () -> Date = { Date() },
                    sleep: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) },
                    onPass: (Pass) -> Void) throws {
        var tracker = WatermarkTracker()
        var index = 0
        while configuration.iterations.map({ index < $0 }) ?? true {
            if index > 0, configuration.interval > 0 { sleep(configuration.interval) }
            let result = try scan(index)
            let status = tracker.observe(maxROWID: result.maxROWID, at: now())
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
