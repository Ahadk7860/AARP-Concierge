import XCTest
@testable import BoiKit

/// Builds small, purpose-made `chat.db` files.
///
/// The shared fixture is deliberately realistic, which makes it a poor instrument for
/// the cases below: it writes one join row per message, never reuses a ROWID, and has
/// no gaps. Several of these tests need exactly the shapes it does not produce.
enum ChatDBBuilder {

    /// The subset of the real schema this track reads. Must satisfy `ChatSchema`.
    static let schema = """
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER,
                           chat_identifier TEXT, service_name TEXT);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT,
                              handle_id INTEGER, service TEXT, date INTEGER,
                              is_from_me INTEGER, associated_message_type INTEGER,
                              attributedBody BLOB, cache_has_attachments INTEGER);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER,
                                        message_date INTEGER);
        CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
        INSERT INTO handle VALUES (1, '+15550100001', 'iMessage');
        INSERT INTO chat VALUES (1, 'iMessage;-;+15550100001', 45, '+15550100001', 'iMessage');
        """

    /// Apple's epoch is 2001-01-01; modern rows count nanoseconds from it.
    static func appleNanos(daysAgo: Int, from now: Date = Date()) -> Int64 {
        let when = now.addingTimeInterval(-Double(daysAgo) * 86_400)
        return Int64(when.timeIntervalSinceReferenceDate) * 1_000_000_000
    }

    static func insert(rowID: Int64, guid: String, text: String, daysAgo: Int,
                       isFromMe: Int = 0, join: Bool = true,
                       from now: Date = Date()) -> String {
        let date = appleNanos(daysAgo: daysAgo, from: now)
        var sql = """
            INSERT INTO message (ROWID, guid, text, handle_id, service, date, is_from_me,
                                 associated_message_type, attributedBody,
                                 cache_has_attachments)
            VALUES (\(rowID), '\(guid)', '\(text)', 1, 'iMessage',
                    \(date), \(isFromMe), 0, NULL, 0);
            """
        if join {
            sql += "\nINSERT INTO chat_message_join VALUES (1, \(rowID), \(date));"
        }
        return sql
    }

    /// Creates a database at a fresh temporary path and returns it.
    static func make(_ statements: String, label: String) throws -> String {
        let path = "/tmp/boi-a/tests/\(label)-\(UUID().uuidString).db"
        try FileManager.default.createDirectory(atPath: "/tmp/boi-a/tests",
                                                withIntermediateDirectories: true)
        try Fixture.run("/usr/bin/sqlite3", [path, schema + "\n" + statements])
        guard FileManager.default.fileExists(atPath: path) else {
            throw Fixture.FixtureUnavailable(detail: "could not build \(path)")
        }
        return path
    }

    @discardableResult
    static func apply(_ sql: String, to path: String) throws -> String {
        try Fixture.run("/usr/bin/sqlite3", [path, sql])
    }
}

final class MirrorTests: XCTestCase {

    private var mirrorPath = ""

    override func setUpWithError() throws {
        try super.setUpWithError()
        try FileManager.default.createDirectory(atPath: "/tmp/boi-a/tests",
                                                withIntermediateDirectories: true)
        mirrorPath = "/tmp/boi-a/tests/mirror-\(UUID().uuidString).db"
    }

    override func tearDown() {
        for suffix in ["", "-wal", "-shm"] {
            try? FileManager.default.removeItem(atPath: mirrorPath + suffix)
        }
        super.tearDown()
    }

    private func sync(_ chatPath: String, now: Date = Date()) throws -> MirrorSync.Stats {
        let reader = try MessageReader(path: chatPath)
        let mirror = try MirrorDatabase(path: mirrorPath)
        return try MirrorSync(reader: reader, mirror: mirror).run(now: now)
    }

    // MARK: - Idempotency

    func testSecondRunOverUnchangedInputInsertsNothing() throws {
        let chat = try ChatDBBuilder.make(
            ChatDBBuilder.insert(rowID: 1, guid: "A", text: "first", daysAgo: 1)
            + ChatDBBuilder.insert(rowID: 2, guid: "B", text: "second", daysAgo: 400),
            label: "idempotent")

        let first = try sync(chat)
        XCTAssertEqual(first.inserted, 2)

        let mirror = try MirrorDatabase(path: mirrorPath)
        let countAfterFirst = try mirror.messageCount()
        XCTAssertEqual(countAfterFirst, 2)

        let second = try sync(chat)
        XCTAssertEqual(second.inserted, 0, "a second run must insert nothing")
        XCTAssertEqual(second.updated, 0, "a second run must rewrite nothing")
        XCTAssertEqual(try MirrorDatabase(path: mirrorPath).messageCount(), countAfterFirst)
    }

