import Foundation

/// Security-scoped bookmark access to `~/Library/Messages`, as an alternative to Full
/// Disk Access. Spiked (not assumed) in `NOTES.md` before this file was written — see
/// that record for the full sequence and its two open non-proofs before trusting this
/// path in production:
///
/// 1. **Untested: an app update.** The spike ran ad-hoc/linker-signed
///    (`TeamIdentifier=not set`); the shipping app is Developer ID–signed and notarized.
///    Bookmark resolution keys on code signing identity, and whether a bookmark saved by
///    build N resolves under the re-signed, re-notarized build N+1 at the same bundle id
///    was never measured. This is the single most likely production failure mode.
/// 2. **Untested: bookmark durability across a real day/night cycle and heavy `chat.db`
///    modification.** The spike round-tripped a static file across about a minute of
///    wall time. Messages.app checkpoints its WAL continuously; a Mac asleep overnight
///    then waking for a 3am `--sync` was never measured.
/// 3. Verified on macOS 15.7.4 (24G517) only. Re-verify at the deployment minimum before
///    trusting this on older systems — the whole result may be version-specific.
///
/// **Because of (1) and (2), `FullDiskAccessProvider` is not a deprecated fallback — it
/// is the thing this file is required to fail loudly into.** A bookmark that fails to
/// resolve must produce a typed, logged error a caller can act on, never a silent
/// "just try FDA and hope," and never a silent empty read.
public enum MessagesFolderAccess {

    public enum Error: Swift.Error, CustomStringConvertible, Equatable {
        /// No bookmark has ever been saved — the user has not run setup, or setup only
        /// ever completed the Full Disk Access path.
        case noBookmark
        /// The bookmark resolved, but macOS marked it stale (the target moved, the
        /// volume was reformatted, or — non-proof (1) above — the calling binary's code
        /// signing identity changed since the bookmark was minted). Resolution repairs
        /// a stale bookmark for free, but repair-in-place would silently paper over an
        /// app-update regression, so this type reports it instead and lets setup
        /// re-prompt.
        case bookmarkStale
        /// `URL(resolvingBookmarkData:)` threw. `detail` is `String(describing: error)`,
        /// never anything from the resolved path's contents.
        case resolutionFailed(detail: String)
        /// The bookmark resolved and access started, but the underlying read still
        /// failed — see `FullDiskAccessProvider.Error.notGranted` for why this is
        /// checked by opening, never by looking.
        case notGranted(source: DataSource, detail: String)
        /// This provider only covers `.messages` and `.attachments` — both live under
        /// the one bookmarked folder. `.contacts` and `.callHistory` need a source this
        /// provider was not built to hold; callers route those through
        /// `FullDiskAccessProvider` unconditionally.
        case unsupportedSource(DataSource)

        public var description: String {
            switch self {
            case .noBookmark:
                return "no Messages folder bookmark saved — setup has not granted " +
                    "folder access; falling back to Full Disk Access"
            case .bookmarkStale:
                return "the saved Messages folder bookmark is stale (moved volume, " +
                    "reformat, or the app's signing identity changed since it was " +
                    "granted, e.g. an app update) — re-run setup"
            case .resolutionFailed(let detail):
                return "could not resolve the saved Messages folder bookmark: \(detail)"
            case .notGranted(let source, let detail):
                return "the bookmarked folder no longer grants \(source.rawValue): \(detail)"
            case .unsupportedSource(let source):
                return "MessagesFolderAccess does not cover \(source.rawValue)"
            }
        }
    }

    /// Where the bookmark lives on disk. One file, one key — this grant only ever
    /// covers one folder (`~/Library/Messages`), so there is nothing to key by.
    ///
    /// `directory` is injectable for exactly the reason `Uploader.Configuration`'s
    /// Application Support search root became injectable: a hardcoded real path in a
    /// unit test either silently passes against a bookmark a developer happens to have
    /// on disk, or silently fails against one they don't — neither is what the test
    /// claims to check.
    public struct BookmarkStore {
        public let directory: String

        public init(directory: String) {
            self.directory = directory
        }

        public static let fileName = "messages-folder-bookmark.data"

        public var path: String {
            URL(fileURLWithPath: directory).appendingPathComponent(Self.fileName).path
        }

        public func save(_ data: Data) throws {
            try FileManager.default.createDirectory(atPath: directory,
                                                     withIntermediateDirectories: true)
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        }

        public func load() -> Data? {
            FileManager.default.contents(atPath: path)
        }

        public func clear() {
            try? FileManager.default.removeItem(atPath: path)
        }
    }
}

/// `LocalStoreProvider` backed by a security-scoped bookmark instead of Full Disk
/// Access. Conforms to the same frozen protocol `FullDiskAccessProvider` does, so
/// everything above it — reader, mirror, metrics, digest — never learns which one it
/// got.
public struct SecurityScopedMessagesProvider: LocalStoreProvider {

    private let store: MessagesFolderAccess.BookmarkStore
    private let log: (String, StructuredLog.Level, [String: Any]) -> Void

