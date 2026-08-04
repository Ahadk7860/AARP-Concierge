import XCTest
@testable import BoiKit

/// What the user is told, and when.
///
/// **The trap prompt `01` names: a test that asserts the app called `GrantWatcher` is not
/// a test of this work.** Nothing here counts an internal call. Every assertion is either
/// on rendered copy or on the bytes a real server received.
final class OnboardingTests: XCTestCase {

    // MARK: - No state falls through to a generic screen

    /// Every stage says something different. The failure this catches is the one the track
    /// started from: five distinct conditions sharing one `"Something went wrong"`.
    ///
    /// MUTATION: give `.relaunchStalled` the same title as `.deniedAfterRelaunch`. Red.
    func testEveryStageHasADistinctTitle() {
        let titles = GrantStage.allCases.map(\.title)
        XCTAssertEqual(Set(titles).count, GrantStage.allCases.count,
                       "two stages share a title, so two conditions render as one screen")
    }

    /// MUTATION: point `.waitingStalled.body` at `GrantStage.waiting.body`. Red.
    func testEveryStageHasADistinctBody() {
        let bodies = GrantStage.allCases.map(\.body)
        XCTAssertEqual(Set(bodies).count, GrantStage.allCases.count)
    }

    /// **The anchor, as an assertion.** A stage whose copy is a generic apology tells the
    /// user nothing about where they are or what to do, which is the spinner wearing
    /// different words.
    ///
    /// MUTATION: set `.relaunchStalled.body` to "Something went wrong. Please try again."
    /// Red on that stage.
    func testNoStageRendersAGenericApology() {
        let banned = ["something went wrong", "an error occurred", "please try again",
                      "unknown error", "unexpected error occurred", "oops"]
        for stage in GrantStage.allCases {
            let copy = ([stage.title, stage.body, stage.nextStep ?? ""])
                .joined(separator: " ").lowercased()
            for phrase in banned {
                XCTAssertFalse(copy.contains(phrase),
                               "\(stage.rawValue) falls back on \"\(phrase)\"")
            }
        }
    }

    /// **Every stage that needs the user names the one thing to do.** The three that do
    /// not are the three where nothing is being asked, and they are pinned by name — so
    /// adding a fourth silent stage fails here rather than shipping as a spinner.
    ///
    /// MUTATION: return `nil` from `.relaunchStalled.nextStep`. Red.
    func testOnlyTheThreeStagesThatAskNothingHaveNoNextStep() {
        let silent = GrantStage.allCases.filter { $0.nextStep == nil }
        XCTAssertEqual(Set(silent), [.checking, .syncing, .ready])

        for stage in GrantStage.allCases where !silent.contains(stage) {
            let step = try? XCTUnwrap(stage.nextStep)
            XCTAssertFalse((step ?? "").isEmpty, "\(stage.rawValue) asks without instructing")
        }
    }

    /// Two stages instructing the user identically means one of them is not really its own
    /// screen.
    ///
    /// MUTATION: make `.deniedAfterRelaunch.nextStep` equal `.waiting.nextStep`. Red.
    func testEveryInstructionIsDistinct() {
        let steps = GrantStage.allCases.compactMap(\.nextStep)
        XCTAssertEqual(Set(steps).count, steps.count)
    }

    // MARK: - The five failure paths, each with its own remedy

    /// Prompt `01` names five, and a generic "something went wrong" fails the criterion.
    /// Each one is a distinct stage with distinct copy and distinct instructions.
    ///
    /// MUTATION: delete `.relaunchStalled` and route it to `.failed`. Red — the set no
    /// longer matches.
    func testTheFiveFailurePathsAreFiveDistinctStages() {
        let paths: [GrantStage] = [
            .notInApplications,       // bundle not in /Applications
            .waitingStalled,          // grant given to the wrong entry
            .returnedWithoutGranting, // user backs out
            .relaunchStalled,         // relaunch budget exceeded
            .deniedAfterRelaunch,     // still denied after relaunch
        ]
        XCTAssertEqual(Set(paths).count, 5)
        for stage in paths {
            XCTAssertTrue(stage.isFailure, "\(stage.rawValue) is a failure path")
            XCTAssertNotNil(stage.nextStep, "\(stage.rawValue) must name its remedy")
        }
        XCTAssertEqual(Set(paths.map(\.title)).count, 5)
        XCTAssertEqual(Set(paths.compactMap(\.nextStep)).count, 5)
    }

