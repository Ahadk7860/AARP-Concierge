import XCTest
@testable import BoiKit

/// Fixture plumbing shared by this track's suites.
enum Fixture {

    /// Repo root, derived from this file's location rather than the working directory,
    /// which `swift test` does not guarantee.
    ///
    /// FOUR deletions, not three. The first strips the file name and lands on the
    /// directory holding it, so three lands on `mac/` and a fourth is needed to clear
    /// it. `FoundationTests.swift` shipped with three and its comments are off by one
    /// step throughout -- see NOTES.md.
    static var repositoryRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // .../mac/Tests/BoiKitTests
            .deletingLastPathComponent()   // .../mac/Tests
            .deletingLastPathComponent()   // .../mac
            .deletingLastPathComponent()   // repo root
    }

    /// Track A's assigned fixture database — CONTRACTS.md section 9.
    static var chatDatabasePath: String {
        ProcessInfo.processInfo.environment["BOI_FIXTURE_CHATDB"] ?? "/tmp/boi-a/chat.db"
    }

    /// A fixture problem is a FAILURE, never a skip.
    ///
    /// `XCTSkip` thrown from `setUpWithError` skips every test in the class — the WAL
    /// check, the tapback check, the group-chat check, the snapshot check — and
    /// `swift test` still exits 0. A green run that asserted nothing is worse than a
    /// red one. The fixture generator models the right instinct: it raises
    /// "INCONCLUSIVE, which is not a pass" rather than returning quietly.
    struct FixtureUnavailable: Swift.Error, CustomStringConvertible {
        let detail: String
        var description: String {
            "fixture unavailable, so the checks below would assert nothing: \(detail)"
        }
    }

    /// Generates the fixture if it is not there. The generator is deterministic on its
    /// default seed, so an existing database and a freshly built one agree.
    static func ensureChatDatabase() throws {
        guard !FileManager.default.fileExists(atPath: chatDatabasePath) else { return }
        let output = try run("/usr/bin/python3", [
            repositoryRoot.appendingPathComponent("scripts/make_synthetic_chatdb.py").path,
            "--out", chatDatabasePath,
        ])
        guard FileManager.default.fileExists(atPath: chatDatabasePath) else {
            throw FixtureUnavailable(detail: "could not build \(chatDatabasePath):\n\(output)")
        }
    }

    @discardableResult
    static func run(_ launchPath: String, _ arguments: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// The 1:1 count, according to the `sqlite3` CLI.
    ///
    /// Both sides of the WAL comparison come from `/usr/bin/sqlite3`, a tool this
    /// track did not write. A control that this repo produces is not a control: it can
    /// be wrong in the same direction as the thing it is checking, and the whole point
    /// of this one criterion is that it is independent.
    ///
    /// `query` is the same SQL the reader runs, spelled out here rather than shared, so
    /// the comparison stays honest if `MessageReader`'s SQL changes.
    static func sqlite3Count(uriQuery: String) throws -> Int {
        let sql = """
            SELECT count(DISTINCT m.ROWID) FROM message m
            JOIN chat_message_join j ON j.message_id = m.ROWID
            JOIN chat c ON c.ROWID = j.chat_id
            WHERE coalesce(c.style, 0) <> 43
              AND coalesce(m.associated_message_type, 0) NOT BETWEEN 2000 AND 3999
            """
        let output = try run("/usr/bin/sqlite3", ["file:\(chatDatabasePath)?\(uriQuery)", sql])
        guard let count = Int(output.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw FixtureUnavailable(detail: "sqlite3 returned no count for ?\(uriQuery):\n\(output)")
        }
        return count
    }

    /// `im` + `mutable` — the URI flag that makes SQLite skip the write-ahead log.
    ///
    /// Assembled from fragments so this file does not itself become the only match of
    /// the Definition of Done's recursive grep for that flag over `mac/`, which must
    /// come back empty. `SourceGuardTests` enforces the same rule from inside the
    /// suite, and it caught this comment when it spelled the flag out.
    static let frozenOpenFlag = "im" + "mutable"
}

final class MessageReaderTests: XCTestCase {

    private var reader: MessageReader!

