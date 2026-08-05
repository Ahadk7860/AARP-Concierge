import Foundation
import Security

/// Frozen names shared by the app, its embedded LaunchDaemon plist, and the helper.
public enum WakeHelperContract {
    public static let plistName = "app.boi.mac.wake-helper.plist"
    public static let serviceName = "app.boi.mac.wake-helper"
    public static let helperIdentifier = "app.boi.mac.wake-helper"
    public static let authorizedAppIdentifier = "app.boi.mac"
    public static let bundleProgram = "Contents/Resources/BoiWakeHelper"
}

/// Defense in depth at the privileged process boundary. Even an internal programming
/// error cannot turn the helper's `Process` call into a general pmset or shell surface.
public enum WakeHelperCommandPolicy {
    public static func allows(executable: String, arguments: [String]) -> Bool {
        guard executable == WakeScheduler.pmsetPath else { return false }
        if arguments == ["-g", "sched"] { return true }
        guard arguments.count == 3,
              arguments[0] == "schedule",
              arguments[1] == "wake" else { return false }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MM/dd/yy HH:mm:ss"
        formatter.isLenient = false
        return formatter.date(from: arguments[2]) != nil
    }
}

/// Exactly one argument-free request crosses the privilege boundary. In particular,
/// there is nowhere to put a date, command, executable, argv, or power-management mode.
@objc public protocol WakeHelperXPCProtocol {
    func reschedule(reply: @escaping (Int, Date?, String?) -> Void)
}

public enum WakeHelperResponse: Equatable, Sendable {
    case scheduled(Date)
    case alreadyScheduled(Date)
    case degraded(String)

    public var disposition: WakeSchedulerLifecycle.ScheduleDisposition {
        switch self {
        case .scheduled(let date): return .scheduled(date)
        case .alreadyScheduled(let date): return .alreadyScheduled(date)
        case .degraded(let detail): return .failed(detail: detail)
        }
    }

    public var wireValue: (code: Int, date: Date?, detail: String?) {
        switch self {
        case .scheduled(let date): return (0, date, nil)
        case .alreadyScheduled(let date): return (1, date, nil)
        case .degraded(let detail): return (2, nil, detail)
        }
    }

    public static func decode(code: Int, date: Date?, detail: String?) -> WakeHelperResponse {
        switch (code, date) {
        case (0, .some(let date)): return .scheduled(date)
        case (1, .some(let date)): return .alreadyScheduled(date)
        default: return .degraded(detail ?? "wake helper returned an invalid response")
        }
    }
}

/// Synchronous adapter for the existing lifecycle seam. The date passed by the lifecycle
/// is intentionally ignored: the XPC request has no arguments and the root helper plans
/// the next fixed local slot using its own clock.
public struct WakeHelperClient {
    public typealias Reschedule = (@escaping (WakeHelperResponse) -> Void) -> Void

    private let reschedule: Reschedule
    private let timeout: TimeInterval

    public init(timeout: TimeInterval = 10) {
        self.timeout = timeout
        self.reschedule = Self.productionReschedule
    }

    public init(timeout: TimeInterval = 10, reschedule: @escaping Reschedule) {
        self.timeout = timeout
        self.reschedule = reschedule
    }

    public func scheduleNextWake(after _: Date) throws -> WakeScheduler.Outcome {
        let semaphore = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var response: WakeHelperResponse?
        var completed = false
        reschedule { value in
            lock.lock()
            guard !completed else {
                lock.unlock()
                return
            }
            completed = true
            response = value
            lock.unlock()
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + timeout) == .success else {
            lock.lock()
            completed = true
            lock.unlock()
            throw WakeScheduler.Error.authorizedHelperUnavailable
        }
        lock.lock()
        let result = response
        lock.unlock()
        switch result {
        case .scheduled(let date): return .scheduled(date)
        case .alreadyScheduled(let date): return .alreadyScheduled(date)
        case .degraded(let detail):
            throw WakeScheduler.Error.helperRejected(detail: detail)
        case nil:
            throw WakeScheduler.Error.helperRejected(detail: "wake helper returned no response")
        }
    }