    /// `LocalStoreProvider.beginAccess()`/`url(for:)` are declared non-mutating (the
    /// protocol has to work for `FullDiskAccessProvider`, which is stateless), so the
    /// URL resolved for one `beginAccess()`/`endAccess()` window is boxed in a class
    /// rather than stored directly on this struct — a `let` box whose *contents*
    /// mutate. `url(for:)` can be called multiple times inside that window (messages,
    /// then attachments) and must resolve the bookmark only once — resolving twice
    /// would call `startAccessingSecurityScopedResource` on two different `URL`
    /// instances for the same folder, and only the one `endAccess()` stops would
    /// actually get balanced.
    private final class ResolvedFolderBox {
        var url: URL?
    }
    private let resolved = ResolvedFolderBox()

    public init(directory: String,
               log: @escaping (String, StructuredLog.Level, [String: Any]) -> Void =
                   { event, level, fields in
                       StructuredLog.emit(event, level: level, fields: fields)
                   }) {
        self.store = MessagesFolderAccess.BookmarkStore(directory: directory)
        self.log = log
    }

    public func beginAccess() throws {
        guard let data = store.load() else {
            log("access.bookmark_missing", .warn, ["source": "messages"])
            throw MessagesFolderAccess.Error.noBookmark
        }

        var isStale = false
        let url: URL
        do {
            url = try URL(resolvingBookmarkData: data, options: [.withSecurityScope],
                          relativeTo: nil, bookmarkDataIsStale: &isStale)
        } catch {
            log("access.bookmark_resolve_failed", .error,
               ["source": "messages", "detail": String(describing: error)])
            throw MessagesFolderAccess.Error.resolutionFailed(detail: String(describing: error))
        }

        if isStale {
            // LOUD, not silently repaired-in-place: see the file-level doc comment on
            // why an app-update signature change surfacing as staleness must be visible
            // rather than quietly re-blessed.
            log("access.bookmark_stale", .warn, ["source": "messages"])
            throw MessagesFolderAccess.Error.bookmarkStale
        }

        guard url.startAccessingSecurityScopedResource() else {
            log("access.bookmark_start_access_failed", .error, ["source": "messages"])
            throw MessagesFolderAccess.Error.resolutionFailed(
                detail: "startAccessingSecurityScopedResource returned false")
        }

        resolved.url = url
        log("access.bookmark_resolved", .info, ["source": "messages"])
    }

    public func endAccess() {
        resolved.url?.stopAccessingSecurityScopedResource()
        resolved.url = nil
    }

    public func url(for source: DataSource) throws -> URL {
        guard let folder = resolved.url else {
            // `beginAccess()` was not called, or it threw and the caller pressed on
            // anyway. Either is a programmer error at the call site, not a TCC
            // condition, so this is `noBookmark` rather than inventing a third case.
            throw MessagesFolderAccess.Error.noBookmark
        }
        let path: String
        switch source {
        case .messages:
            path = folder.appendingPathComponent("chat.db").path
        case .attachments:
            path = folder.appendingPathComponent("Attachments").path
        case .contacts, .callHistory:
            throw MessagesFolderAccess.Error.unsupportedSource(source)
        }
        guard FileManager.default.fileExists(atPath: path) else {
            throw MessagesFolderAccess.Error.notGranted(source: source,
                                                         detail: "no file at \(path)")
        }
        return URL(fileURLWithPath: path)
    }
}

/// Tries the bookmark first, falls back to Full Disk Access — loudly, every time,
/// never silently. This is the type `SyncRun` actually holds; neither provider on its
/// own is meant to be the production default while non-proofs (1) and (2) in
/// `MessagesFolderAccess`'s doc comment are still open.
public struct FallbackLocalStoreProvider: LocalStoreProvider {

    private let primary: SecurityScopedMessagesProvider
    private let fallback: FullDiskAccessProvider
    private let log: (String, StructuredLog.Level, [String: Any]) -> Void
    // See `SecurityScopedMessagesProvider.ResolvedFolderBox` — same reason: the
    // protocol's methods are non-mutating, so which provider served the current
    // access window is boxed rather than stored as a `var` on this struct.
    private final class RouteBox {
        var usingFallback = false
    }
    private let route = RouteBox()

    public init(bookmarkDirectory: String,
               home: URL = FileManager.default.homeDirectoryForCurrentUser,
               log: @escaping (String, StructuredLog.Level, [String: Any]) -> Void =
                   { event, level, fields in
                       StructuredLog.emit(event, level: level, fields: fields)
                   }) {
        self.primary = SecurityScopedMessagesProvider(directory: bookmarkDirectory, log: log)
        self.fallback = FullDiskAccessProvider(home: home)
        self.log = log
    }

    public func beginAccess() throws {
        do {
            try primary.beginAccess()
            route.usingFallback = false
        } catch {
            // Loud: a structured log line every time the bookmark path is not used,
            // not only on the first occurrence — a silently-recurring fallback is
            // exactly the "fails silently at 3am" failure this track exists to prevent.
            log("access.bookmark_fallback_to_fda", .warn,
               ["reason": String(describing: error)])
            try fallback.beginAccess()
            route.usingFallback = true
        }
    }

    public func endAccess() {
        if route.usingFallback { fallback.endAccess() } else { primary.endAccess() }
    }

    public func url(for source: DataSource) throws -> URL {
        if route.usingFallback { return try fallback.url(for: source) }
        do {
            return try primary.url(for: source)
        } catch MessagesFolderAccess.Error.unsupportedSource {
            // Contacts and call history are never covered by the bookmark, in or out
            // of fallback — always Full Disk Access for those two sources.
            return try fallback.url(for: source)
        }
    }
}
