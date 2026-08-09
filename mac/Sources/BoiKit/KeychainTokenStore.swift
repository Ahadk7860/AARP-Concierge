import Foundation
import Security

/// The shipping `TokenStore`. `EnvironmentTokenStore` (Uploader.swift) reads
/// `BOI_USER_ID`/`BOI_DEVICE_TOKEN` from the process environment or `.env` — useful for
/// development and for the CLI, but a plaintext file on disk is not where a device
/// token that lets the server accept digests on a user's behalf should live
/// permanently. This is a second implementation of the same protocol, per the doc
/// comment already on `TokenStore`, not a rewrite of any call site.
///
/// **The ACL, and why there is nothing extra to configure for it.** The step 4
/// requirement was "an ACL permitting the signed binary, so headless/LaunchAgent runs
/// work without a prompt." macOS Keychain items are, by default, scoped to the
/// requesting application's code signing identity — nothing else has to ask for them.
/// `--sync` under a LaunchAgent invokes the identical signed `Boi.app` binary that
/// wrote the item interactively (see `BoiApp.swift`'s doc comment: "the LaunchAgent
/// still runs the main app for TCC-protected reads... TCC is per-responsible-process,
/// so the scheduled run has to be this bundle" — the same fact applies to Keychain
/// identity), so the default per-app scoping already IS the ACL this step asked for.
/// A shared `kSecAttrAccessGroup` would only be needed if a *different* binary (a
/// helper tool, an extension) also had to read this item, which is not the shape here.
///
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` is the accessibility level: not
/// `WhenUnlocked`, because a 3am wake can run before the user has unlocked that
/// session; not synced to iCloud (`ThisDeviceOnly`), because a device token is
/// per-device by construction — syncing it would let one Mac's token work from another
/// machine entirely. Crucially, this level requires no user presence and produces no
/// prompt, which `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` and any
/// `SecAccessControl` with `.userPresence` would.
public struct KeychainTokenStore: TokenStore {

    public enum Error: Swift.Error, CustomStringConvertible {
        case saveFailed(OSStatus)
        case deleteFailed(OSStatus)
        case encodeFailed

        public var description: String {
            switch self {
            case .saveFailed(let status):
                return "Keychain save failed: \(KeychainTokenStore.describe(status))"
            case .deleteFailed(let status):
                return "Keychain delete failed: \(KeychainTokenStore.describe(status))"
            case .encodeFailed:
                return "could not encode the device identity for storage"
            }
        }
    }

    /// Injectable so tests never touch the real production item — see
    /// `Uploader.Configuration.defaultApplicationSupportDirectory` and
    /// `MessagesFolderAccess.BookmarkStore` for the same shape of the same problem: a
    /// hardcoded real identifier means a test either silently collides with whatever a
    /// developer's Mac actually has stored, or silently passes against nothing.
    public let service: String
    public let account: String

    public init(service: String = "app.boi.mac.device-identity", account: String = "default") {
        self.service = service
        self.account = account
    }

    private func query() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    public func save(_ identity: DeviceIdentity) throws {
        guard let data = try? JSONEncoder().encode(identity) else { throw Error.encodeFailed }

        // Delete-then-add rather than SecItemUpdate: the account is only ever one
        // identity, never partially updated, and delete-then-add is one fewer status
        // code to interpret for a store this small.
        SecItemDelete(query() as CFDictionary)

        var attributes = query()
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            StructuredLog.emit("keychain.save_failed", level: .error,
                               fields: ["status": Int(status)])
            throw Error.saveFailed(status)
        }
        StructuredLog.emit("keychain.saved", fields: ["service": service])
    }

    /// `TokenStore.identity()`. Returns `nil` on ANY failure — not found, corrupt data,
    /// a denied Keychain query — because `Uploader.Configuration.fromEnvironment`'s
    /// entire design principle (§ the file's own doc comment: "returning nil rather
    /// than defaulting... is deliberate") applies here identically: an uploader with no
    /// identity does nothing, rather than guessing.
    public func identity() -> DeviceIdentity? {
        var attributes = query()
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(attributes as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            if status != errSecItemNotFound {
                // Not found is the ordinary "never paired" case and not worth a log
                // line every run; anything else (errSecInteractionNotAllowed before
                // first unlock, a denied access) is worth knowing about.
                StructuredLog.emit("keychain.read_failed", level: .warn,
                                   fields: ["status": Int(status)])
            }
            return nil
        }
        return try? JSONDecoder().decode(DeviceIdentity.self, from: data)
    }

    public func clear() throws {
        let status = SecItemDelete(query() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw Error.deleteFailed(status)
        }
    }

    static func describe(_ status: OSStatus) -> String {
        (SecCopyErrorMessageString(status, nil) as String?) ?? "OSStatus \(status)"
    }
}
