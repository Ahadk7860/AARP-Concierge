import XCTest
@testable import BoiKit

// MARK: - The four findings, as tests

final class FullDiskAccessTests: XCTestCase {

    /// **FINDING 1.** `ls -la ~/Library/Messages/chat.db` succeeded and reported a 151 MB
    /// file *while access was denied*. `stat` is not gated; `open` is. So a readiness
    /// check built on existence or readability reports success before the grant exists,
    /// and walks a user who has granted nothing straight past the only screen that
    /// matters.
    ///
    /// This asserts the probe is not merely an existence check: a file that exists but
    /// is not a database must not read as granted.
    func testTheProbeOpensRatherThanLooking() throws {
        let path = "/tmp/boi-a/tests/not-a-database-\(UUID().uuidString).db"
        try FileManager.default.createDirectory(atPath: "/tmp/boi-a/tests",
                                                withIntermediateDirectories: true)
        try Data("this is not a sqlite file, but it certainly exists".utf8)
            .write(to: URL(fileURLWithPath: path))
        defer { try? FileManager.default.removeItem(atPath: path) }

        XCTAssertTrue(FileManager.default.fileExists(atPath: path),
                      "the file exists — an existence check would say yes here")
        XCTAssertTrue(FileManager.default.isReadableFile(atPath: path),
                      "and it is readable — so would a readability check")

        guard case .denied = FullDiskAccess.probe(path: path) else {
            return XCTFail("the probe accepted a file it cannot actually query")
        }
    }

    func testAMissingDatabaseIsNotAPermissionProblem() {
        XCTAssertEqual(FullDiskAccess.probe(path: "/tmp/boi-a/tests/absent-\(UUID().uuidString).db"),
                       .noDatabase,
                       "no chat.db means Messages has never run — telling the user to "
                       + "grant access would not fix it")
    }

    /// A real database this process can open reads as granted, which is the other half:
    /// the probe must not be so strict that it never says yes.
    func testARealReadableDatabaseReadsAsGranted() throws {
        try MetricsFixture.ensureCappedChatDatabase()
        XCTAssertEqual(FullDiskAccess.probe(path: MetricsFixture.cappedChatDatabasePath),
                       .granted)
    }

    func testTheDeepLinkIsTheExactPinnedString() {
        XCTAssertEqual(
            FullDiskAccess.settingsDeepLink,
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles")
    }

    /// **FINDING 4** encoded as numbers: the poll is fast enough that the checkmark flips
    /// while the user is still looking, and the relaunch budget is the two seconds the
    /// Definition of Done measures.
    func testThePollAndRelaunchBudgetsAreWhatTheFlowNeeds() {
        XCTAssertEqual(FullDiskAccess.pollInterval, 0.5)
        XCTAssertEqual(FullDiskAccess.relaunchBudget, 2.0)
        XCTAssertLessThan(FullDiskAccess.pollInterval, 1.0,
                          "the status must flip within a second of the toggle flipping")
    }
}

final class ResponsibleBundleTests: XCTestCase {

    /// **FINDING 2, FROM THE REAL CHAIN.** Granting by hand, the responsible process was
    /// the outermost bundle and not the process that made the call:
    ///
    /// ```
    /// zsh <- .../claude-code/2.1.219/claude.app/... <- /Applications/Claude.app/...
    /// ```
    ///
    /// The grant had to go to `/Applications/Claude.app`. Walking up one level, or taking
    /// the nearest enclosing bundle, produces the wrong answer on exactly this shape.
    func testTheOutermostBundleWinsNotTheNearestOne() {
        let nested = "/Applications/Claude.app/Contents/Resources/app.asar.unpacked/"
            + "node_modules/claude-code/2.1.219/claude.app/Contents/MacOS/claude"
        XCTAssertEqual(ResponsibleBundle.enclosingAppBundle(of: nested),
                       "/Applications/Claude.app")

        XCTAssertEqual(
            ResponsibleBundle.enclosingAppBundle(of: "/Applications/Boi.app/Contents/MacOS/Boi"),
            "/Applications/Boi.app")
        XCTAssertNil(ResponsibleBundle.enclosingAppBundle(of: "/usr/local/bin/boi-cli"),
                     "a bare CLI has no bundle, and cannot hold the grant")
    }

