import Foundation
import SQLite3

/// The Mac-side query engine behind the `ask_device` "search" op (V3_ARCHITECTURE.md
/// §4.3, AGENT_ARCHITECTURE.md §5A).
///
/// Runs against the durable mirror (`mirror.db`) — `message` joined with the FTS5
/// index `message_fts` that `MirrorDatabase`/`MirrorSync` already build and keep in
/// step on every ingest. This type owns its own **read-only** SQLite connection rather
/// than sharing `MirrorDatabase`'s handle: a search must never contend with a sync
/// writer's lock, and SQLite's WAL mode (already enabled by `MirrorDatabase.migrate()`)
/// lets a read-only connection proceed regardless of what the writer is doing.
///
/// **The whole competitive claim in §5A lives in one property of the SQL below**: `who`
/// and the date range are bound into the `WHERE` clause — a `handle IN (...)` list and
/// a `sent_at BETWEEN` range — so SQLite narrows the candidate set *before* ranking,
/// never after. Apple's on-device search has no per-contact index to do this with; a
/// version of this file that fetched the top-N globally and then filtered by handle in
/// Swift would look identical in a demo and lose exactly the property that matters once
/// a thread is buried under thousands of messages with other people.
public final class SearchIndex {

    public enum Error: Swift.Error, CustomStringConvertible {
        case cannotOpen(path: String, message: String)
        case queryFailed(message: String)

        public var description: String {
            switch self {
            case .cannotOpen(let path, let message):
                return "cannot open mirror at \(path) for search: \(message)"
            case .queryFailed(let message):
                return "search query failed: \(message)"
            }
        }
    }

    private var handle: OpaquePointer?
    public let path: String

    /// Maps a raw `message.handle` value to the identifier the wire response reports as
    /// `person_id`. Defaults to the raw handle, which is what V3_ARCHITECTURE.md §4.1
    /// calls out as correct for v3's "one identity per person" simplification —
    /// iMessage is the only source, so `contact_id` and `person_id` coincide. Inject
    /// the same HMAC scheme `ContactResolver.identifier(forNormalizedHandle:)` uses so
    /// search results key identically to everything else the Mac reports; this type
    /// deliberately does not import `ContactResolver` itself (owned by Track D) to keep
    /// the query engine testable without an AddressBook directory in play.
    public var personID: (String) -> String

    public init(path: String, personID: @escaping (String) -> String = { $0 }) throws {
        self.path = path
        self.personID = personID
        var opened: OpaquePointer?
        let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX
        guard sqlite3_open_v2(path, &opened, flags, nil) == SQLITE_OK, let opened else {
            let message = opened.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
            sqlite3_close_v2(opened)
            throw Error.cannotOpen(path: path, message: message)
        }
        self.handle = opened
    }

    deinit { sqlite3_close_v2(handle) }

    /// Every distinct handle the mirror has ever seen. Feeds `WhoResolver`, which turns
    /// a free-text `who` hint into the exact set this method's `whoFilterHandles` wants.
    /// Cheap: one indexed pass, and handle cardinality is a small fraction of message
    /// count even on a large corpus.
    public func distinctHandles() throws -> [String] {
        var handles: [String] = []
        try query("SELECT DISTINCT handle FROM message WHERE handle IS NOT NULL", bind: []) { row in
            if let value = row.string(0) { handles.append(value) }
        }
        return handles
    }

    /// One search.
    ///
    /// - Parameters:
    ///   - whoFilterHandles: the exact `message.handle` values to search within, already
    ///     resolved from the agent's `who` hint by `WhoResolver`. `nil` means no `who`
    ///     hint was given (search everyone). A non-nil **empty** array means the hint
    ///     matched nobody — the query returns nothing rather than silently widening to
    ///     everyone, which would be a worse answer than an honest empty result.
    ///   - whenFrom / whenTo: ISO 8601 strings, compared directly against `sent_at`
    ///     (stored in the same format), matching §4.3's `when_from`/`when_to`.
    public func search(
        query queryText: String,
        whoFilterHandles: [String]? = nil,
        whenFrom: String? = nil,
        whenTo: String? = nil,
        limit: Int
    ) throws -> [AskDeviceSearchResultRow] {
        guard !queryText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        if let whoFilterHandles, whoFilterHandles.isEmpty { return [] }

        var clauses: [String] = []
        var binds: [Binding] = [.text(SearchIndex.ftsQuery(queryText))]

        if let whoFilterHandles {
            let placeholders = whoFilterHandles.map { _ in "?" }.joined(separator: ",")
            clauses.append("m.handle IN (\(placeholders))")
            binds.append(contentsOf: whoFilterHandles.map { Binding.text($0) })
        }
        if let whenFrom {
            clauses.append("m.sent_at >= ?")
            binds.append(.text(whenFrom))
        }
        if let whenTo {
            clauses.append("m.sent_at <= ?")
            binds.append(.text(whenTo))
        }
        // A tapback a user sent carries a body like `Loved "see you thursday"` — see
        // MirrorDatabase's `forEachSentMessage` for the fuller history of why this
        // exact range check exists. Here it just keeps reaction noise out of search
        // results, which would otherwise rank highly on very short indexed text.
        clauses.append("COALESCE(m.associated_message_type, 0) NOT BETWEEN 2000 AND 3999")

        let whereExtra = clauses.map { "AND \($0)" }.joined(separator: "\n              ")

        let sql = """
            SELECT f.guid, m.handle, m.sent_at, m.chat_identifier,
                   snippet(message_fts, 1, '[', ']', '…', 12) AS snip,
                   bm25(message_fts) AS rank
            FROM message_fts f
            JOIN message m ON m.guid = f.guid
            WHERE message_fts MATCH ?
              \(whereExtra)
            ORDER BY rank
            LIMIT ?
            """
        binds.append(.int(Int64(max(1, min(limit, 100)))))

        var rows: [AskDeviceSearchResultRow] = []
        try query(sql, bind: binds) { row in
            let handleValue = row.string(1) ?? ""
            let sentAt = row.string(2) ?? ""
            let chatIdentifier = row.string(3)
            let snippet = row.string(4) ?? ""
            let bm25Rank = row.double(5)
            rows.append(AskDeviceSearchResultRow(
                person_id: self.personID(handleValue),
                when: sentAt,
                snippet: snippet,
                // A 1:1 thread's chat_identifier is sometimes the bare handle rather
                // than a `chat…` guid (seen in the real mirror); when it's genuinely
                // absent, synthesize a stable per-handle thread key rather than
                // returning an empty string the caller cannot key on.
                thread_id: chatIdentifier ?? "dm:\(handleValue)",
                score: SearchIndex.normalizeScore(bm25Rank)
            ))
        }
        return rows
    }

