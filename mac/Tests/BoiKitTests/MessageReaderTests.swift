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

    /// Generates the fixture if it is not there. The generator is deterministic on its
    /// default seed, so an existing database and a freshly built one agree.
    static func ensureChatDatabase() throws {
        guard !FileManager.default.fileExists(atPath: chatDatabasePath) else { return }
        let output = try run("/usr/bin/python3", [
            repositoryRoot.appendingPathComponent("scripts/make_synthetic_chatdb.py").path,
            "--out", chatDatabasePath,
        ])
        guard FileManager.default.fileExists(atPath: chatDatabasePath) else {
            throw XCTSkip("could not build the fixture database:\n\(output)")
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

    /// The two control counts, produced by `scripts/wal_control_counts.py`.
    ///
    /// The frozen-open connection lives in that script, outside `mac/`, on purpose: it
    /// is a negative reference, and no code that ships on the Mac may open chat.db that
    /// way. The script names the flag and explains it in full.
    static func walControlCounts() throws -> (modeRO: Int, frozen: Int) {
        let output = try run("/usr/bin/python3", [
            repositoryRoot.appendingPathComponent("scripts/wal_control_counts.py").path,
            chatDatabasePath,
        ])
        guard let data = output.data(using: .utf8),
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Int],
              let modeRO = json["mode_ro"], let frozen = json["frozen"] else {
            throw XCTSkip("control script produced no counts:\n\(output)")
        }
        return (modeRO, frozen)
    }
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
    /// The reader must see every row a `mode=ro` connection sees, which on this fixture
    /// is exactly one more than a frozen-open connection sees: the row the generator
    /// deliberately left uncheckpointed in `chat.db-wal`. On a live Mac that one row
    /// stands in for every message since the last checkpoint.
    func testReaderSeesTheWALRowThatImmutableWouldMiss() throws {
        let control = try Fixture.walControlCounts()
        let readerCount = try reader.rawMessageCount()

        XCTAssertEqual(readerCount, control.modeRO,
                       "reader disagrees with a mode=ro connection on the same file")
        XCTAssertEqual(readerCount, control.frozen + 1,
                       "reader must see exactly one more row than a frozen connection; "
                       + "reader=\(readerCount) frozen=\(control.frozen)")
        XCTAssertEqual(control.modeRO - control.frozen, 1,
                       "the fixture no longer has an uncheckpointed WAL row, so this "
                       + "experiment is inconclusive, which is not a pass")
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
        XCTAssertGreaterThan(scan.rowsInNoChat, 0)

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

    // MARK: - Snapshot

    /// A snapshot that copies chat.db without its sidecars is the frozen-corpus failure
    /// in another costume: a plausible count, no error, every recent message gone.
    func testSnapshotCarriesTheWALAndThereforeTheSameCount() throws {
        let directory = URL(fileURLWithPath: "/tmp/boi-a/tests/snapshot-\(UUID().uuidString)")
        let snapshot = try DatabaseSnapshot(of: Fixture.chatDatabasePath, into: directory)
        defer { snapshot.remove() }

        XCTAssertTrue(FileManager.default.fileExists(atPath: snapshot.url.path + "-wal"),
                      "snapshot did not carry chat.db-wal")

        let snapshotReader = try MessageReader(path: snapshot.url.path)
        XCTAssertEqual(try snapshotReader.rawMessageCount(), try reader.rawMessageCount())
        XCTAssertEqual(try snapshotReader.count(options: .oneToOne),
                       try reader.count(options: .oneToOne))
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

    func testAStalledDatabaseSurfacesAnAlarmOnEveryPassAfterTheFirst() throws {
        var alarms = 0
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        let configuration = ScanPoller.Configuration(interval: 30, iterations: 4)

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

    /// `im` + `mutable` — the URI flag that makes SQLite skip the write-ahead log.
    private static let frozenOpenFlag = "im" + "mutable"
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
            XCTAssertFalse(source.body.contains(Self.frozenOpenFlag),
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
