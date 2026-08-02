import Foundation
import SQLite3

/// A read-only SQLite handle onto a `chat.db`.
///
/// THE ONE RULE IN THIS FILE: the connection URI is `file:<path>?mode=ro`, and never
/// the flag that promises SQLite the file cannot change.
///
/// That flag makes SQLite skip the write-ahead log entirely. On a live iCloud-syncing
/// Mac the newest messages live in `chat.db-wal` for minutes to hours before a
/// checkpoint folds them into the main file, so a reader that sets it silently freezes
/// the corpus at the last checkpoint. It raises no error, returns no warning, and
/// passes on a quiet test machine. On the fixture database the difference is exactly
/// one row; on a real Mac it is every message since the last checkpoint, forever.
///
/// The flag is named, and the two counts compared, in
/// `scripts/wal_control_counts.py`. It is deliberately absent from every file under
/// `mac/`, which a test in this suite enforces by scanning the sources.
public final class ChatDatabase {

    public enum Error: Swift.Error, CustomStringConvertible {
        case cannotOpen(path: String, message: String)
        case queryFailed(sql: String, message: String)
        case missingFile(path: String)

        public var description: String {
            switch self {
            case .cannotOpen(let path, let message):
                return "cannot open \(path) read-only: \(message)"
            case .queryFailed(let sql, let message):
                return "query failed: \(message)\n  sql: \(sql)"
            case .missingFile(let path):
                return "no database at \(path)"
            }
        }
    }

    private var handle: OpaquePointer?
    public let path: String

    /// Opens `path` with `mode=ro`. The `-wal` and `-shm` sidecars beside it are read
    /// as well, which is the entire point.
    public init(path: String) throws {
        guard FileManager.default.fileExists(atPath: path) else {
            throw Error.missingFile(path: path)
        }
        self.path = path

        let uri = ChatDatabase.readOnlyURI(forPath: path)
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_URI | SQLITE_OPEN_NOMUTEX
        let rc = sqlite3_open_v2(uri, &handle, flags, nil)
        guard rc == SQLITE_OK, let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) }
                ?? String(cString: sqlite3_errstr(rc))
            sqlite3_close_v2(handle)
            throw Error.cannotOpen(path: path, message: message)
        }
        self.handle = handle
    }

    deinit { sqlite3_close_v2(handle) }

    /// `file:<percent-encoded-path>?mode=ro`.
    ///
    /// Exposed so a test can assert the shape of the URI without opening anything.
    public static func readOnlyURI(forPath path: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove("?")
        allowed.remove("#")
        let encoded = path.addingPercentEncoding(withAllowedCharacters: allowed) ?? path
        return "file:\(encoded)?mode=ro"
    }

    // MARK: - Queries

    /// Runs `sql` and hands each row to `consume`.
    public func query(_ sql: String, bind: [Int64] = [], consume: (Row) -> Void) throws {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK,
              let statement else {
            throw Error.queryFailed(sql: sql, message: lastErrorMessage())
        }
        defer { sqlite3_finalize(statement) }

        for (index, value) in bind.enumerated() {
            guard sqlite3_bind_int64(statement, Int32(index + 1), value) == SQLITE_OK else {
                throw Error.queryFailed(sql: sql, message: lastErrorMessage())
            }
        }

        while true {
            let rc = sqlite3_step(statement)
            if rc == SQLITE_ROW {
                consume(Row(statement: statement))
            } else if rc == SQLITE_DONE {
                return
            } else {
                throw Error.queryFailed(sql: sql, message: lastErrorMessage())
            }
        }
    }

    /// Runs a query whose first column of its first row is an integer.
    public func scalar(_ sql: String, bind: [Int64] = []) throws -> Int64 {
        var value: Int64 = 0
        var sawRow = false
        try query(sql, bind: bind) { row in
            if !sawRow {
                value = row.int64(0)
                sawRow = true
            }
        }
        return value
    }

    /// Writes a single consistent, fully checkpointed copy of this database to `path`.
    ///
    /// Runs in a read transaction on the source, so the copy includes whatever is
    /// sitting in the write-ahead log and cannot tear against a concurrent checkpoint.
    /// Permitted on a read-only connection: it writes only to the destination.
    ///
    /// The destination is a bound parameter rather than an interpolated string. A path
    /// containing a quote would otherwise change the statement.
    public func vacuum(into path: String) throws {
        let sql = "VACUUM INTO ?"
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK,
              let statement else {
            throw Error.queryFailed(sql: sql, message: lastErrorMessage())
        }
        defer { sqlite3_finalize(statement) }

        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        guard sqlite3_bind_text(statement, 1, path, -1, transient) == SQLITE_OK else {
            throw Error.queryFailed(sql: sql, message: lastErrorMessage())
        }
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw Error.queryFailed(sql: sql, message: lastErrorMessage())
        }
    }

    private func lastErrorMessage() -> String {
        guard let handle else { return "no connection" }
        return String(cString: sqlite3_errmsg(handle))
    }

    /// A single result row. Valid only inside the `consume` callback that received it.
    public struct Row {
        let statement: OpaquePointer

        public func int64(_ column: Int32) -> Int64 { sqlite3_column_int64(statement, column) }
        public func int(_ column: Int32) -> Int { Int(sqlite3_column_int64(statement, column)) }
        public func bool(_ column: Int32) -> Bool { sqlite3_column_int64(statement, column) != 0 }

        public func string(_ column: Int32) -> String? {
            guard let raw = sqlite3_column_text(statement, column) else { return nil }
            return String(cString: raw)
        }

        public func isNull(_ column: Int32) -> Bool {
            sqlite3_column_type(statement, column) == SQLITE_NULL
        }
    }
}
