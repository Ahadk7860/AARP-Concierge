import BoiKit
import Foundation
import ServiceManagement
import SwiftUI

/// The onboarding state machine.
///
/// **THE FLOW IS `deep link → poll → RELAUNCH → verify`, NOT `deep link → poll →
/// proceed`.** Granting Full Disk Access by hand established that the grant does not
/// apply to an already-running process: after granting, the identical query still
/// returned `authorization denied`, and it only worked after quitting and reopening. So
/// an app that polls and then proceeds waits forever on a permission it can never
/// observe. The relaunch is load-bearing.
///
/// **This type is deliberately thin.** `BoiApp` is an executable target and
/// `BoiKitTests` cannot import it, so anything decided here is decided where no test can
/// read it. Every judgement — which stage a launch lands on, when waiting stops being
/// honest, when the cloud is worth telling, what the user is told — lives in
/// `GrantNarrator.swift` in `BoiKit` and is asserted there. What is left here is the
/// probe, the timer, the window and the relaunch: the parts that need AppKit.
@MainActor
final class PermissionModel: ObservableObject {

    struct HealthSummary: Equatable {
        var health: CorpusHealth
        var headline: String
        var remedies: [HealthCheck.Remedy]
        var messageCount: Int
        var digestPath: String?
        var producesReport: Bool
    }

    /// Where the user is. Every value renders its own screen — see `GrantStage`.
    @Published private(set) var stage: GrantStage = .checking
    /// Flips the instant the probe succeeds. Not knowing whether it worked is the single
    /// biggest reason people abandon this screen, so this is bound straight to the view.
    @Published private(set) var accessGranted = false
    /// Visible on the waiting screens, so somebody watching can see the app is alive
    /// rather than hung.
    @Published private(set) var pollCount = 0
    @Published private(set) var statusLine = ""
    /// Set only for `.ready`.
    @Published private(set) var summary: HealthSummary?
    /// Set only for `.failed` — the detail that used to be the whole message.
    @Published private(set) var failureDetail: String?
    /// Set only for `.notInApplications`, so the screen can show where the copy they
    /// opened actually lives.
    @Published private(set) var bundlePath: String?
    /// The way into the thread. Resolved once the scan completes.
    @Published private(set) var handoff: ThreadHandoff.State = .unreachable(signupLink: nil)
    /// Visible even when the LaunchAgent itself is enabled: launchd registration and
    /// permission to install a hardware wake are two different capabilities.
    @Published private(set) var backgroundFreshnessDegradation: String?
    @Published private(set) var backgroundRefreshRequiresApproval = false

    private var timer: Timer?
    private var relaunchWatchdog: Timer?
    private var backgroundRefreshTask: Task<Void, Never>?
    /// Whether the user has actually left this app since we started waiting.
    private var leftWhileWaiting = false
    private var watcher = GrantWatcher()
    private let defaults: UserDefaults
    private let probe: () -> FullDiskAccess.Status
    private let relaunch: () -> Void
    private let install: () -> InstallLocation.Verdict
    private let narrator: GrantNarrator
    private let stateDirectory: String
    /// Where the user's assigned line comes from.
    ///
    /// **Injected, and per-user.** The registrar assigns a different line to every user —
    /// a shared pool means the number is not a constant, and a hard-coded one would open a
    /// thread with a line that is not theirs. Nothing on the Mac resolves it today
    /// (`cloud/api/src/` owns the registrar), so this returns nil and the handoff says so
    /// plainly rather than rendering a broken `sms:` link. Recorded in `NOTES.md`.
    private let assignedLine: () -> String?
    private let pairingToken: () -> String?

    static let consentKey = "app.boi.mac.consent.accepted.v1"
    /// **The marker that makes "still denied after relaunch" a distinguishable state.**
    /// Without it, a process that relaunched and a process that never tried both see
    /// `denied` and collapse onto one screen — so the user who did everything correctly is
    /// handed the instructions they already followed.
    static let relaunchedKey = "app.boi.mac.fda.relaunched.v1"

