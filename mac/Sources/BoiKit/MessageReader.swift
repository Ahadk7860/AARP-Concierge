import Foundation

/// One `message` row, joined to the chat it belongs to.
public struct ChatMessage: Sendable, Equatable {
    public let rowID: Int64
    public let guid: String
    /// The message body, from the `text` column **or** recovered from `attributedBody`.
    ///
    /// This is the single text path. Everything downstream — mirror, metrics, voice
    /// pack — reads this and never touches `attributedBody` itself, so there is exactly
    /// one place where "half the corpus is missing" can be introduced or fixed.
    /// `nil` means no recoverable text, which the coverage report counts.
    public let text: String?
    /// Where `text` came from. Carried so the coverage metric is a property of the data
    /// rather than a separate re-scan that could drift from what the reader does.
    public let textSource: TextSource
    public let hasAttributedBody: Bool
    public let handleRowID: Int64
    public let handle: String?
    public let service: String?
    public let date: Date?
    public let isFromMe: Bool
    public let associatedMessageType: Int
    public let chatRowID: Int64
    public let chatIdentifier: String?
    public let chatStyle: Int

    /// Where a message's text came from.
    public enum TextSource: String, Sendable, Codable {
        /// The `text` column was populated.
        case column
        /// Recovered by decoding `attributedBody`.
        case attributedBody = "attributed_body"
        /// The blob decoded cleanly and contained no text — only the attachment
        /// placeholder. An image or file message. There is nothing here for a decoder
        /// to recover and never was, so this is not a failure; it is a message that is
        /// not made of words.
        case attachmentOnly = "attachment_only"
        /// No text column, and either no blob at all or a blob that would not decode.
        /// This is the only bucket that can contain a decoder bug.
        case unrecoverable
    }
}

/// Which rows a scan keeps.
public struct ScanOptions: Sendable {
    /// Tapbacks (`associated_message_type` 2000-3999) are reactions, not messages.
    /// Counting them inflates every volume metric and corrupts the ranking.
    public var excludeTapbacks: Bool
    /// `chat.style = 43` is a group thread. The 1:1 read excludes them; whole-life
    /// metrics in a later prompt may want them back, which is why this is a knob.
    public var excludeGroupChats: Bool
    public var limit: Int?
    /// Keep rows joined to no chat at all. The 1:1 read does not want them; the mirror
    /// does, because the mirror keeps everything it has ever seen.
    public var includeMessagesInNoChat: Bool
    /// Incremental selection: keep a row if its ROWID is above this **or** its date is
    /// at or after `newerThan`. The two are OR'd, never AND'd — that is the whole
    /// backfill defence.
    public var afterROWID: Int64?
    public var newerThan: Date?

    public init(excludeTapbacks: Bool = true,
                excludeGroupChats: Bool = true,
                limit: Int? = nil,
                includeMessagesInNoChat: Bool = false,
                afterROWID: Int64? = nil,
                newerThan: Date? = nil) {
        self.excludeTapbacks = excludeTapbacks
        self.excludeGroupChats = excludeGroupChats
        self.limit = limit
        self.includeMessagesInNoChat = includeMessagesInNoChat
        self.afterROWID = afterROWID
        self.newerThan = newerThan
    }

    public static let oneToOne = ScanOptions()

    /// Everything, unfiltered — what the mirror ingests. Tapbacks, group threads and
    /// chat-less rows all belong in the durable record; filtering is a query concern.
    public static let everything = ScanOptions(excludeTapbacks: false,
                                               excludeGroupChats: false,
                                               includeMessagesInNoChat: true)
}