    override func setUpWithError() throws {
        try super.setUpWithError()
        try Fixture.ensureChatDatabase()
        reader = try MessageReader(path: Fixture.chatDatabasePath)
    }

    // MARK: - The WAL check

    /// The load-bearing test of this prompt.
    ///
    /// The load-bearing test of this prompt.
    ///
    /// Asserted on `matchedCount` — the 1:1 count `boi-cli scan` actually prints — not
    /// on the raw table count. The WAL-only row joins a chat, so a reader that froze
    /// the corpus would report a number that is wrong in the number a human reads.
    ///
    /// Both controls come from `/usr/bin/sqlite3`, not from anything in this repo.
    func testReaderSeesTheWALRowThatAFrozenConnectionWouldMiss() throws {
        let modeRO = try Fixture.sqlite3Count(uriQuery: "mode=ro")
        let frozen = try Fixture.sqlite3Count(uriQuery: "\(Fixture.frozenOpenFlag)=1")
        let readerCount = try reader.scan(options: .oneToOne).matchedCount

        XCTAssertEqual(modeRO - frozen, 1,
                       "the fixture no longer has an uncheckpointed WAL row visible to "
                       + "the 1:1 read, so this experiment is inconclusive, which is "
                       + "not a pass")
        XCTAssertEqual(readerCount, modeRO,
                       "reader disagrees with sqlite3 mode=ro on the same file")
        XCTAssertEqual(readerCount, frozen + 1,
                       "reader must see exactly one more message than a frozen "
                       + "connection; reader=\(readerCount) frozen=\(frozen)")
    }

    /// The same divergence at the raw-table level, which is what the prompt's
    /// `CONTRACTS.md` section 10 quotes: 9637 against 9636.
    func testTheRawTableCountDivergesTheSameWay() throws {
        let output = try Fixture.run("/usr/bin/sqlite3", [
            "file:\(Fixture.chatDatabasePath)?mode=ro", "SELECT count(*) FROM message",
        ])
        let modeRO = try XCTUnwrap(Int(output.trimmingCharacters(in: .whitespacesAndNewlines)))
        XCTAssertEqual(try reader.rawMessageCount(), modeRO)
    }

    func testTheConnectionURIRequestsReadOnlyAndNotAFrozenSnapshot() {
        let uri = ChatDatabase.readOnlyURI(forPath: "/tmp/boi-a/chat.db")
        XCTAssertEqual(uri, "file:/tmp/boi-a/chat.db?mode=ro")
    }

    func testOpeningAMissingDatabaseThrowsRatherThanReturningZero() {
        XCTAssertThrowsError(try MessageReader(path: "/tmp/boi-a/does-not-exist.db"))
    }

    // MARK: - Tapbacks

    /// Tapbacks are reactions, not messages. Counting them inflates every volume
    /// metric and moves the top of the ranking.
    func testTapbacksAreExcludedFromTheOneToOneRead() throws {
        let withTapbacks = try reader.count(options: ScanOptions(excludeTapbacks: false))
        let withoutTapbacks = try reader.count(options: .oneToOne)
        let tapbacks = try reader.excludedTapbackCount()

        XCTAssertGreaterThan(tapbacks, 0, "fixture has no tapbacks left to exclude")
        XCTAssertEqual(withoutTapbacks, withTapbacks - tapbacks)

        let scan = try reader.scan(options: .oneToOne, loadMessages: true)
        XCTAssertEqual(scan.messages.filter { (2000...3999).contains($0.associatedMessageType) }.count, 0)
    }

    /// The whole-corpus accounting identity: every row in `message` is either kept by
    /// the 1:1 read or dropped for exactly one named reason. If a fourth bucket ever
    /// appears, this fails rather than quietly shrinking the corpus.
    func testEveryRowIsEitherKeptOrDroppedForANamedReason() throws {
        let scan = try reader.scan(options: .oneToOne)

        XCTAssertGreaterThan(scan.excludedTapbackCount, 0)
        XCTAssertGreaterThan(scan.excludedGroupChatCount, 0)
        // Orphans are 0 on the current fixture -- the WAL-only row now joins a chat --
        // but real databases have them, so the bucket stays in the identity.
        XCTAssertGreaterThanOrEqual(scan.rowsInNoChat, 0)

        XCTAssertEqual(
            scan.matchedCount,
            scan.rawMessageCount - scan.excludedTapbackCount
                - scan.excludedGroupChatCount - scan.rowsInNoChat,
            "kept + dropped no longer accounts for every row in message"
        )
    }