    // MARK: - Backfill

    /// The Definition of Done's backfill case: a new ROWID carrying an old date.
    func testABackfilledMessageWithANewROWIDAndAnOldDateLandsInTheMirror() throws {
        let chat = try ChatDBBuilder.make(
            ChatDBBuilder.insert(rowID: 1, guid: "A", text: "first", daysAgo: 1),
            label: "backfill-newid")
        _ = try sync(chat)

        // Arrives later, with a fresh id and a date two months old.
        try ChatDBBuilder.apply(
            ChatDBBuilder.insert(rowID: 2, guid: "BACKFILLED", text: "sixty days old",
                                 daysAgo: 60),
            to: chat)

        let second = try sync(chat)
        XCTAssertEqual(second.inserted, 1)
        XCTAssertTrue(try MirrorDatabase(path: mirrorPath).contains(guid: "BACKFILLED"))
    }

    /// The case that actually discriminates, and the reason the trailing window exists.
    ///
    /// The criterion above is satisfied by a ROWID-only watermark too — a fresh ROWID is
    /// by definition above the high-water mark, so ROWID alone finds it. This one is
    /// not: the row arrives with an id *below* the watermark, which is what happens when
    /// a transaction commits after one that took a larger id, and on every restore and
    /// iCloud resync. Only the trailing re-scan sees it.
    ///
    /// The second half of the test proves the discrimination rather than asserting it:
    /// a ROWID-only scan of the same database does **not** return the row.
    func testAMessageArrivingBelowTheWatermarkIsStillIngested() throws {
        // Gaps in the id space, so a later row can legitimately take id 5.
        let chat = try ChatDBBuilder.make(
            ChatDBBuilder.insert(rowID: 1, guid: "A", text: "one", daysAgo: 3)
            + ChatDBBuilder.insert(rowID: 10, guid: "B", text: "ten", daysAgo: 2),
            label: "backfill-lowid")

        let first = try sync(chat)
        XCTAssertEqual(first.watermarkAfter, 10)

        try ChatDBBuilder.apply(
            ChatDBBuilder.insert(rowID: 5, guid: "LATE", text: "committed out of order",
                                 daysAgo: 1),
            to: chat)

        let second = try sync(chat)
        XCTAssertEqual(second.inserted, 1)
        XCTAssertTrue(try MirrorDatabase(path: mirrorPath).contains(guid: "LATE"),
                      "the trailing re-scan is what catches this; without it the "
                      + "message is lost silently and permanently")

        // And the control: a ROWID-only watermark misses it.
        let reader = try MessageReader(path: chat)
        var rowIDOnly = ScanOptions.everything
        rowIDOnly.afterROWID = 10
        let missed = try reader.scan(options: rowIDOnly, loadMessages: true)
        XCTAssertFalse(missed.messages.contains { $0.guid == "LATE" },
                       "if a ROWID-only scan finds this row, the test no longer "
                       + "discriminates and proves nothing")
    }

    /// Backfill older than the window is beyond recovery, and the code should not
    /// pretend otherwise. Documented as a limit, not asserted as a success.
    func testBackfillOlderThanTheWindowAndBelowTheWatermarkIsNotRecovered() throws {
        let chat = try ChatDBBuilder.make(
            ChatDBBuilder.insert(rowID: 1, guid: "A", text: "one", daysAgo: 3)
            + ChatDBBuilder.insert(rowID: 10, guid: "B", text: "ten", daysAgo: 2),
            label: "backfill-beyond")
        _ = try sync(chat)

        try ChatDBBuilder.apply(
            ChatDBBuilder.insert(rowID: 5, guid: "ANCIENT", text: "long gone", daysAgo: 400),
            to: chat)

        let second = try sync(chat)
        XCTAssertEqual(second.inserted, 0)
        XCTAssertFalse(try MirrorDatabase(path: mirrorPath).contains(guid: "ANCIENT"),
                       "documents the real limit of a 30-day window: a row both below "
                       + "the watermark and older than the window is not recoverable "
                       + "incrementally. iMessage's own queue depth is 30 days, so a "
                       + "source in this state has usually lost the message too.")
    }

