import Foundation

/// Everything about the Full Disk Access grant that had to be learned by doing it.
///
/// The grant cannot be scripted — there is no `tccutil` verb that grants, and `TCC.db`
/// is SIP-protected. A human clicks. What this file controls is everything around the
/// click, and each piece below exists because performing the grant by hand behaved
/// differently from how anyone would have guessed.
public enum FullDiskAccess {

    /// **FINDING 1: YOU CANNOT DETECT THE GRANT BY LOOKING AT THE FILE.**
    ///
    /// `ls -la ~/Library/Messages/chat.db` succeeded and reported a 151 MB file *while
    /// access was denied*. `stat` is not gated; `open` is. The denial arrives as SQLite
    /// `authorization denied` at connection time and not one moment earlier.
    ///
    /// So the probe opens the database read-only, runs one trivial query to force the
    /// authorization check, and throws the handle away. Anything cheaper — `fileExists`,
    /// `isReadableFile`, a size check — reports success before the grant exists, which
    /// would send a user who has granted nothing straight past the only screen that
    /// matters.
    public static func probe(path: String = defaultMessagesPath()) -> Status {
        guard FileManager.default.fileExists(atPath: path) else { return .noDatabase }
        do {
            let database = try ChatDatabase(path: path)
            // The open alone is not enough on every macOS release: SQLite defers the
            // real file read until the first statement. One count against a table that
            // always exists forces it.
            _ = try database.scalar("SELECT count(*) FROM sqlite_master")
            return .granted
        } catch {
            return .denied(detail: "\(error)")
        }
    }

    public enum Status: Sendable, Equatable {
        case granted
        case denied(detail: String)
        /// No `chat.db` at all — a Mac that has never opened Messages. Not a permission
        /// problem, and telling the user to grant access would not fix it.
        case noDatabase

        public var isGranted: Bool { self == .granted }
    }

    public static func defaultMessagesPath(
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> String {
        home.appendingPathComponent("Library/Messages/chat.db").path
    }

    /// The System Settings pane. Pinned by prompt 07's Definition of Done.
    public static let settingsDeepLink = HealthCheck.fullDiskAccessDeepLink

    /// **FINDING 4: THE GRANT DOES NOT APPLY TO AN ALREADY-RUNNING PROCESS.**
    ///
    /// After granting, the identical query still returned `authorization denied`. It only
    /// worked after the process was quit and reopened. macOS offers "Quit & Reopen" in a
    /// dialog and users dismiss it, and then the app sits there polling a permission it
    /// can never observe.
    ///
    /// So the flow is **deep link → poll → relaunch → verify**, and the relaunch is
    /// load-bearing rather than a nicety. A poll alone waits forever.
    ///
    /// Polls every 500 ms as the prompt specifies — fast enough that the checkmark flips
    /// while the user is still looking at the window, which is the single biggest reason
    /// people abandon this screen.
    public static let pollInterval: TimeInterval = 0.5

    /// The window inside which the relaunch must happen once the toggle flips.
    public static let relaunchBudget: TimeInterval = 2.0
}

/// Which process macOS holds responsible for a file access.
///
/// **FINDING 2: THE RESPONSIBLE PROCESS IS THE OUTER APP BUNDLE, NOT THE PROCESS THAT
/// MADE THE CALL.** Granting access by hand, the chain was:
///
/// ```
/// zsh
///   <- .../Application Support/Claude/claude-code/2.1.219/claude.app/.../claude
///   <- /Applications/Claude.app/Contents/Helpers/disclaimer
///   <- /Applications/Claude.app/Contents/MacOS/Claude
/// ```
///
/// The grant had to go to `/Applications/Claude.app`. Granting the direct parent would
/// not have worked, and the code cannot compute the bundle to grant by walking up one
/// level — it has to keep walking until it runs out of enclosing bundles.
///
/// **FINDING 3, AND IT IS THE EXPENSIVE ONE: THAT DIRECT PARENT IS VERSION-NUMBERED.**
/// `claude-code/2.1.219/claude.app` is CONTRACTS.md § 11 item 10 observed in the wild.
/// If TCC ever binds a grant to a versioned inner bundle, an auto-update silently drops
/// it for the **entire fleet on the same day** — every Mac stops syncing, none of them
/// raise an error, and the first signal is briefs going stale everywhere at once. A
/// per-user "your Mac hasn't checked in" notice is a support ticket. That is an outage
/// nobody is paged for. See `Heartbeat` for the alarm that makes it survivable.
///
/// So Boi keeps every privileged read inside a **stable outer bundle path** — no version
/// number anywhere in it — and this type is what proves the path it would ask the user
/// to grant is that stable one.
public enum ResponsibleBundle {