    /// **Relaunch-budget-exceeded is distinguishable from still-denied in the UI and in
    /// the log**, which the Definition of Done asks for separately because they are one
    /// bug away from collapsing into each other and their remedies differ: one is "quit us
    /// by hand", the other is "the switch is on the wrong row".
    ///
    /// MUTATION: make `logEvent` return a constant `"fda.stage"`. Red.
    func testRelaunchStalledAndDeniedAfterRelaunchDifferInBothUIAndLog() {
        XCTAssertNotEqual(GrantStage.relaunchStalled.title,
                          GrantStage.deniedAfterRelaunch.title)
        XCTAssertNotEqual(GrantStage.relaunchStalled.nextStep,
                          GrantStage.deniedAfterRelaunch.nextStep)
        XCTAssertNotEqual(GrantStage.relaunchStalled.logEvent,
                          GrantStage.deniedAfterRelaunch.logEvent)

        let events = GrantStage.allCases.map(\.logEvent)
        XCTAssertEqual(Set(events).count, events.count, "every stage is its own log slug")
    }

    /// **The bundle check happens before the deep link, so this stage must not offer it.**
    /// Sending somebody to System Settings to grant a bundle that cannot durably hold the
    /// grant spends the one trip they were willing to make.
    ///
    /// MUTATION: add `.notInApplications` to `offersSettingsLink`. Red.
    func testTheWrongInstallLocationDoesNotOfferTheSettingsLink() {
        XCTAssertFalse(GrantStage.notInApplications.offersSettingsLink)
        XCTAssertTrue(GrantStage.waiting.offersSettingsLink)
        XCTAssertTrue(GrantStage.deniedAfterRelaunch.offersSettingsLink)
    }

    /// Wherever the automatic relaunch may not arrive, the user is given the manual way
    /// out. `waitingStalled` is on this list because if the probe cannot observe the grant
    /// from inside the process that was running when it was made, no automatic relaunch is
    /// ever triggered and this button is the only exit.
    ///
    /// MUTATION: remove `.waitingStalled` from `offersManualRelaunch`. Red.
    func testEveryStageWhereTheRelaunchMayNotArriveOffersTheManualWayOut() {
        XCTAssertEqual(Set(GrantStage.allCases.filter(\.offersManualRelaunch)),
                       [.waitingStalled, .relaunchStalled, .deniedAfterRelaunch])
    }

    /// The waiting screen escalates once waiting stops being informative — but not so
    /// early that it nags somebody still reading the settings list.
    ///
    /// MUTATION: make `whileWaiting` always return `.waiting`. Red — the user waits
    /// forever on a screen that says everything is fine.
    func testWaitingEscalatesOnlyAfterWaitingStopsBeingHonest() {
        XCTAssertEqual(GrantStage.whileWaiting(polls: 1), .waiting)
        XCTAssertEqual(GrantStage.whileWaiting(polls: 10), .waiting)

        // The boundary, computed from the real poll interval rather than hard-coded, so a
        // change to `pollInterval` cannot silently move the escalation to a different
        // wall-clock time.
        let boundary = Int(GrantStage.escalateAfter / FullDiskAccess.pollInterval)
        XCTAssertEqual(GrantStage.whileWaiting(polls: boundary - 1), .waiting)
        XCTAssertEqual(GrantStage.whileWaiting(polls: boundary), .waitingStalled)
        XCTAssertEqual(GrantStage.whileWaiting(polls: boundary * 10), .waitingStalled)
    }

    // MARK: - Which stage a launch lands on

    /// **Still-denied-after-relaunch is a different screen from not-yet-tried**, and the
    /// only thing separating them is the marker the relaunching process left behind.
    /// Without it both are simply `denied` and the user who did everything right sees the
    /// same instructions they already followed.
    ///
    /// MUTATION: ignore `didRelaunch` and always return `.waiting` on denied. Red.
    func testARelaunchedProcessThatIsStillDeniedGetsItsOwnStage() {
        XCTAssertEqual(
            LaunchDisposition.stage(probe: .denied(detail: "authorization denied"),
                                    didRelaunch: true, install: .installed),
            .deniedAfterRelaunch)

        XCTAssertEqual(
            LaunchDisposition.stage(probe: .denied(detail: "authorization denied"),
                                    didRelaunch: false, install: .installed),
            .waiting)
    }

