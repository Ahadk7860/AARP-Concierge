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

/// The helper reserves its final second for TERM/KILL cleanup and must return before the
/// client deadline. All values are process-monotonic, never wall-clock dates.
public enum WakeHelperTiming {
    public static let helperTransactionTimeout: TimeInterval = 7
    public static let processCleanupReserve: TimeInterval = 1
    public static let clientTimeout: TimeInterval = 10
}

public struct WakeHelperTransactionDeadline: Equatable, Sendable {
    public let startedAtNanoseconds: UInt64
    public let commandCutoffNanoseconds: UInt64
    public let hardDeadlineNanoseconds: UInt64

    public init(startedAtNanoseconds: UInt64) {
        self.startedAtNanoseconds = startedAtNanoseconds
        self.hardDeadlineNanoseconds = startedAtNanoseconds
            + Self.nanoseconds(WakeHelperTiming.helperTransactionTimeout)
        self.commandCutoffNanoseconds = hardDeadlineNanoseconds
            - Self.nanoseconds(WakeHelperTiming.processCleanupReserve)
    }

    public func canStartCommand(atNanoseconds now: UInt64) -> Bool {
        now < commandCutoffNanoseconds
    }

    public func commandWaitInterval(atNanoseconds now: UInt64) -> DispatchTimeInterval? {
        guard canStartCommand(atNanoseconds: now) else { return nil }
        let remaining = commandCutoffNanoseconds - now
        return .nanoseconds(Int(min(remaining, UInt64(Int.max))))
    }

    public func cleanupWaitInterval(atNanoseconds now: UInt64) -> DispatchTimeInterval {
        guard now < hardDeadlineNanoseconds else { return .nanoseconds(0) }
        let remaining = hardDeadlineNanoseconds - now
        return .nanoseconds(Int(min(remaining, UInt64(Int.max))))
    }

    public static var clientMargin: TimeInterval {
        WakeHelperTiming.clientTimeout - WakeHelperTiming.helperTransactionTimeout
    }

    private static func nanoseconds(_ seconds: TimeInterval) -> UInt64 {
        UInt64(seconds * 1_000_000_000)
    }
}

/// Defense in depth at the privileged process boundary. Even an internal programming
/// error cannot turn the helper's `Process` call into a general pmset or shell surface.
public enum WakeHelperCommandPolicy {
    public static func allows(executable: String, arguments: [String],
                              now: Date = Date(), calendar: Calendar = .current) -> Bool {
        guard executable == WakeScheduler.pmsetPath else { return false }
        if arguments == ["-g", "sched"] { return true }
        guard arguments.count == 3,
              arguments[0] == "schedule",
              arguments[1] == "wake" else { return false }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MM/dd/yy HH:mm:ss"
        formatter.isLenient = false
        guard let requested = formatter.date(from: arguments[2]),
              let next = WakeScheduler.nextWake(after: now, calendar: calendar) else {
            return false
        }
        return abs(requested.timeIntervalSince(next)) < 0.5
    }
}

/// One queue is shared by every exported service object, so the idempotency read and the
/// conditional schedule write are one transaction across all simultaneous XPC clients.
public final class WakeHelperTransactionQueue: @unchecked Sendable {
    private let queue: DispatchQueue

    public init(label: String = "app.boi.mac.wake-helper.transaction") {
        self.queue = DispatchQueue(label: label)
    }

    public func perform(_ operation: @escaping () -> Void) {
        queue.async(execute: operation)
    }
}

public enum BackgroundServiceStatus: Equatable, Sendable {
    case enabled
    case requiresApproval
    case notRegistered
    case notFound
    case unknown
}

public enum WakeRegistrationState: Equatable, Sendable {
    case registeringDaemon
    case requiresApproval(service: String)
    case registeringAgent
    case schedulingWake
    case ready(WakeSchedulerLifecycle.ScheduleDisposition)
    case degraded(String)
}

/// Daemon approval is the first gate. The agent is not touched until the daemon becomes
/// enabled, and scheduling starts only after the agent is re-read and verified enabled.
public enum WakeRegistrationCoordinator {
    public typealias Status = () -> BackgroundServiceStatus
    public typealias Register = () throws -> Void
    public typealias Observe = (WakeRegistrationState) -> Void
    public typealias Sleep = () async throws -> Void

