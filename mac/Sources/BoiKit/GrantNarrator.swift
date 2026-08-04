import Foundation

/// What the user is looking at, and what they should do about it.
///
/// **The anchor of this track is that the grant is the product's cliff edge and a user
/// standing on it can see nothing.** Before this type existed, `PermissionModel` had four
/// renderings for the whole grant — a spinner, "Not granted yet", a poll counter, and one
/// `"Something went wrong"` that caught every distinct failure. A user who granted the
/// wrong app, whose bundle sat in `~/Downloads`, or whose relaunch silently failed all saw
/// the same screen as somebody who simply had not clicked yet.
///
/// So the stages are enumerated here rather than inlined in the view, for two reasons that
/// are both load-bearing:
///
/// 1. **`BoiApp` is an executable target and `BoiKitTests` cannot import it**
///    (`Package.swift`). Copy that lives in the view is copy no test can read. Putting the
///    stage and its words in `BoiKit` is what makes "every state names what to do next" an
///    assertion instead of an intention.
/// 2. **`CaseIterable` lets the test iterate the whole enumeration.** A test that checks
///    the five stages somebody remembered is a test that a sixth stage silently defeats.
///
/// Deliberately **no associated values.** The poll count and a failure's detail string are
/// live data the view renders *alongside* a stage, not part of its identity — otherwise
/// `CaseIterable` is unavailable and the exhaustiveness this type exists for goes with it.
public enum GrantStage: String, CaseIterable, Sendable, Equatable {

    /// Probing at launch, before we know anything.
    case checking
    /// The consent screen. Named here so the enumeration covers onboarding end to end.
    case needsConsent

    /// **Failure path 1, and it is caught BEFORE the deep link.** The grant binds to the
    /// responsible bundle; a bundle outside an Applications folder can be granted and the
    /// grant still will not survive, so sending the user to System Settings first wastes
    /// the one trip they are willing to make. See `InstallLocation` for why *both*
    /// Applications folders count.
    case notInApplications

    /// The deep link is open and we are polling.
    case waiting
    /// **Failure paths 2 and 3, which the platform cannot tell apart.** A grant given to
    /// the wrong entry and a user who never flipped anything both leave the probe
    /// `denied`, byte-identical. So this stage does not *claim* a diagnosis — it escalates
    /// with the two things worth checking and a way out that does not depend on us
    /// detecting anything.
    case waitingStalled
    /// The user came back to Boi with the switch still off. A real signal — the app became
    /// frontmost again — and distinct from never having left.
    case returnedWithoutGranting

    /// The toggle flipped. Shown before the relaunch, because an app that vanishes without
    /// acknowledging the click is indistinguishable from a crash.
    case granted
    case relaunching
    /// **Failure path 4.** The relaunch was asked for and this process is still here past
    /// `FullDiskAccess.relaunchBudget`. Distinct from `deniedAfterRelaunch` in both the UI
    /// and the log, because the remedies are different: this one is "quit us by hand", the
    /// other is "the switch is on the wrong row".
    case relaunchStalled
    /// **Failure path 5.** We relaunched and the probe is still denied. The switch is off,
    /// or it is on for something that is not this bundle.
    case deniedAfterRelaunch

    /// Not a permission problem, and telling the user to grant access would not fix it.
    case noDatabase
    /// Granted and verified; reading the corpus.
    case syncing
    case ready
    /// A genuine unexpected error — and *only* that. Every condition above has its own
    /// stage precisely so this one stops being the drain everything falls into.
    case failed

    // MARK: - What the user is told

    public var title: String {
        switch self {
        case .checking: return "Checking this Mac"
        case .needsConsent: return "Boi reads your message history on this Mac"
        case .notInApplications: return "Move Boi to your Applications folder first"
        case .waiting: return "Waiting for you to flip the switch"
        case .waitingStalled: return "Still waiting — two things worth checking"
        case .returnedWithoutGranting: return "The switch is still off"
        case .granted: return "Full Disk Access granted"
        case .relaunching: return "Restarting Boi"
        case .relaunchStalled: return "Boi could not restart itself"
        case .deniedAfterRelaunch: return "Boi restarted, and the switch is still off"
        case .noDatabase: return "This Mac has no Messages history yet"
        case .syncing: return "Reading your messages"
        case .ready: return "You're all set"
        case .failed: return "Boi hit an error it did not expect"
        }
    }

