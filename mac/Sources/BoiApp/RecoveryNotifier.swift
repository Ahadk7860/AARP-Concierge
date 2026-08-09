import BoiKit
import Foundation
import UserNotifications

/// A local user notification for the one failure mode this track exists to prevent
/// from being silent: a headless `--sync` that lost access to the Messages folder,
/// most likely right after a Sparkle update re-signed the binary.
///
/// **Fires once per loss episode, not once per sync.** The LaunchAgent runs every 30
/// minutes; without a persisted "already notified" marker, a Mac stuck in a lost state
/// would get a fresh notification every half hour, which teaches a user to swipe it
/// away without reading it — exactly the false-alarm failure mode
/// `classifyRecoveryState`'s `neverConfigured`/`lost` split already guards against on
/// the OTHER side (first-run silence). The marker clears itself the moment access is
/// confirmed working again, so a genuine second loss still notifies.
enum RecoveryNotifier {

    private static func markerPath(stateDirectory: String) -> String {
        URL(fileURLWithPath: stateDirectory)
            .appendingPathComponent("recovery-notification-sent.marker").path
    }

    /// Call after every `--sync` attempt, headless or interactive. Cheap on the common
    /// path (`.ok` or `.neverConfigured`) — no notification, and `.ok` actively clears
    /// a stale marker so the next real loss notifies again.
    static func notifyIfNeeded(
        stateDirectory: String,
        classify: (String) -> MessagesFolderAccess.AccessRecoveryState =
            MessagesFolderAccess.classifyRecoveryState,
        post: (UNMutableNotificationContent) -> Void = postToNotificationCenter
    ) {
        let marker = markerPath(stateDirectory: stateDirectory)
        switch classify(stateDirectory) {
        case .neverConfigured:
            // Never notify on first-run "hasn't set up yet" — the explicit
            // requirement this type exists to honor.
            break
        case .ok:
            try? FileManager.default.removeItem(atPath: marker)
        case .lost(let detail):
            guard !FileManager.default.fileExists(atPath: marker) else {
                // Already notified for this ongoing loss; do not repeat every 30
                // minutes.
                break
            }
            let content = UNMutableNotificationContent()
            content.title = "Boi"
            content.body = "Boi lost access to your Messages folder. Open Boi to restore it."
            content.sound = .default
            post(content)
            FileManager.default.createFile(atPath: marker, contents: nil)
            StructuredLog.emit("recovery.notified", level: .warn, fields: ["detail": detail])
        }
    }

    /// The actual `UNUserNotificationCenter` call, split out so `notifyIfNeeded` is
    /// testable without touching Notification Center. Clicking the notification
    /// activates the app by default — no custom action needed for "open Boi"; the
    /// route to the setup screen is handled by `BoiApplication`'s own launch-time
    /// check of `classifyRecoveryState`/FDA, not by anything here.
    private static func postToNotificationCenter(_ content: UNMutableNotificationContent) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            guard granted else {
                if let error {
                    StructuredLog.emit("recovery.notification_denied", level: .warn,
                                       fields: ["detail": String(describing: error)])
                }
                return
            }
            let request = UNNotificationRequest(
                identifier: "app.boi.mac.recovery." + UUID().uuidString,
                content: content, trigger: nil)
            center.add(request) { error in
                if let error {
                    StructuredLog.emit("recovery.notification_post_failed", level: .error,
                                       fields: ["detail": String(describing: error)])
                }
            }
        }
    }
}
