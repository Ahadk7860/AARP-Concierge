import XCTest
@testable import BoiKit

final class WakeSchedulerHelperTests: XCTestCase {
    func testClientSendsOneArgumentFreeRequestAndMapsTypedSuccess() throws {
        let expected = Date(timeIntervalSince1970: 1_800_000_000)
        var requestCount = 0
        let client = WakeHelperClient { reply in
            requestCount += 1
            reply(.scheduled(expected))
        }

        let callerSuppliedDate = Date(timeIntervalSince1970: 42)
        XCTAssertEqual(try client.scheduleNextWake(after: callerSuppliedDate),
                       .scheduled(expected))
        XCTAssertEqual(requestCount, 1)
    }

    func testDegradedHelperResponseFailsClosed() {
        let client = WakeHelperClient { reply in reply(.degraded("caller rejected")) }
        XCTAssertThrowsError(try client.scheduleNextWake(after: Date())) { error in
            XCTAssertEqual(error as? WakeScheduler.Error,
                           .helperRejected(detail: "caller rejected"))
        }
    }

    func testMissingHelperTimesOutAsAuthorizationUnavailable() {
        let client = WakeHelperClient(timeout: 0.001) { _ in }
        XCTAssertThrowsError(try client.scheduleNextWake(after: Date())) { error in
            XCTAssertEqual(error as? WakeScheduler.Error, .authorizedHelperUnavailable)
        }
    }

    func testAuthorizationRejectsAdHocAndInvalidProductionCallers() {
        var validationCalls = 0
        let adHoc = WakeHelperCallerAuthorization(teamIdentifier: { nil }) { _, _ in
            validationCalls += 1
            return true
        }
        XCTAssertFalse(adHoc.allows(pid: 123))
        XCTAssertEqual(validationCalls, 0, "no Team ID must fail before code validation")

        let invalid = WakeHelperCallerAuthorization(teamIdentifier: { "TEAM123" }) {
            pid, requirement in
            validationCalls += 1
            XCTAssertEqual(pid, 456)
            XCTAssertTrue(requirement.contains("identifier \"app.boi.mac\""))
            XCTAssertTrue(requirement.contains("subject.OU] = \"TEAM123\""))
            return false
        }
        XCTAssertFalse(invalid.allows(pid: 456))
        XCTAssertEqual(validationCalls, 1)
    }

    func testAuthorizationAcceptsOnlyAnExactIdentifierAndSameTeamRequirement() {
        var captured = ""
        let authorization = WakeHelperCallerAuthorization(teamIdentifier: { "A1B2C3" }) {
            _, requirement in
            captured = requirement
            return true
        }
        XCTAssertTrue(authorization.allows(pid: 789))
        XCTAssertEqual(captured,
                       "anchor apple generic and identifier \"app.boi.mac\" "
                       + "and certificate leaf[subject.OU] = \"A1B2C3\"")
        XCTAssertFalse(authorization.allows(pid: 0))
    }

