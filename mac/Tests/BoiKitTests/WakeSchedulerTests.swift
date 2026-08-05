import Foundation
import XCTest
@testable import BoiKit

final class WakeSchedulerTests: XCTestCase {
    private final class CommandSpy: @unchecked Sendable {
        var commands: [WakeScheduler.Command] = []
        var scheduledListing = "Scheduled power events:\n"
        var nextScheduleResult = WakeScheduler.CommandResult(exitCode: 0)

        func run(_ command: WakeScheduler.Command) throws -> WakeScheduler.CommandResult {
            commands.append(command)
            if command.arguments == ["-g", "sched"] {
                return .init(exitCode: 0, standardOutput: scheduledListing)
            }
            let result = nextScheduleResult
            if result.exitCode == 0, command.arguments.count == 3 {
                scheduledListing += " [0] wake at \(command.arguments[2]) by 'app.boi.mac'\n"
            }
            return result
        }
    }

    private final class LogSpy: @unchecked Sendable {
        struct Entry {
            let event: String
            let level: StructuredLog.Level
            let fields: [String: String]
        }

        var entries: [Entry] = []

        func record(_ event: String, _ level: StructuredLog.Level,
                    _ fields: [String: String]) {
            entries.append(.init(event: event, level: level, fields: fields))
        }
    }

    func testTheFourWakeTimesAreFixedLocalWallClockTimes() {
        XCTAssertEqual(WakeScheduler.localWakeTimes, [
            .init(hour: 8),
            .init(hour: 12),
            .init(hour: 17),
            .init(hour: 21),
        ])
    }

    func testNextWakeMovesThroughTodayAndThenToTomorrow() throws {
        let calendar = newYorkCalendar()
        let scheduler = WakeScheduler(calendar: calendar, runCommand: { _ in
            XCTFail("planning must not execute pmset")
            return .init(exitCode: 0)
        })

        XCTAssertEqual(components(try XCTUnwrap(scheduler.nextWake(
            after: date(2026, 8, 5, 7, 59, calendar: calendar))), calendar: calendar),
                       [2026, 8, 5, 8, 0])
        XCTAssertEqual(components(try XCTUnwrap(scheduler.nextWake(
            after: date(2026, 8, 5, 8, 0, calendar: calendar))), calendar: calendar),
                       [2026, 8, 5, 12, 0])
        XCTAssertEqual(components(try XCTUnwrap(scheduler.nextWake(
            after: date(2026, 8, 5, 20, 59, calendar: calendar))), calendar: calendar),
                       [2026, 8, 5, 21, 0])
        XCTAssertEqual(components(try XCTUnwrap(scheduler.nextWake(
            after: date(2026, 8, 5, 21, 0, calendar: calendar))), calendar: calendar),
                       [2026, 8, 6, 8, 0])
    }

    func testNextWakeKeepsEightLocalAcrossSpringDSTBoundary() throws {
        let calendar = newYorkCalendar()
        let before = date(2026, 3, 7, 21, 0, calendar: calendar)
        let wake = try XCTUnwrap(WakeScheduler.nextWake(after: before, calendar: calendar))

        XCTAssertEqual(components(wake, calendar: calendar), [2026, 3, 8, 8, 0])
        XCTAssertEqual(wake.timeIntervalSince(before), 10 * 60 * 60,
                       "spring-forward night has ten elapsed hours from 21:00 to 08:00")
    }

    func testNextWakeKeepsEightLocalAcrossFallDSTBoundary() throws {
        let calendar = newYorkCalendar()
        let before = date(2026, 10, 31, 21, 0, calendar: calendar)
        let wake = try XCTUnwrap(WakeScheduler.nextWake(after: before, calendar: calendar))

        XCTAssertEqual(components(wake, calendar: calendar), [2026, 11, 1, 8, 0])
        XCTAssertEqual(wake.timeIntervalSince(before), 12 * 60 * 60,
                       "fall-back night has twelve elapsed hours from 21:00 to 08:00")
    }

    func testSchedulingUsesOnlyTheClosedPMSetWakeCommandSurface() throws {
        let calendar = newYorkCalendar()
        let commands = CommandSpy()
        let scheduler = WakeScheduler(calendar: calendar,
                                      runCommand: commands.run)

        let outcome = try scheduler.scheduleNextWake(
            after: date(2026, 8, 5, 9, 0, calendar: calendar))

        XCTAssertEqual(outcome, .scheduled(date(2026, 8, 5, 12, 0, calendar: calendar)))
        XCTAssertEqual(commands.commands.map(\.executable), [
            "/usr/bin/pmset", "/usr/bin/pmset",
        ])
        XCTAssertEqual(commands.commands.map(\.arguments), [
            ["-g", "sched"],
            ["schedule", "wake", "08/05/26 12:00:00"],
        ])
    }

