import BoiKit
import Foundation

/// Executes only the two commands WakeScheduler can synthesize. There is no shell and
/// no request-derived executable or argument vector.
private enum PMSetRunner {
    static func run(_ command: WakeScheduler.Command) throws -> WakeScheduler.CommandResult {
        guard command.executable == WakeScheduler.pmsetPath,
              WakeHelperCommandPolicy.allows(executable: command.executable,
                                             arguments: command.arguments) else {
            throw WakeScheduler.Error.helperRejected(detail: "command outside closed wake surface")
        }

        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: WakeScheduler.pmsetPath)
        process.arguments = command.arguments
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
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
    func reschedule(reply: @escaping (Int, Date?, String?) -> Void) {
        let response: WakeHelperResponse
        do {
            let scheduler = WakeScheduler(runCommand: PMSetRunner.run)
            switch try scheduler.scheduleNextWake(after: Date()) {
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

private final class WakeHelperListenerDelegate: NSObject, NSXPCListenerDelegate {
    private let authorization: WakeHelperCallerAuthorization
    private let service: WakeHelperService

    init(authorization: WakeHelperCallerAuthorization = .init(),
         service: WakeHelperService = .init()) {
        self.authorization = authorization
        self.service = service
    }

    func listener(_ listener: NSXPCListener,
                  shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard authorization.allows(pid: connection.processIdentifier) else { return false }
        connection.exportedInterface = NSXPCInterface(with: WakeHelperXPCProtocol.self)
        connection.exportedObject = service
        connection.resume()
        return true
    }
}

private let listener = NSXPCListener(machServiceName: WakeHelperContract.serviceName)
private let delegate = WakeHelperListenerDelegate()
listener.delegate = delegate
listener.resume()
RunLoop.current.run()