    init(defaults: UserDefaults = .standard,
         probe: @escaping () -> FullDiskAccess.Status = { FullDiskAccess.probe() },
         relaunch: @escaping () -> Void = Relauncher.relaunchNow,
         install: @escaping () -> InstallLocation.Verdict = InstallLocation.current,
         stateDirectory: String = SyncRun.Paths.installed().stateDirectory,
         assignedLine: @escaping () -> String? = { PairingHandles.assignedLine() },
         pairingToken: @escaping () -> String? = { PairingHandles.pairingToken() }) {
        self.defaults = defaults
        self.probe = probe
        self.relaunch = relaunch
        self.install = install
        self.stateDirectory = stateDirectory
        self.assignedLine = assignedLine
        self.pairingToken = pairingToken
        self.watcher = GrantWatcher(probe: probe)
        // Persisted, because the happy path relaunches this process: an in-memory limiter
        // would signal the grant, restart, come back empty and signal again.
        self.narrator = GrantNarrator.persisted(inDirectory: stateDirectory)
    }

    // MARK: - Entry

    func start() {
        guard defaults.bool(forKey: Self.consentKey) else {
            enter(.needsConsent)
            return
        }
        evaluateAccess()
    }

    func acceptConsent() {
        defaults.set(true, forKey: Self.consentKey)
        evaluateAccess()
    }

    /// Registers background work and separately records whether an RTC wake was really
    /// installed. Failure never blocks foreground scans or the report handoff.
    func enableBackgroundRefresh() {
        backgroundRefreshTask?.cancel()
        backgroundRefreshTask = Task { [weak self] in
            guard let self else { return }
            let result = await ScheduledSync.register(observe: { state in
                guard !Task.isCancelled else { return }
                self.observeBackgroundRegistration(state)
            })
            guard !Task.isCancelled else { return }
            backgroundFreshnessDegradation = result.degradation
            backgroundRefreshRequiresApproval = false
            StructuredLog.emit("agent.register",
                               level: result.degradation == nil ? .info : .warn,
                               fields: [
                "result": result.summary,
                "status": ScheduledSync.statusDescription,
                "freshness": result.degradation == nil ? "scheduled" : "degraded",
            ])
        }
    }

    func openBackgroundApprovalSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    private func observeBackgroundRegistration(_ state: WakeRegistrationState) {
        switch state {
        case .requiresApproval(let service):
            backgroundRefreshRequiresApproval = true
            backgroundFreshnessDegradation = "Approve \(service) in System Settings. "
                + "Boi will notice the approval and continue automatically."
        case .ready:
            backgroundRefreshRequiresApproval = false
            backgroundFreshnessDegradation = nil
        case .degraded(let detail):
            backgroundRefreshRequiresApproval = false
            backgroundFreshnessDegradation = detail
        case .registeringDaemon, .registeringAgent, .schedulingWake:
            break
        }
    }

    /// **Detects the already-granted case and skips the screen entirely**, which is the
    /// reinstall path and the second-launch path. Showing a permission screen to somebody
    /// who already granted the permission is how an app teaches people to click through
    /// its screens without reading them.
    private func evaluateAccess() {
        let status = probe()
        let didRelaunch = defaults.bool(forKey: Self.relaunchedKey)
        let location = install()
        let next = LaunchDisposition.stage(probe: status, didRelaunch: didRelaunch,
                                           install: location)

        if case .elsewhere(let path) = location { bundlePath = path }

        switch next {
        case .syncing:
            // The relaunch did its job. Clear the marker so a later denial is not blamed
            // on a restart that already succeeded.
            defaults.set(false, forKey: Self.relaunchedKey)
            accessGranted = true
            stopPolling()
            enter(.syncing)
            signalGrant(true)
            Task { await runScan() }

        case .noDatabase:
            stopPolling()
            enter(.noDatabase)

        case .notInApplications:
            // **Before the deep link, not after the grant fails.** No polling: nothing the
            // user does in System Settings can make this bundle grantable.
            stopPolling()
            accessGranted = false
            enter(.notInApplications)

        case .deniedAfterRelaunch:
            defaults.set(false, forKey: Self.relaunchedKey)
            accessGranted = false
            enter(.deniedAfterRelaunch)
            // Still polling: if they now flip the correct row we notice immediately.
            startPolling()

        default:
            accessGranted = false
            enter(.waiting)
            startPolling()
        }
    }

    // MARK: - The poll

    func openSettings() {
        if let url = URL(string: FullDiskAccess.settingsDeepLink) {
            NSWorkspace.shared.open(url)
        }
        startPolling()
    }

