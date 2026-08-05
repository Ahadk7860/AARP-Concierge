import Foundation

/// Plans and installs one RTC wake at a time.
///
/// The command surface is deliberately closed: this type can list scheduled events and
/// can install a single `wake` event. It has no API for arbitrary `pmset` arguments,
/// persistent power settings, a shell, or privilege escalation.
public struct WakeScheduler {

    public static let pmsetPath = "/usr/bin/pmset"

    /// The four product-defined local wake times. They are values in the supplied
    /// calendar's time zone, not UTC offsets, so they stay at local wall-clock time
    /// across daylight-saving transitions.
    public static let localWakeTimes: [LocalWakeTime] = [
        .init(hour: 8),
        .init(hour: 12),
        .init(hour: 17),
        .init(hour: 21),
    ]

    public struct LocalWakeTime: Equatable, Sendable {
        public let hour: Int
        public let minute: Int

        public init(hour: Int, minute: Int = 0) {
            precondition((0...23).contains(hour), "hour must be in 0...23")
            precondition((0...59).contains(minute), "minute must be in 0...59")
            self.hour = hour
            self.minute = minute
        }
    }

    public struct Command: Equatable, Sendable {
        public let executable: String
        public let arguments: [String]

        fileprivate static let scheduledEvents = Command(
            executable: WakeScheduler.pmsetPath,
            arguments: ["-g", "sched"]
        )

        fileprivate static func scheduleWake(at formattedDate: String) -> Command {
            Command(executable: WakeScheduler.pmsetPath,
                    arguments: ["schedule", "wake", formattedDate])
        }
    }

    public struct CommandResult: Equatable, Sendable {
        public var exitCode: Int32
        public var standardOutput: String
        public var standardError: String

        public init(exitCode: Int32, standardOutput: String = "",
                    standardError: String = "") {
            self.exitCode = exitCode
            self.standardOutput = standardOutput
            self.standardError = standardError
        }
    }

    public enum Outcome: Equatable, Sendable {
        case scheduled(Date)
        case alreadyScheduled(Date)
    }

    public enum Error: Swift.Error, Equatable, LocalizedError, Sendable {
        case noFutureWake
        case commandFailed(operation: String, exitCode: Int32, detail: String)

        public var errorDescription: String? {
            switch self {
            case .noFutureWake:
                return "could not find the next scheduled wake"
            case let .commandFailed(operation, exitCode, detail):
                return "pmset \(operation) failed with exit \(exitCode): \(detail)"
            }
        }
    }

    public typealias RunCommand = (Command) throws -> CommandResult
    public typealias Log = (String, StructuredLog.Level, [String: String]) -> Void

    private let calendar: Calendar
    private let runCommand: RunCommand
    private let log: Log

    /// Production initializer. Constructing a scheduler is inert; a process is launched
    /// only when `scheduleNextWake` is called.
    public init(calendar: Calendar = .current) {
        self.calendar = calendar
        self.runCommand = { command in try Self.run(command) }
        self.log = { event, level, fields in
            StructuredLog.emit(event, level: level, fields: fields)
        }
    }

    /// Injection initializer used by tests and future dry-run tooling.
    public init(calendar: Calendar = .current,
                runCommand: @escaping RunCommand,
                log: Log? = nil) {
        self.calendar = calendar
        self.runCommand = runCommand
        self.log = log ?? { event, level, fields in
            StructuredLog.emit(event, level: level, fields: fields)
        }
    }

    /// Returns the first product wake strictly after `date`.
    ///
    /// `Calendar.nextDate` performs calendar-day arithmetic in the calendar's time zone;
    /// adding fixed seconds would move the wall-clock wake by an hour at DST boundaries.
    public func nextWake(after date: Date) -> Date? {
        Self.nextWake(after: date, calendar: calendar)
    }

    public static func nextWake(after date: Date, calendar: Calendar) -> Date? {
        localWakeTimes.compactMap { wakeTime in
            calendar.nextDate(
                after: date,
                matching: DateComponents(hour: wakeTime.hour,
                                         minute: wakeTime.minute,
                                         second: 0),
                matchingPolicy: .nextTime,
                repeatedTimePolicy: .first,
                direction: .forward
            )
        }.min()
    }

