import AppKit
import BoiKit
import Foundation
import ServiceManagement
import SwiftUI

// Boi.app — the delivery vehicle.
//
// The iMessage read is a few days of work; this is the part that is 5% of the code and
// a quarter of the ongoing engineering. All privileged I/O happens inside this bundle:
// CLI executables dropped off the Full Disk Access list in macOS 26.1-26.2, so the
// shipping app cannot be a bare SwiftPM binary however convenient that would be.

/// The process entry point.
///
/// `--sync` is the LaunchAgent's entry and runs **headless**, handled before SwiftUI is
/// ever touched — so a scheduled run at 3pm never bounces an icon in the Dock or steals
/// focus from whatever the user is actually doing. Same binary either way, which is the
/// point: TCC is per-responsible-process, so the scheduled run has to be this bundle.
@main
enum Entry {
    static func main() async {
        // Both paths log to disk. A GUI app launched from the Finder and a job launched
        // by `launchd` both have a stdout nobody will ever read, and "did the relaunch
        // happen inside two seconds" is not a question a screenshot can answer.
        StructuredLog.setFileSink(URL(fileURLWithPath: SyncRun.Paths.installed().stateDirectory)
            .appendingPathComponent("boi.log"))
        if CommandLine.arguments.contains("--sync") {
            exit(await HeadlessSync.run())
        }
        // Registering the agent needs the bundle but not the window, so it is reachable
        // headlessly — otherwise the only way to verify `launchctl list` shows it is to
        // click a button, which is not evidence anybody can reproduce.
        if CommandLine.arguments.contains("--register-agent") {
            let result = await ScheduledSync.register()
            StructuredLog.emit("agent.register",
                               level: result.degradation == nil ? .info : .warn,
                               fields: [
                "result": result.summary,
                "status": ScheduledSync.statusDescription,
                "label": AppInfo.launchAgentLabel,
                "plist": LaunchAgentPlist.fileName,
            ])
            exit(0)
        }
        if CommandLine.arguments.contains("--unregister-agent") {
            ScheduledSync.unregister()
            StructuredLog.emit("agent.unregister",
                               fields: ["status": ScheduledSync.statusDescription])
            exit(0)
        }
        if CommandLine.arguments.contains("--agent-status") {
            StructuredLog.emit("agent.status", fields: [
                "status": ScheduledSync.statusDescription,
                "label": AppInfo.launchAgentLabel,
            ])
            exit(0)
        }
        BoiApplication.main()
    }
}

enum HeadlessSync {
    static func run(
        scheduleNextWake: @escaping WakeSchedulerLifecycle.AsyncSchedule = {
            try await WakeHelperClient().scheduleNextWake()
        }
    ) async -> Int32 {
        let result = await WakeSchedulerLifecycle.runEligibleSyncAsync(
            sync: attempt,
            schedule: scheduleNextWake
        )
        return result.exitCode
    }

    private static func attempt() -> WakeSchedulerLifecycle.SyncDisposition {
        guard let salt = ContactResolver.developmentSalt() else {
            let detail = "no \(ContactResolver.developmentSaltVariable)"
            StructuredLog.emit("sync.failed", level: .error, fields: [
                "detail": detail,
            ])
            return .failed(detail: detail)
        }
        let paths = SyncRun.Paths.installed()
        // Checked on every attempt, run/skip/fail alike: a genuine loss of
        // previously-working Messages folder access is exactly as real on a skipped
        // (idempotent-guard) run as on a completed one, and this is the one place a
        // headless 3am `--sync` can raise an alarm nobody is otherwise watching for.
        RecoveryNotifier.notifyIfNeeded(stateDirectory: paths.stateDirectory)
        let force = CommandLine.arguments.contains("--force")
        do {
            let outcome = try SyncRun(paths: paths, salt: salt)
                .runReportingFailures(force: force)
            if outcome.ran {
                StructuredLog.emit("sync.complete", fields: [
                    "ran": true,
                    "messages_ingested": outcome.messagesIngested,
                    "mirror_message_count": outcome.mirrorMessageCount,
                    "health": outcome.health.rawValue,
                    "digest": outcome.digestPath ?? "none — corpus is thin",
                    "voice_packs": outcome.voicePackPaths.count,
                    "heartbeat": outcome.heartbeatPath ?? "none",
                    "elapsed_s": (outcome.elapsed * 1000).rounded() / 1000,
                    "app_version": AppInfo.version,
                ])
                return .completed
            } else {
                // The idempotent guard. launchd fires on wake as well as on schedule, so
                // this is the common case on a laptop, not an error.
                StructuredLog.emit("sync.skipped", fields: [
                    "ran": false,
                    "reason": outcome.skippedReason ?? "unknown",
                    "mirror_message_count": outcome.mirrorMessageCount,
                    "minimum_hours_between_runs": SyncRun.defaultMinimumHoursBetweenRuns,
                ])
                return .skipped(reason: outcome.skippedReason ?? "unknown")
            }
        } catch {
            let detail = String(describing: error)
            StructuredLog.emit("sync.failed", level: .error, fields: ["detail": detail])
            return .failed(detail: detail)
        }
    }
}

