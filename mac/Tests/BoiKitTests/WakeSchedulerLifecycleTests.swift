import Foundation
import XCTest
@testable import BoiKit

final class WakeSchedulerLifecycleTests: XCTestCase {
    private final class Spy {
        struct LogEntry {
            let event: String
            let level: StructuredLog.Level
            let fields: [String: String]
        }

        var syncCalls = 0
        var scheduleCalls = 0
        var events: [String] = []
        var logs: [LogEntry] = []

        func log(_ event: String, _ level: StructuredLog.Level,
                 _ fields: [String: String]) {
            logs.append(.init(event: event, level: level, fields: fields))
        }
    }

    func testEligibleHeadlessLifecycleReschedulesExactlyOnceAfterSyncAttempt() {
        let spy = Spy()
        let now = Date(timeIntervalSince1970: 1_786_000_000)
        let wake = now.addingTimeInterval(4 * 60 * 60)

        let result = WakeSchedulerLifecycle.runEligibleSync(sync: {
            spy.syncCalls += 1
            spy.events.append("sync")
            return .completed
        }, schedule: { scheduledAfter in
            spy.scheduleCalls += 1
            spy.events.append("schedule")
            XCTAssertEqual(scheduledAfter, now)
            return .scheduled(wake)
        }, clock: { now }, log: spy.log)

        XCTAssertEqual(spy.syncCalls, 1)
        XCTAssertEqual(spy.scheduleCalls, 1)
        XCTAssertEqual(spy.events, ["sync", "schedule"])
        XCTAssertEqual(result.sync, .completed)
        XCTAssertEqual(result.wake, .scheduled(wake))
        XCTAssertTrue(result.freshnessAdvanced)
        XCTAssertEqual(result.exitCode, 0)
    }

    func testFailedSyncStillQueuesTheNextWakeButNeverClaimsFreshness() {
        let spy = Spy()
        let now = Date(timeIntervalSince1970: 1_786_000_000)
        let wake = now.addingTimeInterval(4 * 60 * 60)

        let result = WakeSchedulerLifecycle.runEligibleSync(sync: {
            spy.syncCalls += 1
            return .failed(detail: "chat.db denied")
        }, schedule: { _ in
            spy.scheduleCalls += 1
            return .scheduled(wake)
        }, clock: { now }, log: spy.log)

        XCTAssertEqual(spy.syncCalls, 1)
        XCTAssertEqual(spy.scheduleCalls, 1)
        XCTAssertFalse(result.freshnessAdvanced)
        XCTAssertEqual(result.exitCode, 1)
        XCTAssertEqual(result.sync, .failed(detail: "chat.db denied"))
        XCTAssertEqual(result.wake, .scheduled(wake))
    }

    func testIdempotentlySkippedSyncStillReschedulesWithoutClaimingFreshness() {
        let spy = Spy()
        let wake = Date(timeIntervalSince1970: 1_786_014_400)

        let result = WakeSchedulerLifecycle.runEligibleSync(sync: {
            .skipped(reason: "inside six-hour window")
        }, schedule: { _ in
            spy.scheduleCalls += 1
            return .alreadyScheduled(wake)
        }, log: spy.log)

        XCTAssertEqual(spy.scheduleCalls, 1)
        XCTAssertEqual(result.sync, .skipped(reason: "inside six-hour window"))
        XCTAssertFalse(result.freshnessAdvanced)
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(result.wake, .alreadyScheduled(wake))
    }

    func testWakeFailureIsVisibleWhileSuccessfulAppWorkRemainsUsable() throws {
        struct PermissionFailure: Error, CustomStringConvertible {
            var description: String { "pmset permission denied" }
        }
        let spy = Spy()

        let result = WakeSchedulerLifecycle.runEligibleSync(sync: {
            .completed
        }, schedule: { _ in
            spy.scheduleCalls += 1
            throw PermissionFailure()
        }, log: spy.log)

        XCTAssertEqual(spy.scheduleCalls, 1)
        XCTAssertEqual(result.exitCode, 0,
                       "wake degradation must not make a completed sync unusable")
        XCTAssertTrue(result.freshnessAdvanced)
        XCTAssertEqual(result.wake, .failed(detail: "pmset permission denied"))
        let failure = try XCTUnwrap(spy.logs.last)
        XCTAssertEqual(failure.event, "wake.lifecycle_degraded")
        XCTAssertEqual(failure.level, .error)
        XCTAssertEqual(failure.fields["reason"], "headless_sync")
        XCTAssertEqual(failure.fields["freshness_advanced"], "true")
        XCTAssertEqual(failure.fields["detail"], "pmset permission denied")
    }

    func testInitialRegistrationSchedulesOneWakeThroughTheSameInjectedSeam() {
        let spy = Spy()
        let now = Date(timeIntervalSince1970: 1_786_000_000)
        let wake = now.addingTimeInterval(4 * 60 * 60)

        let result = WakeSchedulerLifecycle.scheduleInitialWake(schedule: { date in
            spy.scheduleCalls += 1
            XCTAssertEqual(date, now)
            return .alreadyScheduled(wake)
        }, clock: { now }, log: spy.log)

        XCTAssertEqual(spy.scheduleCalls, 1)
        XCTAssertEqual(result, .alreadyScheduled(wake))
        XCTAssertEqual(spy.logs.last?.fields["reason"], "initial_registration")
    }

    func testBoiAppSourceWiresOnlyProductionBoundariesToTheLifecycle() throws {
        let appRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/BoiApp")
        let entry = try String(contentsOf: appRoot.appendingPathComponent("BoiApp.swift"),
                               encoding: .utf8)
        let onboarding = try String(
            contentsOf: appRoot.appendingPathComponent("PermissionModel.swift"),
            encoding: .utf8)

        XCTAssertTrue(entry.contains("WakeSchedulerLifecycle.runEligibleSync"))
        XCTAssertTrue(entry.contains("WakeScheduler().scheduleNextWake"))
        XCTAssertTrue(entry.contains("WakeSchedulerLifecycle.scheduleInitialWake"))
        XCTAssertTrue(onboarding.contains("ScheduledSync.register()"),
                      "successful onboarding must register the agent and first wake")
    }
}