    // MARK: - The window after a long outage

    /// A Mac shut for two months must not resume with a hole behind it.
    ///
    /// Anchored only on the clock, the window is always `[now-30d, now]`, so a machine
    /// that slept for 60 days never looks at the 60 days it missed. Rows that landed in
    /// that gap are then covered by the ROWID half alone — and any row arriving *below*
    /// the high-water mark is lost permanently. Those are exactly the rows the trailing
    /// re-scan exists for. "The Mac is allowed to be asleep" is an architectural
    /// premise, and a campus beachhead means summer breaks.
    func testTheWindowReachesBackToTheLastSyncAfterALongOutage() throws {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let chat = try ChatDBBuilder.make(
            ChatDBBuilder.insert(rowID: 1, guid: "A", text: "one", daysAgo: 1, from: start)
            + ChatDBBuilder.insert(rowID: 10, guid: "B", text: "ten", daysAgo: 1, from: start),
            label: "outage")

        let first = try sync(chat, now: start)
        XCTAssertEqual(first.watermarkAfter, 10)

        // The Mac sleeps for 60 days. While it is away a row lands below the watermark,
        // dated one day after the last sync -- long outside [resume-30d, resume].
        try ChatDBBuilder.apply(
            ChatDBBuilder.insert(rowID: 5, guid: "DURING_OUTAGE", text: "landed while away",
                                 daysAgo: 59, from: start.addingTimeInterval(60 * 86_400)),
            to: chat)

        let resume = start.addingTimeInterval(60 * 86_400)
        let second = try sync(chat, now: resume)

        XCTAssertEqual(second.previousSyncAt, start, "last_sync_at is written but unread")
        let windowStart = try XCTUnwrap(second.windowStart)
        XCTAssertLessThan(windowStart, start,
                          "the window must reach back past the last sync, not to resume-30d")
        XCTAssertEqual(second.inserted, 1)
        XCTAssertTrue(try MirrorDatabase(path: mirrorPath).contains(guid: "DURING_OUTAGE"))
    }

    /// The window must not *shrink* on a machine that syncs regularly: a run one hour
    /// after the last one still reaches a full window back from now.
    func testTheWindowIsNeverShorterThanOneWindowFromNow() throws {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let chat = try ChatDBBuilder.make(
            ChatDBBuilder.insert(rowID: 10, guid: "A", text: "one", daysAgo: 1, from: start),
            label: "window-floor")
        _ = try sync(chat, now: start)

        let soon = start.addingTimeInterval(3600)
        let second = try sync(chat, now: soon)
        let windowStart = try XCTUnwrap(second.windowStart)
        XCTAssertLessThanOrEqual(windowStart,
                                 soon.addingTimeInterval(-Double(MirrorSync.defaultTrailingWindowDays) * 86_400))
    }

    /// After a long outage there has to be a way to reach further back than 30 days.
    func testTheTrailingWindowIsOverridable() throws {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let chat = try ChatDBBuilder.make(
            ChatDBBuilder.insert(rowID: 10, guid: "A", text: "one", daysAgo: 1, from: start),
            label: "window-override")
        _ = try sync(chat, now: start)

        // 200 days old and below the watermark: outside the default window entirely.
        try ChatDBBuilder.apply(
            ChatDBBuilder.insert(rowID: 5, guid: "OLD", text: "long ago", daysAgo: 200,
                                 from: start),
            to: chat)

        let narrow = try sync(chat, now: start)
        XCTAssertEqual(narrow.inserted, 0, "default window should not reach this row")

        let reader = try MessageReader(path: chat)
        let mirror = try MirrorDatabase(path: mirrorPath)
        let wide = try MirrorSync(reader: reader, mirror: mirror,
                                  trailingWindowDays: 365).run(now: start)
        XCTAssertEqual(wide.trailingWindowDays, 365)
        XCTAssertEqual(wide.inserted, 1)
        XCTAssertTrue(try MirrorDatabase(path: mirrorPath).contains(guid: "OLD"))
    }

