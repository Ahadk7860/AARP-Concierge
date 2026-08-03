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
@MainActor
final class PermissionModel: ObservableObject {

    enum Step: Equatable {
        case checking
        case needsConsent
        case needsFullDiskAccess
        /// The toggle flipped. We have at most `relaunchBudget` seconds to get out of
        /// our own way.
        case relaunching
        case ready(HealthSummary)
        case noDatabase
        case failed(String)
    }

    struct HealthSummary: Equatable {
        var health: CorpusHealth
        var headline: String
        var remedies: [HealthCheck.Remedy]
        var messageCount: Int
        var digestPath: String?
        var producesReport: Bool
    }

    @Published private(set) var step: Step = .checking
    /// Flips the instant the probe succeeds. Not knowing whether it worked is the single
    /// biggest reason people abandon this screen, so this is bound straight to the view.
    @Published private(set) var accessGranted = false
    @Published private(set) var pollCount = 0
    @Published private(set) var statusLine = ""

    private var timer: Timer?
    private var watcher = GrantWatcher()
    private let defaults: UserDefaults
    private let probe: () -> FullDiskAccess.Status
    private let relaunch: () -> Void

    static let consentKey = "app.boi.mac.consent.accepted.v1"

    init(defaults: UserDefaults = .standard,
         probe: @escaping () -> FullDiskAccess.Status = { FullDiskAccess.probe() },
         relaunch: @escaping () -> Void = Relauncher.relaunchNow) {
        self.defaults = defaults
        self.probe = probe
        self.relaunch = relaunch
        self.watcher = GrantWatcher(probe: probe)
    }

    // MARK: - Entry

    func start() {
        guard defaults.bool(forKey: Self.consentKey) else {
            step = .needsConsent
            return
        }
        evaluateAccess()
    }

    func acceptConsent() {
        defaults.set(true, forKey: Self.consentKey)
        evaluateAccess()
    }

    /// **Detects the already-granted case and skips the screen entirely**, which is the
    /// reinstall path and the second-launch path. Showing a permission screen to
    /// somebody who already granted the permission is how an app teaches people to click
    /// through its screens without reading them.
    private func evaluateAccess() {
        switch probe() {
        case .granted:
            accessGranted = true
            stopPolling()
            step = .ready(HealthSummary(health: .thin, headline: "Reading your messages…",
                                        remedies: [], messageCount: 0, digestPath: nil,
                                        producesReport: false))
            Task { await runScan() }
        case .noDatabase:
            stopPolling()
            step = .noDatabase
        case .denied:
            accessGranted = false
            step = .needsFullDiskAccess
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

    /// The decision lives in `GrantWatcher`, in BoiKit, so it is testable without a
    /// window. This is the part that has to touch AppKit.
    private func tick() {
        switch watcher.tick() {
        case .waiting(let polls):
            pollCount = polls
            statusLine = "Waiting for the switch… (checked \(polls)×)"
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
            step = .noDatabase

        case .granted(let polls, let elapsed):
            pollCount = polls
            statusLine = "Access granted — restarting Boi so macOS applies it…"
            // Mark it FIRST so the checkmark is already on screen, then stop polling and
            // get out. Everything from here is on the two-second clock.
            accessGranted = true
            stopPolling()
            step = .relaunching
            StructuredLog.emit("fda.granted", fields: [
                "polls": polls,
                "waited_s": (elapsed * 1000).rounded() / 1000,
                "poll_interval_s": FullDiskAccess.pollInterval,
                "relaunch_budget_s": FullDiskAccess.relaunchBudget,
            ])

            // A beat so the flipped checkmark actually renders before the window goes
            // away — an app that vanishes without acknowledging the click reads as a
            // crash. Well inside the budget; `GrantWatcher` asserts that arithmetic.
            Task { @MainActor in
                try? await Task.sleep(
                    nanoseconds: UInt64(GrantWatcher.acknowledgementPause * 1_000_000_000))
                StructuredLog.emit("fda.relaunching", fields: [
                    "reason": "macOS does not apply a TCC grant to an already-running process",
                ])
                self.relaunch()
            }

        case .relaunching:
            break
        }
    }

    // MARK: - The scan

    func runScan(force: Bool = false) async {
        guard let salt = ContactResolver.developmentSalt() else {
            step = .failed("No user salt. The real one arrives from pairing; until then "
                           + "set \(ContactResolver.developmentSaltVariable) in .env.")
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

            step = .ready(HealthSummary(health: health.health,
                                        headline: health.headline,
                                        remedies: health.remedies,
                                        messageCount: metrics.corpus.messageCount,
                                        digestPath: outcome.digestPath,
                                        producesReport: health.producesReport))
        } catch {
            step = .failed("\(error)")
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
