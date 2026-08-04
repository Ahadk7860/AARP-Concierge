import BoiKit
import Foundation
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

    private var timer: Timer?
    private var relaunchWatchdog: Timer?
    /// Whether the user has actually left this app since we started waiting.
    private var leftWhileWaiting = false
    private var watcher = GrantWatcher()
    private let defaults: UserDefaults
    private let probe: () -> FullDiskAccess.Status
    private let relaunch: () -> Void
    private let install: () -> InstallLocation.Verdict
    private let narrator: GrantNarrator
    private let stateDirectory: String

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
         stateDirectory: String = SyncRun.Paths.installed().stateDirectory) {
        self.defaults = defaults
        self.probe = probe
        self.relaunch = relaunch
        self.install = install
        self.stateDirectory = stateDirectory
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
            pollCount = polls
            statusLine = "Access granted — restarting Boi so macOS applies it…"
            // Mark it FIRST so the checkmark is already on screen, then stop polling and
            // get out. Everything from here is on the two-second clock.
            accessGranted = true
            stopPolling()
            enter(.granted)
            StructuredLog.emit("fda.granted", fields: [
                "polls": polls,
                "waited_s": (elapsed * 1000).rounded() / 1000,
                "poll_interval_s": FullDiskAccess.pollInterval,
                "relaunch_budget_s": FullDiskAccess.relaunchBudget,
            ])

            // **The heartbeat leaves now, not on the next scheduled sync.** Under
            // AMENDMENT-002 the iMessage thread already exists, so this is what lets the
            // cloud tell the user the grant landed while they are still standing in
            // System Settings.
            signalGrant(true)

            // The marker the next process reads. Written before the relaunch, because
            // after it there is no "us" left to write anything.
            defaults.set(true, forKey: Self.relaunchedKey)

            // A beat so the flipped checkmark actually renders before the window goes
            // away — an app that vanishes without acknowledging the click reads as a
            // crash. Well inside the budget; `GrantWatcher` asserts that arithmetic.
            Task { @MainActor in
                try? await Task.sleep(
                    nanoseconds: UInt64(GrantWatcher.acknowledgementPause * 1_000_000_000))
                self.enter(.relaunching)
                StructuredLog.emit("fda.relaunching", fields: [
                    "reason": "macOS does not apply a TCC grant to an already-running process",
                ])
                self.armRelaunchWatchdog()
                self.relaunch()
            }

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

    /// Quit and reopen, by hand. Offered wherever the automatic relaunch may not arrive —
    /// including the stalled *waiting* screen, because if this process cannot observe the
    /// grant it made, no automatic relaunch is ever triggered and this is the only exit.
    func relaunchManually() {
        defaults.set(true, forKey: Self.relaunchedKey)
        StructuredLog.emit("fda.relaunch_manual", fields: ["stage": stage.rawValue])
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
            enter(.ready)
        } catch {
            failureDetail = "\(error)"
            enter(.failed)
        }
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