/// What one pass over the database saw.
public struct ScanResult: Sendable {
    /// `SELECT count(*) FROM message` — every row, no filtering, no joins. This is the
    /// number the WAL check compares against, because the WAL-only fixture row has no
    /// `chat_message_join` entry and so appears in no thread.
    public let rawMessageCount: Int
    /// Rows kept after the scan's filters.
    public let matchedCount: Int
    public let maxROWID: Int64
    public let excludedTapbackCount: Int
    public let excludedGroupChatCount: Int
    public let rowsInNoChat: Int
    public let messagesWithoutText: Int
    public let threadCount: Int
    public let scannedAt: Date
    /// Populated only when the caller asked for rows.
    public let messages: [ChatMessage]
}

/// Reads `chat.db`. No writes, no network, no cache.
public struct MessageReader {

    private let database: ChatDatabase

    /// Verifies the source schema before any query can run against it.
    ///
    /// A renamed column does not crash a query that never mentions it — it produces a
    /// smaller number. "You don't text anyone much" is indistinguishable from a bug,
    /// so the schema check happens at open time and fails by name.
    public init(database: ChatDatabase) throws {
        try ChatSchema.verify(database)
        self.database = database
    }

    public init(path: String) throws {
        try self.init(database: try ChatDatabase(path: path))
    }

    public var path: String { database.path }

    // MARK: - Counts

    /// `SELECT count(*) FROM message`, unfiltered.
    public func rawMessageCount() throws -> Int {
        Int(try database.scalar("SELECT count(*) FROM message"))
    }

    /// The watermark used only as a liveness signal here.
    ///
    /// NOT an ingestion watermark: backfilled messages arrive with new ROWIDs and old
    /// dates, so `MAX(ROWID)` alone silently skips them. Prompt 02 pairs it with a
    /// trailing re-scan and dedup by `guid`.
    public func maxROWID() throws -> Int64 {
        try database.scalar("SELECT coalesce(max(ROWID), 0) FROM message")
    }

    /// COUNT(DISTINCT m.ROWID), NOT count(*).
    ///
    /// A message routinely joins more than one `chat` row on a real database — thread
    /// merges, a contact whose handle changed from a phone number to an Apple ID, an
    /// iMessage thread that fell back to SMS. Each of those adds a
    /// `chat_message_join` row, so `count(*)` over the join counts one message several
    /// times and inflates every volume metric built on it. The synthetic fixture
    /// writes exactly one join row per message and therefore hides this entirely.
    public func count(options: ScanOptions = .oneToOne) throws -> Int {
        Int(try database.scalar("""
            SELECT count(DISTINCT m.ROWID) FROM message m \(Self.joinClause(options)) \(Self.whereClause(options))
            """))
    }

    /// Tapbacks that the 1:1 read drops — reactions attached to a non-group thread.
    public func excludedTapbackCount() throws -> Int {
        Int(try database.scalar("""
            SELECT count(DISTINCT m.ROWID) FROM message m \(Self.joinClause)
            WHERE coalesce(c.style, 0) <> 43
              AND coalesce(m.associated_message_type, 0) BETWEEN 2000 AND 3999
            """))
    }

    /// Rows the 1:1 read drops for living in a group thread (`chat.style = 43`).
    ///
    /// Counted as messages that appear in *no* non-group thread, so a message living in
    /// both a group and a 1:1 is not double-counted against the kept set.
    public func excludedGroupChatCount() throws -> Int {
        Int(try database.scalar("""
            SELECT count(DISTINCT m.ROWID) FROM message m \(Self.joinClause)
            WHERE coalesce(c.style, 0) = 43
              AND NOT EXISTS (
                SELECT 1 FROM chat_message_join j2
                JOIN chat c2 ON c2.ROWID = j2.chat_id
                WHERE j2.message_id = m.ROWID AND coalesce(c2.style, 0) <> 43
              )
            """))
    }

    /// Rows joined to no chat at all. Real databases have them and so does the
    /// fixture: the WAL-only row is one.
    public func rowsInNoChatCount() throws -> Int {
        Int(try database.scalar("""
            SELECT count(*) FROM message m
            WHERE NOT EXISTS (SELECT 1 FROM chat_message_join j WHERE j.message_id = m.ROWID)
            """))
    }