    private static func productionReschedule(reply: @escaping (WakeHelperResponse) -> Void) {
        let oneShot = WakeHelperReplyOnce(reply)
        let connection = NSXPCConnection(machServiceName: WakeHelperContract.serviceName,
                                         options: .privileged)
        connection.remoteObjectInterface = NSXPCInterface(with: WakeHelperXPCProtocol.self)
        connection.interruptionHandler = {
            oneShot.call(.degraded("authorized wake helper connection was interrupted"))
        }
        connection.invalidationHandler = {}
        connection.resume()
        let proxy = connection.remoteObjectProxyWithErrorHandler { error in
            oneShot.call(.degraded(
                "authorized wake helper unavailable: \(error.localizedDescription)"))
            connection.invalidate()
        }
        guard let helper = proxy as? WakeHelperXPCProtocol else {
            oneShot.call(.degraded("authorized wake helper protocol unavailable"))
            connection.invalidate()
            return
        }
        helper.reschedule { code, date, detail in
            oneShot.call(WakeHelperResponse.decode(code: code, date: date, detail: detail))
            connection.invalidate()
        }
    }
}

private final class WakeHelperReplyOnce {
    private let lock = NSLock()
    private var completed = false
    private let reply: (WakeHelperResponse) -> Void

    init(_ reply: @escaping (WakeHelperResponse) -> Void) {
        self.reply = reply
    }

    func call(_ response: WakeHelperResponse) {
        lock.lock()
        guard !completed else {
            lock.unlock()
            return
        }
        completed = true
        lock.unlock()
        reply(response)
    }
}

/// Verifies the connecting process, not data supplied by that process. Production fails
/// closed when this helper or its caller is ad-hoc signed because ad-hoc code has no Team
/// ID that can establish the same-team boundary. Tests inject both seams.
public struct WakeHelperCallerAuthorization {
    public typealias TeamIdentifier = () -> String?
    public typealias Validate = (_ pid: pid_t, _ requirement: String) -> Bool

    private let teamIdentifier: TeamIdentifier
    private let validate: Validate

    public init() {
        self.teamIdentifier = Self.productionTeamIdentifier
        self.validate = Self.productionValidate
    }

    public init(teamIdentifier: @escaping TeamIdentifier,
                validate: @escaping Validate) {
        self.teamIdentifier = teamIdentifier
        self.validate = validate
    }

    public func allows(pid: pid_t) -> Bool {
        guard pid > 0,
              let teamID = teamIdentifier(),
              !teamID.isEmpty else { return false }
        let escapedTeam = Self.requirementLiteral(teamID)
        let escapedIdentifier = Self.requirementLiteral(WakeHelperContract.authorizedAppIdentifier)
        let requirement = "anchor apple generic and identifier \"\(escapedIdentifier)\" "
            + "and certificate leaf[subject.OU] = \"\(escapedTeam)\""
        return validate(pid, requirement)
    }

    private static func requirementLiteral(_ value: String) -> String {
        value.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }

    private static func productionTeamIdentifier() -> String? {
        var ownCode: SecCode?
        guard SecCodeCopySelf([], &ownCode) == errSecSuccess,
              let ownCode else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(ownCode, [], &staticCode) == errSecSuccess,
              let staticCode else { return nil }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode,
                                            SecCSFlags(rawValue: kSecCSSigningInformation),
                                            &information) == errSecSuccess,
              let dictionary = information as? [CFString: Any] else { return nil }
        return dictionary[kSecCodeInfoTeamIdentifier] as? String
    }

    private static func productionValidate(pid: pid_t, requirementText: String) -> Bool {
        let attributes = [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary
        var guest: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess,
              let guest else { return false }
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(requirementText as CFString, [], &requirement)
                == errSecSuccess,
              let requirement else { return false }
        return SecCodeCheckValidity(guest, [], requirement) == errSecSuccess
    }
}
