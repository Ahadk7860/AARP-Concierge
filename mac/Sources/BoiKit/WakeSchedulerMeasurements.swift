import Foundation

/// A deliberately evidence-empty record for Track G's later physical wake gate.
///
/// Creating a plan does not claim that a wake occurred, that battery was consumed, or
/// that Messages pulled anything from iCloud. A later manual harness must populate the
/// optional observations from a closed-machine run and attach its artifact paths.
public struct WakeSchedulerMeasurementResult: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 2
    /// An observed wake may lag the RTC alarm while macOS restores hardware and the OS,
    /// but a timestamp farther away is not evidence of that scheduled wake.
    public static let observedWakeTolerance: TimeInterval = 15 * 60

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
              !evidenceArtifactPaths.isEmpty,
              observedScheduledWakesVerified == true,
              wakes.allSatisfy({ $0.measuredBatteryDrainPercent != nil }) else { return nil }
        return measuredBatteryDrainPercent
    }

    /// `nil` means the physical run is still pending. A completed run passes only when
    /// it contains four distinct planned local slots, a corresponding observed wake
    /// within tolerance, a bounded wake window, and a wake artifact for every slot.
    public var observedScheduledWakesVerified: Bool? {
        guard completedAt != nil else { return nil }
        guard let timeZone = TimeZone(identifier: timeZoneIdentifier),
              wakes.count == WakeScheduler.localWakeTimes.count else { return false }

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        calendar.locale = Locale(identifier: "en_US_POSIX")
        let expectedSlots = Set(WakeScheduler.localWakeTimes.map {
            String(format: "%02d:%02d", $0.hour, $0.minute)
        })
        let dayFormatter = DateFormatter()
        dayFormatter.calendar = calendar
        dayFormatter.timeZone = timeZone
        dayFormatter.locale = Locale(identifier: "en_US_POSIX")
        dayFormatter.dateFormat = "yyyy-MM-dd"
        var observedSlots: Set<String> = []

        for observation in wakes {
            let components = calendar.dateComponents([.hour, .minute, .second],
                                                     from: observation.plannedWakeAt)
            guard let hour = components.hour,
                  let minute = components.minute,
                  components.second == 0 else { return false }
            let slot = String(format: "%02d:%02d", hour, minute)
            guard dayFormatter.string(from: observation.plannedWakeAt) == localDay,
                  expectedSlots.contains(slot), observedSlots.insert(slot).inserted,
                  !observation.evidenceArtifactPaths.isEmpty,
                  let observed = observation.observedWakeAt,
                  let windowEnd = observation.wakeWindowEndedAt,
                  observed >= observation.plannedWakeAt,
                  observed.timeIntervalSince(observation.plannedWakeAt)
                    <= Self.observedWakeTolerance,
                  observed <= windowEnd else { return false }
        }
        return observedSlots == expectedSlots
    }

    /// `nil` means unmeasured. `false` means measured and incomplete. `true` requires
    /// all four planned wakes to carry both an observed wake and a real phone-originated
    /// message observed in `chat.db` after that wake.
    public var messagesICloudPullVerified: Bool? {
        guard completedAt != nil else {
            return nil
        }
        guard observedScheduledWakesVerified == true,
              machineRemainedClosed == true else { return false }
        var messageEvidenceIDs: Set<String> = []
        for observation in wakes {
            guard let evidenceID = observation.phoneMessageEvidenceID,
                  !evidenceID.isEmpty,
                  messageEvidenceIDs.insert(evidenceID).inserted,
                  !observation.phoneOriginEvidenceArtifactPaths.isEmpty,
                  !observation.absenceEvidenceArtifactPaths.isEmpty,
                  !observation.arrivalEvidenceArtifactPaths.isEmpty,
                  let wake = observation.observedWakeAt,
                  let windowEnd = observation.wakeWindowEndedAt,
                  let sent = observation.phoneMessageSentAt,
                  let absent = observation.messageAbsentBeforeWakeAt,
                  let observed = observation.messageObservedInChatDatabaseAt else {
                return false
            }
            guard sent <= absent && absent < wake,
                  wake <= observed && observed <= windowEnd else { return false }
        }
        return true
    }

    public struct WakeObservation: Codable, Equatable, Sendable {
        public var plannedWakeAt: Date
        public var observedWakeAt: Date?
        public var wakeWindowEndedAt: Date?
        public var batteryPercentBeforeWake: Double?
        public var batteryPercentAfterWake: Double?
        /// Opaque evidence id or digest only — never a message body or contact handle.
        public var phoneMessageEvidenceID: String?
        public var phoneMessageSentAt: Date?
        public var messageAbsentBeforeWakeAt: Date?
        public var messageObservedInChatDatabaseAt: Date?
        public var evidenceArtifactPaths: [String]
        public var phoneOriginEvidenceArtifactPaths: [String]
        public var absenceEvidenceArtifactPaths: [String]
        public var arrivalEvidenceArtifactPaths: [String]

        public init(plannedWakeAt: Date,
                    observedWakeAt: Date? = nil,
                    wakeWindowEndedAt: Date? = nil,
                    batteryPercentBeforeWake: Double? = nil,
                    batteryPercentAfterWake: Double? = nil,
                    phoneMessageEvidenceID: String? = nil,
                    phoneMessageSentAt: Date? = nil,
                    messageAbsentBeforeWakeAt: Date? = nil,
                    messageObservedInChatDatabaseAt: Date? = nil,
                    evidenceArtifactPaths: [String] = [],
                    phoneOriginEvidenceArtifactPaths: [String] = [],
                    absenceEvidenceArtifactPaths: [String] = [],
                    arrivalEvidenceArtifactPaths: [String] = []) {
            self.plannedWakeAt = plannedWakeAt
            self.observedWakeAt = observedWakeAt
            self.wakeWindowEndedAt = wakeWindowEndedAt
            self.batteryPercentBeforeWake = batteryPercentBeforeWake
            self.batteryPercentAfterWake = batteryPercentAfterWake
            self.phoneMessageEvidenceID = phoneMessageEvidenceID
            self.phoneMessageSentAt = phoneMessageSentAt
            self.messageAbsentBeforeWakeAt = messageAbsentBeforeWakeAt
            self.messageObservedInChatDatabaseAt = messageObservedInChatDatabaseAt
            self.evidenceArtifactPaths = evidenceArtifactPaths
            self.phoneOriginEvidenceArtifactPaths = phoneOriginEvidenceArtifactPaths
            self.absenceEvidenceArtifactPaths = absenceEvidenceArtifactPaths
            self.arrivalEvidenceArtifactPaths = arrivalEvidenceArtifactPaths
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