    /// **The install location is checked before the deep link, and it outranks the
    /// relaunch marker.** When both apply, the wrong folder is the cause of the failed
    /// relaunch — telling that user "Boi restarted and it still did not work" sends them
    /// back to a switch that was never going to hold.
    ///
    /// MUTATION: reorder so `didRelaunch` is tested first. Red on the second assertion.
    func testTheWrongInstallLocationOutranksTheRelaunchMarker() {
        let downloads = InstallLocation.Verdict.elsewhere(path: "/Users/x/Downloads/Boi.app")

        XCTAssertEqual(
            LaunchDisposition.stage(probe: .denied(detail: "denied"),
                                    didRelaunch: false, install: downloads),
            .notInApplications)

        XCTAssertEqual(
            LaunchDisposition.stage(probe: .denied(detail: "denied"),
                                    didRelaunch: true, install: downloads),
            .notInApplications,
            "the folder is why the relaunch did not help")
    }

    /// A granted probe skips the permission screens entirely, whatever else is true —
    /// the reinstall and second-launch path. Showing a permission screen to somebody who
    /// already granted the permission teaches people to click through without reading.
    ///
    /// MUTATION: return `.waiting` when `didRelaunch` is true regardless of the probe. Red.
    func testAGrantedProbeAlwaysSkipsStraightToSyncing() {
        for didRelaunch in [true, false] {
            for install in [InstallLocation.Verdict.installed, .notABundle,
                            .elsewhere(path: "/Users/x/Downloads/Boi.app")] {
                XCTAssertEqual(
                    LaunchDisposition.stage(probe: .granted, didRelaunch: didRelaunch,
                                            install: install),
                    .syncing)
            }
        }
    }

    /// No `chat.db` is not a permission problem, and it must not be reported as one at any
    /// combination of the other inputs.
    ///
    /// MUTATION: fall through to the denied branch for `.noDatabase`. Red.
    func testNoDatabaseIsNeverReportedAsAPermissionProblem() {
        for didRelaunch in [true, false] {
            for install in [InstallLocation.Verdict.installed, .notABundle,
                            .elsewhere(path: "/Users/x/Downloads/Boi.app")] {
                XCTAssertEqual(
                    LaunchDisposition.stage(probe: .noDatabase, didRelaunch: didRelaunch,
                                            install: install),
                    .noDatabase)
            }
        }
    }

    // MARK: - The heartbeat that left the machine

