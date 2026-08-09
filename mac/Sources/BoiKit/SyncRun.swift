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
        /// An explicit `AddressBook-v22.abcddb`, or `nil` to auto-discover.
        ///
        /// Added for prompt 05. `AddressBookDirectory.discover()` resolves the home
        /// directory through `homeDirectoryForCurrentUser`, which does NOT read `HOME` —
        /// so a harness could not point this run at a contacts directory by any means,
        /// and every card the end-to-end run produced was headed with phone numbers.
        /// `digest`, `voice-pack` and `health` have taken `--contacts` since Track A;
        /// `sync-run` was the one command without it.
        public var contacts: String?

        public init(chatDatabase: String, mirror: String,
                    outputDirectory: String, stateDirectory: String,
                    contacts: String? = nil) {
            self.chatDatabase = chatDatabase
            self.mirror = mirror
            self.outputDirectory = outputDirectory
            self.stateDirectory = stateDirectory
            self.contacts = contacts
        }

        /// Where a real installation keeps things: Application Support, not `/tmp`.
        public static func installed(
            home: URL = FileManager.default.homeDirectoryForCurrentUser
        ) -> Paths {
            let root = home.appendingPathComponent("Library/Application Support/Boi")
            // Prefers a resolved security-scoped bookmark; falls back to the FDA
            // default on any failure, including "no bookmark saved at all" — see
            // MessagesFolderAccess.resolvedChatDatabasePath's doc comment. Track D,
            // logged in INTERFACES.md.
            return Paths(chatDatabase: MessagesFolderAccess.resolvedChatDatabasePath(
                            stateDirectory: root.path, home: home),
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
        /// Dual-written Phase 2 artefacts. V1 remains on disk while local consumers
        /// migrate; v2 is the canonical upload for this run.
        public var phase2DigestPath: String?
        public var phase2VoicePackPaths: [String] = []
        public var health: CorpusHealth = .thin
        public var heartbeatPath: String?
        public var elapsed: TimeInterval = 0
        /// What reached the cloud. `nil` means no upload was attempted at all — no
        /// `BOI_API_BASE`, or no paired identity — which is a legitimate state for a
        /// developer run and is logged as `upload.not_configured` rather than as a
        /// failure.
        public var upload: Uploader.Dispatch?
    }

    public let paths: Paths
    public let salt: String
    public let minimumHoursBetweenRuns: Int
    /// Injected so a test can drive the whole run against a real loopback HTTP server.
    /// `nil` means "read the environment", which is what the LaunchAgent gets.
    let uploader: Uploader?
    let tokenStore: TokenStore

    public init(paths: Paths, salt: String,
                minimumHoursBetweenRuns: Int = SyncRun.defaultMinimumHoursBetweenRuns,
                uploader: Uploader? = nil,
                tokenStore: TokenStore = EnvironmentTokenStore()) {
        self.paths = paths
        self.salt = salt
        self.minimumHoursBetweenRuns = minimumHoursBetweenRuns
        self.uploader = uploader
        self.tokenStore = tokenStore
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

        let contacts = paths.contacts.flatMap(AddressBookDirectory.read(path:))
            ?? AddressBookDirectory.discover()
        let calls = CallHistory.discover()
        let resolver = ContactResolver(salt: salt, directory: contacts ?? .empty)
        let metrics = try MetricLibrary(resolver: resolver,
                                        options: .init(now: now, callHistory: calls))
            .compute(mirror: mirror)

        // WHY THE RANKING SHOWS PHONE NUMBERS, ANSWERED WITH A COUNT.
        //
        // `Identity.display` falls back to the handle by design — a digest that says
        // "unknown" for half the ranking is worse than one that says a phone number. So a
        // reply naming `+1920…` is not evidence of a bug on its own, and cannot be told
        // apart from a genuinely unsaved contact by looking at the digest.
        //
        // What IS diagnostic is the shape of the directory we bound to: `discover()` takes
        // the first source with any records, so several sources with one thin winner would
        // produce exactly this symptom. Logged per source, once per run.
        for candidate in AddressBookDirectory.survey() {
            StructuredLog.emit("contacts.source", fields: [
                "path": (candidate.path as NSString).lastPathComponent,
                "record_count": candidate.recordCount,
            ])
        }
        let unresolved = metrics.relationships
            .filter { $0.identity.addressBookRecordID == nil }.count
        StructuredLog.emit("contacts.resolution", fields: [
            "directory_records": contacts?.recordCount ?? 0,
            "relationships": metrics.relationships.count,
            "unresolved": unresolved,
        ])

        var system = HealthCheck.SystemState.read()
        system.hasNonIMessageContacts = contacts.map { $0.recordCount > 0 }
        let health = HealthCheck.evaluate(corpus: metrics.corpus, system: system)
        outcome.health = health.health

        // THE PAIRED IDENTITY, AND WHY IT IS THREADED IN RATHER THAN DERIVED.
        //
        // `DigestBuilder` defaults `user_id` to `ContactResolver.localUserIdentifier()`,
        // an HMAC of the local salt. The server issues `user_id` at signup instead, and
        // `POST /v1/digest` answers `401 unauthorized` when the body's `user_id` is not
        // the authenticated one. So a locally-derived id produces a digest that is
        // correct on disk and unacceptable on the wire — silently, forever. That is
        // precisely the class of failure this track exists to find; see NOTES.md.
        //
        // An injected uploader carries its own identity; the token store is the path the
        // LaunchAgent takes. Preferring the injection keeps a test from configuring the
        // same identity twice and disagreeing with itself.
        let identity = uploader?.identity ?? tokenStore.identity()
        var packs: [VoicePack] = []
        var phase2Digest: DigestV2?
        var phase2Packs: [VoicePackV2] = []

        // DEGRADE, NEVER FABRICATE. A thin corpus gets no digest — handing somebody a
        // report built on 400 messages and calling it their year is the failure this
        // whole health check exists to prevent, and writing the file anyway would let a
        // later step pick it up and send it.
        if health.producesReport {
            // AMENDMENT-001. The allowlist is extracted here, from the mirror, because
            // `MetricLibrary.Result` deliberately carries no messages — the corpus is
            // the thing that must not travel. Only `facts` leaves; the messages it was
            // derived from stay on this machine.
            let signals = try FactExtractor.signalsByContact(
                mirror: mirror, identities: metrics.relationships.map(\.identity))
            let redactor = Redactor(directory: contacts ?? .empty)
            let builder = DigestBuilder(resolver: resolver,
                                        options: .init(userID: identity?.user_id,
                                                       generatedAt: now, system: system,
                                                       signalsByContact: signals,
                                                       understandingRedactor: redactor))
            let built = builder.build(from: metrics)
            let builtV2 = try builder.buildV2(from: metrics, mirror: mirror)
            let digestPath = URL(fileURLWithPath: paths.outputDirectory)
                .appendingPathComponent("digest.json").path
            let phase2DigestPath = URL(fileURLWithPath: paths.outputDirectory)
                .appendingPathComponent("digest_v2.json").path
            try DigestBuilder.write(built, to: digestPath)
            try DigestBuilder.write(builtV2, to: phase2DigestPath)
            outcome.digestPath = digestPath
            outcome.phase2DigestPath = phase2DigestPath
            phase2Digest = builtV2

            packs = try VoicePackBuilder(options: .init(
                now: now, redactor: redactor))
                .build(mirror: mirror, identities: metrics.relationships.map(\.identity))
            outcome.voicePackPaths = try packs.map {
                try VoicePackBuilder.write($0, toDirectory: paths.outputDirectory)
            }
            phase2Packs = try VoicePackBuilder(options: .init(now: now, redactor: redactor))
                .buildV2(mirror: mirror, identities: metrics.relationships.map(\.identity))
            outcome.phase2VoicePackPaths = try phase2Packs.map {
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

        // UPLOAD LAST, AND AFTER EVERYTHING DURABLE IS ON DISK.
        //
        // The digest file stays whatever happens here — it is the only thing a support
        // conversation can ask for, and it is also what the queue re-reads. Nothing above
        // this line depends on the network, so a Mac with no connectivity still produces
        // a complete local run.
        outcome.upload = try upload(phase2Digest: phase2Digest,
                                    phase2DigestPath: outcome.phase2DigestPath,
                                    phase2Packs: phase2Packs,
                                    phase2PackPaths: outcome.phase2VoicePackPaths,
                                    heartbeatPath: outcome.heartbeatPath,
                                    deviceID: resolver.localDeviceIdentifier(),
                                    identity: identity,
                                    now: now)
        return outcome
    }

    /// Sends what this run produced, and throws `Uploader.Deferred` if any of it did not
    /// land.
    ///
    /// **The throw is the point.** Prompt `01`: "a 500 from the server enqueues the
    /// digest and returns non-zero from `--sync`". The shipping `--sync` entry point is
    /// in `BoiApp.swift`, which this track does not own, so a return value cannot change
    /// its exit code — only an error can. Everything durable is already written when this
    /// runs, so the throw costs nothing but the process's exit status, which is exactly
    /// what it is for.
    func upload(phase2Digest: DigestV2?,
                phase2DigestPath: String?,
                phase2Packs: [VoicePackV2],
                phase2PackPaths: [String],
                heartbeatPath: String?,
                deviceID: String,
                identity: DeviceIdentity?,
                now: Date) throws -> Uploader.Dispatch? {
        let uploader: Uploader
        if let injected = self.uploader {
            uploader = injected
        } else {
            guard let configuration = Uploader.Configuration.fromEnvironment() else {
                StructuredLog.emit("upload.not_configured", fields: [
                    "reason": "no \(Uploader.Configuration.baseURLVariable)",
                ])
                return nil
            }
            guard let identity else {
                StructuredLog.emit("upload.not_configured", fields: [
                    "reason": "no paired identity: set \(EnvironmentTokenStore.userIDVariable) "
                        + "and \(EnvironmentTokenStore.deviceTokenVariable)",
                ])
                return nil
            }
            uploader = Uploader(configuration: configuration, identity: identity)
        }

        var payloads: [Uploader.Payload] = []

        // Both versions stay on disk during migration. Only v2 crosses this boundary:
        // v1 and v2 share `generated_at`, the server's duplicate key, so posting both
        // would silently leave whichever version arrived first as the only stored row.
        // Read exact v2 bytes back from disk because the writer fills explicit nulls.
        if let phase2Digest, let phase2DigestPath,
           let body = FileManager.default.contents(atPath: phase2DigestPath) {
            payloads.append(.init(body: body, endpoint: .digest,
                                  descriptor: .forDigest(phase2Digest)))
        }
        for (pack, path) in zip(phase2Packs, phase2PackPaths) {
            guard let body = FileManager.default.contents(atPath: path) else { continue }
            payloads.append(.init(body: body, endpoint: .voicePack,
                                  descriptor: .forVoicePack(pack)))
        }
        if let heartbeatPath,
           let data = FileManager.default.contents(atPath: heartbeatPath),
           let beat = try? JSONDecoder().decode(Heartbeat.self, from: data) {
            // NOT wired to messagesAccessState yet, deliberately. HeartbeatUpload
            // carries the field (Uploader.swift) and MessagesFolderAccess can compute
            // it (used by RecoveryNotifier locally), but contracts/openapi/boi-api.v1
            // .yaml sets additionalProperties: false on this shape, and the server
            // enforces it: sending a non-nil value here turned EVERY real heartbeat
            // upload into `400 rejected` — caught by SyncRunTests failing with
            // "upload deferred: ... rejected (/v1/heartbeat)" the moment this ran
            // against a real endpoint, not a contrived test failure. Re-add this
            // argument only once Track F or H has amended the contract to permit the
            // field — see INTERFACES.md's entry for this exact field.
            let wire = HeartbeatUpload.from(beat, deviceID: deviceID,
                                            digestGeneratedAt: phase2Digest?.generated_at)
            if let body = try? JSONEncoder().encode(wire) {
                payloads.append(.init(body: body, endpoint: .heartbeat,
                                      descriptor: .forHeartbeat(wire)))
            }
        }

        let queue = UploadQueue(directory: paths.stateDirectory)
        // `try`, not `try?`. A queue that cannot be written throws `QueueUnavailable`,
        // which propagates out of `--sync` as a non-zero exit — it is a strictly worse
        // state than `Deferred` and must not be flattened into it.
        let report = try uploader.dispatch(payloads, queue: queue, now: now)
        guard report.isClean else {
            throw Uploader.Deferred(queued: report.queued,
                                    rejected: report.rejected,
                                    endpoints: Array(Set(report.unlanded)).sorted())
        }
        return report
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
