import Foundation
import XCTest
@testable import BoiKit

final class WakeSchedulerMeasurementsTests: XCTestCase {
    func testPendingHarnessCreatesFourEvidenceEmptyLocalWakes() throws {
        let calendar = losAngelesCalendar()
        let day = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026, month: 8, day: 5, hour: 15)))

        let result = WakeSchedulerMeasurementHarness.pendingResult(
            forLocalDay: day, calendar: calendar)

        XCTAssertEqual(result.schemaVersion, 1)
        XCTAssertEqual(result.localDay, "2026-08-05")
        XCTAssertEqual(result.timeZoneIdentifier, "America/Los_Angeles")
        XCTAssertEqual(result.wakes.map {
            calendar.component(.hour, from: $0.plannedWakeAt)
        }, [8, 12, 17, 21])
        XCTAssertTrue(result.wakes.allSatisfy {
            $0.observedWakeAt == nil
                && $0.phoneMessageSentAt == nil
                && $0.messageObservedInChatDatabaseAt == nil
                && $0.wakeWindowEndedAt == nil
                && $0.measuredBatteryDrainPercent == nil
                && $0.evidenceArtifactPaths.isEmpty
        })
        XCTAssertNil(result.startedAt)
        XCTAssertNil(result.completedAt)
        XCTAssertNil(result.measuredBatteryDrainPercent)
        XCTAssertNil(result.closedMachineDailyBatteryDrainPercent)
        XCTAssertNil(result.messagesICloudPullVerified)
        XCTAssertNil(result.machineRemainedClosed)
        XCTAssertNil(result.machineRemainedOnBattery)
        XCTAssertTrue(result.evidenceArtifactPaths.isEmpty)
    }

    func testCompletedRealFieldsProduceMeasuredValuesWithoutEstimates() throws {
        let calendar = losAngelesCalendar()
        let day = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026, month: 8, day: 5)))
        var result = WakeSchedulerMeasurementHarness.pendingResult(
            forLocalDay: day, calendar: calendar)
        result.startedAt = day
        result.completedAt = day.addingTimeInterval(24 * 60 * 60)
        result.batteryPercentAtStart = 83
        result.batteryPercentAtEnd = 79.5
        result.machineRemainedClosed = true
        result.machineRemainedOnBattery = true
        result.evidenceArtifactPaths = ["test-fixture/daily-battery.log"]
        result.wakes = result.wakes.map { observation in
            var measured = observation
            measured.observedWakeAt = observation.plannedWakeAt.addingTimeInterval(10)
            measured.wakeWindowEndedAt = observation.plannedWakeAt.addingTimeInterval(5 * 60)
            measured.batteryPercentBeforeWake = 83
            measured.batteryPercentAfterWake = 82.75
            measured.phoneMessageSentAt = observation.plannedWakeAt.addingTimeInterval(-60)
            measured.messageObservedInChatDatabaseAt = observation.plannedWakeAt
                .addingTimeInterval(90)
            measured.evidenceArtifactPaths = ["test-fixture/wake.log"]
            return measured
        }

        XCTAssertEqual(result.measuredBatteryDrainPercent, 3.5)
        XCTAssertEqual(result.closedMachineDailyBatteryDrainPercent, 3.5)
        XCTAssertTrue(result.wakes.allSatisfy { $0.measuredBatteryDrainPercent == 0.25 })
        XCTAssertEqual(result.messagesICloudPullVerified, true)
    }

    func testCompletedButIncompleteEvidenceFailsThePullGate() throws {
        let calendar = losAngelesCalendar()
        let day = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026, month: 8, day: 5)))
        var result = WakeSchedulerMeasurementHarness.pendingResult(
            forLocalDay: day, calendar: calendar)
        result.completedAt = day.addingTimeInterval(24 * 60 * 60)
        result.wakes[0].observedWakeAt = result.wakes[0].plannedWakeAt

        XCTAssertEqual(result.messagesICloudPullVerified, false)
    }

    func testTimestampsWithoutArtifactsCannotClaimThePhysicalGatePassed() throws {
        let calendar = losAngelesCalendar()
        let day = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026, month: 8, day: 5)))
        var result = WakeSchedulerMeasurementHarness.pendingResult(
            forLocalDay: day, calendar: calendar)
        result.startedAt = day
        result.completedAt = day.addingTimeInterval(24 * 60 * 60)
        result.machineRemainedClosed = true
        result.machineRemainedOnBattery = true
        result.batteryPercentAtStart = 80
        result.batteryPercentAtEnd = 79
        result.wakes = result.wakes.map { observation in
            var claimed = observation
            claimed.observedWakeAt = observation.plannedWakeAt
            claimed.wakeWindowEndedAt = observation.plannedWakeAt.addingTimeInterval(5 * 60)
            claimed.phoneMessageSentAt = observation.plannedWakeAt.addingTimeInterval(-60)
            claimed.messageObservedInChatDatabaseAt = observation.plannedWakeAt
                .addingTimeInterval(30)
            return claimed
        }

        XCTAssertEqual(result.measuredBatteryDrainPercent, 1)
        XCTAssertNil(result.closedMachineDailyBatteryDrainPercent)
        XCTAssertEqual(result.messagesICloudPullVerified, false)
    }

    private func losAngelesCalendar() -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "en_US_POSIX")
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        return calendar
    }
}