    func testOrdinaryAppFailsClosedWhenAuthorizedHelperIsUnavailable() throws {
        let calendar = newYorkCalendar()
        let logs = LogSpy()
        let scheduler = WakeScheduler(calendar: calendar, log: logs.record)

        XCTAssertThrowsError(try scheduler.scheduleNextWake(
            after: date(2026, 8, 5, 9, 0, calendar: calendar))) { error in
            XCTAssertEqual(error as? WakeScheduler.Error, .authorizedHelperUnavailable)
        }
        let failure = try XCTUnwrap(logs.entries.last)
        XCTAssertEqual(failure.event, "wake.authorization_unavailable")
        XCTAssertEqual(failure.level, .error)
        XCTAssertTrue(failure.fields["detail"]?.contains("not installed") == true)
    }

    func testProductionSourceHasNoAlwaysOnOrPrivilegeEscalationEscapeHatch() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/BoiKit/WakeScheduler.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let forbidden = [
            "disable" + "sleep",
            "/usr/bin/" + "sudo",
            "arguments: [\"" + "repeat" + "\"",
            "Process" + "()",
        ]

        for token in forbidden {
            XCTAssertFalse(source.contains(token),
                           "WakeScheduler gained a persistent/root-global command: \(token)")
        }
        XCTAssertEqual(source.components(separatedBy: "fileprivate static").count - 1, 2,
                       "only list-scheduled-events and schedule-one-wake may build commands")
    }

    func testSchedulingTheSameWakeTwiceIsIdempotent() throws {
        let calendar = newYorkCalendar()
        let commands = CommandSpy()
        let scheduler = WakeScheduler(calendar: calendar,
                                      runCommand: commands.run)
        let now = date(2026, 8, 5, 9, 0, calendar: calendar)

        XCTAssertEqual(try scheduler.scheduleNextWake(after: now),
                       .scheduled(date(2026, 8, 5, 12, 0, calendar: calendar)))
        XCTAssertEqual(try scheduler.scheduleNextWake(after: now),
                       .alreadyScheduled(date(2026, 8, 5, 12, 0, calendar: calendar)))
        XCTAssertEqual(commands.commands.filter { $0.arguments.first == "schedule" }.count, 1)
    }

    func testFourDigitYearInPMSetListingIsAlsoRecognizedAsTheSameWake() throws {
        let calendar = newYorkCalendar()
        let commands = CommandSpy()
        commands.scheduledListing = """
            Scheduled power events:
             [0] wake at 08/05/2026 12:00:00 by 'app.boi.mac'
            """
        let scheduler = WakeScheduler(calendar: calendar, runCommand: commands.run)
        let wake = date(2026, 8, 5, 12, 0, calendar: calendar)

        XCTAssertEqual(try scheduler.scheduleNextWake(
            after: date(2026, 8, 5, 9, 0, calendar: calendar)),
                       .alreadyScheduled(wake))
        XCTAssertEqual(commands.commands.map(\.arguments), [["-g", "sched"]])
    }

    func testACommandFailureIsReturnedAndLoggedAsAnErrorWithStderr() throws {
        let calendar = newYorkCalendar()
        let commands = CommandSpy()
        commands.nextScheduleResult = .init(exitCode: 77,
                                            standardError: "permission denied")
        let logs = LogSpy()
        let scheduler = WakeScheduler(calendar: calendar,
                                      runCommand: commands.run,
                                      log: logs.record)

        XCTAssertThrowsError(try scheduler.scheduleNextWake(
            after: date(2026, 8, 5, 9, 0, calendar: calendar))) { error in
            XCTAssertEqual(error as? WakeScheduler.Error,
                           .commandFailed(operation: "schedule", exitCode: 77,
                                          detail: "permission denied"))
        }
        let failure = try XCTUnwrap(logs.entries.last)
        XCTAssertEqual(failure.event, "wake.command_failed")
        XCTAssertEqual(failure.level, .error)
        XCTAssertEqual(failure.fields["operation"], "schedule")
        XCTAssertEqual(failure.fields["exit_code"], "77")
        XCTAssertEqual(failure.fields["detail"], "permission denied")
    }

    func testAListingFailureDoesNotRiskAppendingADuplicateWake() {
        let calendar = newYorkCalendar()
        let commands = CommandSpy()
        let logs = LogSpy()
        let scheduler = WakeScheduler(calendar: calendar, runCommand: { command in
            commands.commands.append(command)
            return .init(exitCode: 1, standardError: "cannot read schedule")
        }, log: logs.record)

        XCTAssertThrowsError(try scheduler.scheduleNextWake(
            after: date(2026, 8, 5, 9, 0, calendar: calendar)))
        XCTAssertEqual(commands.commands.map(\.arguments), [["-g", "sched"]])
        XCTAssertEqual(logs.entries.last?.level, .error)
    }

    private func newYorkCalendar() -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "en_US_POSIX")
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        return calendar
    }

    private func date(_ year: Int, _ month: Int, _ day: Int,
                      _ hour: Int, _ minute: Int, calendar: Calendar) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day,
                                           hour: hour, minute: minute, second: 0))!
    }

    private func components(_ date: Date, calendar: Calendar) -> [Int] {
        let value = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return [value.year!, value.month!, value.day!, value.hour!, value.minute!]
    }
}