    // MARK: - Durability

    /// The mirror is the durable record. `chat.db` losing a row must not lose it here —
    /// that is the whole promise of not being a cache.
    func testARowDeletedFromChatDBSurvivesInTheMirror() throws {
        let chat = try ChatDBBuilder.make(
            ChatDBBuilder.insert(rowID: 1, guid: "KEEPER", text: "do not lose me", daysAgo: 1)
            + ChatDBBuilder.insert(rowID: 2, guid: "B", text: "other", daysAgo: 1),
            label: "durable")
        _ = try sync(chat)
        XCTAssertEqual(try MirrorDatabase(path: mirrorPath).messageCount(), 2)

        try ChatDBBuilder.apply("DELETE FROM message WHERE guid = 'KEEPER';", to: chat)
        XCTAssertEqual(try MessageReader(path: chat).rawMessageCount(), 1,
                       "the source really did lose the row")

        _ = try sync(chat)
        let mirror = try MirrorDatabase(path: mirrorPath)
        XCTAssertTrue(try mirror.contains(guid: "KEEPER"))
        XCTAssertEqual(try mirror.messageCount(), 2, "the mirror never shrinks")
    }

    // MARK: - Dedup

    /// `chat.db` is eventually consistent and occasionally lossy, so the same message
    /// can appear at two ROWIDs after a restore or a merge. `guid` is the identity.
    func testTwoSourceRowsWithTheSameGUIDCollapseToOneMirrorRow() throws {
        let chat = try ChatDBBuilder.make(
            ChatDBBuilder.insert(rowID: 1, guid: "SAME", text: "duplicated", daysAgo: 1)
            + ChatDBBuilder.insert(rowID: 2, guid: "SAME", text: "duplicated", daysAgo: 1),
            label: "dedup")

        let reader = try MessageReader(path: chat)
        XCTAssertEqual(try reader.rawMessageCount(), 2, "the source really has two rows")

        let stats = try sync(chat)
        XCTAssertEqual(stats.scanned, 2)
        XCTAssertEqual(stats.inserted, 1)
        XCTAssertEqual(stats.duplicatesSkipped, 1)
        XCTAssertEqual(try MirrorDatabase(path: mirrorPath).messageCount(), 1)
    }

    // MARK: - FTS5

    func testFullTextSearchFindsAMessageByItsWords() throws {
        let chat = try ChatDBBuilder.make(
            ChatDBBuilder.insert(rowID: 1, guid: "FTS", text: "pistachio croissant friday",
                                 daysAgo: 2)
            + ChatDBBuilder.insert(rowID: 2, guid: "OTHER", text: "unrelated chatter",
                                   daysAgo: 2),
            label: "fts")
        _ = try sync(chat)

        let mirror = try MirrorDatabase(path: mirrorPath)
        XCTAssertEqual(try mirror.search("pistachio"), ["FTS"])
        XCTAssertEqual(try mirror.search("croissant"), ["FTS"])
        XCTAssertEqual(try mirror.search("unrelated"), ["OTHER"])
        XCTAssertTrue(try mirror.search("kumquat").isEmpty)
    }

    /// Re-ingesting must not leave the index holding two copies of one message.
    func testTheSearchIndexDoesNotAccumulateDuplicates() throws {
        let chat = try ChatDBBuilder.make(
            ChatDBBuilder.insert(rowID: 1, guid: "FTS", text: "pistachio croissant", daysAgo: 2),
            label: "fts-idempotent")
        _ = try sync(chat)
        _ = try sync(chat)
        XCTAssertEqual(try MirrorDatabase(path: mirrorPath).search("pistachio"), ["FTS"])
    }

    /// A message whose text changes -- which is exactly what prompt 03 does when it
    /// decodes an attributedBody that was previously NULL -- must become findable.
    func testAnUpdatedMessageIsReindexed() throws {
        let chat = try ChatDBBuilder.make(
            ChatDBBuilder.insert(rowID: 1, guid: "R", text: "before", daysAgo: 1),
            label: "reindex")
        _ = try sync(chat)
        XCTAssertEqual(try MirrorDatabase(path: mirrorPath).search("before"), ["R"])

        try ChatDBBuilder.apply("UPDATE message SET text = 'after' WHERE guid = 'R';", to: chat)
        let second = try sync(chat)
        XCTAssertEqual(second.updated, 1)

        let mirror = try MirrorDatabase(path: mirrorPath)
        XCTAssertEqual(try mirror.search("after"), ["R"])
        XCTAssertTrue(try mirror.search("before").isEmpty, "stale index entry left behind")
        XCTAssertEqual(try mirror.messageCount(), 1)
    }

