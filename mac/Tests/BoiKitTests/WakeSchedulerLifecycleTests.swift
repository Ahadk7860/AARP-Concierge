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

    func testDaemonApprovalAutomaticallyContinuesToVerifiedAgentAndAsyncWake() async {
        var daemon: BackgroundServiceStatus = .notRegistered
        var agent: BackgroundServiceStatus = .notRegistered
        var events: [String] = []
        let wake = Date(timeIntervalSince1970: 1_900_000_000)

        let result = await WakeRegistrationCoordinator.run(
            daemonStatus: { daemon },
            registerDaemon: {
                events.append("register-daemon")
                daemon = .requiresApproval
            },
            agentStatus: { agent },
            registerAgent: {
                events.append("register-agent")
                agent = .enabled
            },
            schedule: {
                events.append("schedule")
                return .scheduled(wake)
            },
            observe: { state in
                if case .requiresApproval = state { events.append("requires-approval") }
            },
            sleep: {
                events.append("observe-approval")
                daemon = .enabled
            }
        )

        XCTAssertEqual(result, .ready(.scheduled(wake)))
        XCTAssertEqual(events, ["register-daemon", "requires-approval", "observe-approval",
                                "register-agent", "schedule"])
    }

    func testRegisterThrowThatEntersApprovalIsObservedWithoutASecondClick() async {
        struct ApprovalRequired: Error {}
        var daemon: BackgroundServiceStatus = .notRegistered
        var agent: BackgroundServiceStatus = .notRegistered
        var events: [String] = []
        let wake = Date(timeIntervalSince1970: 1_900_000_100)

        let result = await WakeRegistrationCoordinator.run(
            daemonStatus: { daemon },
            registerDaemon: {
                events.append("register-denied")
                daemon = .requiresApproval
                throw ApprovalRequired()
            },
            agentStatus: { agent },
            registerAgent: { events.append("register-agent"); agent = .enabled },
            schedule: { events.append("schedule"); return .scheduled(wake) },
            observe: { state in
                if case .requiresApproval = state { events.append("show-settings") }
            },
            sleep: { events.append("approval-observed"); daemon = .enabled }
        )

        XCTAssertEqual(result, .ready(.scheduled(wake)))
        XCTAssertEqual(events, ["register-denied", "show-settings", "approval-observed",
                                "register-agent", "schedule"])
    }

    func testRegisterThrowWithoutApprovalRemainsTerminal() async {
        struct BrokenRegistration: Error, CustomStringConvertible {
            var description: String { "registration genuinely failed" }
        }
        var agentTouched = false
        let result = await WakeRegistrationCoordinator.run(
            daemonStatus: { .notRegistered },
            registerDaemon: { throw BrokenRegistration() },
            agentStatus: { agentTouched = true; return .enabled },
            registerAgent: { agentTouched = true },
            schedule: { agentTouched = true; return .scheduled(Date()) },
            observe: { _ in }, sleep: {}
        )
        XCTAssertEqual(result, .degraded("registration genuinely failed"))
        XCTAssertFalse(agentTouched)
    }

    func testAgentIsNeverReportedRegisteredUntilStatusRechecksEnabled() async {
        var agent: BackgroundServiceStatus = .notRegistered
        var scheduled = false
        let result = await WakeRegistrationCoordinator.run(
            daemonStatus: { .enabled }, registerDaemon: {},
            agentStatus: { agent },
            registerAgent: { agent = .notRegistered },
            schedule: { scheduled = true; return .scheduled(Date()) },
            observe: { _ in }, sleep: {}
        )
        XCTAssertEqual(result, .degraded("background sync agent is not enabled"))
        XCTAssertFalse(scheduled)
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
        let view = try String(
            contentsOf: appRoot.appendingPathComponent("OnboardingView.swift"),
            encoding: .utf8)

        XCTAssertTrue(entry.contains("WakeSchedulerLifecycle.runEligibleSync"))
        XCTAssertFalse(entry.contains("WakeScheduler().scheduleNextWake"),
                       "ordinary app must never use the root-only command scheduler")
        XCTAssertEqual(entry.components(separatedBy: "WakeHelperClient().scheduleNextWake()").count - 1,
                       2, "initial and subsequent wakes must use the authenticated helper")
        XCTAssertTrue(entry.contains("WakeSchedulerLifecycle.runEligibleSyncAsync"))
        XCTAssertTrue(entry.contains(".daemon(plistName: WakeHelperContract.plistName)"))
        XCTAssertTrue(onboarding.contains("ScheduledSync.register(observe:"),
                      "successful onboarding must register the agent and first wake")
        XCTAssertTrue(onboarding.contains("backgroundFreshnessDegradation = result.degradation"),
                      "agent enabled and RTC wake authorized are distinct states")
        XCTAssertTrue(view.contains("wake-freshness-degraded"),
                      "wake degradation must remain visible while the app stays usable")
        XCTAssertTrue(view.contains("wake-helper-open-settings"))
        XCTAssertTrue(onboarding.contains("SMAppService.openSystemSettingsLoginItems()"))
    }
}