    /// Every 500 ms, as prompt 07 specifies. Fast enough that the checkmark flips while
    /// the user is still looking at the window.
    func startPolling() {
        guard timer == nil else { return }
        let timer = Timer(timeInterval: FullDiskAccess.pollInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        tick()
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
    }

    /// The user left Boi — almost always to System Settings. Recorded so that coming back
    /// can be told apart from never having gone.
    func applicationDidResignActive() {
        guard stage == .waiting || stage == .waitingStalled else { return }
        leftWhileWaiting = true
    }

    /// The user came back to Boi with the switch still off. A real signal — the window
    /// became frontmost again — and a different screen from never having left, because the
    /// useful thing to say is different.
    ///
    /// **Gated on having actually left.** `didBecomeActive` also fires once at launch, and
    /// without this guard every user would be told they had backed out of a settings pane
    /// they had not opened yet.
    func applicationDidBecomeActive() {
        guard leftWhileWaiting else { return }
        guard stage == .waiting || stage == .waitingStalled else { return }
        guard case .denied = probe() else { return }
        leftWhileWaiting = false
        enter(.returnedWithoutGranting)
    }

    /// The decision lives in `GrantWatcher` and `GrantStage`, in BoiKit, so both are
    /// testable without a window. This is the part that has to touch AppKit.
    private func tick() {
        switch watcher.tick() {
        case .waiting(let polls):
            pollCount = polls
            statusLine = "Waiting for the switch… (checked \(polls)×)"
            // Do not walk back to a waiting screen from a more specific one — a user who
            // backed out or came back from a failed relaunch is told something better, and
            // the poll count keeps updating underneath it either way.
            if stage == .waiting || stage == .waitingStalled {
                enter(GrantStage.whileWaiting(polls: polls))
            }
            // Logged sparsely: the first poll proves the watch started, and a line every
            // ten seconds proves it is still alive without writing 120 lines a minute.
            if polls == 1 || polls.isMultiple(of: 20) {
                StructuredLog.emit("fda.waiting", fields: [
                    "polls": polls,
                    "poll_interval_s": FullDiskAccess.pollInterval,
                    "deep_link": FullDiskAccess.settingsDeepLink,
                ])
            }

        case .noDatabase:
            stopPolling()
            enter(.noDatabase)

        case .granted(let polls, let elapsed):
            // **The non-deterministic case: the probe occasionally succeeds before any
            // relaunch. Proceed SILENTLY.**
            //
            // No acknowledgement screen, no pause, no automatic relaunch. All three were
            // in `01` and all three were wrong once the manual run landed:
            //
            // - The acknowledgement screen appeared at the exact moment macOS puts up its
            //   own "Boi will not have full disk access until it is quit" dialog, and Boi
            //   popping up alongside it was the friction the run found. The system dialog
            //   is authoritative and performs the relaunch; the best thing Boi can do is
            //   be quiet behind it.
            // - Congratulating the user for reaching this state tells them they skipped a
            //   step they never knew existed, and presents a different flow from the one
            //   they were reading thirty seconds earlier.
            // - Relaunching ourselves here competes with the dialog for the same job.
            //
            // So this path is indistinguishable, from the user's side, from the ordinary
            // post-relaunch launch: straight to reading their messages.
            pollCount = polls
            accessGranted = true
            stopPolling()
            defaults.set(false, forKey: Self.relaunchedKey)
            StructuredLog.emit("fda.granted", fields: [
                "polls": polls,
                "waited_s": (elapsed * 1000).rounded() / 1000,
                "poll_interval_s": FullDiskAccess.pollInterval,
                "pre_relaunch": true,
                "detail": "probe succeeded without a relaunch — non-deterministic, proceeding silently",
            ])
            enter(.syncing)

            // **The heartbeat leaves now, not on the next scheduled sync.** Under
            // AMENDMENT-002 the iMessage thread already exists, so this is what lets the
            // cloud tell the user the grant landed while they are still standing in
            // System Settings. Silent on screen is not silent to the cloud.
            signalGrant(true)
            Task { await runScan() }

        case .relaunching:
            break
        }
    }

    /// **Failure path 4, and it only exists because this code can observe its own
    /// failure.** If the relaunch worked, this process is gone before the timer fires. If
    /// it is still here past the budget, the restart did not happen and the user is
    /// looking at a window that promised to disappear — so say so, and give them the
    /// Command-Q that does the same job.
    private func armRelaunchWatchdog() {
        relaunchWatchdog?.invalidate()
        let deadline = FullDiskAccess.relaunchBudget
        let watchdog = Timer(timeInterval: deadline, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.stage == .relaunching else { return }
                StructuredLog.emit("fda.relaunch_stalled", level: .error, fields: [
                    "relaunch_budget_s": deadline,
                    "detail": "the process was still running after the relaunch budget",
                ])
                self.enter(.relaunchStalled)
            }
        }
        RunLoop.main.add(watchdog, forMode: .common)
        relaunchWatchdog = watchdog
    }

