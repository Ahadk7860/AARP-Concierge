import Foundation

/// One `message` row, joined to the chat it belongs to.
public struct ChatMessage: Sendable, Equatable {
    public let rowID: Int64
    public let guid: String
    /// `nil` when the row carries its body in `attributedBody` instead. Prompt 03
    /// decodes those; until then a NULL-text row is a row with no text.
    public let text: String?
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

    public init(excludeTapbacks: Bool = true, excludeGroupChats: Bool = true, limit: Int? = nil) {
        self.excludeTapbacks = excludeTapbacks
        self.excludeGroupChats = excludeGroupChats
        self.limit = limit
    }

    public static let oneToOne = ScanOptions()
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

    public init(database: ChatDatabase) {
        self.database = database
    }

    public init(path: String) throws {
        self.init(database: try ChatDatabase(path: path))
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

    public func count(options: ScanOptions = .oneToOne) throws -> Int {
        Int(try database.scalar("SELECT count(*) FROM message m \(Self.joinClause) \(Self.whereClause(options))"))
    }

    /// Tapbacks that the 1:1 read drops — reactions attached to a non-group thread.
    public func excludedTapbackCount() throws -> Int {
        Int(try database.scalar("""
            SELECT count(*) FROM message m \(Self.joinClause)
            WHERE coalesce(c.style, 0) <> 43
              AND coalesce(m.associated_message_type, 0) BETWEEN 2000 AND 3999
            """))
    }

    /// Rows the 1:1 read drops for living in a group thread (`chat.style = 43`).
    public func excludedGroupChatCount() throws -> Int {
        Int(try database.scalar("""
            SELECT count(*) FROM message m \(Self.joinClause)
            WHERE coalesce(c.style, 0) = 43
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
            SELECT count(DISTINCT c.ROWID) FROM message m \(Self.joinClause) \(Self.whereClause(options))
            """))
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
            try database.query(Self.selectClause + " \(Self.joinClause) \(Self.whereClause(options)) ORDER BY m.ROWID" + (options.limit.map { " LIMIT \($0)" } ?? "")) { row in
                let message = Self.message(from: row)
                if message.text == nil { withoutText += 1 }
                messages.append(message)
            }
        } else {
            withoutText = Int(try database.scalar("""
                SELECT count(*) FROM message m \(Self.joinClause) \(Self.whereClause(options))
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
        SELECT m.ROWID, m.guid, m.text, m.attributedBody IS NOT NULL, m.handle_id,
               h.id, m.service, m.date, m.is_from_me,
               coalesce(m.associated_message_type, 0), c.ROWID, c.chat_identifier,
               coalesce(c.style, 0)
        FROM message m
        """

    private static let joinClause = """
        JOIN chat_message_join j ON j.message_id = m.ROWID
        JOIN chat c ON c.ROWID = j.chat_id
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        """

    private static func whereClause(_ options: ScanOptions) -> String {
        var predicates = ["1 = 1"]
        if options.excludeGroupChats {
            predicates.append("coalesce(c.style, 0) <> 43")
        }
        if options.excludeTapbacks {
            predicates.append("coalesce(m.associated_message_type, 0) NOT BETWEEN 2000 AND 3999")
        }
        return "WHERE " + predicates.joined(separator: " AND ")
    }

    private static func message(from row: ChatDatabase.Row) -> ChatMessage {
        ChatMessage(
            rowID: row.int64(0),
            guid: row.string(1) ?? "",
            text: row.string(2),
            hasAttributedBody: row.bool(3),
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
        let seconds = abs(raw) > 100_000_000_000 ? Double(raw) / 1_000_000_000 : Double(raw)
        return Date(timeIntervalSinceReferenceDate: seconds)
    }
}