    /// **FINDING 3 — THE EXPENSIVE ONE.** That inner bundle was
    /// `claude-code/2.1.219/claude.app`: a **version-numbered path**. If TCC ever binds a
    /// grant to one, an auto-update drops it for the entire fleet on the same day, every
    /// Mac silently, nobody paged.
    ///
    /// So Boi's own bundle path must never contain a version, and that is asserted here
    /// rather than left as an intention in a comment.
    func testAVersionedBundlePathIsRecognisedAsTheFleetWideHazard() {
        XCTAssertTrue(ResponsibleBundle.containsVersionedComponent(
            "/Users/x/Library/Application Support/Claude/claude-code/2.1.219/claude.app"))
        XCTAssertTrue(ResponsibleBundle.containsVersionedComponent("/opt/tool/v1.4/App.app"))
        XCTAssertFalse(ResponsibleBundle.containsVersionedComponent("/Applications/Boi.app"))
        XCTAssertFalse(ResponsibleBundle.containsVersionedComponent(
            "/Users/x/Applications/Boi.app"))
    }

    /// The path Boi would ask a user to grant must be a stable one. This is the assertion
    /// that would fail the day somebody moves the bundle under a versioned directory.
    func testBoisOwnInstallPathsAreStable() {
        for path in ["/Applications/Boi.app",
                     NSHomeDirectory() + "/Applications/Boi.app",
                     "/tmp/boi-a/app/Boi.app"] {
            XCTAssertFalse(ResponsibleBundle.containsVersionedComponent(path),
                           "\(path) carries a version and would lose its grant on update")
        }
    }
}

// MARK: - The LaunchAgent

final class LaunchAgentTests: XCTestCase {

    private let binary = "/Users/x/Applications/Boi.app/Contents/MacOS/Boi"

    func testTheGeneratedPlistHasNoProblems() {
        XCTAssertEqual(LaunchAgentPlist.problems(inXML:
            LaunchAgentPlist.xml(binaryPath: binary)), [])
    }

    /// The plist invokes the **main app binary** with `--sync`. TCC is
    /// per-responsible-process and children do not inherit, so a helper would need its
    /// own grant that no screen asks for — and the sync would silently never run.
    func testThePlistInvokesTheRelocatableBundledAppBinaryAndNotAHelper() {
        let xml = LaunchAgentPlist.xml(binaryPath: binary)
        XCTAssertTrue(xml.contains("<key>BundleProgram</key>"))
        XCTAssertTrue(xml.contains("<string>Contents/MacOS/Boi</string>"))
        XCTAssertTrue(xml.contains("<string>--sync</string>"))
        XCTAssertFalse(xml.contains(binary))

        let helper = xml.replacingOccurrences(of: "Contents/MacOS/Boi",
                                              with: "Contents/Helpers/boi-sync")
        XCTAssertFalse(LaunchAgentPlist.problems(inXML: helper).isEmpty,
            "a helper path must be rejected — it cannot hold the grant")
    }

    func testGeneratorIsByteIdenticalAcrossStagingAndInstallLocations() {
        let staged = LaunchAgentPlist.xml(binaryPath: "/tmp/build/Boi.app/Contents/MacOS/Boi")
        let installed = LaunchAgentPlist.xml(
            binaryPath: "/Applications/Boi.app/Contents/MacOS/Boi")
        XCTAssertEqual(staged, installed)
        XCTAssertFalse(staged.contains("/tmp/"))
        XCTAssertFalse(staged.contains("/Applications/"))
    }

    /// Agent, always. Root processes cannot hold TCC at all on macOS 13+, so the
    /// root-level variant would start, run, and read nothing, forever, in silence.
    func testTheRootLevelVariantIsRejected() {
        let bad = LaunchAgentPlist.xml(binaryPath: binary)
            .replacingOccurrences(of: "<key>Label</key>",
                                  of: "<key>\(LaunchAgentPlist.rootLevelVariant)</key>")
        XCTAssertTrue(LaunchAgentPlist.problems(inXML: bad)
            .contains { $0.contains("root") })
    }