    public var body: String {
        switch self {
        case .checking:
            return "Looking at whether Boi can already read your messages. This takes a "
                + "moment and needs nothing from you."
        case .needsConsent:
            return "To tell you who you are drifting from, Boi reads the conversations on "
                + "this Mac — including the messages other people sent you. That reading "
                + "happens here, on your machine, and nowhere else."
        case .notInApplications:
            return "macOS ties Full Disk Access to where an app lives. Granted from any "
                + "other folder, the permission will not stick — and you would not find "
                + "out until Boi stopped working."
        case .waiting:
            return "System Settings is open on the Full Disk Access list. Boi is watching "
                + "and will notice the moment you switch it on."
        case .waitingStalled:
            return "Boi still cannot read your messages. Almost always this is one of two "
                + "things: the switch went on for a different app in the list, or the "
                + "settings window closed before it took."
        case .returnedWithoutGranting:
            return "You're back, and Boi still cannot read your messages. Nothing is "
                + "broken — the switch just is not on yet."
        case .granted:
            return "Boi can read your messages. macOS only applies that to an app that "
                + "starts afterwards, so Boi has to restart before it can use it."
        case .relaunching:
            return "Boi is closing and reopening itself. This is expected, it takes about "
                + "a second, and you do not need to do anything."
        case .relaunchStalled:
            return "The switch is on, but Boi could not close and reopen itself — so it "
                + "still cannot use the access you just granted. Quitting it by hand does "
                + "exactly the same job."
        case .deniedAfterRelaunch:
            return "Boi restarted and still cannot read your messages, so the switch it "
                + "needs is not the one that got flipped. The row has to say Boi, and the "
                + "toggle has to be blue."
        case .noDatabase:
            return "Boi could not find a Messages database on this Mac. This is not a "
                + "permissions problem — there is simply nothing here to read yet."
        case .syncing:
            return "Boi is reading your message history. It stays on this Mac; only counts "
                + "and dates ever leave."
        case .ready:
            return "Boi can read your messages and the first report is on its way to your "
                + "thread."
        case .failed:
            return "This is not a permissions problem and not something you did. The "
                + "details are below and in Boi's log."
        }
    }

    /// The one thing to do now. **Non-nil for every stage that needs the user**, which is
    /// the criterion: a state that renders without naming a next step is the spinner this
    /// track exists to delete.
    public var nextStep: String? {
        switch self {
        case .checking, .syncing, .ready:
            // Nothing is being asked. These are the only three, and the test pins that.
            return nil
        case .needsConsent:
            return "Read the four points above, then continue."
        case .notInApplications:
            return "Drag Boi into Applications, open it from there, and come back to this "
                + "screen."
        case .waiting:
            return "Find Boi in the list and switch it on."
        case .waitingStalled:
            return "Check that the row you switched on says Boi, then leave System "
                + "Settings open until Boi notices."
        case .returnedWithoutGranting:
            return "Reopen the settings pane and switch Boi on."
        case .granted:
            return "Nothing — Boi is restarting itself now."
        case .relaunching:
            return "Wait about a second."
        case .relaunchStalled:
            return "Quit Boi with Command-Q and open it again."
        case .deniedAfterRelaunch:
            return "Open the pane again and switch on the row that says Boi."
        case .noDatabase:
            return "Open Messages, sign in with your Apple Account, then come back."
        case .failed:
            return "Try again. If it keeps happening, the log will say why."
        }
    }

    /// Whether this stage is the user stuck rather than the user progressing. Drives the
    /// icon and the log level, and pins which stages must carry a remedy.
    public var isFailure: Bool {
        switch self {
        case .notInApplications, .waitingStalled, .returnedWithoutGranting,
             .relaunchStalled, .deniedAfterRelaunch, .noDatabase, .failed:
            return true
        case .checking, .needsConsent, .waiting, .granted, .relaunching, .syncing, .ready:
            return false
        }
    }

