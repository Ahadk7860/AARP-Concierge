import Foundation

/// Calls, from macOS's `CallHistory.storedata`.
///
/// Context the message log cannot give you: two people who stopped texting but talk for
/// an hour every Sunday are not fading, and a digest built only on messages would say
/// they are. That is the "confident wrong answer about somebody's friend" failure the
/// architecture is most afraid of, so calls are worth reading even though they are a
/// second database with its own permission.
///
/// **This degrades rather than fails.** The file is absent on a Mac that has never taken
/// a call, and unreadable until Full Disk Access is granted. Both produce `nil`, which
/// leaves `calls` off the relationship entirely — the schema makes it optional for
/// exactly this reason. A zero call count would be a claim; absence is not.
public struct CallHistory: Sendable {

    /// One person's calls, already aggregated. No numbers dialed, no timestamps.
    public struct Summary: Sendable, Equatable {
        public var count = 0
        public var totalSeconds = 0
        public var initiatedByUser = 0
        public var missed = 0

        public init(count: Int = 0, totalSeconds: Int = 0,
                    initiatedByUser: Int = 0, missed: Int = 0) {
            self.count = count
            self.totalSeconds = totalSeconds
            self.initiatedByUser = initiatedByUser
            self.missed = missed
        }
    }

    /// normalized handle -> summary.
    public let byHandle: [String: Summary]

    public var callCount: Int { byHandle.values.reduce(0) { $0 + $1.count } }

    public init(byHandle: [String: Summary]) { self.byHandle = byHandle }

    /// Sums the summaries for every handle belonging to one person.
    ///
    /// Merged the same way messages are: by identity, not by handle string. Someone who
    /// is called on a phone number and texted from an Apple ID is one person, and the
    /// call minutes belong on their row.
    public func summary(forHandles handles: [String]) -> Summary? {
        var total = Summary()
        var found = false
        for handle in handles {
            guard let summary = byHandle[handle] else { continue }
            found = true
            total.count += summary.count
            total.totalSeconds += summary.totalSeconds
            total.initiatedByUser += summary.initiatedByUser
            total.missed += summary.missed
        }
        return found ? total : nil
    }

    /// Reads `CallHistory.storedata`, or returns nil.
    ///
    /// `ZCALLRECORD` is Core Data again: `ZADDRESS` is the other party (a blob on some
    /// releases, text on others), `ZDURATION` is seconds, `ZORIGINATED` is 1 when the
    /// user placed the call, and `ZANSWERED` is 0 on a call that rang out. A missed call
    /// is one that was not answered and not placed by the user; an outgoing call nobody
    /// picked up is not something to tell the user they missed.
    public static func read(path: String) -> CallHistory? {
        guard let database = try? ChatDatabase(path: path) else { return nil }

        var byHandle: [String: Summary] = [:]
        let sql = """
            SELECT ZADDRESS, coalesce(ZDURATION, 0), coalesce(ZORIGINATED, 0),
                   coalesce(ZANSWERED, 0)
            FROM ZCALLRECORD
            """
        guard (try? database.query(sql) { row in
            // ZADDRESS is declared BLOB and holds UTF-8 on every release seen so far.
            // sqlite3_column_text converts either representation, so read it as text and
            // let a row we cannot make sense of fall out rather than guessing.
            guard let raw = row.string(0) else { return }
            let handle = ContactResolver.normalize(raw)
            guard !handle.isEmpty else { return }

            var summary = byHandle[handle] ?? Summary()
            summary.count += 1
            // ZDURATION is REAL; the integer accessor truncates it, which is what we
            // want — nobody needs fractional seconds of phone call.
            summary.totalSeconds += max(0, Int(row.int64(1)))
            let originated = row.int64(2) != 0
            let answered = row.int64(3) != 0
            if originated { summary.initiatedByUser += 1 }
            if !originated && !answered { summary.missed += 1 }
            byHandle[handle] = summary
        }) != nil else { return nil }

        return CallHistory(byHandle: byHandle)
    }

    public static func defaultPaths(
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> [String] {
        [home.appendingPathComponent(
            "Library/Application Support/CallHistoryDB/CallHistory.storedata").path]
    }

    public static func discover(
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> CallHistory? {
        for path in defaultPaths(home: home) {
            if let history = read(path: path) { return history }
        }
        return nil
    }
}
