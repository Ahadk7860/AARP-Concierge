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

    /// **Every stage that needs the user names the one thing to do.** The two that do not
    /// are the two where nothing is being asked, and they are pinned by name — so adding a
    /// third silent stage fails here rather than shipping as a spinner.
    ///
    /// *Changed by prompt 02:* `ready` used to be silent because it was the terminal
    /// screen and terminal meant "nothing more to do". The handoff makes the terminal
    /// screen a door, so `ready` now asks for something too.
    ///
    /// MUTATION: return `nil` from `.relaunchStalled.nextStep`. Red.
    func testOnlyTheTwoStagesThatAskNothingHaveNoNextStep() {
        let silent = GrantStage.allCases.filter { $0.nextStep == nil }
        XCTAssertEqual(Set(silent), [.checking, .syncing])

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

    // MARK: - Prompt 02: getting out of macOS's way

    /// **The relaunch is offered from the first waiting screen, not after thirty seconds.**
    ///
    /// The manual run settled that `GrantWatcher` never observes the grant — the app does
    /// not auto-advance, so restarting is the only path, not a fallback. `01` hid the one
    /// thing that works behind a 30-second timer while a counter climbed to `checked 43×`.
    ///
    /// MUTATION: remove `.waiting` from `offersManualRelaunch`. Red.
    func testTheRelaunchIsOfferedImmediatelyBecauseNothingElseAdvances() {
        XCTAssertTrue(GrantStage.waiting.offersManualRelaunch,
                      "restarting is the only path; it cannot be behind a timer")
        XCTAssertEqual(Set(GrantStage.allCases.filter(\.offersManualRelaunch)),
                       [.waiting, .waitingStalled, .relaunchStalled, .deniedAfterRelaunch])
    }

    /// **Boi presents nothing that competes with the macOS Quit & Reopen dialog.**
    ///
    /// The system dialog is authoritative, the user already trusts it, and it performs the
    /// relaunch. `01` put an acknowledgement screen up at that exact moment, which the
    /// manual run recorded as *"friction and confusing"*. The state machine's answer is
    /// that there is no stage to show: `granted` no longer exists.
    ///
    /// MUTATION: re-add a `granted` case that renders its own screen. Red — the count and
    /// the raw-value set both move.
    func testThereIsNoStageThatCompetesWithTheSystemDialog() {
        XCTAssertFalse(GrantStage.allCases.contains { $0.rawValue == "granted" },
                       "an acknowledgement screen here competes with the system dialog")

        // The stage a user sits on while macOS asks is `waiting`, and it is quiet: no
        // remedy styling, no focus-taking action, just the explanation.
        XCTAssertFalse(GrantStage.waiting.isFailure)
    }

    /// **A user who chooses Later is told what they deferred and how to resume** — on the
    /// screen they are already looking at, because nothing can detect that choice. Having
    /// flipped the switch and deferred the restart produces the same `denied` probe as
    /// never having flipped it at all.
    ///
    /// MUTATION: remove the "If you chose Later" sentence from `waiting.body`. Red.
    func testTheWaitingScreenAnswersTheDeferredUser() {
        let copy = (GrantStage.waiting.body + " " + (GrantStage.waiting.nextStep ?? ""))
            .lowercased()
        XCTAssertTrue(copy.contains("quit & reopen"),
                      "the system dialog's own wording, so the two screens agree")
        XCTAssertTrue(copy.contains("later"), "the deferred user needs the way back")
        XCTAssertTrue(GrantStage.waiting.offersManualRelaunch,
                      "and the way back has to be a button, not just prose")
    }

    /// The counter must not promise an advance that never comes. `01`'s
    /// *"Waiting for the switch… (checked 43×)"* reads as "any moment now", and the manual
    /// run proved that moment never arrives.
    ///
    /// MUTATION: revert `waiting.title` to "Waiting for you to flip the switch". Red.
    func testTheWaitingScreenDoesNotPromiseAnAutomaticAdvance() {
        let title = GrantStage.waiting.title.lowercased()
        XCTAssertTrue(title.contains("restart"),
                      "the title names the restart, since that is what actually happens")
        XCTAssertFalse(GrantStage.waiting.body.lowercased()
            .contains("will notice the moment you switch it on"),
                       "nothing notices; that was the false promise")
    }

    /// The waiting screen escalates once waiting stops being informative — but not so
    /// early that it nags somebody still reading the settings list. Since prompt 02 this
    /// is only the wrong-entry escalation; the relaunch is already offered from `waiting`.
    ///
    /// MUTATION: make `whileWaiting` always return `.waiting`. Red — the user never gets
    /// the "check the row says Boi" escalation.
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

    // MARK: - Prompt 02: the handoff to the thread

    /// **The terminal screen is the handoff, not the health list.** The user just granted
    /// full disk access; ending on two things that are wrong is the wrong reward.
    ///
    /// MUTATION: give `.handoff` a `nil` `nextStep`, making it a dead end. Red.
    func testTheHandoffIsTerminalAndAsksForSomething() {
        XCTAssertNotNil(GrantStage.handoff.nextStep,
                        "the terminal screen is a door, so it has a next action")
        XCTAssertFalse(GrantStage.handoff.isFailure)

        // The only stages that ask nothing are the two where nothing is happening yet.
        XCTAssertEqual(Set(GrantStage.allCases.filter { $0.nextStep == nil }),
                       [.checking, .syncing])
    }

    /// **Paired and unpaired, asserted separately against the token store.**
    ///
    /// MUTATION: ignore `isPaired` and always return the unpaired link. Red — the paired
    /// case gets a token appended to a thread that already exists.
    func testPairedAndUnpairedRenderDifferentLinks() {
        XCTAssertEqual(
            ThreadHandoff.resolve(handle: "+15551234567", pairingToken: "tok_abc",
                                  isPaired: true),
            .paired(link: "sms:+15551234567"),
            "the thread exists; no pairing token belongs in the link")

        XCTAssertEqual(
            ThreadHandoff.resolve(handle: "+15551234567", pairingToken: "tok_abc",
                                  isPaired: false),
            .unpaired(link: "sms:+15551234567&body=tok_abc"))
    }

    /// **The link format is the cloud's, byte for byte.** `cloud/api/src/welcome.ts` builds
    /// `sms:${handle}&body=${encodeURIComponent(token)}` and uses **`&body=`** rather than
    /// `?body=` deliberately. Diverging opens Messages with an empty body and silently
    /// loses the pairing token — a link that looks like it worked and did not.
    ///
    /// MUTATION: change `link` to use `?body=`. Red.
    func testTheLinkUsesTheAmpersandBodyFormTheCloudUses() {
        XCTAssertEqual(ThreadHandoff.link(handle: "+15551234567", token: "tok_abc"),
                       "sms:+15551234567&body=tok_abc")
        XCTAssertFalse(ThreadHandoff.link(handle: "+1555", token: "t").contains("?"))
    }

    /// A token with URL-significant characters must not be able to split the link.
    ///
    /// MUTATION: use `.urlQueryAllowed` unmodified in `encode`. Red — `&` survives and the
    /// token becomes two query parameters.
    func testATokenCannotSplitTheLink() {
        let link = ThreadHandoff.link(handle: "+15551234567", token: "a&b=c?d#e")
        XCTAssertEqual(link, "sms:+15551234567&body=a%26b%3Dc%3Fd%23e")
        // Exactly one `&`: the one this format requires.
        XCTAssertEqual(link.filter { $0 == "&" }.count, 1)
    }

    /// **An unresolvable line renders an honest message, never a malformed `sms:` URL.**
    /// The number is per-user and comes from the registrar; a constant would open a thread
    /// with a line that is not theirs.
    ///
    /// MUTATION: fall back to a constant number when `handle` is nil. Red.
    func testAnUnresolvableLineIsSaidPlainlyRatherThanRenderedBroken() {
        // The last four are the ones a loose validator lets through: a path separator, an
        // angle bracket and a quote all change what the URL means rather than failing
        // loudly, and `?` starts a query the `sms:` form does not use.
        for handle in [nil, "", "   ", "+1555 123", "+1555&body=x", "line\nbreak",
                       "+1555/x", "a<b>@c.com", "a\"b@c.com", "+1555?x=1"] {
            XCTAssertEqual(
                ThreadHandoff.resolve(handle: handle, pairingToken: "tok", isPaired: false),
                .lineUnresolved,
                "handle \(handle ?? "nil") must not become a link")
        }
    }

    /// Unpaired with no token is not a usable link either: it opens a thread and sends
    /// nothing that pairs anything, which looks like it worked and does not.
    ///
    /// MUTATION: drop the token check in `resolve`. Red — an `sms:…&body=` with an empty
    /// body is produced.
    func testUnpairedWithNoTokenIsNotOfferedAsALink() {
        XCTAssertEqual(
            ThreadHandoff.resolve(handle: "+15551234567", pairingToken: nil, isPaired: false),
            .lineUnresolved)
        XCTAssertEqual(
            ThreadHandoff.resolve(handle: "+15551234567", pairingToken: "", isPaired: false),
            .lineUnresolved)
    }

    /// An email handle is legitimate — the registrar registers both the phone number and
    /// the account email — and `sms:` accepts it.
    ///
    /// MUTATION: require a leading `+` in `isUsable`. Red.
    func testAnEmailHandleIsAcceptable() {
        XCTAssertEqual(
            ThreadHandoff.resolve(handle: "boi@example.com", pairingToken: nil, isPaired: true),
            .paired(link: "sms:boi@example.com"))
    }

    /// Every link this type produces has to survive `URL(string:)`, or the button opens
    /// nothing and the failure is silent.
    ///
    /// MUTATION: allow spaces in `isUsable`. Red.
    func testEveryProducedLinkIsAParseableURL() {
        let states = [
            ThreadHandoff.resolve(handle: "+15551234567", pairingToken: nil, isPaired: true),
            ThreadHandoff.resolve(handle: "boi@example.com", pairingToken: "tok_a b",
                                  isPaired: false),
            ThreadHandoff.resolve(handle: "+15551234567", pairingToken: "tok/x?y&z",
                                  isPaired: false),
        ]
        for state in states {
            switch state {
            case .paired(let link), .unpaired(let link):
                XCTAssertNotNil(URL(string: link), "\(link) is not a parseable URL")
            case .lineUnresolved:
                continue
            }
        }
    }

    // MARK: - The cross-language seam

    /// **Swift and TypeScript must build the same `sms:` link, and this runs both.**
    ///
    /// The fourth cross-language seam in this project. The two that held — `contact_id`
    /// and the fact vocabulary — held because the *algorithm* was pinned or one side was
    /// generated from the other. The two that diverged had their shape specified and the
    /// algorithm left to each reader. A separator is exactly the kind of thing a schema
    /// cannot catch: `?body=` and `&body=` are both "a string", both sides pass their own
    /// tests, and the pairing token is silently lost.
    ///
    /// Built in the shape of `DigestTests`' Swift-versus-Python comparison — **both sides
    /// computed from scratch and compared**, not one side asserted against a literal
    /// somebody typed. `&body=` was confirmed empirically on a real Mac: the deep link
    /// opened Messages with the number and the body prefilled.
    ///
    /// Node runs the real `.ts` directly via type stripping, so this needs no `npm
    /// install` — which matters, because a worktree shares no untracked dependencies and a
    /// test nobody can run is a test nobody runs.
    ///
    /// MUTATION: change `ThreadHandoff.link`/`paired` to `?body=`, or to drop the `sms:`
    /// prefix. Red — the two sides stop agreeing.
    func testTheSwiftAndTypeScriptDeepLinksAgree() throws {
        let handle = "+15551234567"
        let token = "tok_cross_language"

        let script = """
        const m = await import('./cloud/api/src/welcome.ts');
        const out = {
          smsDeepLink: m.smsDeepLink ? m.smsDeepLink('\(handle)') : null,
          pairingDeepLink: m.pairingDeepLink
            ? m.pairingDeepLink({ handle: '\(handle)', token: '\(token)' })
            : null,
        };
        console.log(JSON.stringify(out));
        """

        let typescript = try Self.node(script)
        var compared = 0

        // The paired path: an existing thread, no token. Both sides say `sms:<handle>`.
        if let theirs = typescript["smsDeepLink"] as? String {
            XCTAssertEqual(ThreadHandoff.resolve(handle: handle, pairingToken: nil,
                                                 isPaired: true),
                           .paired(link: theirs),
                           "Swift and TypeScript disagree about the paired deep link")
            compared += 1
        }

        // The unpaired path: the token rides in the body. This is the one the separator
        // question was about. `pairingDeepLink` arrives with Track E's prompt 08 — until
        // that merges this side is absent, and the comparison extends to cover it with no
        // edit here the moment it lands.
        if let theirs = typescript["pairingDeepLink"] as? String {
            XCTAssertEqual(ThreadHandoff.link(handle: handle, token: token), theirs,
                           "Swift and TypeScript disagree about the pairing deep link — "
                               + "check the &body= separator")
            XCTAssertTrue(theirs.contains("&body="),
                          "the empirically-confirmed separator is &body=, not ?body=")
            compared += 1
        }

        // **The guard that stops this passing vacuously.** The `contact_id` comparison has
        // the same one — without it, a comparison over an empty set is indistinguishable
        // from a comparison that succeeded, which is how a cross-language test goes green
        // for years while the two sides drift.
        XCTAssertGreaterThan(compared, 0,
                             "no deep-link function was compared; the TypeScript side "
                                 + "exported neither, so this test checked nothing")
    }

    /// Runs a script against the repository root with node's type stripping, so the real
    /// `.ts` source is the thing under test rather than a hand-copied mirror.
    private static func node(_ script: String) throws -> [String: Any] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "--experimental-strip-types", "--input-type=module",
                             "-e", script]
        process.currentDirectoryURL = Fixture.repositoryRoot
        let output = Pipe(), errors = Pipe()
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        let errorText = String(data: errors.fileHandleForReading.readDataToEndOfFile(),
                               encoding: .utf8) ?? ""
        process.waitUntilExit()

        // Fails rather than skips. A green run that checked nothing is worse than a red
        // one, and this project has been bitten by exactly that.
        guard process.terminationStatus == 0 else {
            throw Fixture.FixtureUnavailable(
                detail: "node exited \(process.terminationStatus): \(errorText)")
        }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Fixture.FixtureUnavailable(detail: "node produced no JSON: \(errorText)")
        }
        return object
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
