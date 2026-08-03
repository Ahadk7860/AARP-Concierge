import Foundation

/// One complete pass: read `chat.db`, update the mirror, write the digest and the voice
/// packs, record a heartbeat.
///
/// This is what `Boi.app --sync` does, and the LaunchAgent invokes **the main app
/// binary** with that flag. Never a separate helper: TCC is per-responsible-process and
/// children do not inherit, so a helper binary would need its own Full Disk Access grant
/// that the user has no idea how to give and no screen ever asks for. The sync would
/// then silently never run — no error, no alarm, just a brief that quietly stops being
/// about this week.
public struct SyncRun {

    /// `StartInterval`, not `StartCalendarInterval`. A calendar trigger assumes the
    /// laptop is open at a particular moment; an interval degrades gracefully across
    /// unpredictable opens, which is what a laptop actually is.
    public static let defaultIntervalSeconds = 1800

    /// The idempotent guard. Two invocations inside this window do one run and log a
    /// skip — `launchd` fires on wake as well as on schedule, so a laptop opened five
    /// times in an hour would otherwise do five full passes for nothing.
    public static let defaultMinimumHoursBetweenRuns = 6

    public struct Paths: Sendable {
        public var chatDatabase: String
        public var mirror: String
        public var outputDirectory: String
        public var stateDirectory: String

        public init(chatDatabase: String, mirror: String,
                    outputDirectory: String, stateDirectory: String) {
            self.chatDatabase = chatDatabase
            self.mirror = mirror
            self.outputDirectory = outputDirectory
            self.stateDirectory = stateDirectory
        }

        /// Where a real installation keeps things: Application Support, not `/tmp`.
        public static func installed(
            home: URL = FileManager.default.homeDirectoryForCurrentUser
        ) -> Paths {
            let root = home.appendingPathComponent("Library/Application Support/Boi")
            return Paths(chatDatabase: FullDiskAccess.defaultMessagesPath(home: home),
                         mirror: root.appendingPathComponent("mirror.db").path,
                         outputDirectory: root.appendingPathComponent("out").path,
                         stateDirectory: root.path)
        }
    }

    public struct Outcome: Sendable {
        public var ran: Bool
        public var skippedReason: String?
        public var messagesIngested = 0
        public var mirrorMessageCount = 0
        public var digestPath: String?
        public var voicePackPaths: [String] = []
        public var health: CorpusHealth = .thin
        public var heartbeatPath: String?
        public var elapsed: TimeInterval = 0
    }

    public let paths: Paths
    public let salt: String
    public let minimumHoursBetweenRuns: Int

    public init(paths: Paths, salt: String,
                minimumHoursBetweenRuns: Int = SyncRun.defaultMinimumHoursBetweenRuns) {
        self.paths = paths
        self.salt = salt
        self.minimumHoursBetweenRuns = minimumHoursBetweenRuns
    }

    static let lastRunKey = "last_full_run_at"

    /// `force` is what the app's own "Scan now" button passes. The guard exists to stop
    /// `launchd` from re-running on every wake, not to stop a human who just clicked.
    public func run(now: Date = Date(), force: Bool = false) throws -> Outcome {
        let started = Date()
        var outcome = Outcome(ran: false)

        let mirror = try MirrorDatabase(path: paths.mirror)
        if !force, let previous = try mirror.meta(Self.lastRunKey)
            .flatMap(StructuredLog.date(from:)),
           now.timeIntervalSince(previous) < Double(minimumHoursBetweenRuns) * 3600 {
            outcome.skippedReason = "a full run completed at \(StructuredLog.timestamp(previous)), "
                + "inside the \(minimumHoursBetweenRuns)h window"
            outcome.mirrorMessageCount = try mirror.messageCount()
            return outcome
        }

        // Keep the Mac awake for the duration. A run interrupted by sleep leaves the
        // mirror consistent — every write is in a transaction — but wastes the wake.
        let caffeinate = Caffeinate.start()
        defer { caffeinate?.stop() }

        let reader = try MessageReader(path: paths.chatDatabase)
        let stats = try MirrorSync(reader: reader, mirror: mirror).run(now: now)
        outcome.messagesIngested = stats.inserted + stats.updated
        outcome.mirrorMessageCount = try mirror.messageCount()

        let contacts = AddressBookDirectory.discover()
        let calls = CallHistory.discover()
        let resolver = ContactResolver(salt: salt, directory: contacts ?? .empty)
        let metrics = try MetricLibrary(resolver: resolver,
                                        options: .init(now: now, callHistory: calls))
            .compute(mirror: mirror)

        var system = HealthCheck.SystemState.read()
        system.hasNonIMessageContacts = contacts.map { $0.recordCount > 0 }
        let health = HealthCheck.evaluate(corpus: metrics.corpus, system: system)
        outcome.health = health.health

        // DEGRADE, NEVER FABRICATE. A thin corpus gets no digest — handing somebody a
        // report built on 400 messages and calling it their year is the failure this
        // whole health check exists to prevent, and writing the file anyway would let a
        // later step pick it up and send it.
        if health.producesReport {
            let digest = DigestBuilder(resolver: resolver,
                                       options: .init(generatedAt: now, system: system))
                .build(from: metrics)
            let digestPath = URL(fileURLWithPath: paths.outputDirectory)
                .appendingPathComponent("digest.json").path
            try DigestBuilder.write(digest, to: digestPath)
            outcome.digestPath = digestPath

            let packs = try VoicePackBuilder(options: .init(
                now: now, redactor: Redactor(directory: contacts ?? .empty)))
                .build(mirror: mirror, identities: metrics.relationships.map(\.identity))
            outcome.voicePackPaths = try packs.map {
                try VoicePackBuilder.write($0, toDirectory: paths.outputDirectory)
            }
        }

        try mirror.setMeta(Self.lastRunKey, StructuredLog.timestamp(now))
        outcome.heartbeatPath = try writeHeartbeat(now: now,
                                                   lastSuccessfulSyncAt: now,
                                                   mirrorMessageCount: outcome.mirrorMessageCount,
                                                   health: health.health)

        outcome.ran = true
        outcome.elapsed = Date().timeIntervalSince(started)
        return outcome
    }

