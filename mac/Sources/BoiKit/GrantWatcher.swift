import Foundation

/// Watches for the Full Disk Access grant and decides when to relaunch.
///
/// Lives in `BoiKit` rather than in the view so it is testable without a window. The
/// sequence it implements is the one that had to be learned by performing the grant by
/// hand, and every step of it is load-bearing:
///
/// ```
/// deep link  ->  poll every 500ms  ->  RELAUNCH  ->  verify
/// ```
///
/// **Not `deep link -> poll -> proceed`.** macOS does not apply a TCC grant to a process
/// that is already running: after granting, the identical query still returned
/// `authorization denied`, and it only worked after quitting and reopening. An app that
/// polls and then proceeds is waiting for a permission this process can never observe,
/// forever, while the user watches a spinner.
public final class GrantWatcher {

    public enum Event: Sendable, Equatable {
        /// Still denied. Carries the poll count so the UI can show it is alive.
        case waiting(polls: Int)
        /// The toggle flipped. The checkmark must be visible **now** — this fires before
        /// the relaunch, because an app that vanishes without acknowledging the click is
        /// indistinguishable from a crash.
        case granted(polls: Int, elapsed: TimeInterval)
        /// Relaunching. Everything after this is on the two-second clock.
        case relaunching
        case noDatabase
    }

    private let probe: () -> FullDiskAccess.Status
    private let clock: () -> Date
    private var started: Date?
    private var polls = 0
    private var finished = false

    public init(probe: @escaping () -> FullDiskAccess.Status = { FullDiskAccess.probe() },
                clock: @escaping () -> Date = Date.init) {
        self.probe = probe
        self.clock = clock
    }

    public private(set) var lastEvent: Event = .waiting(polls: 0)

    /// One poll. Returns the event, and returns `.granted` exactly once — a watcher that
    /// fired repeatedly would relaunch an app that is already on its way out.
    @discardableResult
    public func tick() -> Event {
        guard !finished else { return lastEvent }
        if started == nil { started = clock() }
        polls += 1

        let event: Event
        switch probe() {
        case .granted:
            finished = true
            event = .granted(polls: polls,
                             elapsed: clock().timeIntervalSince(started ?? clock()))
        case .noDatabase:
            finished = true
            event = .noDatabase
        case .denied:
            event = .waiting(polls: polls)
        }
        lastEvent = event
        return event
    }

    /// True once the grant has been seen. The relaunch happens on this transition and on
    /// no other.
    public var hasSeenGrant: Bool {
        if case .granted = lastEvent { return true }
        return false
    }

    /// How long the caller may take between seeing the grant and being gone.
    ///
    /// The Definition of Done measures two seconds from the toggle flipping to the app
    /// being back. The pause before relaunching exists so the flipped checkmark actually
    /// renders — but it has to leave room.
    public static let acknowledgementPause: TimeInterval = 0.35

    public static var relaunchDeadlineIsAchievable: Bool {
        acknowledgementPause + FullDiskAccess.pollInterval < FullDiskAccess.relaunchBudget
    }
}