    func testLaunchDaemonPlistHasOneMachServiceAndBundleProgram() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let plistURL = root.appendingPathComponent("Sources/BoiWakeHelper/")
            .appendingPathComponent(WakeHelperContract.plistName)
        let data = try Data(contentsOf: plistURL)
        let value = try XCTUnwrap(PropertyListSerialization.propertyList(from: data,
                                                                          format: nil)
                                  as? [String: Any])
        XCTAssertEqual(value["Label"] as? String, WakeHelperContract.serviceName)
        XCTAssertEqual(value["BundleProgram"] as? String, WakeHelperContract.bundleProgram)
        XCTAssertNil(value["ProgramArguments"])
        XCTAssertNil(value["Program"])
        let services = try XCTUnwrap(value["MachServices"] as? [String: Bool])
        XCTAssertEqual(services, [WakeHelperContract.serviceName: true])
        XCTAssertEqual(value["AssociatedBundleIdentifiers"] as? [String],
                       [WakeHelperContract.authorizedAppIdentifier])
    }

    func testCommandPolicyRejectsEveryBroaderPMSetMutation() {
        XCTAssertTrue(WakeHelperCommandPolicy.allows(
            executable: "/usr/bin/pmset", arguments: ["-g", "sched"]))
        XCTAssertTrue(WakeHelperCommandPolicy.allows(
            executable: "/usr/bin/pmset",
            arguments: ["schedule", "wake", "08/06/26 08:00:00"]))

        let rejected: [(String, [String])] = [
            ("/bin/sh", ["-c", "pmset schedule wake tomorrow"]),
            ("/usr/bin/pmset", ["repeat", "wake", "MTWRFSU", "08:00:00"]),
            ("/usr/bin/pmset", ["schedule", "sleep", "08/06/26 08:00:00"]),
            ("/usr/bin/pmset", ["schedule", "wakeorpoweron", "08/06/26 08:00:00"]),
            ("/usr/bin/pmset", ["schedule", "cancelall"]),
            ("/usr/bin/pmset", ["schedule", "wake", "tomorrow"]),
            ("/usr/bin/pmset", ["schedule", "wake", "08/06/26 08:00:00", "extra"]),
        ]
        for (executable, arguments) in rejected {
            XCTAssertFalse(WakeHelperCommandPolicy.allows(executable: executable,
                                                          arguments: arguments),
                           "accepted broad command: \(executable) \(arguments)")
        }
    }

    func testIPCAndHelperSourcesHaveNoBroadRequestOrCommandSurface() throws {
        let testURL = URL(fileURLWithPath: #filePath)
        let tests = testURL.deletingLastPathComponent()
        let mac = tests.deletingLastPathComponent().deletingLastPathComponent()
        let contract = try String(contentsOf: mac.appendingPathComponent(
            "Sources/BoiKit/WakeSchedulerHelper.swift"))
        let helper = try String(contentsOf: mac.appendingPathComponent(
            "Sources/BoiWakeHelper/main.swift"))

        let protocolStart = try XCTUnwrap(contract.range(of: "@objc public protocol"))
        let protocolEnd = try XCTUnwrap(contract.range(of: "\n}\n", range: protocolStart.upperBound..<contract.endIndex))
        let protocolText = String(contract[protocolStart.lowerBound..<protocolEnd.upperBound])
        XCTAssertEqual(ipcProblems(protocolText), [])

        XCTAssertEqual(helper.components(separatedBy: "Process()").count - 1, 1)
        for escape in ["/bin/sh", "/bin/zsh", "/usr/bin/sudo", "osascript"] {
            XCTAssertFalse(helper.contains(escape), "privilege escape in helper: \(escape)")
        }
        XCTAssertTrue(helper.contains("WakeHelperCommandPolicy.allows"))
    }

    func testBroadIPCMutationsAreRejectedByTheSameGuard() {
        let valid = """
        @objc public protocol WakeHelperXPCProtocol {
            func reschedule(reply: @escaping (Int, Date?, String?) -> Void)
        }
        """
        XCTAssertEqual(ipcProblems(valid), [])

        let callerDate = valid.replacingOccurrences(
            of: "reschedule(reply:", with: "reschedule(date: Date, reply:")
        XCTAssertTrue(ipcProblems(callerDate).contains { $0.contains("date:") })

        let arbitraryCommand = valid.replacingOccurrences(
            of: "reschedule(reply:", with: "reschedule(command: String, reply:")
        XCTAssertTrue(ipcProblems(arbitraryCommand).contains { $0.contains("command:") })

        let secondMethod = valid.replacingOccurrences(
            of: "\n}", with: "\n    func cancelAll(reply: @escaping (Bool) -> Void)\n}")
        XCTAssertTrue(ipcProblems(secondMethod).contains { $0.contains("exactly one") })
    }

    private func ipcProblems(_ source: String) -> [String] {
        var problems: [String] = []
        if source.components(separatedBy: "func ").count - 1 != 1 {
            problems.append("IPC must expose exactly one method")
        }
        if !source.contains("func reschedule(reply:") {
            problems.append("only argument-free reschedule is allowed")
        }
        for broadName in ["date:", "arguments:", "command:", "executable:", "mode:"]
            where source.contains(broadName) {
            problems.append("broad IPC field: \(broadName)")
        }
        return problems
    }
}