    /// Quit and reopen, by hand — **the only relaunch Boi performs, and only when the user
    /// asks for it.**
    ///
    /// Offered from `waiting` onwards rather than after a timer, because the probe never
    /// observes the grant from inside the process that was running when it was made. It is
    /// also the resume path for somebody who chose **Later** on the system dialog, which is
    /// a state nothing can detect.
    func relaunchManually() {
        defaults.set(true, forKey: Self.relaunchedKey)
        StructuredLog.emit("fda.relaunch_manual", fields: ["stage": stage.rawValue])
        stopPolling()
        enter(.relaunching)
        armRelaunchWatchdog()
        relaunch()
    }

    // MARK: - Telling the cloud

    /// Fires the heartbeat if — and only if — the narrator says this is news.
    ///
    /// **Off the main actor.** `Uploader.URLSessionTransport` blocks on a semaphore with a
    /// 30-second timeout; running it here would freeze the exact screen this track exists
    /// to keep alive, at the exact moment it matters most.
    private func signalGrant(_ granted: Bool) {
        let decision = narrator.observe(granted: granted, now: Date())
        switch decision {
        case .unchanged:
            return
        case .suppressed(_, let retryAfter):
            StructuredLog.emit("fda.signal.suppressed", fields: [
                "granted": granted,
                "retry_after_s": (retryAfter * 10).rounded() / 10,
                "minimum_interval_s": GrantNarrator.minimumInterval,
            ])
            return
        case .signal(let value):
            guard let signaller = makeSignaller() else {
                // No endpoint, or no paired identity. Nothing is broken on this Mac and
                // nothing the user can do about it here — but it is not a silent success
                // either, because the cloud will not narrate a grant it never heard about.
                StructuredLog.emit("fda.signal.unconfigured", level: .warn, fields: [
                    "granted": value,
                    "detail": "no upload endpoint or no paired device identity",
                ])
                return
            }
            let digestGeneratedAt = lastDigestGeneratedAt()
            Task.detached {
                signaller.send(granted: value, digestGeneratedAt: digestGeneratedAt)
            }
        }
    }

    /// **Paired or unpaired is knowable, not guessed** — ask the token store. Under
    /// AMENDMENT-002 the thread is opened before the app is ever installed, so paired is
    /// the normal path and unpaired means a direct download or a pairing that never
    /// completed.
    private func resolveHandoff() -> ThreadHandoff.State {
        let state = ThreadHandoff.resolve(
            handle: assignedLine(),
            pairingToken: pairingToken(),
            isPaired: EnvironmentTokenStore().identity() != nil,
            setupToken: "boi-setup")

        // Logged apart, because they are different problems with different owners. A
        // paired user missing the line is a display gap on this Mac; an unreachable user
        // cannot receive anything at all, and that is the one worth a warning.
        switch state {
        case .pairedLineUnknown:
            StructuredLog.emit("handoff.line_unknown", fields: [
                "paired": true,
                "detail": "thread exists; this Mac does not know the assigned line",
            ])
        case .unreachable(let signupLink):
            StructuredLog.emit("handoff.unreachable", level: .warn, fields: [
                "paired": false,
                "has_signup_link": signupLink != nil,
                "detail": "no thread, so the transport will not carry a brief at all",
            ])
        case .paired, .unpaired:
            break
        }
        return state
    }

    private func makeSignaller() -> GrantSignaller? {
        guard let configuration = Uploader.Configuration.fromEnvironment(),
              let identity = EnvironmentTokenStore().identity(),
              let salt = ContactResolver.developmentSalt() else { return nil }
        // AMENDMENT-003: the Mac derives its own `dev_` id and `/v1/pair` accepts it, so
        // this needs no round trip. The device *token* is the paired half, above.
        let deviceID = ContactResolver(salt: salt).localDeviceIdentifier()
        return GrantSignaller(
            uploader: Uploader(configuration: configuration, identity: identity),
            deviceID: deviceID,
            appVersion: AppInfo.version)
    }

    /// `nil` when this Mac has never produced a digest — which at the moment of the grant
    /// is always. AMENDMENT-003 makes that an explicit `null` on the wire rather than a
    /// fabricated timestamp, so *granted but never synced* is a state the fleet can see.
    private func lastDigestGeneratedAt() -> String? {
        Heartbeat.read(fromDirectory: stateDirectory)?.last_successful_sync_at
    }

    // MARK: - Stage transitions

