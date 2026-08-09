import XCTest
@testable import BoiKit

// A temp directory stands in for the bookmarked ~/Library/Messages: bookmark creation
// and resolution do not require TCC at all when the target is already an ordinary
// POSIX-readable path (nothing under /tmp is TCC-protected), so the round-trip itself
// is fully testable here. What is NOT testable in CI is whether macOS actually grants
// the bookmark in the first place for a genuinely protected path — that was verified
// separately, interactively, and is recorded in NOTES.md rather than asserted here.

final class MessagesFolderAccessTests: XCTestCase {

    func scratch(_ label: String) throws -> String {
        let path = "/tmp/boi-a/tests/messages-folder-\(label)-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        return path
    }

    /// A minimal but real sqlite file, so `SecurityScopedMessagesProvider.url(for:)`
    /// callers that go on to open it succeed exactly as they would against a real
    /// `chat.db`.
    /// `URL.resolvingSymlinksInPath()` deliberately does NOT dereference `/tmp`,
    /// `/var`, or `/etc` — Apple special-cases exactly those three historically-symlinked
    /// roots (into `/private/...`) for compatibility, unlike a real `realpath(3)`. A
    /// saved bookmark resolves through the latter, so comparing against the former
    /// would fail on a symlink difference that has nothing to do with bookmark
    /// correctness.
    func canonical(_ path: String) -> String {
        guard let resolved = realpath(path, nil) else { return path }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    func makeFakeMessagesFolder() throws -> URL {
        let folder = try scratch("folder")
        let folderURL = URL(fileURLWithPath: canonical(folder))
        try FileManager.default.createDirectory(at: folderURL.appendingPathComponent("Attachments"),
                                                withIntermediateDirectories: true)
        // Not a real sqlite database — these tests check bookmark plumbing, not sqlite.
        // FullDiskAccessTests already owns "does the probe actually open the file."
        try Data("stand-in".utf8).write(to: folderURL.appendingPathComponent("chat.db"))
        return folderURL
    }

    // MARK: - BookmarkStore

    func testANeverSavedBookmarkLoadsAsNil() throws {
        let store = MessagesFolderAccess.BookmarkStore(directory: try scratch("empty"))
        XCTAssertNil(store.load())
    }

    func testSaveThenLoadRoundTrips() throws {
        let store = MessagesFolderAccess.BookmarkStore(directory: try scratch("roundtrip"))
        try store.save(Data("bookmark-bytes".utf8))
        XCTAssertEqual(store.load(), Data("bookmark-bytes".utf8))
    }

    func testClearRemovesTheSavedBookmark() throws {
        let store = MessagesFolderAccess.BookmarkStore(directory: try scratch("clear"))
        try store.save(Data("bookmark-bytes".utf8))
        store.clear()
        XCTAssertNil(store.load())
    }

    func testSaveCreatesTheDirectoryIfMissing() throws {
        let directory = try scratch("nested") + "/does/not/exist/yet"
        let store = MessagesFolderAccess.BookmarkStore(directory: directory)
        try store.save(Data("bookmark-bytes".utf8))
        XCTAssertEqual(store.load(), Data("bookmark-bytes".utf8))
    }

    // MARK: - SecurityScopedMessagesProvider

    func testNoBookmarkOnDiskThrowsNoBookmarkRatherThanCrashing() throws {
        let provider = SecurityScopedMessagesProvider(directory: try scratch("no-bookmark"))
        XCTAssertThrowsError(try provider.beginAccess()) { error in
            XCTAssertEqual(error as? MessagesFolderAccess.Error, .noBookmark)
        }
    }

    func testCallingURLBeforeBeginAccessThrowsRatherThanReturningStaleState() throws {
        let provider = SecurityScopedMessagesProvider(directory: try scratch("not-begun"))
        XCTAssertThrowsError(try provider.url(for: .messages)) { error in
            XCTAssertEqual(error as? MessagesFolderAccess.Error, .noBookmark)
        }
    }

    /// The whole point of the provider: a saved bookmark resolves to the messages db
    /// and the attachments folder inside the granted directory, with no TCC prompt
    /// needed for a plain POSIX-readable target.
    func testASavedBookmarkResolvesToMessagesAndAttachments() throws {
        let folder = try makeFakeMessagesFolder()
        let directory = try scratch("state")
        let store = MessagesFolderAccess.BookmarkStore(directory: directory)
        let bookmark = try folder.bookmarkData(options: [.withSecurityScope],
                                               includingResourceValuesForKeys: nil,
                                               relativeTo: nil)
        try store.save(bookmark)

        let provider = SecurityScopedMessagesProvider(directory: directory)
        try provider.beginAccess()
        defer { provider.endAccess() }

        XCTAssertEqual(try provider.url(for: .messages).path,
                       folder.appendingPathComponent("chat.db").path)
        XCTAssertEqual(try provider.url(for: .attachments).path,
                       folder.appendingPathComponent("Attachments").path)
    }

    func testContactsAndCallHistoryAreUnsupportedByThisProviderOnPurpose() throws {
        let folder = try makeFakeMessagesFolder()
        let directory = try scratch("state")
        let store = MessagesFolderAccess.BookmarkStore(directory: directory)
        try store.save(try folder.bookmarkData(options: [.withSecurityScope],
                                               includingResourceValuesForKeys: nil,
                                               relativeTo: nil))

        let provider = SecurityScopedMessagesProvider(directory: directory)
        try provider.beginAccess()
        defer { provider.endAccess() }

        for source in [DataSource.contacts, .callHistory] {
            XCTAssertThrowsError(try provider.url(for: source)) { error in
                XCTAssertEqual(error as? MessagesFolderAccess.Error, .unsupportedSource(source))
            }
        }
    }

    /// Corrupted or truncated bookmark bytes on disk (a half-written save, a bookmark
    /// from a different macOS install restored via Time Machine) must fail loudly with
    /// `resolutionFailed`, never crash and never silently produce garbage.
    func testCorruptBookmarkDataFailsLoudlyRatherThanCrashing() throws {
        let directory = try scratch("corrupt")
        let store = MessagesFolderAccess.BookmarkStore(directory: directory)
        try store.save(Data("not real bookmark data".utf8))

        let provider = SecurityScopedMessagesProvider(directory: directory)
        XCTAssertThrowsError(try provider.beginAccess()) { error in
            guard case .resolutionFailed = error as? MessagesFolderAccess.Error else {
                return XCTFail("expected resolutionFailed, got \(error)")
            }
        }
    }

    // MARK: - FallbackLocalStoreProvider

    /// No bookmark saved at all (a Mac that only ever completed the FDA path, or a
    /// fresh install) must fall back to Full Disk Access rather than throwing —
    /// `FullDiskAccessProvider.url(for:)` will itself throw `.missing`/`.notGranted` as
    /// appropriate, which is the existing, already-tested behaviour.
    func testWithNoBookmarkAtAllItFallsBackRatherThanThrowingNoBookmark() throws {
        let provider = FallbackLocalStoreProvider(bookmarkDirectory: try scratch("fallback"))
        // Falls through to FullDiskAccessProvider.beginAccess(), which is a no-op that
        // never throws — so this must not throw `MessagesFolderAccess.Error.noBookmark`.
        XCTAssertNoThrow(try provider.beginAccess())
    }

    func testASavedBookmarkIsPreferredOverFallingBackToFDA() throws {
        let folder = try makeFakeMessagesFolder()
        let directory = try scratch("state")
        let store = MessagesFolderAccess.BookmarkStore(directory: directory)
        try store.save(try folder.bookmarkData(options: [.withSecurityScope],
                                               includingResourceValuesForKeys: nil,
                                               relativeTo: nil))

        let provider = FallbackLocalStoreProvider(bookmarkDirectory: directory)
        try provider.beginAccess()
        defer { provider.endAccess() }

        // Resolves through the bookmark, not through Full Disk Access against the real
        // ~/Library/Messages — proven by it returning the FAKE folder's chat.db path.
        XCTAssertEqual(try provider.url(for: .messages).path,
                       folder.appendingPathComponent("chat.db").path)
    }
}