    public static func run(
        daemonStatus: @escaping Status,
        registerDaemon: Register,
        agentStatus: @escaping Status,
        registerAgent: Register,
        schedule: WakeSchedulerLifecycle.AsyncSchedule,
        observe: @escaping Observe,
        sleep: @escaping Sleep
    ) async -> WakeRegistrationState {
        do {
            observe(.registeringDaemon)
            var surfacedDaemonApproval = false
            if daemonStatus() == .notRegistered {
                do {
                    try registerDaemon()
                } catch {
                    // SMAppService may throw when registration has nevertheless entered
                    // the user-approval state. Status is authoritative; the thrown error
                    // is terminal only when the re-read status is not requiresApproval.
                    guard daemonStatus() == .requiresApproval else { throw error }
                    observe(.requiresApproval(service: "wake helper"))
                    surfacedDaemonApproval = true
                }
            }
            while daemonStatus() == .requiresApproval {
                if !surfacedDaemonApproval {
                    observe(.requiresApproval(service: "wake helper"))
                }
                surfacedDaemonApproval = false
                try await sleep()
            }
            guard daemonStatus() == .enabled else {
                let state = WakeRegistrationState.degraded("wake helper daemon is not enabled")
                observe(state)
                return state
            }

            observe(.registeringAgent)
            if agentStatus() == .notRegistered { try registerAgent() }
            while agentStatus() == .requiresApproval {
                observe(.requiresApproval(service: "background sync"))
                try await sleep()
            }
            guard agentStatus() == .enabled else {
                let state = WakeRegistrationState.degraded("background sync agent is not enabled")
                observe(state)
                return state
            }

            observe(.schedulingWake)
            let disposition = await WakeSchedulerLifecycle.scheduleInitialWakeAsync(
                schedule: schedule)
            let state: WakeRegistrationState
            if case .failed(let detail) = disposition {
                state = .degraded(detail)
            } else {
                state = .ready(disposition)
            }
            observe(state)
            return state
        } catch is CancellationError {
            let state = WakeRegistrationState.degraded("background refresh setup cancelled")
            observe(state)
            return state
        } catch {
            let state = WakeRegistrationState.degraded(String(describing: error))
            observe(state)
            return state
        }
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

/// Handle retained by the async client for the full request lifetime.
public protocol WakeHelperRequestHandle: AnyObject {
    func invalidate()
}

/// An async, cancellable adapter that owns its XPC connection until exactly one terminal
/// result. Timeout and task cancellation invalidate the connection; late replies are ignored.
public final class WakeHelperClient: @unchecked Sendable {
    public typealias StartRequest = (@escaping (WakeHelperResponse) -> Void) throws
        -> WakeHelperRequestHandle

    private let startRequest: StartRequest
    private let timeout: TimeInterval

    public init(timeout: TimeInterval = WakeHelperTiming.clientTimeout) {
        self.timeout = timeout
        self.startRequest = Self.productionStartRequest
    }

    public init(timeout: TimeInterval = WakeHelperTiming.clientTimeout,
                startRequest: @escaping StartRequest) {
        self.timeout = timeout
        self.startRequest = startRequest
    }

    public func scheduleNextWake() async throws -> WakeScheduler.Outcome {
        let state = WakeHelperAsyncRequestState()
        let response: WakeHelperResponse = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                state.install(continuation: continuation)
                guard !Task.isCancelled else {
                    state.finish(.failure(CancellationError()))
                    return
                }
                do {
                    let handle = try startRequest { response in
                        state.finish(.success(response))
                    }
                    state.install(handle: handle)
                } catch {
                    state.finish(.failure(error))
                }
                state.installTimeout(seconds: timeout)
            }
        } onCancel: {
            state.finish(.failure(CancellationError()))
        }

        switch response {
        case .scheduled(let date): return .scheduled(date)
        case .alreadyScheduled(let date): return .alreadyScheduled(date)
        case .degraded(let detail):
            throw WakeScheduler.Error.helperRejected(detail: detail)
        }
    }

    private static func productionStartRequest(
        reply: @escaping (WakeHelperResponse) -> Void
    ) throws -> WakeHelperRequestHandle {
        let peerRequirement = try WakeHelperSigningRequirement.peerRequirement(
            expectedSelfIdentifier: WakeHelperContract.authorizedAppIdentifier,
            peerIdentifier: WakeHelperContract.helperIdentifier)
        let connection = NSXPCConnection(machServiceName: WakeHelperContract.serviceName,
                                         options: .privileged)
        let handle = WakeHelperXPCRequest(connection: connection)
        connection.remoteObjectInterface = NSXPCInterface(with: WakeHelperXPCProtocol.self)
        connection.setCodeSigningRequirement(peerRequirement)
        connection.interruptionHandler = {
            reply(.degraded("authorized wake helper connection was interrupted"))
        }
        connection.invalidationHandler = {}
        connection.activate()
        let proxy = connection.remoteObjectProxyWithErrorHandler { error in
            reply(.degraded("authorized wake helper unavailable: \(error.localizedDescription)"))
        }
        guard let helper = proxy as? WakeHelperXPCProtocol else {
            reply(.degraded("authorized wake helper protocol unavailable"))
            return handle
        }
        helper.reschedule { code, date, detail in
            reply(WakeHelperResponse.decode(code: code, date: date, detail: detail))
        }
        return handle
    }
}

