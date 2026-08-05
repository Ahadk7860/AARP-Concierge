import XCTest
@testable import BoiKit

/// The signal, and when it is allowed to leave the machine.
///
/// Every test here names the mutation that breaks it, because a rate limiter is exactly
/// the kind of code that passes a test suite while doing nothing: delete the clock check
/// and most naive assertions still go green.
final class GrantNarratorTests: XCTestCase {

    /// A controlled clock. The real one would make every interval test either slow or
    /// flaky, and the prompt requires the flapping case be driven deterministically.
    private let t0 = Date(timeIntervalSince1970: 1_770_000_000)

    // MARK: - The rule that outranks the rate limit

    /// **The first false→true fires immediately.** This is the message the whole track
    /// exists to send, and a limiter that delays it satisfies "one per minute" while
    /// defeating the point.
    ///
    /// MUTATION: seed the narrator with `Memory(granted: false, at: now)` at init — i.e.
    /// apply the cap to the first transition. This goes red; `observe` returns
    /// `.suppressed` instead of `.signal`.
    func testFirstGrantSignalsImmediatelyWithNoWarmUp() {
        let narrator = GrantNarrator()

        // Denied at launch is not news and must not spend a heartbeat.
        XCTAssertEqual(narrator.observe(granted: false, now: t0), .unchanged)

        // The very next observation, with no clock advance whatsoever.
        XCTAssertEqual(narrator.observe(granted: true, now: t0), .signal(granted: true))
    }

    /// The grant landing on the *first* poll of a fresh process, with nothing observed
    /// before it. There is no prior observation to compare against, so an implementation
    /// driven by edges rather than by state would miss this entirely.
    ///
    /// MUTATION: change `observe` to require a previous observation before it can signal
    /// (an edge detector). Red — returns `.unchanged`.
    func testGrantOnTheVeryFirstObservationSignals() {
        let narrator = GrantNarrator()
        XCTAssertEqual(narrator.observe(granted: true, now: t0), .signal(granted: true))
    }

    // MARK: - The cap, on flaps

    /// A user toggling the switch in System Settings produces exactly one signal a minute,
    /// not one per toggle.
    ///
    /// MUTATION: delete the `elapsed >= minimumInterval` guard in `observe`. Red — the
    /// count becomes 20 instead of 1.
    func testFlappingGrantProducesAtMostOneSignalPerMinute() {
        let narrator = GrantNarrator()
        var signals = 0
        var lastObservation = t0

        // Twenty flips inside one minute — three seconds apart, well under the cap.
        for index in 0..<20 {
            let granted = index.isMultiple(of: 2)
            lastObservation = t0.addingTimeInterval(Double(index) * 3)
            if narrator.observe(granted: granted, now: lastObservation).isSignal { signals += 1 }
        }

        XCTAssertEqual(signals, 1, "the first grant, and nothing else inside the minute")
        // Pins the premise: every observation above happened inside one interval, so the
        // count of 1 is the cap biting and not the clock quietly running past it.
        XCTAssertLessThan(lastObservation.timeIntervalSince(t0),
                          GrantNarrator.minimumInterval)
    }

    /// Suppression carries the wait, so the log can say how long rather than just "no".
    ///
    /// MUTATION: return a constant `retryAfter: 0`. Red.
    func testSuppressionReportsHowLongUntilASignalIsAllowed() {
        let narrator = GrantNarrator()
        XCTAssertTrue(narrator.observe(granted: true, now: t0).isSignal)

        let decision = narrator.observe(granted: false, now: t0.addingTimeInterval(15))
        XCTAssertEqual(decision, .suppressed(granted: false, retryAfter: 45))
    }

    /// Past the interval, a real change signals again.
    ///
    /// MUTATION: make the interval comparison `>` a `<`. Red.
    func testChangeAfterTheIntervalSignalsAgain() {
        let narrator = GrantNarrator()
        XCTAssertTrue(narrator.observe(granted: true, now: t0).isSignal)

        let later = t0.addingTimeInterval(GrantNarrator.minimumInterval + 1)
        XCTAssertEqual(narrator.observe(granted: false, now: later),
                       .signal(granted: false))
    }

