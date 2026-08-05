import XCTest
@testable import BoiKit

final class WakeSchedulerHelperTests: XCTestCase {
    private final class Handle: WakeHelperRequestHandle {
        private(set) var invalidated = false
        func invalidate() { invalidated = true }
    }

    func testClientSendsOneArgumentFreeRequestAndMapsTypedSuccess() async throws {
        let expected = Date(timeIntervalSince1970: 1_800_000_000)
        var requestCount = 0
        let handle = Handle()
        let client = WakeHelperClient { reply in
            requestCount += 1
            reply(.scheduled(expected))
            return handle
        }
        let outcome = try await client.scheduleNextWake()
        XCTAssertEqual(outcome, .scheduled(expected))
        XCTAssertEqual(requestCount, 1)
        XCTAssertTrue(handle.invalidated)
    }

    func testDegradedHelperResponseFailsClosed() async {
        let client = WakeHelperClient { reply in
            reply(.degraded("caller rejected"))
            return Handle()
        }
        do {
            _ = try await client.scheduleNextWake()
            XCTFail("degraded response must throw")
        } catch {
            XCTAssertEqual(error as? WakeScheduler.Error,
                           .helperRejected(detail: "caller rejected"))
        }
    }

    func testMissingHelperTimesOutAndInvalidatesItsConnection() async {
        let handle = Handle()
        var lateReply: ((WakeHelperResponse) -> Void)?
        let client = WakeHelperClient(timeout: 0.001) { reply in
            lateReply = reply
            return handle
        }
        do {
            _ = try await client.scheduleNextWake()
            XCTFail("timeout must throw")
        } catch {
            XCTAssertEqual(error as? WakeScheduler.Error, .authorizedHelperUnavailable)
        }
        XCTAssertTrue(handle.invalidated)
        lateReply?(.scheduled(Date(timeIntervalSince1970: 1_900_000_000)))
        XCTAssertTrue(handle.invalidated)
    }

    func testSigningRequirementRejectsAdHocWrongIdentityAndInvalidSelfAnchor() {
        var validationCalls = 0
        XCTAssertThrowsError(try WakeHelperSigningRequirement.peerRequirement(
            expectedSelfIdentifier: "app.boi.mac", peerIdentifier: "app.boi.mac.wake-helper",
            readIdentity: { nil },
            validateSelf: { _ in validationCalls += 1; return true })) { error in
            XCTAssertEqual(error as? WakeHelperSigningRequirement.Error, .unverifiableSelf)
        }
        XCTAssertThrowsError(try WakeHelperSigningRequirement.peerRequirement(
            expectedSelfIdentifier: "app.boi.mac", peerIdentifier: "app.boi.mac.wake-helper",
            readIdentity: { .init(identifier: "wrong.app", teamIdentifier: "TEAM123") },
            validateSelf: { _ in true })) { error in
            XCTAssertEqual(error as? WakeHelperSigningRequirement.Error, .wrongSelfIdentifier)
        }
        XCTAssertThrowsError(try WakeHelperSigningRequirement.peerRequirement(
            expectedSelfIdentifier: "app.boi.mac", peerIdentifier: "app.boi.mac.wake-helper",
            readIdentity: { .init(identifier: "app.boi.mac", teamIdentifier: "TEAM123") },
            validateSelf: { _ in validationCalls += 1; return false })) { error in
            XCTAssertEqual(error as? WakeHelperSigningRequirement.Error, .invalidSelfSignature)
        }
        XCTAssertEqual(validationCalls, 1)
    }

