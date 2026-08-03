import Foundation
import SQLite3

/// The durable local mirror.
///
/// This is versioned storage, not a cache. After three years it holds message history
/// that `chat.db` itself no longer has — iMessage prunes, restores lose threads, and a
/// device migration drops whatever did not sync. The mirror keeps everything it has
/// ever seen, including rows the source has since deleted. That is the point: leaving
/// Boi should mean walking away with your own history, not losing it.
///
/// Two consequences of taking that seriously, both enforced below:
/// - **Nothing here deletes a message row.** No prune, no retention window, no vacuum
///   of old threads.
/// - **Ingesting the same source twice changes nothing.** Idempotence is what makes a
///   durable store safe to run on a timer.
///
/// Every statement goes through one prepared-statement path, including the DDL. Values
/// are always bound, never interpolated.
public final class MirrorDatabase {

    public enum Error: Swift.Error, CustomStringConvertible {
        case cannotOpen(path: String, message: String)
        case failed(sql: String, message: String)
        case unsupportedSchema(found: Int, supported: Int)

        public var description: String {
            switch self {
            case .cannotOpen(let path, let message):
                return "cannot open mirror at \(path): \(message)"
            case .failed(let sql, let message):
                return "mirror statement failed: \(message)\n  sql: \(sql)"
            case .unsupportedSchema(let found, let supported):
                return "mirror is schema v\(found) but this build understands v\(supported). "
                    + "Refusing to touch it: a newer mirror written by an older build is "
                    + "how durable storage quietly loses columns."
            }
        }
    }

    /// Bump only alongside a migration. SQLite's `user_version` is the authority.
    ///
    /// v2 adds `was_delivered_quietly`, which prompt 04's warmth metric reads. Migrating
    /// forward only adds the column; a mirror written by v1 keeps every row it had.
    public static let schemaVersion = 2

    private var handle: OpaquePointer?
    public let path: String