    /// Whether the Full Disk Access deep link is worth offering here.
    ///
    /// **`notInApplications` is deliberately false.** Sending somebody to System Settings
    /// to grant a bundle that cannot hold the grant is the wasted trip this stage exists
    /// to prevent.
    public var offersSettingsLink: Bool {
        switch self {
        case .waiting, .waitingStalled, .returnedWithoutGranting, .deniedAfterRelaunch:
            return true
        case .checking, .needsConsent, .notInApplications, .granted, .relaunching,
             .relaunchStalled, .noDatabase, .syncing, .ready, .failed:
            return false
        }
    }

    /// Whether to offer "quit and reopen Boi yourself".
    ///
    /// Offered wherever the automatic relaunch may not arrive. `waitingStalled` is on this
    /// list on purpose: if the probe can never observe the grant from inside the process
    /// that was running when it was made, an automatic relaunch is never triggered and
    /// this button is the user's only exit. See `NOTES.md`.
    public var offersManualRelaunch: Bool {
        switch self {
        case .waitingStalled, .relaunchStalled, .deniedAfterRelaunch:
            return true
        // `returnedWithoutGranting` is false on purpose: nothing has been granted yet, so
        // restarting would accomplish exactly nothing and offering it implies otherwise.
        case .checking, .needsConsent, .notInApplications, .waiting,
             .returnedWithoutGranting, .granted, .relaunching, .noDatabase, .syncing,
             .ready, .failed:
            return false
        }
    }

    /// The structured-log event for this stage. One slug per stage so
    /// `relaunchStalled` and `deniedAfterRelaunch` are distinguishable in the log as well
    /// as on screen, which the Definition of Done requires separately.
    public var logEvent: String { "fda.stage.\(rawValue)" }

    /// How long somebody waits before "it is working, keep going" becomes a lie.
    ///
    /// A correct grant is observed in a second or two. Thirty seconds of nothing means
    /// something is wrong that more waiting will not fix — but it is deliberately not
    /// three, because escalating over a user who is still reading the settings list is how
    /// a helpful screen becomes a nagging one.
    public static let escalateAfter: TimeInterval = 30

    /// Which waiting screen to show, given how many polls have gone by.
    ///
    /// **This is an escalation, not a detection.** A grant given to the wrong entry and a
    /// user who never flipped anything both leave the probe `denied`, byte-identical —
    /// macOS offers nothing that tells them apart. So the stalled screen offers the two
    /// things worth checking and a way out, and claims no diagnosis it cannot support.
    public static func whileWaiting(polls: Int) -> GrantStage {
        Double(polls) * FullDiskAccess.pollInterval >= escalateAfter ? .waitingStalled : .waiting
    }
}

/// Decides **when** a change in the Full Disk Access grant is worth telling the cloud
/// about, and rate-limits it.
///
/// Not *what* the message says — the copy is the cloud's, and this type never sees it.
/// Under AMENDMENT-002 the iMessage thread already exists by the time the Mac app is
/// installed, so the cloud can narrate the grant on the phone in the user's hand while
/// they work on the Mac. This is the Mac half of that: the signal, and nothing else.
///
/// ## Two rules, and the first one outranks the second
///
/// **The first false→true fires immediately, always.** That message is the entire reason
/// this track exists. A rate limiter that delays it would satisfy a "one signal per
/// minute" criterion while defeating the thing the criterion was written to protect.
///
/// **The cap applies to flapping thereafter** — at most one signal per
/// `minimumInterval`. A grant that toggles repeatedly is a user experimenting in System
/// Settings, and it must not become a burst of heartbeats.
///
/// ## Why the state is persisted
///
/// The happy path **relaunches the process.** An in-memory limiter would signal the grant,
/// relaunch, come back with an empty memory and signal again — two heartbeats about the
/// same event, roughly two seconds apart, straight through a cap that reads as one per
/// minute in the tests. Persisting `lastSignalled` across the relaunch is what makes the
/// limit true on the one path that actually happens.
public final class GrantNarrator {

    /// The floor between two signals about the same device.
    public static let minimumInterval: TimeInterval = 60

    public enum Decision: Equatable, Sendable {
        /// Send a heartbeat now, carrying this grant state.
        case signal(granted: Bool)
        /// Nothing new to say. The cloud already believes this.
        case unchanged
        /// The state genuinely changed, but too soon after the last signal. Carries how
        /// long until a signal would be allowed, so the caller can log a number rather
        /// than "suppressed".
        case suppressed(granted: Bool, retryAfter: TimeInterval)