    /// Records a heartbeat **whether or not the run succeeded**.
    ///
    /// `full_disk_access` used to be passed a literal `true`, written only after a
    /// successful run — so the field could not vary, and the fleet-wide alarm Track D is
    /// asked to build on it would have been built on a constant. The one state that
    /// matters most is exactly the one that never got recorded: **access denied**, which
    /// is the signature of a grant dropped by an auto-update.
    ///
    /// So the value is probed, not asserted, and `runReportingFailures` writes one on the
    /// failure path too. A Mac that cannot read `chat.db` must still be able to say so.
    @discardableResult
    func writeHeartbeat(now: Date,
                        lastSuccessfulSyncAt: Date?,
                        mirrorMessageCount: Int,
                        health: CorpusHealth) throws -> String {
        try Heartbeat.write(
            Heartbeat.current(now: now,
                              appVersion: AppInfo.version,
                              bundlePath: ResponsibleBundle.current(),
                              fullDiskAccess: FullDiskAccess.probe(path: paths.chatDatabase)
                                  .isGranted,
                              lastSuccessfulSyncAt: lastSuccessfulSyncAt,
                              mirrorMessageCount: mirrorMessageCount,
                              corpusHealth: health),
            toDirectory: paths.stateDirectory)
    }

    /// `run`, but a failure still leaves a heartbeat behind.
    ///
    /// This is the path the LaunchAgent takes. A Mac whose grant was revoked throws on
    /// the first read, and if that simply propagated the machine would go **silent** —
    /// indistinguishable from a laptop in a drawer. Silent-and-denied is the diagnosis;
    /// silent alone is not.
    public func runReportingFailures(now: Date = Date(), force: Bool = false) throws -> Outcome {
        do {
            return try run(now: now, force: force)
        } catch {
            let previous = try? MirrorDatabase(path: paths.mirror)
            let lastRun = (try? previous?.meta(Self.lastRunKey))
                .flatMap { $0 }
                .flatMap(StructuredLog.date(from:))
            let count = (try? previous?.messageCount()).flatMap { $0 } ?? 0
            _ = try? writeHeartbeat(now: now,
                                    lastSuccessfulSyncAt: lastRun,
                                    mirrorMessageCount: count,
                                    health: .thin)
            throw error
        }
    }
}

/// Holds a power assertion for the length of a run.
///
/// `caffeinate -i -w $$` — wait on *this* process, so the assertion dies with us even if
/// we crash. A `defer` that never runs is the usual way a power assertion outlives its
/// reason and quietly stops a laptop from sleeping all afternoon.
public final class Caffeinate {

    private let process: Process

    private init(process: Process) { self.process = process }

    public static func start(pid: Int32 = ProcessInfo.processInfo.processIdentifier) -> Caffeinate? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/caffeinate")
        process.arguments = ["-i", "-w", String(pid)]
        guard (try? process.run()) != nil else { return nil }
        return Caffeinate(process: process)
    }

    public func stop() {
        guard process.isRunning else { return }
        process.terminate()
    }
}

/// Version and identity, read from the bundle when there is one.
public enum AppInfo {
    public static let bundleIdentifier = "app.boi.mac"
    public static let launchAgentLabel = "app.boi.mac.sync"
    public static let displayName = "Boi"

    /// Falls back to a marker rather than to a plausible-looking number: a heartbeat
    /// claiming "1.0.0" from a build that has no version is worse than one that says it
    /// does not know, because the fleet-wide alarm correlates on this field.
    public static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
            ?? "0.0.0-unbundled"
    }
}
