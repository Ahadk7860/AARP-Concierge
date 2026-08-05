import BoiKit
import Darwin
import Foundation

/// Executes only the two commands WakeScheduler can synthesize. There is no shell and
/// no request-derived executable or argument vector.
private enum PMSetRunner {
    static let timeout: TimeInterval = 5

    static func run(_ command: WakeScheduler.Command, plannedAfter: Date,
                    calendar: Calendar) throws -> WakeScheduler.CommandResult {
        guard command.executable == WakeScheduler.pmsetPath,
              WakeHelperCommandPolicy.allows(executable: command.executable,
                                             arguments: command.arguments,
                                             now: plannedAfter,
                                             calendar: calendar) else {
            throw WakeScheduler.Error.helperRejected(detail: "command outside closed wake surface")
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
        guard terminated.wait(timeout: .now() + timeout) == .success else {
            process.terminate()
            if terminated.wait(timeout: .now() + 1) != .success && process.isRunning {
                kill(process.processIdentifier, SIGKILL)
                _ = terminated.wait(timeout: .now() + 1)
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

}

private final class WakeHelperService: NSObject, WakeHelperXPCProtocol {
    private let transactions: WakeHelperTransactionQueue

    init(transactions: WakeHelperTransactionQueue) {
        self.transactions = transactions
    }

    func reschedule(reply: @escaping (Int, Date?, String?) -> Void) {
        transactions.perform {
            let response: WakeHelperResponse
            do {
                let now = Date()
                let calendar = Calendar.current
                let scheduler = WakeScheduler(calendar: calendar, runCommand: { command in
                    try PMSetRunner.run(command, plannedAfter: now, calendar: calendar)
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