        public var isSignal: Bool {
            if case .signal = self { return true }
            return false
        }
    }

    /// What the cloud was last told, and when. `nil` state means "never told it anything".
    public struct Memory: Codable, Sendable, Equatable {
        public var granted: Bool
        public var at: Date

        public init(granted: Bool, at: Date) {
            self.granted = granted
            self.at = at
        }
    }

    private var memory: Memory?
    private let persist: (Memory) -> Void

    /// - Parameters:
    ///   - memory: what a previous process already signalled, or nil on a first run.
    ///   - persist: called whenever a signal is issued, so the limit survives the relaunch.
    ///     Defaults to doing nothing, which is what a unit test wants.
    public init(memory: Memory? = nil, persist: @escaping (Memory) -> Void = { _ in }) {
        self.memory = memory
        self.persist = persist
    }

    /// What the cloud currently believes, or nil if it has never been told.
    public var lastSignalled: Memory? { memory }

    /// One observation of the grant state.
    ///
    /// Called on every poll rather than only on a detected edge, and that is deliberate:
    /// it is what lets a suppressed change **converge**. If the grant flips true (signal),
    /// then flips false and is suppressed, the cloud would otherwise be left believing a
    /// grant that no longer exists, forever, because no further edge ever arrives. Driving
    /// off the difference between the current state and the last *signalled* state instead
    /// of off an edge means the next observation after the interval elapses corrects it.
    public func observe(granted: Bool, now: Date) -> Decision {
        guard let memory else {
            // Never signalled anything. A Mac that starts up denied is not news — the
            // cloud's default assumption is already "not granted", and announcing it would
            // spend the user's first heartbeat saying nothing.
            guard granted else { return .unchanged }
            return issue(granted: granted, now: now)
        }

        // The cloud already believes this. Not a change, whatever the clock says.
        guard memory.granted != granted else { return .unchanged }

        let elapsed = now.timeIntervalSince(memory.at)
        guard elapsed >= Self.minimumInterval else {
            return .suppressed(granted: granted,
                               retryAfter: Self.minimumInterval - elapsed)
        }
        return issue(granted: granted, now: now)
    }

    private func issue(granted: Bool, now: Date) -> Decision {
        let updated = Memory(granted: granted, at: now)
        memory = updated
        persist(updated)
        return .signal(granted: granted)
    }

    // MARK: - Persistence

    public static let fileName = "grant-narrator.json"

    /// Loads what a previous process signalled. A missing or unreadable file means "never
    /// signalled", which is the safe direction: the worst case is one extra heartbeat, and
    /// the alternative — assuming we already told the cloud — silently loses the message
    /// this whole track exists to send.
    public static func load(fromDirectory directory: String) -> Memory? {
        let url = URL(fileURLWithPath: directory).appendingPathComponent(fileName)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Memory.self, from: data)
    }

    public static func save(_ memory: Memory, toDirectory directory: String) {
        let url = URL(fileURLWithPath: directory).appendingPathComponent(fileName)
        try? FileManager.default.createDirectory(at: URL(fileURLWithPath: directory),
                                                 withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(memory) else { return }
        try? data.write(to: url, options: .atomic)
    }

    /// A narrator wired to the on-disk memory in `directory`.
    public static func persisted(inDirectory directory: String) -> GrantNarrator {
        GrantNarrator(memory: load(fromDirectory: directory),
                      persist: { save($0, toDirectory: directory) })
    }
}

/// Which stage a launch lands on.
///
/// Pure, and in `BoiKit`, because `BoiApp` is an executable target that `BoiKitTests`
/// cannot import — logic left in the view model is logic no test can reach. `PermissionModel`
/// keeps only the wiring: the probe, the timer, the window.
public enum LaunchDisposition {