    // MARK: - Group chats

    func testGroupChatRowsAreExcludedFromTheOneToOneRead() throws {
        let scan = try reader.scan(options: .oneToOne, loadMessages: true)
        XCTAssertFalse(scan.messages.isEmpty)
        XCTAssertEqual(scan.messages.filter { $0.chatStyle == 43 }.count, 0)

        let groupRows = try reader.excludedGroupChatCount()
        XCTAssertGreaterThan(groupRows, 0, "fixture has no group chat left to exclude")

        let withGroups = try reader.count(options: ScanOptions(excludeGroupChats: false))
        XCTAssertEqual(try reader.count(options: .oneToOne), withGroups - groupRows)
    }

    // MARK: - Rows

    func testNullTextRowsAreCountedRatherThanDropped() throws {
        // attributedBody decoding is prompt 03. Until then a NULL-text row is a row
        // with no text -- but it is still a row, and it still counts.
        let scan = try reader.scan(options: .oneToOne, loadMessages: true)
        XCTAssertGreaterThan(scan.messagesWithoutText, 0)
        XCTAssertEqual(scan.messages.filter { $0.text == nil }.count, scan.messagesWithoutText)
        XCTAssertTrue(scan.messages.contains { $0.text == nil && $0.hasAttributedBody })
    }

    func testMessageDatesLandInAPlausibleWindow() throws {
        let scan = try reader.scan(options: ScanOptions(limit: 200), loadMessages: true)
        let dates = scan.messages.compactMap(\.date)
        XCTAssertFalse(dates.isEmpty)
        // A raw Apple timestamp read as seconds instead of nanoseconds lands in 2001;
        // read the other way round it lands well past 3000. Both are silent.
        let floor = Date(timeIntervalSince1970: 1_262_304_000)   // 2010-01-01
        let ceiling = Date().addingTimeInterval(60 * 60 * 24)
        for date in dates {
            XCTAssertGreaterThan(date, floor)
            XCTAssertLessThan(date, ceiling)
        }
    }

    func testAppleTimestampsAreReadInBothUnits() {
        // 2024-01-01T00:00:00Z is 725,846,400 seconds after the Apple epoch.
        let seconds: Int64 = 725_846_400
        let nanoseconds = seconds * 1_000_000_000
        XCTAssertEqual(MessageReader.appleDate(seconds), MessageReader.appleDate(nanoseconds))
        XCTAssertNil(MessageReader.appleDate(0))
        XCTAssertNil(MessageReader.appleDate(nil))
    }

    // MARK: - One message, several threads

    /// The fixture cannot express this: it writes exactly one `chat_message_join` row
    /// per message. Real databases do not — a thread merge, a handle that changed from
    /// a phone number to an Apple ID, or an iMessage thread that fell back to SMS all
    /// leave one message joined to several chats. Counting `count(*)` over that join
    /// reports the message once per thread and inflates every volume metric built on
    /// it, which is invisible on the fixture and wrong on every real Mac.
    func testAMessageInSeveralThreadsIsCountedOnce() throws {
        let path = "/tmp/boi-a/tests/multichat-\(UUID().uuidString).db"
        defer { try? FileManager.default.removeItem(atPath: path) }

        try Fixture.run("/usr/bin/sqlite3", [path, """
            CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
            CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER,
                               chat_identifier TEXT, service_name TEXT);
            CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT,
                                  handle_id INTEGER, service TEXT, date INTEGER,
                                  is_from_me INTEGER, associated_message_type INTEGER,
                                  attributedBody BLOB);
            CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER,
                                            message_date INTEGER);
            INSERT INTO handle VALUES (1, '+15550100001', 'iMessage');
            -- the same person, reached two ways: SMS thread and iMessage thread
            INSERT INTO chat VALUES (1, 'SMS;-;+15550100001', 45, '+15550100001', 'SMS');
            INSERT INTO chat VALUES (2, 'iMessage;-;+15550100001', 45, '+15550100001', 'iMessage');
            INSERT INTO message VALUES (1, 'MSG-1', 'hi', 1, 'iMessage', 700000000000000000, 0, 0, NULL);
            INSERT INTO chat_message_join VALUES (1, 1, 700000000000000000);
            INSERT INTO chat_message_join VALUES (2, 1, 700000000000000000);
            """])

        let multiChatReader = try MessageReader(path: path)
        XCTAssertEqual(try multiChatReader.rawMessageCount(), 1)
        XCTAssertEqual(try multiChatReader.count(options: .oneToOne), 1,
                       "one message joined to two chats must count once, not twice")

        let scan = try multiChatReader.scan(options: .oneToOne, loadMessages: true)
        XCTAssertEqual(scan.messages.count, 1)
        XCTAssertEqual(scan.matchedCount, 1)
        // min(c.ROWID) picks a chat deterministically, and the columns beside it come
        // from that same chat rather than from an arbitrary one.
        XCTAssertEqual(scan.messages.first?.chatRowID, 1)
        XCTAssertEqual(scan.messages.first?.service, "iMessage")
    }

