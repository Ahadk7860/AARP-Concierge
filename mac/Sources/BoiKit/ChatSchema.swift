import Foundation

/// Checks that `chat.db` still has the columns this track reads.
///
/// Apple renames and drops columns across macOS releases without notice. The failure
/// mode that matters is not a crash — it is a query that still parses, returns zero
/// rows, and gets reported as "you don't text anyone much." So a missing column is a
/// named, loud error raised at open time, before any count can be computed from it.
public enum ChatSchema {

    public static let version = 1

    /// Columns this track depends on. Anything not listed here is a column we may read
    /// opportunistically but must never require.
    public static let required: [String: Set<String>] = [
        // cache_has_attachments is required because the decoder metric depends on it:
        // attachment-only rows must be classified from Apple's own attachment evidence,
        // never from the decoder's output. A decoder that grades its own failures as
        // "that one was just a photo" exonerates itself.
        "message": ["ROWID", "guid", "text", "handle_id", "service", "date",
                    "is_from_me", "associated_message_type", "attributedBody",
                    "cache_has_attachments"],
        "chat": ["ROWID", "guid", "style", "chat_identifier"],
        "chat_message_join": ["chat_id", "message_id"],
        "message_attachment_join": ["message_id", "attachment_id"],
        "handle": ["ROWID", "id"],
    ]

    public enum Error: Swift.Error, CustomStringConvertible {
        case missingTable(String)
        case missingColumns(table: String, columns: [String])

        public var description: String {
            switch self {
            case .missingTable(let table):
                return "chat.db has no `\(table)` table. This is not a chat.db, or its "
                    + "schema changed. Refusing to read rather than report zero."
            case .missingColumns(let table, let columns):
                return "chat.db `\(table)` is missing \(columns.sorted().joined(separator: ", ")). "
                    + "Apple changed the schema. Refusing to read rather than silently "
                    + "returning zero rows, which reads as a thin corpus and not as a bug."
            }
        }
    }

    /// Throws unless every required table and column is present.
    public static func verify(_ database: ChatDatabase) throws {
        for (table, columns) in required {
            var found: Set<String> = []
            // PRAGMA table_info is a query, not a statement with parameters, and the
            // table names are compile-time constants from `required` above.
            try database.query("PRAGMA table_info(\(table))") { row in
                if let name = row.string(1) { found.insert(name) }
            }
            guard !found.isEmpty else { throw Error.missingTable(table) }

            // ROWID never appears in table_info; it exists unless the table was
            // declared WITHOUT ROWID, which chat.db's never are.
            let missing = columns.subtracting(found).subtracting(["ROWID"])
            guard missing.isEmpty else {
                throw Error.missingColumns(table: table, columns: Array(missing))
            }
        }
    }
}
