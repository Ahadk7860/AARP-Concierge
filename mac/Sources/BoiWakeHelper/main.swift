import BoiKit
import Darwin
import Foundation

/// Executes only the two commands WakeScheduler can synthesize. There is no shell and
/// no request-derived executable or argument vector.
private enum PMSetRunner {
    static func run(_ command: WakeScheduler.Command, plannedAfter: Date,
                    calendar: Calendar,
                    deadline: WakeHelperTransactionDeadline) throws
        -> WakeScheduler.CommandResult {
        guard command.executable == WakeScheduler.pmsetPath,
              WakeHelperCommandPolicy.allows(executable: command.executable,
                                             arguments: command.arguments,
                                             now: plannedAfter,
                                             calendar: calendar) else {
            throw WakeScheduler.Error.helperRejected(detail: "command outside closed wake surface")
        }
        guard let commandWait = deadline.commandWaitInterval(
            atNanoseconds: DispatchTime.now().uptimeNanoseconds) else {
            throw WakeScheduler.Error.helperRejected(detail: "wake transaction deadline expired")
        }

        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: WakeScheduler.pmsetPath)
        process.arguments = command.arguments
        process.standardOutput = output
        process.standardError = errors
        let terminated = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in terminated.signal() }
        try process.run()
        guard terminated.wait(timeout: .now() + commandWait) == .success else {
            process.terminate()
            let remaining = deadline.cleanupWaitInterval(
                atNanoseconds: DispatchTime.now().uptimeNanoseconds)
            if terminated.wait(timeout: .now() + half(remaining)) != .success
                && process.isRunning {
                kill(process.processIdentifier, SIGKILL)
                _ = terminated.wait(timeout: .now() + deadline.cleanupWaitInterval(
                    atNanoseconds: DispatchTime.now().uptimeNanoseconds))
            }
            throw WakeScheduler.Error.helperRejected(detail: "pmset command timed out")
        }
        return WakeScheduler.CommandResult(
            exitCode: process.terminationStatus,
            standardOutput: String(decoding: output.fileHandleForReading.readDataToEndOfFile(),
                                   as: UTF8.self),
            standardError: String(decoding: errors.fileHandleForReading.readDataToEndOfFile(),
                                  as: UTF8.self)
        )
    }

    private static func half(_ interval: DispatchTimeInterval) -> DispatchTimeInterval {
        switch interval {
        case .nanoseconds(let value): return .nanoseconds(max(0, value / 2))
        case .microseconds(let value): return .microseconds(max(0, value / 2))
        case .milliseconds(let value): return .milliseconds(max(0, value / 2))
        case .seconds(let value): return .milliseconds(max(0, value * 500))
        case .never: return .milliseconds(500)
        @unknown default: return .nanoseconds(0)
        }
    }

}

private final class WakeHelperService: NSObject, WakeHelperXPCProtocol {
    private let transactions: WakeHelperTransactionQueue

    init(transactions: WakeHelperTransactionQueue) {
        self.transactions = transactions
    }

    func reschedule(reply: @escaping (Int, Date?, String?) -> Void) {
        // Receipt time, not queue-entry time: a request waiting behind another client
        // cannot begin pmset work after its own deadline (or after the app timed out).
        let deadline = WakeHelperTransactionDeadline(
            startedAtNanoseconds: DispatchTime.now().uptimeNanoseconds)
        transactions.perform {
            let response: WakeHelperResponse
            do {
                let now = Date()
                let calendar = Calendar.current
                let scheduler = WakeScheduler(calendar: calendar, runCommand: { command in
                    try PMSetRunner.run(command, plannedAfter: now, calendar: calendar,
                                        deadline: deadline)
                })
                switch try scheduler.scheduleNextWake(after: now) {
                case .scheduled(let date): response = .scheduled(date)
                case .alreadyScheduled(let date): response = .alreadyScheduled(date)
                }
            } catch {
                response = .degraded(error.localizedDescription)
            }
            let wire = response.wireValue
            reply(wire.code, wire.date, wire.detail)
        }
    }
}

private final class WakeHelperListenerDelegate: NSObject, NSXPCListenerDelegate {
    private let service: WakeHelperService

    init(service: WakeHelperService) {
        self.service = service
    }

    func listener(_ listener: NSXPCListener,
                  shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        connection.exportedInterface = NSXPCInterface(with: WakeHelperXPCProtocol.self)
        connection.exportedObject = service
        connection.activate()
        return true
    }
}

private let appRequirement: String = {
    do {
        return try WakeHelperSigningRequirement.peerRequirement(
            expectedSelfIdentifier: WakeHelperContract.helperIdentifier,
            peerIdentifier: WakeHelperContract.authorizedAppIdentifier)
    } catch {
        StructuredLog.emit("wake.helper_identity_invalid", level: .error,
                           fields: ["detail": error.localizedDescription])
        exit(EX_CONFIG)
    }
}()
private let transactions = WakeHelperTransactionQueue()
private let service = WakeHelperService(transactions: transactions)
private let listener = NSXPCListener(machServiceName: WakeHelperContract.serviceName)
private let delegate = WakeHelperListenerDelegate(service: service)
listener.setConnectionCodeSigningRequirement(appRequirement)
listener.delegate = delegate
listener.activate()
RunLoop.current.run()