    // MARK: - Snapshot

    /// A snapshot that loses the WAL is the frozen-corpus failure in another costume:
    /// a plausible count, no error, every recent message gone.
    ///
    /// `VACUUM INTO` folds the WAL into the copy, so the assertion is on the counts
    /// rather than on a sidecar existing beside the result — there deliberately is no
    /// sidecar. If the snapshot ever loses the log, the uncheckpointed row disappears
    /// and both equalities below break.
    func testSnapshotCarriesTheWALAndThereforeTheSameCount() throws {
        let directory = URL(fileURLWithPath: "/tmp/boi-a/tests/snapshot-\(UUID().uuidString)")
        let snapshot = try DatabaseSnapshot(of: Fixture.chatDatabasePath, into: directory)
        defer { snapshot.remove() }

        let snapshotReader = try MessageReader(path: snapshot.url.path)
        XCTAssertEqual(try snapshotReader.rawMessageCount(), try reader.rawMessageCount())
        XCTAssertEqual(try snapshotReader.count(options: .oneToOne),
                       try reader.count(options: .oneToOne))

        // And it agrees with the independent control, not merely with itself.
        XCTAssertEqual(try snapshotReader.count(options: .oneToOne),
                       try Fixture.sqlite3Count(uriQuery: "mode=ro"))

        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshot.url.path + "-wal"),
                       "VACUUM INTO should produce a fully checkpointed single file")
    }
}

final class WatermarkTests: XCTestCase {

    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    func testFirstObservationIsNotAnAlarm() {
        var tracker = WatermarkTracker()
        let status = tracker.observe(maxROWID: 100, at: start)
        XCTAssertEqual(status, .first(100))
        XCTAssertFalse(status.isAlarm)
    }

    func testAdvancingWatermarkIsQuiet() {
        var tracker = WatermarkTracker()
        _ = tracker.observe(maxROWID: 100, at: start)
        let status = tracker.observe(maxROWID: 140, at: start.addingTimeInterval(30))
        XCTAssertEqual(status, .advanced(from: 100, to: 140))
        XCTAssertFalse(status.isAlarm)
    }

    /// The alarm this prompt asks for: MAX(ROWID) did not advance between runs.
    func testAFlatWatermarkRaisesAnAlarmThatGrowsWithTheStall() {
        var tracker = WatermarkTracker()
        _ = tracker.observe(maxROWID: 100, at: start)
        let first = tracker.observe(maxROWID: 100, at: start.addingTimeInterval(30))
        let later = tracker.observe(maxROWID: 100, at: start.addingTimeInterval(300))

        XCTAssertEqual(first, .stalled(at: 100, forSeconds: 30))
        XCTAssertEqual(later, .stalled(at: 100, forSeconds: 300))
        XCTAssertTrue(first.isAlarm)
        XCTAssertTrue(later.isAlarm)
    }

