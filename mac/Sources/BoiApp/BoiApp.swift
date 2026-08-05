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
    static func main() {
        // Both paths log to disk. A GUI app launched from the Finder and a job launched
        // by `launchd` both have a stdout nobody will ever read, and "did the relaunch
        // happen inside two seconds" is not a question a screenshot can answer.
        StructuredLog.setFileSink(URL(fileURLWithPath: SyncRun.Paths.installed().stateDirectory)
            .appendingPathComponent("boi.log"))
        if CommandLine.arguments.contains("--sync") {
            exit(HeadlessSync.run())
        }
        // Registering the agent needs the bundle but not the window, so it is reachable
        // headlessly — otherwise the only way to verify `launchctl list` shows it is to
        // click a button, which is not evidence anybody can reproduce.
        if CommandLine.arguments.contains("--register-agent") {
            let result = ScheduledSync.register()
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
        scheduleNextWake: @escaping WakeSchedulerLifecycle.Schedule = { date in
            try WakeHelperClient().scheduleNextWake(after: date)
        }
    ) -> Int32 {
        let result = WakeSchedulerLifecycle.runEligibleSync(
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

struct BoiApplication: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = PermissionModel()

    var body: some Scene {
        WindowGroup("Boi") {
            OnboardingView(model: model)
                .frame(minWidth: 560, minHeight: 460)
                .onAppear { model.start() }
                // Leaving for System Settings and coming back with the switch still off
                // is a real, observable event, and it deserves a better screen than the
                // one that says "waiting". Both halves are needed: `didBecomeActive` also
                // fires at launch, so the resign is what proves the user actually went.
                .onReceive(NotificationCenter.default.publisher(
                    for: NSApplication.didResignActiveNotification)) { _ in
                    model.applicationDidResignActive()
                }
                .onReceive(NotificationCenter.default.publisher(
                    for: NSApplication.didBecomeActiveNotification)) { _ in
                    model.applicationDidBecomeActive()
                }
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
        scheduleNextWake: @escaping WakeSchedulerLifecycle.Schedule = { date in
            try WakeHelperClient().scheduleNextWake(after: date)
        }
    ) -> RegistrationResult {
        let registration: String
        do {
            if service.status == .enabled {
                registration = "already registered"
            } else {
                try service.register()
                registration = "registered"
            }
        } catch {
            return RegistrationResult(serviceResult: "agent failed: \(error)", wake: nil)
        }

        let helperRegistration: String
        do {
            if wakeService.status == .enabled {
                helperRegistration = "wake helper enabled"
            } else {
                try wakeService.register()
                switch wakeService.status {
                case .enabled:
                    helperRegistration = "wake helper registered"
                case .requiresApproval:
                    helperRegistration = "wake helper requires admin approval"
                case .notFound:
                    helperRegistration = "wake helper failed: embedded daemon not found"
                case .notRegistered:
                    helperRegistration = "wake helper failed: daemon not registered"
                @unknown default:
                    helperRegistration = "wake helper failed: unknown registration status"
                }
            }
        } catch {
            return RegistrationResult(
                serviceResult: "\(registration); wake helper failed: \(error)",
                wake: .failed(detail: "authorized wake helper registration failed")
            )
        }

        guard wakeService.status == .enabled else {
            return RegistrationResult(
                serviceResult: "\(registration); \(helperRegistration)",
                wake: .failed(detail: "authorized wake helper requires admin approval")
            )
        }

        let wake = WakeSchedulerLifecycle.scheduleInitialWake(schedule: scheduleNextWake)
        return RegistrationResult(serviceResult: "\(registration); \(helperRegistration)",
                                  wake: wake)
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
}
