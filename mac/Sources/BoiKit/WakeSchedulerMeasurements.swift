import Foundation

/// A deliberately evidence-empty record for Track G's later physical wake gate.
///
/// Creating a plan does not claim that a wake occurred, that battery was consumed, or
/// that Messages pulled anything from iCloud. A later manual harness must populate the
/// optional observations from a closed-machine run and attach its artifact paths.
public struct WakeSchedulerMeasurementResult: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1

    public var schemaVersion: Int
    public var localDay: String
    public var timeZoneIdentifier: String
    public var startedAt: Date?
    public var completedAt: Date?
    public var batteryPercentAtStart: Double?
    public var batteryPercentAtEnd: Double?
    public var machineRemainedClosed: Bool?
    public var machineRemainedOnBattery: Bool?
    public var wakes: [WakeObservation]
    public var evidenceArtifactPaths: [String]

    public init(schemaVersion: Int = currentSchemaVersion,
                localDay: String,
                timeZoneIdentifier: String,
                startedAt: Date? = nil,
                completedAt: Date? = nil,
                batteryPercentAtStart: Double? = nil,
                batteryPercentAtEnd: Double? = nil,
                machineRemainedClosed: Bool? = nil,
                machineRemainedOnBattery: Bool? = nil,
                wakes: [WakeObservation],
                evidenceArtifactPaths: [String] = []) {
        self.schemaVersion = schemaVersion
        self.localDay = localDay
        self.timeZoneIdentifier = timeZoneIdentifier
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.batteryPercentAtStart = batteryPercentAtStart
        self.batteryPercentAtEnd = batteryPercentAtEnd
        self.machineRemainedClosed = machineRemainedClosed
        self.machineRemainedOnBattery = machineRemainedOnBattery
        self.wakes = wakes
        self.evidenceArtifactPaths = evidenceArtifactPaths
    }

    /// Remains nil until both real battery readings exist. This is a measurement, not
    /// an estimate: charging can legitimately make the signed value negative.
    public var measuredBatteryDrainPercent: Double? {
        guard let start = batteryPercentAtStart, let end = batteryPercentAtEnd else {
            return nil
        }
        return start - end
    }

    /// The shipping gate's battery number. Merely assigning two percentages is not
    /// enough: the run must be complete, closed, on battery, and have an attached
    /// artifact before this presents a result.
    public var closedMachineDailyBatteryDrainPercent: Double? {
        guard startedAt != nil,
              completedAt != nil,
              machineRemainedClosed == true,
              machineRemainedOnBattery == true,
              !evidenceArtifactPaths.isEmpty else { return nil }
        return measuredBatteryDrainPercent
    }

    /// `nil` means unmeasured. `false` means measured and incomplete. `true` requires
    /// all four planned wakes to carry both an observed wake and a real phone-originated
    /// message observed in `chat.db` after that wake.
    public var messagesICloudPullVerified: Bool? {
        guard completedAt != nil else {
            return nil
        }
        return machineRemainedClosed == true
            && wakes.count == WakeScheduler.localWakeTimes.count
            && wakes.allSatisfy { observation in
                guard !observation.evidenceArtifactPaths.isEmpty,
                      let wake = observation.observedWakeAt,
                      let windowEnd = observation.wakeWindowEndedAt,
                      let sent = observation.phoneMessageSentAt,
                      let observed = observation.messageObservedInChatDatabaseAt else {
                    return false
                }
                return sent <= observed && wake <= observed && observed <= windowEnd
            }
    }

    public struct WakeObservation: Codable, Equatable, Sendable {
        public var plannedWakeAt: Date
        public var observedWakeAt: Date?
        public var wakeWindowEndedAt: Date?
        public var batteryPercentBeforeWake: Double?
        public var batteryPercentAfterWake: Double?
        public var phoneMessageSentAt: Date?
        public var messageObservedInChatDatabaseAt: Date?
        public var evidenceArtifactPaths: [String]

        public init(plannedWakeAt: Date,
                    observedWakeAt: Date? = nil,
                    wakeWindowEndedAt: Date? = nil,
                    batteryPercentBeforeWake: Double? = nil,
                    batteryPercentAfterWake: Double? = nil,
                    phoneMessageSentAt: Date? = nil,
                    messageObservedInChatDatabaseAt: Date? = nil,
                    evidenceArtifactPaths: [String] = []) {
            self.plannedWakeAt = plannedWakeAt
            self.observedWakeAt = observedWakeAt
            self.wakeWindowEndedAt = wakeWindowEndedAt
            self.batteryPercentBeforeWake = batteryPercentBeforeWake
            self.batteryPercentAfterWake = batteryPercentAfterWake
            self.phoneMessageSentAt = phoneMessageSentAt
            self.messageObservedInChatDatabaseAt = messageObservedInChatDatabaseAt
            self.evidenceArtifactPaths = evidenceArtifactPaths
        }

        public var measuredBatteryDrainPercent: Double? {
            guard let before = batteryPercentBeforeWake,
                  let after = batteryPercentAfterWake else { return nil }
            return before - after
        }
    }
}

/// Produces the empty four-wake record that a later, explicitly manual run fills in.
/// It never executes `pmset` and never probes battery or Messages state.
public enum WakeSchedulerMeasurementHarness {
    public static func pendingResult(forLocalDay day: Date,
                                     calendar: Calendar) -> WakeSchedulerMeasurementResult {
        let startOfDay = calendar.startOfDay(for: day)
        let wakes = WakeScheduler.localWakeTimes.compactMap { localTime -> Date? in
            calendar.date(bySettingHour: localTime.hour,
                          minute: localTime.minute,
                          second: 0,
                          of: startOfDay)
        }.map { plannedWake in
            WakeSchedulerMeasurementResult.WakeObservation(plannedWakeAt: plannedWake)
        }

        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"

        return WakeSchedulerMeasurementResult(
            localDay: formatter.string(from: startOfDay),
            timeZoneIdentifier: calendar.timeZone.identifier,
            wakes: wakes
        )
    }
}