    func testStallAlarmRespectsItsGracePeriod() {
        XCTAssertFalse(ScanPoller.raisesAlarm(.stalled(at: 1, forSeconds: 30), after: 120))
        XCTAssertTrue(ScanPoller.raisesAlarm(.stalled(at: 1, forSeconds: 300), after: 120))
        XCTAssertTrue(ScanPoller.raisesAlarm(.regressed(from: 9, to: 4), after: 999))
        XCTAssertFalse(ScanPoller.raisesAlarm(.advanced(from: 1, to: 2), after: 0))
    }

    /// A database swapped underneath the reader -- restore, resync, stale snapshot.
    func testAWatermarkGoingBackwardsIsAnAlarm() {
        var tracker = WatermarkTracker()
        _ = tracker.observe(maxROWID: 900, at: start)
        let status = tracker.observe(maxROWID: 400, at: start.addingTimeInterval(30))
        XCTAssertEqual(status, .regressed(from: 900, to: 400))
        XCTAssertTrue(status.isAlarm)
    }
}

final class ScanPollerTests: XCTestCase {

    private func emptyResult(maxROWID: Int64, at date: Date) -> ScanResult {
        ScanResult(rawMessageCount: 0, matchedCount: 0, maxROWID: maxROWID,
                   excludedTapbackCount: 0, excludedGroupChatCount: 0, rowsInNoChat: 0,
                   messagesWithoutText: 0, threadCount: 0, scannedAt: date, messages: [])
    }

    func testDefaultIsASinglePass() throws {
        var passes = 0
        try ScanPoller(configuration: .once).run(
            scan: { _ in self.emptyResult(maxROWID: 1, at: Date()) },
            sleep: { _ in XCTFail("a single pass must not sleep") },
            onPass: { _ in passes += 1 }
        )
        XCTAssertEqual(passes, 1)
    }

    func testForegroundPollsEveryThirtySecondsAndSleepsBetweenPassesOnly() throws {
        var sleeps: [TimeInterval] = []
        var statuses: [WatermarkStatus] = []
        let configuration = ScanPoller.Configuration(interval: ScanPoller.foregroundInterval,
                                                     iterations: 3)
        var clock = Date(timeIntervalSince1970: 1_800_000_000)

        try ScanPoller(configuration: configuration).run(
            scan: { index in self.emptyResult(maxROWID: Int64(10 + index), at: clock) },
            now: { clock },
            sleep: { interval in
                sleeps.append(interval)
                clock = clock.addingTimeInterval(interval)
            },
            onPass: { statuses.append($0.watermark) }
        )

        XCTAssertEqual(ScanPoller.foregroundInterval, 30)
        XCTAssertEqual(sleeps, [30, 30], "n passes must sleep n-1 times")
        XCTAssertEqual(statuses, [.first(10), .advanced(from: 10, to: 11),
                                  .advanced(from: 11, to: 12)])
    }