    func testSigningRequirementPinsExactPeerIdentifierAndSameValidatedTeam() throws {
        var captured = ""
        let requirement = try WakeHelperSigningRequirement.peerRequirement(
            expectedSelfIdentifier: "app.boi.mac.wake-helper", peerIdentifier: "app.boi.mac",
            readIdentity: {
                .init(identifier: "app.boi.mac.wake-helper", teamIdentifier: "A1B2C3")
            }, validateSelf: { value in captured = value; return true })
        XCTAssertEqual(captured,
                       "anchor apple generic and identifier \"app.boi.mac.wake-helper\" "
                       + "and certificate leaf[subject.OU] = \"A1B2C3\"")
        XCTAssertEqual(requirement,
                       "anchor apple generic and identifier \"app.boi.mac\" "
                       + "and certificate leaf[subject.OU] = \"A1B2C3\"")
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
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let now = calendar.date(from: DateComponents(year: 2026, month: 8, day: 5,
                                                     hour: 7, minute: 30))!
        XCTAssertTrue(WakeHelperCommandPolicy.allows(
            executable: "/usr/bin/pmset", arguments: ["-g", "sched"],
            now: now, calendar: calendar))
        XCTAssertTrue(WakeHelperCommandPolicy.allows(
            executable: "/usr/bin/pmset",
            arguments: ["schedule", "wake", "08/05/26 08:00:00"],
            now: now, calendar: calendar))

        let rejected: [(String, [String])] = [
            ("/bin/sh", ["-c", "pmset schedule wake tomorrow"]),
            ("/usr/bin/pmset", ["repeat", "wake", "MTWRFSU", "08:00:00"]),
            ("/usr/bin/pmset", ["schedule", "sleep", "08/06/26 08:00:00"]),
            ("/usr/bin/pmset", ["schedule", "wakeorpoweron", "08/06/26 08:00:00"]),
            ("/usr/bin/pmset", ["schedule", "cancelall"]),
            ("/usr/bin/pmset", ["schedule", "wake", "tomorrow"]),
            ("/usr/bin/pmset", ["schedule", "wake", "08/05/26 09:13:47"]),
            ("/usr/bin/pmset", ["schedule", "wake", "08/05/26 12:00:00"]),
            ("/usr/bin/pmset", ["schedule", "wake", "08/06/26 08:00:00", "extra"]),
        ]
        for (executable, arguments) in rejected {
            XCTAssertFalse(WakeHelperCommandPolicy.allows(executable: executable,
                                                          arguments: arguments,
                                                          now: now, calendar: calendar),
                           "accepted broad command: \(executable) \(arguments)")
        }
    }

    func testCancellationInvalidatesConnectionAndLateReplyCannotWin() async {
        let handle = Handle()
        var reply: ((WakeHelperResponse) -> Void)?
        let client = WakeHelperClient(timeout: 60) { callback in
            reply = callback
            return handle
        }
        let task = Task { try await client.scheduleNextWake() }
        while reply == nil { await Task.yield() }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("cancelled request must throw")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        XCTAssertTrue(handle.invalidated)
        reply?(.scheduled(Date(timeIntervalSince1970: 1_900_000_000)))
        XCTAssertTrue(handle.invalidated)
    }

    func testTransactionsAreSerializedAcrossConcurrentConnections() {
        let queue = WakeHelperTransactionQueue(label: "test.wake.transactions")
        let complete = expectation(description: "all transactions")
        complete.expectedFulfillmentCount = 8
        let lock = NSLock()
        var active = 0
        var maximumActive = 0
        for _ in 0..<8 {
            DispatchQueue.global().async {
                queue.perform {
                    lock.lock()
                    active += 1
                    maximumActive = max(maximumActive, active)
                    lock.unlock()
                    Thread.sleep(forTimeInterval: 0.002)
                    lock.lock()
                    active -= 1
                    lock.unlock()
                    complete.fulfill()
                }
            }
        }
        wait(for: [complete], timeout: 2)
        XCTAssertEqual(maximumActive, 1)
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
        XCTAssertFalse(helper.contains("connection.processIdentifier"))
        XCTAssertFalse(contract.contains("SecCodeCopyGuestWithAttributes"))
        XCTAssertTrue(helper.contains("setConnectionCodeSigningRequirement"))
        XCTAssertTrue(contract.contains("setCodeSigningRequirement(peerRequirement)"))
        XCTAssertTrue(helper.contains("terminated.wait(timeout:"))
        XCTAssertTrue(helper.contains("process.terminate()"))
        XCTAssertTrue(helper.contains("SIGKILL"))
        let signing = try XCTUnwrap(helper.range(of: "setConnectionCodeSigningRequirement"))
        let activation = try XCTUnwrap(helper.range(of: "listener.activate()"))
        XCTAssertLessThan(signing.lowerBound, activation.lowerBound)
        let clientSigning = try XCTUnwrap(contract.range(of: "setCodeSigningRequirement"))
        let clientActivation = try XCTUnwrap(contract.range(of: "connection.activate()"))
        XCTAssertLessThan(clientSigning.lowerBound, clientActivation.lowerBound)
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