    // MARK: - Convergence

    /// **The cloud is never left believing a grant that no longer exists.**
    ///
    /// This is why `observe` is driven by the difference against the last *signalled*
    /// state rather than by an edge. A revocation that gets suppressed produces no further
    /// edge — nothing changes again — so an edge-driven limiter would leave the cloud
    /// permanently wrong. Polling re-offers the same unreported state until it is allowed
    /// through.
    ///
    /// MUTATION: make `observe` return `.unchanged` whenever the value equals the previous
    /// *observed* value (an edge detector) rather than the last *signalled* value. Red —
    /// the final assertion gets `.unchanged` and the cloud still believes `granted: true`.
    func testASuppressedRevocationStillReachesTheCloudOnceTheIntervalElapses() {
        let narrator = GrantNarrator()
        XCTAssertTrue(narrator.observe(granted: true, now: t0).isSignal)

        // Revoked ten seconds later, and suppressed.
        XCTAssertFalse(narrator.observe(granted: false, now: t0.addingTimeInterval(10)).isSignal)

        // It stays revoked. No new edge ever arrives — only more polls of the same value.
        var now = t0.addingTimeInterval(20)
        var signalled = false
        for _ in 0..<100 {
            if narrator.observe(granted: false, now: now).isSignal { signalled = true; break }
            now = now.addingTimeInterval(0.5)
        }

        XCTAssertTrue(signalled, "a suppressed revocation must eventually be reported")
        XCTAssertEqual(narrator.lastSignalled?.granted, false)
    }

    /// Repeating what the cloud already believes is never a signal, however much time
    /// passes. The cap is a floor on *changes*, not a keepalive.
    ///
    /// MUTATION: drop the `memory.granted != granted` guard. Red — signals once the
    /// interval elapses even though nothing changed.
    func testRepeatingAKnownStateNeverSignalsHoweverLongItHasBeen() {
        let narrator = GrantNarrator()
        XCTAssertTrue(narrator.observe(granted: true, now: t0).isSignal)

        var now = t0
        for _ in 0..<50 {
            now = now.addingTimeInterval(GrantNarrator.minimumInterval * 2)
            XCTAssertEqual(narrator.observe(granted: true, now: now), .unchanged)
        }
    }

    // MARK: - Surviving the relaunch

    /// **The happy path restarts the process**, so an in-memory limiter is not a limiter.
    /// Without persistence the sequence is: grant → signal → relaunch → fresh memory →
    /// signal again, two heartbeats about one event roughly two seconds apart, straight
    /// through a cap that reads as one-per-minute in every other test here.
    ///
    /// MUTATION: have `persisted(inDirectory:)` ignore the loaded memory (pass `nil`).
    /// Red — the second process signals again.
    func testTheLimitSurvivesTheRelaunchThatTheHappyPathPerforms() throws {
        let directory = NSTemporaryDirectory() + "boi-f-narrator-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: directory) }

        // Process one: sees the grant, signals, and is about to relaunch.
        let first = GrantNarrator.persisted(inDirectory: directory)
        XCTAssertTrue(first.observe(granted: true, now: t0).isSignal)

        // Process two, two seconds later, having just been relaunched by process one.
        let second = GrantNarrator.persisted(inDirectory: directory)
        XCTAssertEqual(second.observe(granted: true, now: t0.addingTimeInterval(2)),
                       .unchanged,
                       "the cloud was told two seconds ago by the process that relaunched us")
    }

    /// An unreadable or absent memory means "never signalled", not "already signalled".
    /// The failure directions are not symmetric: one costs a duplicate heartbeat, the
    /// other silently loses the only message this track sends.
    ///
    /// MUTATION: make `load` return `Memory(granted: true, at: .distantFuture)` on a read
    /// failure. Red.
    func testAMissingMemoryMeansNeverSignalledRatherThanAlreadySignalled() {
        let directory = NSTemporaryDirectory() + "boi-f-absent-\(UUID().uuidString)"
        XCTAssertNil(GrantNarrator.load(fromDirectory: directory))

        let narrator = GrantNarrator.persisted(inDirectory: directory)
        defer { try? FileManager.default.removeItem(atPath: directory) }
        XCTAssertTrue(narrator.observe(granted: true, now: t0).isSignal)
    }