    /// Phase 1's half-hour polling is obsolete. The four RTC alarms wake the Mac at the
    /// same wall-clock times represented here, so launchd now has four matching calendar
    /// triggers and no periodic fallback.
    func testTheCalendarIntervalsMatchTheFourWakePlannerTimes() {
        let xml = LaunchAgentPlist.xml(binaryPath: binary)
        XCTAssertTrue(xml.contains("<key>StartCalendarInterval</key>"))
        XCTAssertFalse(xml.contains("<key>StartInterval</key>"))
        for hour in [8, 12, 17, 21] {
            XCTAssertTrue(xml.contains("<integer>\(hour)</integer>"),
                          "missing local \(hour):00 trigger")
        }
        XCTAssertEqual(xml.components(separatedBy: "<key>Minute</key>").count - 1, 4)
    }

    func testTheObsoletePeriodicIntervalIsRejected() {
        let bad = LaunchAgentPlist.xml(binaryPath: binary)
            .replacingOccurrences(of: "<key>RunAtLoad</key>",
                                  with: "<key>StartInterval</key><integer>1800</integer>"
                                      + "<key>RunAtLoad</key>")
        let problems = LaunchAgentPlist.problems(inXML: bad)
        XCTAssertTrue(problems.contains { $0.contains("obsolete periodic StartInterval") })
    }

    func testTheLegacyIntervalArgumentCannotRestorePolling() {
        let xml = LaunchAgentPlist.xml(binaryPath: binary, intervalSeconds: 60)
        XCTAssertFalse(xml.contains("<key>StartInterval</key>"))
        XCTAssertEqual(LaunchAgentPlist.problems(inXML: xml), [])
    }

    func testAMissingOrChangedWakeTimeIsRejected() {
        let xml = LaunchAgentPlist.xml(binaryPath: binary)
        let missing = xml.replacingOccurrences(
            of: "<key>StartCalendarInterval</key>",
            with: "<key>ObsoleteCalendarInterval</key>")
        XCTAssertTrue(LaunchAgentPlist.problems(inXML: missing)
            .contains { $0.contains("no valid StartCalendarInterval") })

        let changed = xml.replacingOccurrences(of: "<integer>21</integer>",
                                               with: "<integer>22</integer>")
        XCTAssertTrue(LaunchAgentPlist.problems(inXML: changed)
            .contains { $0.contains("expected exactly") })
    }

    func testTheAgentLivesInsideTheBundle() {
        XCTAssertEqual(LaunchAgentPlist.directoryInsideBundle, "Contents/Library/LaunchAgents")
        XCTAssertEqual(LaunchAgentPlist.fileName, "app.boi.mac.sync.plist")
    }

    /// The plist that a build actually produced, checked by the same rules as a generated
    /// one. Fails rather than skips when the bundle is absent: a green run that checked
    /// nothing is worse than a red one.
    func testTheBuiltBundlesPlistPassesTheSameRules() throws {
        // Prefer the bundle this worktree's build command produces. A separately
        // installed older Boi.app must not make a new bundle test inspect stale bytes.
        let candidates = ["/tmp/boi-a/app/Boi.app",
                          NSHomeDirectory() + "/Applications/Boi.app"]
        guard let bundle = candidates.first(where: {
            FileManager.default.fileExists(atPath: $0)
        }) else {
            throw Fixture.FixtureUnavailable(
                detail: "no built Boi.app. Run: bash mac/scripts/build-app.sh --out ~/Applications")
        }
        let plist = bundle + "/" + LaunchAgentPlist.directoryInsideBundle
            + "/" + LaunchAgentPlist.fileName
        let xml = try String(contentsOfFile: plist, encoding: .utf8)
        XCTAssertEqual(LaunchAgentPlist.problems(inXML: xml), [])
        XCTAssertTrue(xml.contains("<string>Contents/MacOS/Boi</string>"))
        XCTAssertFalse(xml.contains(bundle), "plist must survive moving the app bundle")
    }
}

// MARK: - The least-privilege wake helper bundle structure

final class AppBundleWakeHelperTests: XCTestCase {
    private var bundle: String { "/tmp/boi-a/app/Boi.app" }