    /// - Parameters:
    ///   - probe: what `FullDiskAccess.probe()` just said.
    ///   - didRelaunch: whether the previous process relaunched us for this grant. The
    ///     marker is what makes "still denied after relaunch" distinguishable from "has not
    ///     tried yet" — without it both are simply `denied` and collapse into one screen.
    ///   - install: where this bundle lives.
    public static func stage(probe: FullDiskAccess.Status,
                             didRelaunch: Bool,
                             install: InstallLocation.Verdict) -> GrantStage {
        switch probe {
        case .granted:
            return .syncing
        case .noDatabase:
            // Not a permission problem. Sending this user to System Settings would be
            // advice that cannot work.
            return .noDatabase
        case .denied:
            // **Install location outranks the relaunch marker**, because when both apply
            // the wrong folder is the *cause* of the failed relaunch. Reporting
            // "still denied after restarting" to somebody running Boi from ~/Downloads
            // sends them back to a switch that was never going to hold.
            if case .elsewhere = install { return .notInApplications }
            return didRelaunch ? .deniedAfterRelaunch : .waiting
        }
    }
}

/// The heartbeat sent at the moment the grant lands, on the wire.
///
/// **This is not `HeartbeatUpload`, and the difference is AMENDMENT-003.** That struct
/// declares `digest_as_of: String` — non-optional — because it was written for a heartbeat
/// that follows a sync. The grant heartbeat by definition precedes the first digest, so
/// there is no timestamp to put there, and Track E's own comment is right that inventing
/// one "would report a Mac that produced nothing as having produced something now."
///
/// AMENDMENT-003 makes `digest_as_of` **required and nullable**: `null` is the claim "this
/// device has never synced", which turns *granted but never synced* into a queryable fleet
/// state instead of an invisible one. The amendment is Track E's to implement in the
/// struct and the route; this track does not wait for it and does not edit
/// `Uploader.swift`. So the body is encoded here to the amended shape and handed to the
/// existing `Uploader.send(_:to:descriptor:)`, which takes raw `Data` and is unchanged.
///
/// When Track E lands the amendment in `HeartbeatUpload`, this type collapses into it and
/// one call site moves. That is the seam working as intended.
public struct GrantHeartbeat: Sendable, Equatable {

    public var device_id: String
    public var app_version: String
    /// AMENDMENT-003. `nil` encodes as an explicit `null`, never as an absent key —
    /// omitting it would be rejected by a schema that still requires the field, and would
    /// read as "an older build that did not report it" rather than "never synced".
    public var digest_as_of: String?
    public var macos_version: String?
    public var fda_granted: Bool

    public init(device_id: String,
                app_version: String,
                digest_as_of: String?,
                macos_version: String? = nil,
                fda_granted: Bool) {
        self.device_id = device_id
        self.app_version = app_version
        self.digest_as_of = digest_as_of
        self.macos_version = macos_version
        self.fda_granted = fda_granted
    }

    /// The exact property set `POST /v1/heartbeat` declares. The route sets
    /// `additionalProperties: false`, so an extra key is a `400` — this is written out
    /// rather than derived so the test can compare against it and a drift shows up here.
    public static let wireKeys: Set<String> = [
        "device_id", "app_version", "digest_as_of", "macos_version", "fda_granted",
    ]

    /// JSON with `digest_as_of` present-and-null when there has been no digest.
    ///
    /// `macos_version` is omitted when absent rather than nulled: the contract marks it
    /// optional, and `additionalProperties: false` with a null on an optional string is a
    /// validation failure on a strict schema.
    public func encoded() throws -> Data {
        var object: [String: Any] = [
            "device_id": device_id,
            "app_version": app_version,
            "fda_granted": fda_granted,
        ]
        if let macos_version { object["macos_version"] = macos_version }
        if let digest_as_of {
            object["digest_as_of"] = digest_as_of
        } else {
            object["digest_as_of"] = NSNull()
        }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}

/// Ties the narrator's decision to the byte that leaves the machine.
///
/// Kept in `BoiKit` rather than in the view model for the reason the whole track turns on:
/// `BoiApp` is an executable target and `BoiKitTests` cannot import it, so anything living
/// there cannot be asserted against a real server. The Definition of Done asks for the
/// heartbeat that left the machine, which means this has to be reachable from a test.
public struct GrantSignaller: Sendable {

    private let uploader: Uploader
    private let appVersion: String
    private let deviceID: String

    /// `DeviceIdentity` stays injected, per AMENDMENT-003. `device_id` is derivable on the
    /// Mac and `/v1/pair` accepts a client-supplied one; the device *token* comes from
    /// pairing, which under AMENDMENT-002 now happens in the iMessage thread before the
    /// app is ever installed — so by the time the grant lands, the device is already
    /// paired.
    public init(uploader: Uploader, deviceID: String, appVersion: String) {
        self.uploader = uploader
        self.deviceID = deviceID
        self.appVersion = appVersion
    }