    /// Installs the next wake unless `pmset` already reports that exact event.
    ///
    /// Listing is part of the write: if the scheduler cannot establish current state it
    /// refuses to append a possibly duplicate event. Tests inject `runCommand`; only a
    /// shipping call site uses the default process runner.
    @discardableResult
    public func scheduleNextWake(after date: Date = Date()) throws -> Outcome {
        guard let wake = nextWake(after: date) else {
            log("wake.plan_failed", .error, ["reason": "no_future_wake"])
            throw Error.noFutureWake
        }

        let formattedWake = Self.pmsetDate(wake, calendar: calendar)
        let listing = try execute(.scheduledEvents, operation: "list")
        if Self.containsWake(at: wake, in: listing.standardOutput, calendar: calendar) {
            log("wake.already_scheduled", .info, [
                "wake_at": StructuredLog.timestamp(wake),
                "local_wake_at": formattedWake,
            ])
            return .alreadyScheduled(wake)
        }

        _ = try execute(.scheduleWake(at: formattedWake), operation: "schedule")
        log("wake.scheduled", .info, [
            "wake_at": StructuredLog.timestamp(wake),
            "local_wake_at": formattedWake,
        ])
        return .scheduled(wake)
    }

    private func execute(_ command: Command, operation: String) throws -> CommandResult {
        let result: CommandResult
        do {
            result = try runCommand(command)
        } catch {
            let detail = String(describing: error)
            log("wake.command_failed", .error, [
                "operation": operation,
                "detail": detail,
            ])
            throw Error.commandFailed(operation: operation, exitCode: -1, detail: detail)
        }

        guard result.exitCode == 0 else {
            let detail = Self.visibleFailureDetail(result)
            log("wake.command_failed", .error, [
                "operation": operation,
                "exit_code": String(result.exitCode),
                "detail": detail,
            ])
            throw Error.commandFailed(operation: operation,
                                      exitCode: result.exitCode,
                                      detail: detail)
        }
        return result
    }

    static func containsWake(at wake: Date, in listing: String, calendar: Calendar) -> Bool {
        // `schedule` accepts a two-digit year, while macOS versions differ in whether
        // `-g sched` prints that year with two or four digits.
        let renderedDates = ["MM/dd/yy HH:mm:ss", "MM/dd/yyyy HH:mm:ss"].map { format in
            pmsetDate(wake, calendar: calendar, format: format).lowercased()
        }
        return listing.split(whereSeparator: \.isNewline).contains { rawLine in
            let line = rawLine.lowercased()
            return line.contains("wake") && renderedDates.contains { line.contains($0) }
        }
    }

    static func pmsetDate(_ date: Date, calendar: Calendar) -> String {
        pmsetDate(date, calendar: calendar, format: "MM/dd/yy HH:mm:ss")
    }

    private static func pmsetDate(_ date: Date, calendar: Calendar,
                                  format: String) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = format
        return formatter.string(from: date)
    }

    private static func visibleFailureDetail(_ result: CommandResult) -> String {
        let stderr = result.standardError.trimmingCharacters(in: .whitespacesAndNewlines)
        if !stderr.isEmpty { return stderr }
        let stdout = result.standardOutput.trimmingCharacters(in: .whitespacesAndNewlines)
        if !stdout.isEmpty { return stdout }
        return "no command output"
    }

    private static func run(_ command: Command) throws -> CommandResult {
        let process = Process()
        let standardOutput = Pipe()
        let standardError = Pipe()
        process.executableURL = URL(fileURLWithPath: command.executable)
        process.arguments = command.arguments
        process.standardOutput = standardOutput
        process.standardError = standardError

        try process.run()
        process.waitUntilExit()

        let outputData = standardOutput.fileHandleForReading.readDataToEndOfFile()
        let errorData = standardError.fileHandleForReading.readDataToEndOfFile()
        return CommandResult(
            exitCode: process.terminationStatus,
            standardOutput: String(decoding: outputData, as: UTF8.self),
            standardError: String(decoding: errorData, as: UTF8.self)
        )
    }
}