    func testBuiltBundleEmbedsTheSignedHelperAndDedicatedDaemonPlist() throws {
        let helper = bundle + "/Contents/Resources/BoiWakeHelper"
        let plist = bundle + "/Contents/Library/LaunchDaemons/"
            + WakeHelperContract.plistName
        guard FileManager.default.fileExists(atPath: helper),
              FileManager.default.fileExists(atPath: plist) else {
            throw Fixture.FixtureUnavailable(
                detail: "no Prompt 03 bundle. Run: bash mac/scripts/build-app.sh")
        }
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: helper))
        let value = try XCTUnwrap(PropertyListSerialization.propertyList(
            from: Data(contentsOf: URL(fileURLWithPath: plist)), format: nil) as? [String: Any])
        XCTAssertEqual(value["BundleProgram"] as? String, WakeHelperContract.bundleProgram)
        XCTAssertEqual(value["MachServices"] as? [String: Bool],
                       [WakeHelperContract.serviceName: true])

        try verifySignature(at: helper)
        try verifySignature(at: bundle, deep: true)
    }

    func testBuildScriptSignsNestedHelperBeforeOuterApp() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let script = try String(contentsOf: root.appendingPathComponent("scripts/build-app.sh"))
        let branchStart = try XCTUnwrap(script.range(of: "if [ \"$SIGN_IDENTITY\" = \"-\" ]"))
        let branchEnd = try XCTUnwrap(script.range(of: "\nfi\n", range: branchStart.upperBound..<script.endIndex))
        let signingBlock = String(script[branchStart.lowerBound..<branchEnd.upperBound])
        let branches = signingBlock.components(separatedBy: "\nelse\n")
        XCTAssertEqual(branches.count, 2)
        for branch in branches {
            let helper = try XCTUnwrap(branch.range(of: "--identifier \"$HELPER_ID\""))
            let app = try XCTUnwrap(branch.range(of: "--identifier \"$BUNDLE_ID\""))
            XCTAssertLessThan(helper.lowerBound, app.lowerBound,
                              "nested helper must be signed before its containing app")
        }
        XCTAssertTrue(script.contains("codesign --verify --deep --strict \"$APP\""))
    }

    private func verifySignature(at path: String, deep: Bool = false) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        process.arguments = ["--verify", "--strict"] + (deep ? ["--deep"] : []) + [path]
        let errors = Pipe()
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
        let detail = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(),
                            as: UTF8.self)
        XCTAssertEqual(process.terminationStatus, 0, detail)
    }
}

// MARK: - The heartbeat

final class HeartbeatTests: XCTestCase {

    /// **THE FIELD THE FLEET-WIDE ALARM IS BUILT ON.** A silent Mac is ambiguous. A
    /// cohort of silent Macs that all share one app version, going quiet the day the next
    /// version shipped, is a diagnosis — and it is only visible if the heartbeat says
    /// which version each Mac was running.
    func testTheHeartbeatCarriesTheVersionAndTheBundleStability() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let stable = Heartbeat.current(now: now, appVersion: "1.2.3",
                                       bundlePath: "/Applications/Boi.app",
                                       fullDiskAccess: true, lastSuccessfulSyncAt: now,
                                       mirrorMessageCount: 94_824, corpusHealth: .fixable)
        XCTAssertEqual(stable.app_version, "1.2.3")
        XCTAssertTrue(stable.bundle_path_stable)