private final class WakeHelperXPCRequest: WakeHelperRequestHandle {
    private let connection: NSXPCConnection
    init(connection: NSXPCConnection) { self.connection = connection }
    func invalidate() { connection.invalidate() }
}

private final class WakeHelperAsyncRequestState: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<WakeHelperResponse, Swift.Error>?
    private var handle: WakeHelperRequestHandle?
    private var timeoutTask: Task<Void, Never>?
    private var result: Result<WakeHelperResponse, Swift.Error>?
    private var finished = false

    func install(continuation: CheckedContinuation<WakeHelperResponse, Swift.Error>) {
        lock.lock()
        if let result {
            lock.unlock()
            continuation.resume(with: result)
            return
        }
        self.continuation = continuation
        lock.unlock()
    }

    func install(handle: WakeHelperRequestHandle) {
        lock.lock()
        if finished {
            lock.unlock()
            handle.invalidate()
            return
        }
        self.handle = handle
        lock.unlock()
    }

    func installTimeout(seconds: TimeInterval) {
        let nanoseconds = UInt64(max(0, seconds) * 1_000_000_000)
        let task = Task { [weak self] in
            try? await Task.sleep(nanoseconds: nanoseconds)
            guard !Task.isCancelled else { return }
            self?.finish(.failure(WakeScheduler.Error.authorizedHelperUnavailable))
        }
        lock.lock()
        if finished {
            lock.unlock()
            task.cancel()
            return
        }
        timeoutTask = task
        lock.unlock()
    }

    func finish(_ result: Result<WakeHelperResponse, Swift.Error>) {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return
        }
        finished = true
        self.result = result
        let continuation = self.continuation
        self.continuation = nil
        let handle = self.handle
        self.handle = nil
        let timeoutTask = self.timeoutTask
        self.timeoutTask = nil
        lock.unlock()
        timeoutTask?.cancel()
        handle?.invalidate()
        continuation?.resume(with: result)
    }
}

public struct WakeHelperSigningRequirement {
    public struct Identity: Equatable, Sendable {
        public let identifier: String
        public let teamIdentifier: String
        public init(identifier: String, teamIdentifier: String) {
            self.identifier = identifier
            self.teamIdentifier = teamIdentifier
        }
    }

    public enum Error: Swift.Error, LocalizedError, Equatable {
        case unverifiableSelf
        case wrongSelfIdentifier
        case invalidSelfSignature
        public var errorDescription: String? {
            switch self {
            case .unverifiableSelf: return "current process has no verifiable Developer ID identity"
            case .wrongSelfIdentifier: return "current process has the wrong signing identifier"
            case .invalidSelfSignature: return "current process signature or anchor is invalid"
            }
        }
    }

    public typealias ReadIdentity = () -> Identity?
    public typealias ValidateSelf = (_ requirement: String) -> Bool

    public static func peerRequirement(expectedSelfIdentifier: String,
                                       peerIdentifier: String) throws -> String {
        try peerRequirement(expectedSelfIdentifier: expectedSelfIdentifier,
                            peerIdentifier: peerIdentifier,
                            readIdentity: productionIdentity,
                            validateSelf: productionValidateSelf)
    }

    public static func peerRequirement(
        expectedSelfIdentifier: String,
        peerIdentifier: String,
        readIdentity: ReadIdentity,
        validateSelf: ValidateSelf
    ) throws -> String {
        guard let identity = readIdentity(), !identity.teamIdentifier.isEmpty else {
            throw Error.unverifiableSelf
        }
        guard identity.identifier == expectedSelfIdentifier else {
            throw Error.wrongSelfIdentifier
        }
        let selfRequirement = requirement(identifier: expectedSelfIdentifier,
                                          teamIdentifier: identity.teamIdentifier)
        guard validateSelf(selfRequirement) else { throw Error.invalidSelfSignature }
        return requirement(identifier: peerIdentifier,
                           teamIdentifier: identity.teamIdentifier)
    }

    private static func requirement(identifier: String, teamIdentifier: String) -> String {
        "anchor apple generic and identifier \"\(literal(identifier))\" "
            + "and certificate leaf[subject.OU] = \"\(literal(teamIdentifier))\""
    }

    private static func literal(_ value: String) -> String {
        value.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }

    private static func productionIdentity() -> Identity? {
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
        guard let identifier = dictionary[kSecCodeInfoIdentifier] as? String,
              let teamIdentifier = dictionary[kSecCodeInfoTeamIdentifier] as? String else {
            return nil
        }
        return Identity(identifier: identifier, teamIdentifier: teamIdentifier)
    }

    private static func productionValidateSelf(requirementText: String) -> Bool {
        var ownCode: SecCode?
        guard SecCodeCopySelf([], &ownCode) == errSecSuccess,
              let ownCode else { return false }
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(requirementText as CFString, [], &requirement)
                == errSecSuccess,
              let requirement else { return false }
        return SecCodeCheckValidity(ownCode, [], requirement) == errSecSuccess
    }
}