    // MARK: - Where the app is installed

    /// **Detected before the deep link, not after the grant fails.** The grant binds to
    /// the responsible bundle's path; granted from anywhere else it will not stick, and
    /// the user finds out by Boi silently not working after they already spent the one
    /// trip to System Settings they were willing to make.
    ///
    /// MUTATION: change `verdict` to compare with `hasPrefix("/Applications/")` on the
    /// bundle path instead of matching the enclosing directory. Red on the nested cases.
    func testInstallLocationAcceptsEitherApplicationsFolder() {
        let home = URL(fileURLWithPath: "/Users/x")

        XCTAssertEqual(
            InstallLocation.verdict(bundlePath: "/Applications/Boi.app", home: home),
            .installed)

        // **`~/Applications` is a real install location, not a mistake.** On 3 Aug this
        // project's own log shows `~/Applications/Boi.app` holding Full Disk Access and
        // completing a 94,897-message sync. A check that rejected it would tell that user
        // to move a working install — and moving the bundle is what actually breaks the
        // grant.
        //
        // MUTATION: drop the home directory from `installDirectories`. Red here.
        XCTAssertEqual(
            InstallLocation.verdict(bundlePath: "/Users/x/Applications/Boi.app", home: home),
            .installed)

        for path in ["/Users/x/Downloads/Boi.app",
                     "/Users/x/Desktop/Boi.app",
                     // A disk image the user never actually installed from.
                     "/Volumes/Boi/Boi.app",
                     // Gatekeeper App Translocation: a randomized path that changes on
                     // every launch, so a grant made against it is worthless tomorrow.
                     "/private/var/folders/ab/xyz/d/AppTranslocation/1234/d/Boi.app",
                     // Contains the word and is still not installed — the substring trap.
                     "/Users/x/Downloads/Applications/Boi.app",
                     // A nested bundle under the real folder is not the responsible one.
                     "/Applications/Xcode.app/Contents/Helpers/Boi.app"] {
            XCTAssertEqual(InstallLocation.verdict(bundlePath: path, home: home),
                           .elsewhere(path: path),
                           "\(path) cannot durably hold the grant")
        }
    }

    /// `/tmp` is a symlink to `/private/tmp`, and more importantly `~` resolves. A path
    /// comparison that ignores symlinks reports two different strings for one folder — so
    /// a correctly installed app could be told to move itself.
    ///
    /// MUTATION: drop `resolvingSymlinksInPath()` from `verdict`. Red.
    func testInstallLocationResolvesSymlinksBeforeComparing() throws {
        // Real directories, because `resolvingSymlinksInPath()` only resolves a path that
        // exists — a fixture built from strings alone would assert nothing.
        let name = "boi-home-\(UUID().uuidString)"
        let home = URL(fileURLWithPath: "/tmp").appendingPathComponent(name)
        let applications = home.appendingPathComponent("Applications")
        try FileManager.default.createDirectory(at: applications,
                                                withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }

        // The same folder, reached through the symlinked and the resolved spelling. On
        // macOS `/tmp` is a symlink to `/private/tmp`, so these are two strings for one
        // directory — and a comparison that ignores that would tell a correctly installed
        // app to move itself.
        XCTAssertEqual(
            InstallLocation.verdict(bundlePath: "/tmp/\(name)/Applications/Boi.app",
                                    home: home),
            .installed)
        XCTAssertEqual(
            InstallLocation.verdict(bundlePath: "/private/tmp/\(name)/Applications/Boi.app",
                                    home: home),
            .installed)
    }

    /// A bare binary — `swift run`, or this test process — has no bundle to grant.
    /// Distinct from "in the wrong folder", because the remedy is different.
    func testABareBinaryIsNotABundle() {
        XCTAssertEqual(InstallLocation.verdict(bundlePath: nil), .notABundle)
        XCTAssertEqual(InstallLocation.verdict(bundlePath: "/usr/local/bin/boi"), .notABundle)
    }
}
