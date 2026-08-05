import Foundation

/// Joins an app lifecycle event to the one-shot wake scheduler without joining the
/// scheduler to `SyncRun` itself.
///
/// The sync attempt and command runner are closures so the lifecycle can be proven
/// without Messages, `pmset`, `launchd`, or an app process. Production BoiApp supplies
/// the real closures at its boundary.
public enum WakeSchedulerLifecycle {
    public enum SyncDisposition: Equatable, Sendable {
        case completed
        case skipped(reason: String)
        case failed(detail: String)

        public var freshnessAdvanced: Bool {
            if case .completed = self { return true }
            return false
        }

        public var exitCode: Int32 {
            if case .failed = self { return 1 }
            return 0
        }
    }

    public enum ScheduleReason: String, Equatable, Sendable {
        case headlessSync = "headless_sync"
        case initialRegistration = "initial_registration"
    }

    public enum ScheduleDisposition: Equatable, Sendable {
        case scheduled(Date)
        case alreadyScheduled(Date)
        case failed(detail: String)
    }

    public struct HeadlessResult: Equatable, Sendable {
        public let sync: SyncDisposition
        public let wake: ScheduleDisposition

        public var freshnessAdvanced: Bool { sync.freshnessAdvanced }
        public var exitCode: Int32 { sync.exitCode }
    }

    public typealias Schedule = (Date) throws -> WakeScheduler.Outcome
    public typealias AsyncSchedule = () async throws -> WakeScheduler.Outcome
    public typealias Log = (String, StructuredLog.Level, [String: String]) -> Void

    /// Runs one eligible `--sync` attempt and then queues exactly one next wake.
    /// Scheduling failure is degraded availability, not a rewrite of the sync result.
    public static func runEligibleSync(
        sync: () -> SyncDisposition,
        schedule: Schedule,
        clock: () -> Date = Date.init,
        log: Log? = nil
    ) -> HeadlessResult {
        let syncResult = sync()
        let wakeResult = scheduleNext(
            reason: .headlessSync,
            at: clock(),
            schedule: schedule,
            freshnessAdvanced: syncResult.freshnessAdvanced,
            log: log
        )
        return HeadlessResult(sync: syncResult, wake: wakeResult)
    }

    /// Queues the first wake after the onboarding LaunchAgent registration succeeds.
    public static func scheduleInitialWake(
        schedule: Schedule,
        clock: () -> Date = Date.init,
        log: Log? = nil
    ) -> ScheduleDisposition {
        scheduleNext(reason: .initialRegistration,
                     at: clock(),
                     schedule: schedule,
                     freshnessAdvanced: false,
                     log: log)
    }

    /// Async production path. No caller date crosses the helper boundary.
    public static func runEligibleSyncAsync(
        sync: () -> SyncDisposition,
        schedule: AsyncSchedule,
        log: Log? = nil
    ) async -> HeadlessResult {
        let syncResult = sync()
        let wakeResult = await scheduleNextAsync(reason: .headlessSync,
                                                 schedule: schedule,
                                                 freshnessAdvanced: syncResult.freshnessAdvanced,
                                                 log: log)
        return HeadlessResult(sync: syncResult, wake: wakeResult)
    }

    public static func scheduleInitialWakeAsync(
        schedule: AsyncSchedule,
        log: Log? = nil
    ) async -> ScheduleDisposition {
        await scheduleNextAsync(reason: .initialRegistration,
                                schedule: schedule,
                                freshnessAdvanced: false,
                                log: log)
    }

    private static func scheduleNext(
        reason: ScheduleReason,
        at date: Date,
        schedule: Schedule,
        freshnessAdvanced: Bool,
        log: Log?
    ) -> ScheduleDisposition {
        let emit = log ?? { event, level, fields in
            StructuredLog.emit(event, level: level, fields: fields)
        }
        do {
            switch try schedule(date) {
            case .scheduled(let wake):
                emit("wake.lifecycle_scheduled", .info, [
                    "reason": reason.rawValue,
                    "result": "scheduled",
                    "wake_at": StructuredLog.timestamp(wake),
                ])
                return .scheduled(wake)
            case .alreadyScheduled(let wake):
                emit("wake.lifecycle_scheduled", .info, [
                    "reason": reason.rawValue,
                    "result": "already_scheduled",
                    "wake_at": StructuredLog.timestamp(wake),
                ])
                return .alreadyScheduled(wake)
            }
        } catch {
            let detail = String(describing: error)
            emit("wake.lifecycle_degraded", .error, [
                "reason": reason.rawValue,
                "detail": detail,
                "freshness_advanced": String(freshnessAdvanced),
            ])
            return .failed(detail: detail)
        }
    }

    private static func scheduleNextAsync(
        reason: ScheduleReason,
        schedule: AsyncSchedule,
        freshnessAdvanced: Bool,
        log: Log?
    ) async -> ScheduleDisposition {
        let emit = log ?? { event, level, fields in
            StructuredLog.emit(event, level: level, fields: fields)
        }
        do {
            switch try await schedule() {
            case .scheduled(let wake):
                emit("wake.lifecycle_scheduled", .info, [
                    "reason": reason.rawValue,
                    "result": "scheduled",
                    "wake_at": StructuredLog.timestamp(wake),
                ])
                return .scheduled(wake)
            case .alreadyScheduled(let wake):
                emit("wake.lifecycle_scheduled", .info, [
                    "reason": reason.rawValue,
                    "result": "already_scheduled",
                    "wake_at": StructuredLog.timestamp(wake),
                ])
                return .alreadyScheduled(wake)
            }
        } catch {
            let detail = String(describing: error)
            emit("wake.lifecycle_degraded", .error, [
                "reason": reason.rawValue,
                "detail": detail,
                "freshness_advanced": String(freshnessAdvanced),
            ])
            return .failed(detail: detail)
        }
    }
}