        // The shape that would take the whole fleet down at once.
        let versioned = Heartbeat.current(now: now, appVersion: "1.2.3",
                                          bundlePath: "/Users/x/tool/2.1.219/Boi.app",
                                          fullDiskAccess: true, lastSuccessfulSyncAt: now,
                                          mirrorMessageCount: 1, corpusHealth: .healthy)
        XCTAssertFalse(versioned.bundle_path_stable)
    }

    /// "Quiet" and "quiet **and denied**" are different diagnoses. The second is the
    /// signature of a grant dropped by an update, and it is the reason the probe result
    /// rides along on the heartbeat rather than only the timestamp.
    func testTheHeartbeatDistinguishesQuietFromDenied() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let denied = Heartbeat.current(now: now, appVersion: "1.2.3",
                                       bundlePath: "/Applications/Boi.app",
                                       fullDiskAccess: false,
                                       lastSuccessfulSyncAt: now.addingTimeInterval(-72 * 3600),
                                       mirrorMessageCount: 94_824, corpusHealth: .fixable)
        XCTAssertFalse(denied.full_disk_access)
        XCTAssertTrue(denied.isStale(now: now))
        XCTAssertFalse(denied.isStale(now: now, hours: 96))
    }

    /// A Mac that has never completed a sync is stale by definition, not silently fresh.
    func testAMacThatHasNeverSyncedIsStale() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let never = Heartbeat.current(now: now, appVersion: "1.2.3", bundlePath: nil,
                                      fullDiskAccess: false, lastSuccessfulSyncAt: nil,
                                      mirrorMessageCount: 0, corpusHealth: .thin)
        XCTAssertTrue(never.isStale(now: now))
        XCTAssertNil(never.last_successful_sync_at)
    }

    /// Round-trips, and writes `last_successful_sync_at` as an explicit null — an absent
    /// key would read as an older build that did not report the field, which is a
    /// different statement from "this Mac has never synced".
    func testItRoundTripsAndWritesAnExplicitNull() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let heartbeat = Heartbeat.current(now: now, appVersion: "1.2.3", bundlePath: nil,
                                          fullDiskAccess: false, lastSuccessfulSyncAt: nil,
                                          mirrorMessageCount: 0, corpusHealth: .thin)
        let directory = "/tmp/boi-a/tests/heartbeat-\(UUID().uuidString)"
        let path = try Heartbeat.write(heartbeat, toDirectory: directory)
        defer { try? FileManager.default.removeItem(atPath: directory) }

        let object = try XCTUnwrap(try JSONSerialization.jsonObject(
            with: try Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any])
        XCTAssertTrue(object.keys.contains("last_successful_sync_at"))
        XCTAssertTrue(object["last_successful_sync_at"] is NSNull)
        XCTAssertEqual(Heartbeat.read(fromDirectory: directory), heartbeat)
    }
}

// MARK: - The scheduled run

final class SyncRunTests: XCTestCase {

    private func paths(label: String) throws -> SyncRun.Paths {
        let root = "/tmp/boi-a/tests/run-\(label)-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        var builder = MetricsFixture.ChatBuilder()
        for day in 1...600 {
            builder.message("ok that works for me \(day)", in: "+15550100001",
                            daysAgo: Double(day) * 0.6, fromMe: true)
            builder.message("hey how are you \(day)", in: "+15550100001",
                            daysAgo: Double(day) * 0.6 - 0.1)
        }
        return SyncRun.Paths(chatDatabase: try builder.build(label: "run-\(label)"),
                             mirror: root + "/mirror.db",
                             outputDirectory: root + "/out",
                             stateDirectory: root)
    }

    /// **The idempotent guard.** `launchd` fires on wake as well as on schedule, so a
    /// laptop opened five times in an hour would otherwise do five full passes for
    /// nothing. Two invocations inside the window do one run and log a skip.
    func testASecondRunInsideTheWindowSkips() throws {
        let paths = try paths(label: "idempotent")
        let run = SyncRun(paths: paths, salt: MetricsFixture.salt)
        let now = MetricsFixture.now

        let first = try run.run(now: now)
        XCTAssertTrue(first.ran)
        XCTAssertNil(first.skippedReason)
        XCTAssertGreaterThan(first.mirrorMessageCount, 0)

        let second = try run.run(now: now.addingTimeInterval(3600))
        XCTAssertFalse(second.ran, "a second run one hour later must skip")
        XCTAssertNotNil(second.skippedReason)
        // And it still reports the corpus size, so a skip is not an absence of news.
        XCTAssertEqual(second.mirrorMessageCount, first.mirrorMessageCount)

        // Past the window, it runs again.
        let later = try run.run(now: now.addingTimeInterval(
            Double(SyncRun.defaultMinimumHoursBetweenRuns) * 3600 + 60))
        XCTAssertTrue(later.ran)
    }

    /// `force` is what the app's own "Scan now" button passes. The guard exists to stop
    /// `launchd` re-running on every wake, not to stop a human who just clicked.
    func testForceOverridesTheGuard() throws {
        let paths = try paths(label: "force")
        let run = SyncRun(paths: paths, salt: MetricsFixture.salt)
        XCTAssertTrue(try run.run(now: MetricsFixture.now).ran)
        XCTAssertTrue(try run.run(now: MetricsFixture.now, force: true).ran)
    }