    public init(path: String) throws {
        self.path = path
        let directory = URL(fileURLWithPath: path).deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX
        guard sqlite3_open_v2(path, &handle, flags, nil) == SQLITE_OK, let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
            sqlite3_close_v2(handle)
            throw Error.cannotOpen(path: path, message: message)
        }
        self.handle = handle
        try migrate()
    }

    deinit { sqlite3_close_v2(handle) }

    // MARK: - Schema

    private func migrate() throws {
        try perform("PRAGMA journal_mode=WAL")

        let found = Int(try scalar("PRAGMA user_version"))
        guard found <= Self.schemaVersion else {
            throw Error.unsupportedSchema(found: found, supported: Self.schemaVersion)
        }
        guard found < Self.schemaVersion else { return }

        // Stepwise, and each step is additive. A mirror is durable storage holding
        // history that chat.db itself may no longer have, so a migration that drops or
        // rewrites a row is data loss with no source left to re-read it from.
        if found < 1 { try migrateToV1() }
        if found < 2 { try migrateToV2() }
        try perform("PRAGMA user_version = \(Self.schemaVersion)")
    }

    private func migrateToV1() throws {
        try perform("""
            CREATE TABLE IF NOT EXISTS message (
              guid                    TEXT PRIMARY KEY,
              source_rowid            INTEGER NOT NULL,
              text                    TEXT,
              has_attributed_body     INTEGER NOT NULL DEFAULT 0,
              handle                  TEXT,
              handle_rowid            INTEGER,
              service                 TEXT,
              sent_at                 TEXT,
              is_from_me              INTEGER NOT NULL DEFAULT 0,
              associated_message_type INTEGER NOT NULL DEFAULT 0,
              chat_rowid              INTEGER,
              chat_identifier         TEXT,
              chat_style              INTEGER,
              first_seen_at           TEXT NOT NULL
            )
            """)
        try perform("CREATE INDEX IF NOT EXISTS message_sent_at_idx ON message(sent_at)")
        try perform("CREATE INDEX IF NOT EXISTS message_source_idx ON message(source_rowid)")
        try perform("CREATE INDEX IF NOT EXISTS message_chat_idx ON message(chat_identifier)")

        // FTS5 now; the same store takes vectors later without migrating this table.
        // Standalone rather than external-content: the content table is keyed by guid,
        // and keeping the index in step explicitly is less fragile than three triggers
        // that must agree with every future migration.
        try perform("CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(guid UNINDEXED, text)")

        try perform("""
            CREATE TABLE IF NOT EXISTS mirror_meta (
              key TEXT PRIMARY KEY, value TEXT NOT NULL
            )
            """)
    }

    /// Adds the one signal that comes from the other person's device.
    ///
    /// Defaulting to 0 is safe here and only here: the column means "their device
    /// suppressed the notification", and a row ingested before this column existed will
    /// be rewritten with the real value on the next sync, because the upsert compares
    /// it. Until then `muted_by_them` reports the conservative answer rather than a
    /// fabricated one.
    private func migrateToV2() throws {
        var columns: Set<String> = []
        try query("PRAGMA table_info(message)") { row in
            if let name = row.string(1) { columns.insert(name) }
        }
        guard !columns.contains("was_delivered_quietly") else { return }
        try perform("ALTER TABLE message ADD COLUMN was_delivered_quietly INTEGER NOT NULL DEFAULT 0")
    }

    // MARK: - Metadata

    public func meta(_ key: String) throws -> String? {
        var value: String?
        try query("SELECT value FROM mirror_meta WHERE key = ?", bind: [.text(key)]) { row in
            value = row.string(0)
        }
        return value
    }

    public func setMeta(_ key: String, _ value: String) throws {
        try perform("INSERT INTO mirror_meta (key, value) VALUES (?, ?) "
                    + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    bind: [.text(key), .text(value)])
    }

    /// Highest source ROWID ingested so far — half of the watermark. The other half is
    /// the trailing re-scan window, which lives in `MirrorSync`.
    public func watermarkROWID() throws -> Int64 {
        Int64(try meta("source_max_rowid") ?? "") ?? 0
    }

    public func setWatermarkROWID(_ rowID: Int64) throws {
        try setMeta("source_max_rowid", String(rowID))
    }

    // MARK: - Reads

    public func messageCount() throws -> Int { Int(try scalar("SELECT count(*) FROM message")) }

    public func contains(guid: String) throws -> Bool {
        var found = false
        try query("SELECT 1 FROM message WHERE guid = ?", bind: [.text(guid)]) { _ in found = true }
        return found
    }

    public func text(forGUID guid: String) throws -> String? {
        var text: String?
        try query("SELECT text FROM message WHERE guid = ?", bind: [.text(guid)]) { row in
            text = row.string(0)
        }
        return text
    }

    public func sentAt(forGUID guid: String) throws -> String? {
        var sentAt: String?
        try query("SELECT sent_at FROM message WHERE guid = ?", bind: [.text(guid)]) { row in
            sentAt = row.string(0)
        }
        return sentAt
    }

    /// Full-text search over message bodies. Returns guids, newest first.
    public func search(_ needle: String, limit: Int = 50) throws -> [String] {
        var guids: [String] = []
        try query("""
            SELECT f.guid FROM message_fts f
            JOIN message m ON m.guid = f.guid
            WHERE message_fts MATCH ?
            ORDER BY m.sent_at DESC
            LIMIT ?
            """, bind: [.text(needle), .int(Int64(limit))]) { row in
            if let guid = row.string(0) { guids.append(guid) }
        }
        return guids
    }

    /// One mirrored message, as the metric library reads it.
    ///
    /// The mirror is the only input to the digest. Nothing downstream of here reopens
    /// `chat.db`, so a column missing from this struct is a metric that cannot exist.
    public struct StoredMessage: Sendable {
        public let guid: String
        public let text: String?
        public let handle: String?
        public let service: String?
        public let sentAt: Date?
        public let isFromMe: Bool
        public let associatedMessageType: Int
        public let chatIdentifier: String?
        public let chatStyle: Int
        public let wasDeliveredQuietly: Bool

        /// `associated_message_type` 2000-3999 is a reaction, not a message.
        public var isTapback: Bool { (2000...3999).contains(associatedMessageType) }
        /// `chat.style = 43`.
        public var isGroup: Bool { chatStyle == 43 }
    }

    /// Streams mirrored messages in send order, optionally filtered.
    ///
    /// Ordered by `(sent_at, guid)` rather than by `sent_at` alone: two messages sharing
    /// a second are common, and reply latency and conversation-opener detection both
    /// read consecutive pairs. An unstable order there would make the same mirror
    /// produce different numbers on different runs.
    ///
    /// `predicate` is private and takes only the two compile-time constants its callers
    /// pass; it is never built from input.
    private func forEachMessage(where predicate: String?,
                                _ consume: (StoredMessage) -> Void) throws {
        try query("""
            SELECT guid, text, handle, service, sent_at, is_from_me,
                   associated_message_type, chat_identifier, chat_style,
                   was_delivered_quietly
            FROM message
            WHERE \(predicate ?? "1 = 1")
            ORDER BY sent_at, guid
            """) { row in
            consume(StoredMessage(
                guid: row.string(0) ?? "",
                text: row.string(1),
                handle: row.string(2),
                service: row.string(3),
                sentAt: row.string(4).flatMap(StructuredLog.date(from:)),
                isFromMe: row.bool(5),
                associatedMessageType: row.int(6),
                chatIdentifier: row.string(7),
                chatStyle: row.int(8),
                wasDeliveredQuietly: row.bool(9)
            ))
        }
    }

    /// GUARD ONE: the messages the user wrote, **and that are not tapbacks**.
    ///
    /// CONTRACTS.md § 7, corrected 3 Aug. `is_from_me = 1` alone does **not** keep the
    /// other person's words out:
    ///
    /// > **A tapback the user sent carries `is_from_me = 1` and a body of
    /// > `Loved "<their sentence>"`** — inbound prose, verbatim, inside a row the user
    /// > genuinely wrote.
    ///
    /// Every other layer is blind to it. Guard two finds no PII in
    /// `Loved "see you thursday"` and returns `202`. Guard three compares verbatim, and
    /// `Loved "…"` is not byte-equal to the message it quotes, so it passes. And no
    /// fixture could produce the case until the generator was fixed, so no test could
    /// have caught it.
    ///
    /// **Both conditions are in the SQL, not applied by the caller**, so neither can be
    /// refactored away by someone who does not know what they are for. That is not
    /// hypothetical: the tapback filter exists in more than one place in this codebase as
    /// a *statistics* guard — tapbacks poison length and burst metrics — and a cleanup
    /// done for statistical reasons would have taken the last real privacy protection
    /// with it without anyone noticing.
    public func forEachSentMessage(_ consume: (StoredMessage) -> Void) throws {
        try forEachMessage(where: """
            is_from_me = 1
              AND COALESCE(associated_message_type, 0) NOT BETWEEN 2000 AND 3999
            """, consume)
    }

    /// Streams every mirrored message in send order.
    public func forEachMessage(_ consume: (StoredMessage) -> Void) throws {
        try forEachMessage(where: nil, consume)
    }

    // MARK: - Ingest

    public enum UpsertOutcome: Sendable { case inserted, updated, unchanged }

    /// Insert, update, or recognise as an exact duplicate.
    ///
    /// Keyed on `guid`, never on ROWID. `chat.db` is eventually consistent and
    /// occasionally lossy: it reuses and reassigns ROWIDs across restores, so two rows
    /// carrying the same `guid` are the same message and must collapse to one.
    @discardableResult
    public func upsert(_ message: ChatMessage, seenAt: Date) throws -> UpsertOutcome {
        let sentAt = message.date.map(StructuredLog.timestamp)

        var existing: [String?]?
        try query("""
            SELECT text, handle, service, sent_at, chat_identifier, is_from_me,
                   was_delivered_quietly
            FROM message WHERE guid = ?
            """, bind: [.text(message.guid)]) { row in
            existing = [row.string(0), row.string(1), row.string(2), row.string(3),
                        row.string(4), String(row.int64(5)), String(row.int64(6))]
        }

        let incoming: [String?] = [message.text, message.handle, message.service, sentAt,
                                   message.chatIdentifier, String(message.isFromMe ? 1 : 0),
                                   String(message.wasDeliveredQuietly ? 1 : 0)]

        if let existing {
            // Deliberately compares content, not source_rowid: a restore reassigns
            // ROWIDs wholesale, and rewriting every row on that basis would make the
            // mirror churn without any message having changed.
            guard existing != incoming else { return .unchanged }
            try perform("""
                UPDATE message SET text = ?, has_attributed_body = ?, handle = ?,
                  handle_rowid = ?, service = ?, sent_at = ?, is_from_me = ?,
                  associated_message_type = ?, chat_rowid = ?, chat_identifier = ?,
                  chat_style = ?, source_rowid = ?, was_delivered_quietly = ?
                WHERE guid = ?
                """, bind: bindings(for: message, sentAt: sentAt) + [.text(message.guid)])
            try reindex(message)
            return .updated
        }

        try perform("""
            INSERT INTO message
              (text, has_attributed_body, handle, handle_rowid, service, sent_at,
               is_from_me, associated_message_type, chat_rowid, chat_identifier,
               chat_style, source_rowid, was_delivered_quietly, guid, first_seen_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, bind: bindings(for: message, sentAt: sentAt)
                 + [.text(message.guid), .text(StructuredLog.timestamp(seenAt))])
        try reindex(message)
        return .inserted
    }

    private func bindings(for message: ChatMessage, sentAt: String?) -> [Binding] {
        [.optionalText(message.text),
         .int(message.hasAttributedBody ? 1 : 0),
         .optionalText(message.handle),
         .int(message.handleRowID),
         .optionalText(message.service),
         .optionalText(sentAt),
         .int(message.isFromMe ? 1 : 0),
         .int(Int64(message.associatedMessageType)),
         .int(message.chatRowID),
         .optionalText(message.chatIdentifier),
         .int(Int64(message.chatStyle)),
         .int(message.rowID),
         .int(message.wasDeliveredQuietly ? 1 : 0)]
    }

    private func reindex(_ message: ChatMessage) throws {
        try perform("DELETE FROM message_fts WHERE guid = ?", bind: [.text(message.guid)])
        guard let text = message.text, !text.isEmpty else { return }
        try perform("INSERT INTO message_fts (guid, text) VALUES (?, ?)",
                    bind: [.text(message.guid), .text(text)])
    }

    public func transaction<T>(_ body: () throws -> T) throws -> T {
        try perform("BEGIN IMMEDIATE")
        do {
            let value = try body()
            try perform("COMMIT")
            return value
        } catch {
            try? perform("ROLLBACK")
            throw error
        }
    }

    // MARK: - SQLite plumbing

    public enum Binding: Sendable {
        case int(Int64)
        case text(String)
        case optionalText(String?)
    }

    private func perform(_ sql: String, bind: [Binding] = []) throws {
        try query(sql, bind: bind) { _ in }
    }

    private func scalar(_ sql: String) throws -> Int64 {
        var value: Int64 = 0
        try query(sql) { row in value = row.int64(0) }
        return value
    }

    private func query(_ sql: String,
                       bind: [Binding] = [],
                       consume: (ChatDatabase.Row) -> Void) throws {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK,
              let statement else {
            throw Error.failed(sql: sql, message: String(cString: sqlite3_errmsg(handle)))
        }
        defer { sqlite3_finalize(statement) }

        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (offset, value) in bind.enumerated() {
            let index = Int32(offset + 1)
            let rc: Int32
            switch value {
            case .int(let number):
                rc = sqlite3_bind_int64(statement, index, number)
            case .text(let string):
                rc = sqlite3_bind_text(statement, index, string, -1, transient)
            case .optionalText(let string):
                rc = string.map { sqlite3_bind_text(statement, index, $0, -1, transient) }
                    ?? sqlite3_bind_null(statement, index)
            }
            guard rc == SQLITE_OK else {
                throw Error.failed(sql: sql, message: String(cString: sqlite3_errmsg(handle)))
            }
        }

        while true {
            let rc = sqlite3_step(statement)
            if rc == SQLITE_ROW {
                consume(ChatDatabase.Row(statement: statement))
            } else if rc == SQLITE_DONE {
                return
            } else {
                throw Error.failed(sql: sql, message: String(cString: sqlite3_errmsg(handle)))
            }
        }
    }
}