    /// The outermost `.app` enclosing `executable`, or nil when there is no bundle at
    /// all (a bare CLI binary, which cannot hold the grant).
    ///
    /// Outermost, not nearest: a nested helper bundle is exactly what the Claude chain
    /// had three levels of, and the nearest one is the wrong answer every time.
    public static func enclosingAppBundle(of executable: String) -> String? {
        var components = URL(fileURLWithPath: executable).pathComponents
        var outermost: [String]?
        var walked: [String] = []
        for component in components {
            walked.append(component)
            if component.hasSuffix(".app"), outermost == nil {
                outermost = walked
            }
        }
        components = outermost ?? []
        guard !components.isEmpty else { return nil }
        return NSString.path(withComponents: components)
    }

    /// The bundle this running process would need granted.
    public static func current(
        executable: String = ProcessInfo.processInfo.arguments.first ?? "",
        bundle: Bundle = .main
    ) -> String? {
        // Inside a real .app, `Bundle.main` already is the outer bundle and is the
        // authority. Outside one — `swift run`, a unit test — fall back to walking the
        // executable path, which is the case the Claude chain exercised.
        if bundle.bundleURL.pathExtension == "app" { return bundle.bundleURL.path }
        return enclosingAppBundle(of: executable)
    }

    /// True when the path carries something that looks like a version number in a
    /// directory component.
    ///
    /// A bundle path containing `2.1.219` is a path that changes on every auto-update.
    /// Boi's must not, and this is asserted in the suite rather than left as an
    /// intention in a comment.
    public static func containsVersionedComponent(_ path: String) -> Bool {
        URL(fileURLWithPath: path).pathComponents.contains { component in
            component.range(of: #"^v?\d+\.\d+(\.\d+)*$"#, options: .regularExpression) != nil
        }
    }
}

/// FDA today, scoped bookmarks at launch.
///
/// The point of conforming to the frozen `LocalStoreProvider` is that everything above
/// it — reader, mirror, metrics, digest — never learns which one it got, so the swap
/// costs an afternoon instead of a rewrite. Nothing in this type is reachable from the
/// metric library, and that is deliberate.
public struct FullDiskAccessProvider: LocalStoreProvider {

    public enum Error: Swift.Error, CustomStringConvertible {
        case notGranted(source: DataSource, detail: String)
        case missing(source: DataSource, path: String)

        public var description: String {
            switch self {
            case .notGranted(let source, let detail):
                return "Full Disk Access is not granted, so \(source.rawValue) cannot be "
                    + "read: \(detail). Grant it in System Settings and reopen the app — "
                    + "macOS does not apply the grant to a process that is already running."
            case .missing(let source, let path):
                return "no \(source.rawValue) database at \(path). This Mac may never have "
                    + "opened Messages; that is not a permission problem."
            }
        }
    }

    private let home: URL

    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.home = home
    }

    public func url(for source: DataSource) throws -> URL {
        let path: String
        switch source {
        case .messages:
            path = FullDiskAccess.defaultMessagesPath(home: home)
        case .attachments:
            path = home.appendingPathComponent("Library/Messages/Attachments").path
        case .contacts:
            guard let found = AddressBookDirectory.defaultPaths(home: home)
                .first(where: { FileManager.default.fileExists(atPath: $0) }) else {
                throw Error.missing(source: source, path: "Library/Application Support/AddressBook")
            }
            path = found
        case .callHistory:
            path = CallHistory.defaultPaths(home: home)[0]
        }

        guard FileManager.default.fileExists(atPath: path) else {
            throw Error.missing(source: source, path: path)
        }
        // Probe by opening, never by looking — finding 1. `messages` is the only source
        // whose openability we can check with a real query; for the rest, existence plus
        // the messages probe is the honest signal, because a denial on one FDA-gated path
        // is a denial on all of them.
        if case .denied(let detail) = FullDiskAccess.probe(path:
            FullDiskAccess.defaultMessagesPath(home: home)) {
            throw Error.notGranted(source: source, detail: detail)
        }
        return URL(fileURLWithPath: path)
    }

    /// FDA needs no begin/end pair — that is a scoped-bookmark idea, and these exist so
    /// the later swap does not change a single call site.
    public func beginAccess() throws {}
    public func endAccess() {}
}
