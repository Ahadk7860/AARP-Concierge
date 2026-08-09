import AppKit
import BoiKit
import Contacts
import Foundation

/// The three-step setup screen: Messages folder / Contacts / Automation, each granted
/// independently with its own live status. This is the NSOpenPanel + security-scoped
/// bookmark path from `MessagesFolderAccess.swift`, offered ALONGSIDE the existing
/// Full Disk Access flow (`PermissionModel`/`OnboardingView`) rather than replacing it
/// — see the two non-proofs documented on `MessagesFolderAccess` (untested across an
/// app update; untested across a real day/night cycle) before this becomes the
/// default entry point for every install. Which screen a fresh install actually lands
/// on is a product decision left open here on purpose.
///
/// **This file is deliberately thin, same discipline as `PermissionModel`'s own doc
/// comment states**: `BoiApp` is an executable target `BoiKitTests` cannot import, so
/// judgement that needs to be testable lives in `BoiKit` (`MessagesFolderAccess.swift`)
/// and this file is the AppKit/Contacts-framework glue around it — the panel, the
/// Contacts authorization call, the AppleEvents probe — none of which has a fake
/// worth building, the same reasoning `FullDiskAccess.probe()` already rests on.
@MainActor
final class SecurityScopedSetupModel: ObservableObject {

    enum StepStatus: Equatable {
        case notGranted
        case checking
        case granted
        /// Granted once, but the bookmark no longer resolves — see
        /// `MessagesFolderAccess.Error.bookmarkStale` for why this is surfaced instead
        /// of silently re-prompting.
        case needsReauthorization(detail: String)

        var label: String {
            switch self {
            case .notGranted: return "Not granted"
            case .checking: return "Checking…"
            case .granted: return "Granted"
            case .needsReauthorization: return "Needs re-authorization"
            }
        }

        var isGranted: Bool { self == .granted }
    }

    @Published private(set) var messagesFolderStatus: StepStatus = .checking
    @Published private(set) var contactsStatus: StepStatus = .checking
    @Published private(set) var automationStatus: StepStatus = .checking

    private let bookmarkDirectory: String
    private let automationTarget = "Messages"

    init(bookmarkDirectory: String = SyncRun.Paths.installed().stateDirectory) {
        self.bookmarkDirectory = bookmarkDirectory
    }

    func refreshAll() {
        refreshMessagesFolderStatus()
        refreshContactsStatus()
        refreshAutomationStatus()
    }

    // MARK: - Messages folder

    func refreshMessagesFolderStatus() {
        let store = MessagesFolderAccess.BookmarkStore(directory: bookmarkDirectory)
        guard store.load() != nil else {
            messagesFolderStatus = .notGranted
            return
        }
        let provider = SecurityScopedMessagesProvider(directory: bookmarkDirectory)
        do {
            try provider.beginAccess()
            defer { provider.endAccess() }
            _ = try provider.url(for: .messages)
            messagesFolderStatus = .granted
        } catch let error as MessagesFolderAccess.Error {
            messagesFolderStatus = .needsReauthorization(detail: error.description)
        } catch {
            messagesFolderStatus = .needsReauthorization(detail: String(describing: error))
        }
    }

    /// Presents the panel already navigated to `~/Library/Messages`, exactly as spiked
    /// and verified — see `MessagesFolderAccess.swift`'s doc comment for what that
    /// verification did and did not cover. Persists the bookmark on success.
    func grantMessagesFolderAccess() {
        let panel = NSOpenPanel()
        panel.title = "Grant Access to Messages"
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Messages")
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Grant Access"
        panel.message = "Click \"Grant Access\" below without navigating anywhere else " +
            "— this folder is already the one being granted."

        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }

        let started = url.startAccessingSecurityScopedResource()
        defer { if started { url.stopAccessingSecurityScopedResource() } }

        do {
            let bookmark = try url.bookmarkData(options: [.withSecurityScope],
                                                includingResourceValuesForKeys: nil,
                                                relativeTo: nil)
            try MessagesFolderAccess.BookmarkStore(directory: bookmarkDirectory).save(bookmark)
            StructuredLog.emit("setup.messages_folder_granted")
        } catch {
            StructuredLog.emit("setup.messages_folder_bookmark_failed", level: .error,
                               fields: ["detail": String(describing: error)])
        }
        refreshMessagesFolderStatus()
    }

    // MARK: - Contacts

    func refreshContactsStatus() {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized, .limited:
            contactsStatus = .granted
        case .notDetermined:
            contactsStatus = .notGranted
        case .denied, .restricted:
            contactsStatus = .needsReauthorization(
                detail: "denied in System Settings > Privacy & Security > Contacts")
        @unknown default:
            contactsStatus = .notGranted
        }
    }

    func grantContactsAccess() {
        CNContactStore().requestAccess(for: .contacts) { [weak self] _, error in
            Task { @MainActor in
                if let error {
                    StructuredLog.emit("setup.contacts_request_failed", level: .warn,
                                       fields: ["detail": String(describing: error)])
                }
                self?.refreshContactsStatus()
            }
        }
    }

    // MARK: - Automation

    /// There is no "check status without prompting" API for AppleEvents automation
    /// permission the way `CNContactStore.authorizationStatus` exists for Contacts —
    /// `AEDeterminePermissionToAutomateTarget` itself can trigger the system prompt
    /// depending on its `askUserIfNeeded` argument. Passing `false` checks without
    /// prompting; `grantAutomationAccess()` below passes `true` for the actual grant.
    func refreshAutomationStatus() {
        automationStatus = Self.probeAutomation(target: automationTarget, askUserIfNeeded: false)
    }

    func grantAutomationAccess() {
        automationStatus = Self.probeAutomation(target: automationTarget, askUserIfNeeded: true)
    }

    private static func probeAutomation(target: String, askUserIfNeeded: Bool) -> StepStatus {
        // Messages.app's actual bundle identifier is com.apple.MobileSMS on modern
        // macOS; com.apple.iChat is the historical one. Try both — whichever matches
        // gets the real answer, and a wrong bundle id would silently under-report as
        // "not granted" forever.
        for bundleID in ["com.apple.MobileSMS", "com.apple.iChat"] {
            let descriptor = NSAppleEventDescriptor(bundleIdentifier: bundleID)
            guard let pointer = descriptor.aeDesc else { continue }
            let status = AEDeterminePermissionToAutomateTarget(pointer, typeWildCard,
                                                                typeWildCard, askUserIfNeeded)
            switch status {
            case noErr:
                return .granted
            case OSStatus(errAEEventNotPermitted):
                return .needsReauthorization(
                    detail: "denied in System Settings > Privacy & Security > Automation")
            default:
                continue // procNotFound (target app not running/installed) — try the next id.
            }
        }
        return .notGranted
    }
}