    /// A run writes the digest, the packs and the heartbeat — the three artefacts the
    /// rest of the product reads.
    func testARunProducesTheDigestThePacksAndTheHeartbeat() throws {
        let paths = try paths(label: "artifacts")
        let outcome = try SyncRun(paths: paths, salt: MetricsFixture.salt)
            .run(now: MetricsFixture.now)

        XCTAssertTrue(outcome.ran)
        let digest = try XCTUnwrap(outcome.digestPath)
        XCTAssertTrue(FileManager.default.fileExists(atPath: digest))
        XCTAssertFalse(outcome.voicePackPaths.isEmpty)
        XCTAssertTrue(outcome.voicePackPaths.contains { $0.hasSuffix("global_fallback.json") })

        let heartbeat = try XCTUnwrap(Heartbeat.read(fromDirectory: paths.stateDirectory))
        XCTAssertEqual(heartbeat.mirror_message_count, outcome.mirrorMessageCount)
        XCTAssertTrue(heartbeat.full_disk_access)
        XCTAssertNotNil(heartbeat.last_successful_sync_at)
    }

    /// **DEGRADE, NEVER FABRICATE.** A thin corpus gets no digest at all — writing one
    /// anyway would let a later step pick it up and send somebody 400 messages dressed
    /// up as their year.
    func testAThinCorpusProducesNoDigestFile() throws {
        let root = "/tmp/boi-a/tests/thin-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        var builder = MetricsFixture.ChatBuilder()
        for index in 1...40 {
            builder.message("hi \(index)", in: "+15550100001",
                            daysAgo: Double(index) * 0.5, fromMe: index.isMultiple(of: 2))
        }
        let paths = SyncRun.Paths(chatDatabase: try builder.build(label: "thin-run"),
                                  mirror: root + "/mirror.db",
                                  outputDirectory: root + "/out",
                                  stateDirectory: root)
        let outcome = try SyncRun(paths: paths, salt: MetricsFixture.salt)
            .run(now: MetricsFixture.now)

        XCTAssertTrue(outcome.ran)
        XCTAssertEqual(outcome.health, .thin)
        XCTAssertNil(outcome.digestPath, "a thin corpus must not produce a report")
        XCTAssertTrue(outcome.voicePackPaths.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root + "/out/digest.json"))
        // The heartbeat still goes out — the Mac is alive, it just has nothing to say.
        XCTAssertNotNil(outcome.heartbeatPath)
    }

    /// **`full_disk_access` has to be able to be `false`, or the alarm built on it is
    /// built on a constant.**
    ///
    /// It used to be a literal `true`, written only after a successful run — so the one
    /// state that matters most, *access denied*, could never be recorded. That is the
    /// signature of a grant dropped by an auto-update, and it is the whole reason
    /// NOTES.md asks Track D to build a fleet-wide alarm on this field.
    ///
    /// A Mac that cannot read `chat.db` must still say so rather than go silent: silent
    /// alone is a laptop in a drawer, silent-and-denied is a diagnosis.
    func testAFailedRunStillLeavesAHeartbeatSayingAccessWasDenied() throws {
        let root = "/tmp/boi-a/tests/denied-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        let paths = SyncRun.Paths(chatDatabase: root + "/there-is-no-chat-db-here.db",
                                  mirror: root + "/mirror.db",
                                  outputDirectory: root + "/out",
                                  stateDirectory: root)

        XCTAssertThrowsError(try SyncRun(paths: paths, salt: MetricsFixture.salt)
            .runReportingFailures(now: MetricsFixture.now),
            "an unreadable chat.db must still be an error")

        let heartbeat = try XCTUnwrap(Heartbeat.read(fromDirectory: root),
                                      "a failed run went completely silent — indistinguishable "
                                      + "from a laptop in a drawer")
        XCTAssertFalse(heartbeat.full_disk_access,
                       "the field the fleet-wide alarm correlates on must be able to be false")
        XCTAssertNil(heartbeat.last_successful_sync_at)
        XCTAssertTrue(heartbeat.isStale(now: MetricsFixture.now))
    }

    /// And the successful path reports it as probed, not asserted.
    func testASuccessfulRunProbesRatherThanAssertingAccess() throws {
        let paths = try paths(label: "probed")
        _ = try SyncRun(paths: paths, salt: MetricsFixture.salt).run(now: MetricsFixture.now)
        let heartbeat = try XCTUnwrap(Heartbeat.read(fromDirectory: paths.stateDirectory))
        XCTAssertTrue(heartbeat.full_disk_access)
        // The probe really did open the database this run read from.
        XCTAssertEqual(FullDiskAccess.probe(path: paths.chatDatabase), .granted)
    }

    /// An installed app keeps its data in Application Support, not in `/tmp`, and the
    /// LaunchAgent's working directory is `/` so nothing may depend on the cwd.
    func testInstalledPathsLiveInApplicationSupport() {
        let paths = SyncRun.Paths.installed(home: URL(fileURLWithPath: "/Users/example"))
        XCTAssertEqual(paths.mirror,
                       "/Users/example/Library/Application Support/Boi/mirror.db")
        XCTAssertEqual(paths.chatDatabase, "/Users/example/Library/Messages/chat.db")
        XCTAssertTrue(paths.outputDirectory.hasPrefix(
            "/Users/example/Library/Application Support/Boi"))
    }
}