    public func threadCount(options: ScanOptions = .oneToOne) throws -> Int {
        Int(try database.scalar("""
            SELECT count(DISTINCT c.ROWID) FROM message m \(Self.joinClause(options)) \(Self.whereClause(options))
            """))
    }

    /// The raw typedstream for one row. Used only to capture local test fixtures; the
    /// reading path itself never hands a blob to a caller.
    public func attributedBody(forROWID rowID: Int64) throws -> Data? {
        var blob: Data?
        try database.query("SELECT attributedBody FROM message WHERE ROWID = ?",
                           bind: [rowID]) { row in
            blob = row.blob(0)
        }
        return blob
    }

    // MARK: - Scan

    /// One full pass. `loadMessages: false` keeps the row set out of memory when the
    /// caller only wants the counts.
    public func scan(options: ScanOptions = .oneToOne,
                     loadMessages: Bool = false,
                     now: Date = Date()) throws -> ScanResult {
        var messages: [ChatMessage] = []
        var withoutText = 0

        if loadMessages {
            messages.reserveCapacity(min(options.limit ?? 4096, 4096))
            try database.query(Self.selectClause + " \(Self.joinClause(options)) \(Self.whereClause(options)) \(Self.groupClause) ORDER BY m.ROWID" + (options.limit.map { " LIMIT \($0)" } ?? "")) { row in
                let message = Self.message(from: row)
                if message.text == nil { withoutText += 1 }
                messages.append(message)
            }
        } else {
            withoutText = Int(try database.scalar("""
                SELECT count(DISTINCT m.ROWID) FROM message m \(Self.joinClause(options)) \(Self.whereClause(options))
                  AND m.text IS NULL
                """))
        }

        return ScanResult(
            rawMessageCount: try rawMessageCount(),
            matchedCount: loadMessages ? messages.count : try count(options: options),
            maxROWID: try maxROWID(),
            excludedTapbackCount: try excludedTapbackCount(),
            excludedGroupChatCount: try excludedGroupChatCount(),
            rowsInNoChat: try rowsInNoChatCount(),
            messagesWithoutText: withoutText,
            threadCount: try threadCount(options: options),
            scannedAt: now,
            messages: messages
        )
    }

    // MARK: - SQL

    private static let selectClause = """
        SELECT m.ROWID, m.guid, m.text, m.attributedBody, m.handle_id,
               h.id, m.service, m.date, m.is_from_me,
               coalesce(m.associated_message_type, 0), min(c.ROWID), c.chat_identifier,
               coalesce(c.style, 0),
               coalesce(m.cache_has_attachments, 0)
                 OR EXISTS (SELECT 1 FROM message_attachment_join maj
                            WHERE maj.message_id = m.ROWID)
        FROM message m
        """

    /// One row per message, not one row per (message, chat) pair — see `count`.
    ///
    /// `min(c.ROWID)` is not decoration. SQLite guarantees that when a query uses
    /// exactly one `min()` or `max()` aggregate, the bare columns beside it come from
    /// the row that produced that extreme, so `chat_identifier` and `style` are read
    /// from the same chat whose ROWID is reported, rather than from an arbitrary one.
    private static let groupClause = "GROUP BY m.ROWID"

    private static let joinClause = joins(leftOuter: false)

    private static func joins(leftOuter: Bool) -> String {
        let join = leftOuter ? "LEFT JOIN" : "JOIN"
        return """
            \(join) chat_message_join j ON j.message_id = m.ROWID
            \(join) chat c ON c.ROWID = j.chat_id
            LEFT JOIN handle h ON h.ROWID = m.handle_id
            """
    }

    private static func joinClause(_ options: ScanOptions) -> String {
        joins(leftOuter: options.includeMessagesInNoChat)
    }

