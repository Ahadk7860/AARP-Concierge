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
            StructuredLog.emit("agent.register", fields: [
                "result": ScheduledSync.register(),
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
            try WakeScheduler().scheduleNextWake(after: date)
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
/// `SMAppService.agent` reads the plist from `Contents/Library/LaunchAgents/` inside this
/// bundle. That location is the reason it works: an agent registered from inside the app
/// bundle runs *as* the app, so it inherits the responsible process and therefore the
/// Full Disk Access grant. A plist dropped in `~/Library/LaunchAgents` pointing at a
/// helper does not, and its failure mode is silence.
enum ScheduledSync {

    static var service: SMAppService { .agent(plistName: LaunchAgentPlist.fileName) }

    @discardableResult
    static func register(
        scheduleNextWake: @escaping WakeSchedulerLifecycle.Schedule = { date in
            try WakeScheduler().scheduleNextWake(after: date)
        }
    ) -> String {
        let registration: String
        do {
            if service.status == .enabled {
                registration = "already registered"
            } else {
                try service.register()
                registration = "registered"
            }
        } catch {
            return "failed: \(error)"
        }

        let wake = WakeSchedulerLifecycle.scheduleInitialWake(schedule: scheduleNextWake)
        switch wake {
        case .scheduled(let date):
            return "\(registration); wake scheduled \(StructuredLog.timestamp(date))"
        case .alreadyScheduled(let date):
            return "\(registration); wake already scheduled \(StructuredLog.timestamp(date))"
        case .failed(let detail):
            return "\(registration); wake scheduling degraded: \(detail)"
        }
    }

    static func unregister() {
        try? service.unregister()
    }

    static var statusDescription: String {
        switch service.status {
        case .enabled: return "enabled"
        case .requiresApproval: return "requires approval in System Settings > Login Items"
        case .notFound: return "not found"
        case .notRegistered: return "not registered"
        @unknown default: return "unknown"
        }
    }
}