    /// FTS5's `bm25()` is unbounded and *lower is better* (more negative = stronger
    /// match) — the opposite of what the wire contract's `score` field implies to a
    /// reader. Folded into `(0, 1]`: the best match in a result set approaches 1, a weak
    /// match approaches 0, and the ordering is preserved exactly (this is monotonic in
    /// `bm25`), so ranking downstream of the wire protocol never has to know SQLite's
    /// sign convention.
    static func normalizeScore(_ bm25: Double) -> Double {
        1.0 / (1.0 + abs(bm25))
    }

    /// FTS5 query syntax is not free text: a bare `"`, a leading `-`, or `*` changes
    /// meaning or throws a syntax error at query time. Quoting each token turns the
    /// user's words into an implicit AND of literal-phrase tokens, so a query like
    /// `what's -- the trip?` cannot crash on the apostrophe or be reinterpreted as a
    /// NOT operator or a prefix wildcard.
    static func ftsQuery(_ raw: String) -> String {
        let tokens = raw
            .split(whereSeparator: { $0.isWhitespace })
            .map { String($0).replacingOccurrences(of: "\"", with: "") }
            .filter { !$0.isEmpty }
        guard !tokens.isEmpty else { return "\"\"" }
        return tokens.map { "\"\($0)\"" }.joined(separator: " ")
    }

    // MARK: - SQLite plumbing
    //
    // Deliberately self-contained rather than sharing `ChatDatabase.Row` /
    // `MirrorDatabase`'s private helpers — this file has no dependency on how those
    // evolve, and a search path with its own small, auditable surface is easier to
    // reason about than one threaded through another file's internals.

    enum Binding {
        case int(Int64)
        case text(String)
    }

    struct Row {
        let statement: OpaquePointer

        func string(_ column: Int32) -> String? {
            guard let raw = sqlite3_column_text(statement, column) else { return nil }
            return String(cString: raw)
        }

        func double(_ column: Int32) -> Double { sqlite3_column_double(statement, column) }
    }

    private func query(_ sql: String, bind: [Binding], consume: (Row) -> Void) throws {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw Error.queryFailed(message: String(cString: sqlite3_errmsg(handle)))
        }
        defer { sqlite3_finalize(statement) }

        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (offset, value) in bind.enumerated() {
            let index = Int32(offset + 1)
            switch value {
            case .int(let number):
                sqlite3_bind_int64(statement, index, number)
            case .text(let string):
                sqlite3_bind_text(statement, index, string, -1, transient)
            }
        }

        while true {
            let rc = sqlite3_step(statement)
            if rc == SQLITE_ROW {
                consume(Row(statement: statement))
            } else if rc == SQLITE_DONE {
                break
            } else {
                throw Error.queryFailed(message: String(cString: sqlite3_errmsg(handle)))
            }
        }
    }
}

/// Turns the agent's free-text `who` hint ("Maya", "+1592…", "abhaya@…") into the exact
/// set of `message.handle` values `SearchIndex.search` should filter on. This is what
/// "narrowing by contact before searching" means concretely: the hint becomes a set
/// membership the SQL WHERE clause enforces, not a label attached to results after the
/// fact.
public struct WhoResolver {
    /// Best-effort display name for a handle, when one is known (e.g. from
    /// `ContactResolver.displayName(forNormalizedHandle:)`, injected by the caller).
    /// Returning `nil` for every handle still lets hints that are themselves a phone
    /// fragment or an email fragment resolve correctly against the raw handle text —
    /// there is no hard dependency on a contacts directory being available.
    public var displayName: (String) -> String?

    public init(displayName: @escaping (String) -> String? = { _ in nil }) {
        self.displayName = displayName
    }

    /// `who`, empty or all-whitespace, is treated as "no filter" — `nil` — the caller
    /// then passes `nil` to `SearchIndex.search`, never an unfiltered "everyone" list
    /// reconstructed from `distinctHandles`, since that list can be very large.
    public func resolve(who: String, distinctHandles: [String]) -> [String]? {
        let needle = who.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return nil }
        return distinctHandles.filter { handle in
            if handle.lowercased().contains(needle) { return true }
            if let name = displayName(handle)?.lowercased(), name.contains(needle) { return true }
            return false
        }
    }
}