    private func enter(_ next: GrantStage) {
        guard stage != next else { return }
        stage = next
        StructuredLog.emit(next.logEvent, level: next.isFailure ? .warn : .info, fields: [
            "stage": next.rawValue,
            "polls": pollCount,
        ])
    }

    // MARK: - The scan

    func runScan(force: Bool = false) async {
        guard let salt = ContactResolver.developmentSalt() else {
            failureDetail = "No user salt. The real one arrives from pairing; until then "
                + "set \(ContactResolver.developmentSaltVariable) in .env."
            enter(.failed)
            return
        }
        let paths = SyncRun.Paths.installed()
        do {
            let outcome = try SyncRun(paths: paths, salt: salt).run(force: force)
            let mirror = try MirrorDatabase(path: paths.mirror)
            let resolver = ContactResolver(salt: salt)
            let metrics = try MetricLibrary(resolver: resolver).compute(mirror: mirror)
            var system = HealthCheck.SystemState.read()
            system.hasNonIMessageContacts = AddressBookDirectory.discover().map { $0.recordCount > 0 }
            let health = HealthCheck.evaluate(corpus: metrics.corpus, system: system)

            summary = HealthSummary(health: health.health,
                                    headline: health.headline,
                                    remedies: health.remedies,
                                    messageCount: metrics.corpus.messageCount,
                                    digestPath: outcome.digestPath,
                                    producesReport: health.producesReport)

            // **The last screen is the handoff, not the health list.** The findings still
            // render — below it. What worked, then what to do next, then what could be
            // better. Ending on two things that are wrong is the wrong reward for having
            // just granted full disk access.
            handoff = resolveHandoff()
            // This is the first eligible onboarding point: terms are accepted, Full Disk
            // Access is effective in this process, and a scan completed. Registration
            // schedules the first RTC wake; failure is logged and rendered as degraded
            // background freshness, but never blocks the report or handoff.
            enableBackgroundRefresh()
            enter(handoff.link == nil ? .ready : .handoff)
        } catch {
            failureDetail = "\(error)"
            enter(.failed)
        }
    }
}

/// Where the Mac reads the two values the handoff link needs.
///
/// **Both are per-user and neither is derivable here.** The registrar assigns the line and
/// issues the pairing token, and both live in `cloud/api/src/` — there is no Mac-side
/// client for either, exactly as there was none for the device token in prompt `01`. So
/// these read the environment and `.env`, and return nil when the value is absent, which
/// the handoff renders as an honest message rather than a broken link.
///
/// This is a seam, not a resting place. See `NOTES.md`.
enum PairingHandles {

    static let assignedLineVariable = "BOI_ASSIGNED_LINE"
    static let spectrumLineVariable = "SPECTRUM_LINE_E164"
    static let pairingTokenVariable = "BOI_PAIRING_TOKEN"

    static func assignedLine() -> String? {
        value(assignedLineVariable) ?? value(spectrumLineVariable)
    }
    static func pairingToken() -> String? { value(pairingTokenVariable) }

    private static func value(_ key: String) -> String? {
        if let value = ProcessInfo.processInfo.environment[key], !value.isEmpty {
            return value
        }
        // Search from Application Support first — that's where a user drops
        // configuration when the app is installed in /Applications.
        let appSupport = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Boi")
        if let value = DotEnv.value(of: key, searchingFrom: appSupport.path), !value.isEmpty {
            return value
        }
        // Then the current directory, for development/debugging.
        return DotEnv.value(of: key, searchingFrom: FileManager.default.currentDirectoryPath)
    }
}

/// Relaunches this app and exits.
///
/// macOS offers "Quit & Reopen" in a dialog after a TCC change and **users dismiss it**,
/// then sit on a screen that will never advance. Doing it for them is the difference
/// between a funnel that converts and one that bleeds at the last step.
enum Relauncher {

    static func relaunchNow() {
        let bundleURL = Bundle.main.bundleURL
        let configuration = NSWorkspace.OpenConfiguration()
        // A NEW instance, not an activation of this one. This process cannot see the
        // grant no matter what it does, so bringing it back to the front would just
        // return the user to the same stuck screen.
        configuration.createsNewApplicationInstance = true
        configuration.activates = true

        NSWorkspace.shared.openApplication(at: bundleURL, configuration: configuration) { _, _ in
            Task { @MainActor in
                NSApplication.shared.terminate(nil)
            }
        }

        // Belt and braces: if the callback never fires we must not leave a stuck window
        // on screen. Well inside the two-second budget.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            NSApplication.shared.terminate(nil)
        }
    }
}