    private static func whereClause(_ options: ScanOptions) -> String {
        var predicates = ["1 = 1"]
        if options.excludeGroupChats {
            predicates.append("coalesce(c.style, 0) <> 43")
        }
        if options.excludeTapbacks {
            predicates.append("coalesce(m.associated_message_type, 0) NOT BETWEEN 2000 AND 3999")
        }
        if let incremental = incrementalPredicate(options) {
            predicates.append(incremental)
        }
        return "WHERE " + predicates.joined(separator: " AND ")
    }

    /// `ROWID > watermark OR date >= cutoff`.
    ///
    /// OR, never AND. A ROWID-only watermark misses any row that arrives with an id
    /// below the high-water mark — which happens whenever a transaction commits after
    /// one with a larger id, and on every restore and iCloud resync. A date-only
    /// watermark misses backfill, which arrives with a fresh id and an old date. Each
    /// alone loses messages silently; together they cannot.
    private static func incrementalPredicate(_ options: ScanOptions) -> String? {
        var clauses: [String] = []
        if let afterROWID = options.afterROWID {
            clauses.append("m.ROWID > \(afterROWID)")
        }
        if let newerThan = options.newerThan {
            // chat.db mixes units in one column: nanoseconds since the 2001 epoch on
            // modern rows, seconds on pre-High-Sierra ones. Compare in whichever unit
            // the row is actually stored in.
            let seconds = Int64(newerThan.timeIntervalSinceReferenceDate)
            let nanoseconds = seconds * 1_000_000_000
            clauses.append("""
                (m.date >= \(nanoseconds) \
                OR (abs(m.date) <= \(appleSecondsCeiling) AND m.date >= \(seconds)))
                """)
        }
        guard !clauses.isEmpty else { return nil }
        return "(" + clauses.joined(separator: " OR ") + ")"
    }

    /// Above this, a raw `message.date` is nanoseconds; at or below, seconds.
    static let appleSecondsCeiling: Int64 = 100_000_000_000

    private static func message(from row: ChatDatabase.Row) -> ChatMessage {
        // THE SINGLE TEXT PATH: `text` when the column has it, otherwise decode the
        // typedstream. Nothing downstream reads attributedBody directly.
        let blob = row.blob(3)
        let hasAttachment = row.bool(13)
        let columnText = row.string(2).flatMap { $0.isEmpty ? nil : $0 }

        var text = columnText
        let source: ChatMessage.TextSource
        if columnText != nil {
            source = .column
        } else {
            switch blob.map(TypedStream.decode) ?? .undecodable {
            case .text(let recovered):
                text = recovered
                source = .attributedBody
            case .attachmentOnly:
                // Apple's evidence decides this, not the decoder's own output.
                source = hasAttachment ? .attachmentOnly : .unrecoverable
            case .undecodable:
                source = .unrecoverable
            }
        }

        return ChatMessage(
            rowID: row.int64(0),
            guid: row.string(1) ?? "",
            text: text,
            textSource: source,
            hasAttributedBody: blob != nil,
            handleRowID: row.int64(4),
            handle: row.string(5),
            service: row.string(6),
            date: appleDate(row.isNull(7) ? nil : row.int64(7)),
            isFromMe: row.bool(8),
            associatedMessageType: row.int(9),
            chatRowID: row.int64(10),
            chatIdentifier: row.string(11),
            chatStyle: row.int(12)
        )
    }

    /// `message.date` counts from 2001-01-01 UTC. Post-High-Sierra rows are in
    /// nanoseconds; older rows in the same table are in seconds. Guessing wrong puts a
    /// message in the year 2001 or the year 4000, which quietly wrecks every recency
    /// metric, so switch on magnitude rather than assuming.
    public static func appleDate(_ raw: Int64?) -> Date? {
        guard let raw, raw != 0 else { return nil }
        let seconds = abs(raw) > appleSecondsCeiling ? Double(raw) / 1_000_000_000 : Double(raw)
        return Date(timeIntervalSinceReferenceDate: seconds)
    }
}