    /// Sends the grant heartbeat. Returns what the server said, or `nil` if the body could
    /// not be encoded at all.
    ///
    /// **Synchronous, and blocking.** `Uploader.URLSessionTransport` waits on a semaphore,
    /// so every caller on the main actor must get this off it — a 30-second timeout on the
    /// main thread would freeze the exact screen this track exists to keep alive.
    @discardableResult
    public func send(granted: Bool,
                     digestGeneratedAt: String?,
                     macOSVersion: String? =
                        ProcessInfo.processInfo.operatingSystemVersionString,
                     log: (String, StructuredLog.Level, [String: Any]) -> Void = Uploader.emit
    ) -> Uploader.Result? {
        let beat = GrantHeartbeat(device_id: deviceID,
                                  app_version: appVersion,
                                  digest_as_of: digestGeneratedAt,
                                  macos_version: macOSVersion,
                                  fda_granted: granted)
        guard let body = try? beat.encoded() else { return nil }
        // `digest_as_of` is the descriptor's `asOf` when there is one. Nothing else about
        // the payload is loggable and none of it is user content.
        let descriptor = Uploader.PayloadDescriptor(schemaVersion: "heartbeat",
                                                    asOf: digestGeneratedAt)
        return uploader.send(body, to: .heartbeat, descriptor: descriptor, log: log)
    }
}

/// Whether this app is somewhere the grant can actually stick.
///
/// **Checked before the deep link is shown, never after the grant fails.** macOS ties Full
/// Disk Access to the responsible bundle's path. A bundle in `~/Downloads` can be granted
/// and the permission still will not hold, and the user finds out by Boi silently not
/// working — after they have already spent the one trip to System Settings they were
/// willing to make.
public enum InstallLocation {

    /// The directories a bundle can durably hold the grant from.
    ///
    /// **`~/Applications` counts, and that was established empirically rather than
    /// assumed.** TRACK.md states the bundle must be "in `/Applications`". This project's
    /// own log disproves the strict reading: on 3 Aug, `~/Applications/Boi.app` held Full
    /// Disk Access and completed a full sync of 94,897 messages. A check requiring
    /// `/Applications` exactly would tell that user to move a working install — advice
    /// that is both wrong and destructive, because moving the bundle is what actually
    /// breaks the grant.
    ///
    /// The property that matters is not which folder it is, but that the path is **stable
    /// and user-installed**. Both Applications folders are; `~/Downloads`, `/Volumes`,
    /// `/tmp` and Gatekeeper's randomized `AppTranslocation` paths are not.
    ///
    /// Not a prefix test — a bundle at `~/Downloads/Applications/Boi.app` contains the
    /// word and is still not installed. These are matched as the *enclosing directory*.
    public static func installDirectories(
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> [String] {
        ["/Applications", home.appendingPathComponent("Applications").path]
    }

    public enum Verdict: Sendable, Equatable {
        case installed
        /// Runnable but not durably grantable. Carries the path so the screen can show the
        /// user where the copy they opened actually is.
        case elsewhere(path: String)
        /// No enclosing `.app` at all — `swift run`, or a unit test. A bare binary cannot
        /// hold the grant, and it is also not a case any shipping user reaches.
        case notABundle
    }

    public static func verdict(
        bundlePath: String?,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> Verdict {
        guard let bundlePath, bundlePath.hasSuffix(".app") else { return .notABundle }
        // The enclosing directory, resolved: `/tmp` is a symlink to `/private/tmp`, and a
        // path comparison that ignores that reports two different strings for one folder.
        let parent = URL(fileURLWithPath: bundlePath).deletingLastPathComponent()
            .resolvingSymlinksInPath().path
        let allowed = installDirectories(home: home)
            .map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }
        return allowed.contains(parent) ? .installed : .elsewhere(path: bundlePath)
    }

    /// The verdict for the running process, via the responsible bundle — not
    /// `Bundle.main` directly, because the grant binds to the outermost enclosing bundle
    /// and that is the path that has to be installed.
    public static func current() -> Verdict {
        verdict(bundlePath: ResponsibleBundle.current())
    }
}