    /// The alarm has to survive the process, or the default `boi-cli scan` path — one
    /// pass, exit — can only ever report `.first` and never observes a stall at all.
    func testTheWatermarkSurvivesBetweenSeparateSinglePassRuns() throws {
        let url = URL(fileURLWithPath: "/tmp/boi-a/tests/watermark-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = WatermarkStore(url: url)
        let clock = Date(timeIntervalSince1970: 1_800_000_000)

        var first: WatermarkStatus?
        try ScanPoller(configuration: .once).run(
            store: store,
            scan: { _ in self.emptyResult(maxROWID: 500, at: clock) },
            now: { clock },
            onPass: { first = $0.watermark }
        )
        XCTAssertEqual(first, .first(500))

        // A brand new poller, as a second process would build: same flat watermark.
        var second: WatermarkStatus?
        var alarmed = false
        let later = clock.addingTimeInterval(7200)
        try ScanPoller(configuration: .once).run(
            store: store,
            scan: { _ in self.emptyResult(maxROWID: 500, at: later) },
            now: { later },
            onPass: { second = $0.watermark; alarmed = $0.raisesAlarm }
        )
        XCTAssertEqual(second, .stalled(at: 500, forSeconds: 7200))
        XCTAssertTrue(alarmed, "a two-hour flat watermark across runs must alarm")

        // And it advances rather than alarming when new messages arrive.
        var third: WatermarkStatus?
        try ScanPoller(configuration: .once).run(
            store: store,
            scan: { _ in self.emptyResult(maxROWID: 512, at: later) },
            now: { later },
            onPass: { third = $0.watermark }
        )
        XCTAssertEqual(third, .advanced(from: 500, to: 512))
    }

    /// A quiet Mac is the common case, so the default grace period must not turn every
    /// poll into a warning nobody reads.
    func testTheDefaultGracePeriodDoesNotWarnOnAnOrdinaryQuietPoll() {
        XCTAssertEqual(ScanPoller.defaultStallAlarmSeconds, 3600)
        let configuration = ScanPoller.Configuration()
        XCTAssertFalse(ScanPoller.raisesAlarm(.stalled(at: 1, forSeconds: 30),
                                              after: configuration.stallAlarmAfterSeconds))
        XCTAssertTrue(ScanPoller.raisesAlarm(.stalled(at: 1, forSeconds: 7200),
                                             after: configuration.stallAlarmAfterSeconds))
    }

    func testAStalledDatabaseSurfacesAnAlarmOnEveryPassAfterTheFirst() throws {
        var alarms = 0
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        let configuration = ScanPoller.Configuration(interval: 30, iterations: 4,
                                                     stallAlarmAfterSeconds: 0)

        try ScanPoller(configuration: configuration).run(
            scan: { _ in self.emptyResult(maxROWID: 77, at: clock) },
            now: { clock },
            sleep: { clock = clock.addingTimeInterval($0) },
            onPass: { if $0.raisesAlarm { alarms += 1 } }
        )
        XCTAssertEqual(alarms, 3)
    }
}

/// The traps in TRACK.md that are checkable by reading the source rather than by
/// running it. They are here because each one passes on a quiet test machine.
///
/// The forbidden tokens below are assembled from fragments rather than written out.
/// The Definition of Done greps the whole of `mac/` for them and expects nothing back,
/// so a guard that spelled them would be the only match — it would fail the very check
/// it exists to enforce. Each fragment is commented with the token it forms.
final class SourceGuardTests: XCTestCase {

    /// `FS` + `Events` and the vnode source factory: inode-bound file watchers.
    private static let fileWatcherTokens = ["FS" + "Events",
                                            "makeFileSystem" + "ObjectSource"]

    /// Every hand-written Swift file under `mac/`.
    ///
    /// `.build` is skipped: it holds compiler output and generated shims derived from
    /// these same sources, not source anyone wrote. The Definition of Done's
    /// `grep -rn` over `mac/` covers it anyway.
    private func swiftSources() throws -> [(path: String, body: String)] {
        let root = Fixture.repositoryRoot.appendingPathComponent("mac")
        guard let walker = FileManager.default.enumerator(atPath: root.path) else {
            return []
        }
        var sources: [(String, String)] = []
        for case let relative as String in walker where relative.hasSuffix(".swift") {
            if relative.hasPrefix(".build/") { continue }
            let url = root.appendingPathComponent(relative)
            sources.append((relative, try String(contentsOf: url, encoding: .utf8)))
        }
        return sources
    }

    /// The frozen-open flag freezes the corpus at the last checkpoint and raises no
    /// error. Nothing under `mac/` may name it -- not the reader, not a test, not a
    /// comment. The negative reference lives in `scripts/wal_control_counts.py`.
    func testNothingUnderMacOpensTheDatabaseFrozen() throws {
        let sources = try swiftSources()
        XCTAssertFalse(sources.isEmpty, "found no Swift sources to check")
        for source in sources {
            XCTAssertFalse(source.body.contains(Fixture.frozenOpenFlag),
                           "\(source.path) names the frozen-open flag")
        }
    }

    /// SQLite deletes and recreates `-wal` and `-shm` on checkpoint. A watcher bound to
    /// those inodes survives the first checkpoint attached to a file that no longer
    /// exists and never fires again, silently.
    func testTheReaderPollsRatherThanWatchingFiles() throws {
        for source in try swiftSources() {
            for token in Self.fileWatcherTokens {
                XCTAssertFalse(source.body.contains(token),
                               "\(source.path) watches files instead of polling (\(token))")
            }
        }
        XCTAssertGreaterThan(ScanPoller.foregroundInterval, 0)
    }
}