private extension String {
    /// Replaces the first occurrence only — the plist mutations above need exactly one.
    func replacingOccurrences(of target: String, of replacement: String) -> String {
        guard let range = range(of: target) else { return self }
        return replacingCharacters(in: range, with: replacement)
    }
}

// MARK: - The poll -> relaunch decision

final class GrantWatcherTests: XCTestCase {

    /// **FINDING 4, AS A STATE MACHINE.** The grant does not apply to an already-running
    /// process, so the watcher's job is to notice the flip and hand over to a relaunch —
    /// once.
    func testItReportsTheGrantExactlyOnce() {
        var granted = false
        let watcher = GrantWatcher(probe: { granted ? .granted : .denied(detail: "no") })

        XCTAssertEqual(watcher.tick(), .waiting(polls: 1))
        XCTAssertEqual(watcher.tick(), .waiting(polls: 2))
        XCTAssertFalse(watcher.hasSeenGrant)

        granted = true
        guard case .granted(let polls, _) = watcher.tick() else {
            return XCTFail("the flip was not reported")
        }
        XCTAssertEqual(polls, 3)
        XCTAssertTrue(watcher.hasSeenGrant)

        // And it does not fire again — a second relaunch would restart an app that is
        // already on its way out.
        guard case .granted = watcher.tick() else { return XCTFail("state was lost") }
        XCTAssertEqual(watcher.lastEvent, watcher.tick())
    }

    /// The elapsed time is measured from the first poll, which is what the report claims
    /// when it says the grant was noticed within one poll interval.
    func testItMeasuresHowLongTheUserTookFromTheFirstPoll() {
        var now = Date(timeIntervalSince1970: 1_800_000_000)
        var granted = false
        let watcher = GrantWatcher(probe: { granted ? .granted : .denied(detail: "no") },
                                   clock: { now })
        _ = watcher.tick()
        now = now.addingTimeInterval(7.5)
        granted = true
        guard case .granted(_, let elapsed) = watcher.tick() else {
            return XCTFail("the flip was not reported")
        }
        XCTAssertEqual(elapsed, 7.5, accuracy: 0.001)
    }

    /// A Mac with no `chat.db` must leave the permission screen rather than poll forever
    /// for a grant that would not help.
    func testAMissingDatabaseEndsThePollRatherThanSpinning() {
        let watcher = GrantWatcher(probe: { .noDatabase })
        XCTAssertEqual(watcher.tick(), .noDatabase)
        XCTAssertFalse(watcher.hasSeenGrant)
    }

    /// **THE TWO-SECOND BUDGET, AS ARITHMETIC.** One poll interval to notice, plus the
    /// pause that lets the checkmark render, has to leave room inside the budget the
    /// Definition of Done measures. This fails if anyone lengthens either one.
    func testTheRelaunchDeadlineIsAchievableFromTheStatedTimings() {
        XCTAssertTrue(GrantWatcher.relaunchDeadlineIsAchievable)
        XCTAssertLessThan(
            GrantWatcher.acknowledgementPause + FullDiskAccess.pollInterval,
            FullDiskAccess.relaunchBudget,
            "notice + acknowledge must fit inside the two seconds, with room to spare")
    }
}