    /// **`fda_granted: true`, on the wire, to a real socket.**
    ///
    /// Asserted on the request the server received rather than on a call count, per the
    /// trap in prompt `01`. `LoopbackHTTPServer` is Track E's, in this same test target
    /// and unmodified.
    ///
    /// MUTATION: hard-code `fda_granted: false` in `GrantHeartbeat.encoded()`. Red.
    func testTheGrantHeartbeatCarriesFDAGrantedTrue() throws {
        let server = try LoopbackHTTPServer { _ in .noContent }
        defer { server.stop() }

        let result = signaller(base: server.baseURL)
            .send(granted: true, digestGeneratedAt: nil, macOSVersion: "15.0", log: { _, _, _ in })

        XCTAssertEqual(result, .accepted(status: 204))
        let request = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/v1/heartbeat")

        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.body) as? [String: Any])
        XCTAssertEqual(body["fda_granted"] as? Bool, true)
    }

    /// **AMENDMENT-003: `digest_as_of` is required and nullable.** At the moment the grant
    /// lands no sync has ever run, so the honest value is an explicit `null` — the claim
    /// "this device has never synced" — and never a fabricated timestamp, which would make
    /// a never-synced Mac indistinguishable from a freshly-synced one in the exact dataset
    /// the field exists to serve.
    ///
    /// MUTATION: change `encoded()` to omit `digest_as_of` when nil. Red — the key is
    /// absent, and a schema that still requires it would reject the body.
    func testDigestAsOfIsPresentAndNullBeforeTheFirstSync() throws {
        let server = try LoopbackHTTPServer { _ in .noContent }
        defer { server.stop() }

        signaller(base: server.baseURL)
            .send(granted: true, digestGeneratedAt: nil, macOSVersion: "15.0", log: { _, _, _ in })

        let request = try XCTUnwrap(server.requests.first)
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.body) as? [String: Any])

        XCTAssertTrue(body.keys.contains("digest_as_of"),
                      "required-and-nullable: the key is always present")
        XCTAssertTrue(body["digest_as_of"] is NSNull,
                      "null is the claim 'never synced', not an absence")
    }

    /// The route sets `additionalProperties: false`, so an extra key is a `400`. This
    /// pins the body against the property set the frozen contract declares.
    ///
    /// MUTATION: add `"bundle_path_stable": true` to `encoded()` — a genuinely useful
    /// field the contract has nowhere to put. Red.
    func testTheBodyValidatesAgainstTheFrozenHeartbeatSchema() throws {
        let server = try LoopbackHTTPServer { _ in .noContent }
        defer { server.stop() }

        signaller(base: server.baseURL)
            .send(granted: true, digestGeneratedAt: nil, macOSVersion: "15.0", log: { _, _, _ in })

        let request = try XCTUnwrap(server.requests.first)
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.body) as? [String: Any])

        // required: [device_id, app_version, digest_as_of]
        for key in ["device_id", "app_version", "digest_as_of"] {
            XCTAssertTrue(body.keys.contains(key), "required property \(key) is missing")
        }
        // additionalProperties: false
        XCTAssertTrue(Set(body.keys).isSubset(of: GrantHeartbeat.wireKeys),
                      "extra keys: \(Set(body.keys).subtracting(GrantHeartbeat.wireKeys))")
        XCTAssertTrue(body["device_id"] is String)
        XCTAssertTrue(body["app_version"] is String)
    }

    /// After a sync, the real timestamp goes in — the null is the pre-sync case only, not
    /// a permanent shrug.
    ///
    /// MUTATION: always encode `NSNull()` for `digest_as_of`. Red.
    func testDigestAsOfCarriesTheRealTimestampOnceOneExists() throws {
        let server = try LoopbackHTTPServer { _ in .noContent }
        defer { server.stop() }

        signaller(base: server.baseURL)
            .send(granted: true, digestGeneratedAt: "2026-08-04T12:00:00Z",
                  macOSVersion: "15.0", log: { _, _, _ in })

        let request = try XCTUnwrap(server.requests.first)
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.body) as? [String: Any])
        XCTAssertEqual(body["digest_as_of"] as? String, "2026-08-04T12:00:00Z")
    }

    /// **The grant reaches the cloud within one poll interval, not on the next scheduled
    /// sync.** Driven by the narrator against a controlled clock and a real socket: the
    /// probe flips, the very next poll signals, and the request is on the wire.
    ///
    /// MUTATION: make `GrantNarrator.observe` return `.unchanged` on the first grant so the
    /// signal waits for a later transition. Red — no request arrives inside the budget.
    func testTheGrantReachesTheCloudWithinOnePollInterval() throws {
        let server = try LoopbackHTTPServer { _ in .noContent }
        defer { server.stop() }

        let narrator = GrantNarrator()
        let signaller = signaller(base: server.baseURL)
        var granted = false
        var pollsUntilSent = 0

        let started = Date()
        // The poll loop, exactly as the app drives it: observe every interval, act on the
        // decision. The grant lands on poll three.
        for poll in 1...5 {
            if poll == 3 { granted = true }
            let decision = narrator.observe(granted: granted,
                                            now: started.addingTimeInterval(
                                                Double(poll) * FullDiskAccess.pollInterval))
            if case .signal(let value) = decision {
                signaller.send(granted: value, digestGeneratedAt: nil,
                               macOSVersion: "15.0", log: { _, _, _ in })
                pollsUntilSent = poll
                break
            }
        }

        XCTAssertEqual(pollsUntilSent, 3, "sent on the poll that observed the grant")
        XCTAssertEqual(server.requests.count, 1)
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: server.requests[0].body) as? [String: Any])
        XCTAssertEqual(body["fda_granted"] as? Bool, true)
    }

    /// **CONTRACTS.md § 7: no message content in any log, test, commit or report.** This
    /// track never touches message bodies, so anything resembling one in the heartbeat is
    /// a bug. The body is five scalar fields and this pins that it stays that way.
    ///
    /// MUTATION: add any free-text field to `encoded()`. Red.
    func testTheHeartbeatBodyCarriesNoFreeText() throws {
        let server = try LoopbackHTTPServer { _ in .noContent }
        defer { server.stop() }

        signaller(base: server.baseURL)
            .send(granted: true, digestGeneratedAt: nil, macOSVersion: "15.0", log: { _, _, _ in })

        let request = try XCTUnwrap(server.requests.first)
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.body) as? [String: Any])

        XCTAssertEqual(Set(body.keys), GrantHeartbeat.wireKeys)
        // Every value is a scalar the Mac computed about itself. No field is free text
        // and none is derived from the corpus.
        XCTAssertEqual(body["device_id"] as? String, "dev_test")
        XCTAssertEqual(body["app_version"] as? String, "1.0.0-test")
        XCTAssertEqual(body["macos_version"] as? String, "15.0")
    }

    // MARK: -

    private func signaller(base: URL) -> GrantSignaller {
        GrantSignaller(
            uploader: Uploader(
                configuration: Uploader.Configuration(baseURL: base, timeout: 5),
                identity: DeviceIdentity(user_id: "usr_test", device_token: "tok_test")),
            deviceID: "dev_test",
            appVersion: "1.0.0-test")
    }
}