/// Decides which onboarding flow a launch lands on. The Full Disk Access flow
/// (`OnboardingView`/`PermissionModel`) is the one every existing user who has already
/// granted FDA is on today, and requirement 4 of the picker-becomes-default decision is
/// that those users must be completely unaffected — so the check is simply "does FDA
/// already work," computed once at launch, the same probe `FullDiskAccess.swift` has
/// always used for this. Only a Mac WITHOUT a working FDA grant — overwhelmingly a
/// fresh install, since anyone who already has FDA takes the branch above — lands on
/// the picker (`SecurityScopedSetupView`), which is what "the picker becomes the
/// default onboarding entry point" means in practice: default for new installs, no
/// change for old ones.
///
/// This is computed once per launch, not re-evaluated live: a user who grants FDA
/// mid-session while looking at the picker screen sees the picker's own Messages
/// Folder row go green (`SecurityScopedSetupModel` reads bookmarks and FDA-adjacent
/// probes independently), and a relaunch is what would move them to the other flow —
/// consistent with how `PermissionModel`'s own FDA grant flow already requires a
/// relaunch to observe a fresh grant (see `FullDiskAccess.swift`'s Finding 4).
enum AppEntryFlow {
    case fullDiskAccess
    case securityScopedPicker

    static func current(probe: () -> FullDiskAccess.Status = { FullDiskAccess.probe() }) -> AppEntryFlow {
        probe().isGranted ? .fullDiskAccess : .securityScopedPicker
    }
}

struct BoiApplication: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = PermissionModel()
    @StateObject private var setupModel = SecurityScopedSetupModel()
    private let entryFlow = AppEntryFlow.current()

    var body: some Scene {
        WindowGroup("Boi") {
            Group {
                switch entryFlow {
                case .fullDiskAccess:
                    // Unchanged. Every existing FDA-granted user's launch is byte-for-byte
                    // what it was before this file learned about the picker at all.
                    OnboardingView(model: model)
                        .onAppear { model.start() }
                        .onReceive(NotificationCenter.default.publisher(
                            for: NSApplication.didResignActiveNotification)) { _ in
                            model.applicationDidResignActive()
                        }
                        .onReceive(NotificationCenter.default.publisher(
                            for: NSApplication.didBecomeActiveNotification)) { _ in
                            model.applicationDidBecomeActive()
                        }
                case .securityScopedPicker:
                    SecurityScopedSetupView(model: setupModel)
                }
            }
            .frame(minWidth: 560, minHeight: 460)
        }
        .windowResizability(.contentSize)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        StructuredLog.emit("app.launched", fields: [
            "bundle": Bundle.main.bundleURL.path,
            "responsible_bundle": ResponsibleBundle.current() ?? "none",
            "bundle_path_stable":
                !ResponsibleBundle.containsVersionedComponent(Bundle.main.bundleURL.path),
            "version": AppInfo.version,
        ])
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

/// Registers the scheduled sync.
///
/// The LaunchAgent still runs the main app for TCC-protected Messages reads. The separate
/// LaunchDaemon has no TCC role: it exposes one authenticated, argument-free request and
/// performs only the root-required RTC wake operation.
@MainActor
enum ScheduledSync {

    struct RegistrationResult {
        let serviceResult: String
        let wake: WakeSchedulerLifecycle.ScheduleDisposition?

        var summary: String {
            guard let wake else { return serviceResult }
            switch wake {
            case .scheduled(let date):
                return "\(serviceResult); wake scheduled \(StructuredLog.timestamp(date))"
            case .alreadyScheduled(let date):
                return "\(serviceResult); wake already scheduled \(StructuredLog.timestamp(date))"
            case .failed(let detail):
                return "\(serviceResult); wake scheduling degraded: \(detail)"
            }
        }

        var degradation: String? {
            if serviceResult.hasPrefix("agent failed:") {
                return "Background refresh could not be registered. Boi still works when opened."
            }
            guard case .failed(let detail) = wake else { return nil }
            return "Closed-lid freshness is unavailable: \(detail). "
                + "Boi still works when opened, but reports can be stale until then."
        }
    }

    static var service: SMAppService { .agent(plistName: LaunchAgentPlist.fileName) }
    static var wakeService: SMAppService {
        .daemon(plistName: WakeHelperContract.plistName)
    }

    @discardableResult
    static func register(
        scheduleNextWake: @escaping WakeSchedulerLifecycle.AsyncSchedule = {
            try await WakeHelperClient().scheduleNextWake()
        },
        observe: @escaping (WakeRegistrationState) -> Void = { _ in }
    ) async -> RegistrationResult {
        let state = await WakeRegistrationCoordinator.run(
            daemonStatus: { status(wakeService.status) },
            registerDaemon: { try wakeService.register() },
            agentStatus: { status(service.status) },
            registerAgent: { try service.register() },
            schedule: scheduleNextWake,
            observe: observe,
            sleep: { try await Task.sleep(nanoseconds: 1_000_000_000) }
        )
        switch state {
        case .ready(let wake):
            return RegistrationResult(serviceResult: "wake helper enabled; agent enabled",
                                      wake: wake)
        case .degraded(let detail):
            return RegistrationResult(serviceResult: "background setup failed: \(detail)",
                                      wake: .failed(detail: detail))
        default:
            return RegistrationResult(serviceResult: "background setup incomplete",
                                      wake: .failed(detail: "background setup incomplete"))
        }
    }

    static func unregister() {
        try? service.unregister()
        try? wakeService.unregister()
    }

    static var statusDescription: String {
        "agent: \(description(service.status)); wake helper: \(description(wakeService.status))"
    }

    private static func description(_ status: SMAppService.Status) -> String {
        switch status {
        case .enabled: return "enabled"
        case .requiresApproval: return "requires approval in System Settings > Login Items"
        case .notFound: return "not found"
        case .notRegistered: return "not registered"
        @unknown default: return "unknown"
        }
    }

    private static func status(_ status: SMAppService.Status) -> BackgroundServiceStatus {
        switch status {
        case .enabled: return .enabled
        case .requiresApproval: return .requiresApproval
        case .notFound: return .notFound
        case .notRegistered: return .notRegistered
        @unknown default: return .unknown
        }
    }
}