    // MARK: - Schema version detection

    /// A renamed column must fail by name. The failure this guards against is not a
    /// crash -- it is a query that still parses, returns zero rows, and gets read as
    /// "you don't text anyone much."
    func testARenamedColumnFailsLoudlyRatherThanReturningZeroRows() throws {
        let chat = try ChatDBBuilder.make(
            ChatDBBuilder.insert(rowID: 1, guid: "A", text: "hi", daysAgo: 1),
            label: "schema-drift")
        try ChatDBBuilder.apply("ALTER TABLE message RENAME COLUMN is_from_me TO sender_is_me;",
                                to: chat)

        XCTAssertThrowsError(try MessageReader(path: chat)) { error in
            guard let schemaError = error as? ChatSchema.Error else {
                return XCTFail("expected a named schema error, got \(error)")
            }
            guard case .missingColumns(let table, let columns) = schemaError else {
                return XCTFail("expected missingColumns, got \(schemaError)")
            }
            XCTAssertEqual(table, "message")
            XCTAssertEqual(columns, ["is_from_me"])
            XCTAssertTrue("\(schemaError)".contains("is_from_me"))
        }
    }

    func testAMissingTableFailsLoudly() throws {
        let chat = try ChatDBBuilder.make("", label: "schema-notable")
        try ChatDBBuilder.apply("DROP TABLE chat_message_join;", to: chat)

        XCTAssertThrowsError(try MessageReader(path: chat)) { error in
            guard case ChatSchema.Error.missingTable(let table) = error else {
                return XCTFail("expected missingTable, got \(error)")
            }
            XCTAssertEqual(table, "chat_message_join")
        }
    }

    func testTheRealFixturePassesTheSchemaCheck() throws {
        try Fixture.ensureChatDatabase()
        XCTAssertNoThrow(try MessageReader(path: Fixture.chatDatabasePath))
    }

    // MARK: - Mirror schema

    func testTheMirrorRefusesASchemaFromTheFuture() throws {
        _ = try MirrorDatabase(path: mirrorPath)
        try ChatDBBuilder.apply("PRAGMA user_version = 999;", to: mirrorPath)

        XCTAssertThrowsError(try MirrorDatabase(path: mirrorPath)) { error in
            guard case MirrorDatabase.Error.unsupportedSchema(let found, let supported) = error else {
                return XCTFail("expected unsupportedSchema, got \(error)")
            }
            XCTAssertEqual(found, 999)
            XCTAssertEqual(supported, MirrorDatabase.schemaVersion)
        }
    }

    func testTheMirrorRecordsItsSchemaVersionOnDisk() throws {
        _ = try MirrorDatabase(path: mirrorPath)
        let version = try ChatDBBuilder.apply("PRAGMA user_version;", to: mirrorPath)
        XCTAssertEqual(version.trimmingCharacters(in: .whitespacesAndNewlines),
                       String(MirrorDatabase.schemaVersion))
    }

    // MARK: - The mirror takes everything

    /// Tapbacks, group threads and chat-less rows all belong in the durable record.
    /// A row dropped at ingest is gone the moment `chat.db` prunes it.
    func testTheMirrorIngestsTheWholeFixtureIncludingRowsTheOneToOneReadDrops() throws {
        try Fixture.ensureChatDatabase()
        let reader = try MessageReader(path: Fixture.chatDatabasePath)
        let raw = try reader.rawMessageCount()
        let oneToOne = try reader.count(options: .oneToOne)
        XCTAssertLessThan(oneToOne, raw, "fixture no longer has rows the 1:1 read drops")

        let stats = try sync(Fixture.chatDatabasePath)
        XCTAssertEqual(stats.inserted, raw,
                       "the mirror must take every row, not just the 1:1 subset")
        XCTAssertEqual(try MirrorDatabase(path: mirrorPath).messageCount(), raw)
    }
}
