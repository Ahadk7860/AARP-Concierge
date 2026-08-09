import Network
import XCTest
@testable import BoiKit

// A join that passes because both sides were stubbed is not a join.
//
// Every upload test below talks to a REAL HTTP server over a REAL loopback socket, with
// the shipping `URLSessionTransport` on the other end. Nothing here swaps `URLProtocol`,
// injects a fake response, or asserts on a log line that a stub produced. The two places
// a transport is injected are the two conditions no server can express — a connection
// that fails before a status exists, and a clock that moves faster than the wall.

// MARK: - A real HTTP server

/// HTTP/1.1 on a loopback socket, enough of it to be honest.
///
/// This exists because the alternative — stubbing `URLSession` — would let an uploader
/// that never opens a socket pass every criterion in prompt `01`. Bytes go out over TCP,
/// come back parsed, and the recorded requests below are what a server actually received.
final class LoopbackHTTPServer: @unchecked Sendable {

    struct Request {
        var method: String
        var path: String
        var headers: [String: String]
        var body: Data
    }

    struct Response {
        var status: Int
        var body: Data

        static func json(_ status: Int, _ object: [String: Any]) -> Response {
            Response(status: status,
                     body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data())
        }

        static let accepted = Response.json(202, ["digest_id": "dg_test", "received_at": "2026-08-03T00:00:00Z"])
        static let noContent = Response(status: 204, body: Data())
        static let serverError = Response.json(500, ["error": "internal"])
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "boi.test.loopback")
    private let lock = NSLock()
    private var _requests: [Request] = []
    private var handler: (Request) -> Response

    /// Every request the server received, in order. Bodies included — this is the only
    /// place in the suite that is allowed to look at one, because it is standing in for
    /// the server.
    var requests: [Request] {
        lock.lock(); defer { lock.unlock() }
        return _requests
    }

    var port: UInt16 { listener.port?.rawValue ?? 0 }
    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    init(handler: @escaping (Request) -> Response = { _ in .accepted }) throws {
        self.handler = handler
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        listener = try NWListener(using: parameters, on: .any)

        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
            if case .failed = state { ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 5) == .success, listener.port != nil else {
            throw NSError(domain: "LoopbackHTTPServer", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "listener never became ready"])
        }
    }

    /// Swap the behaviour mid-test — a server that fails and then recovers is the whole
    /// point of the retry criteria.
    func respond(with handler: @escaping (Request) -> Response) {
        lock.lock(); defer { lock.unlock() }
        self.handler = handler
    }

    func stop() { listener.cancel() }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        read(connection, accumulated: Data())
    }

    private func read(_ connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) {
            [weak self] chunk, _, isComplete, error in
            guard let self else { return }
            var buffer = accumulated
            if let chunk { buffer.append(chunk) }

            if let request = Self.parse(buffer) {
                self.lock.lock()
                self._requests.append(request)
                let handler = self.handler
                self.lock.unlock()
                self.write(handler(request), to: connection)
                return
            }
            if error != nil || isComplete {
                connection.cancel()
                return
            }
            self.read(connection, accumulated: buffer)
        }
    }

    /// Returns nil until the headers and the whole declared body have arrived.
    private static func parse(_ buffer: Data) -> Request? {
        let separator = Data("\r\n\r\n".utf8)
        guard let range = buffer.range(of: separator) else { return nil }
        let headerBytes = buffer[buffer.startIndex..<range.lowerBound]
        guard let headerText = String(data: headerBytes, encoding: .utf8) else { return nil }
        let lines = headerText.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return nil }

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = String(line[line.startIndex..<colon]).lowercased()
            let value = String(line[line.index(after: colon)...])
                .trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }

        let declared = Int(headers["content-length"] ?? "0") ?? 0
        let body = buffer[range.upperBound...]
        guard body.count >= declared else { return nil }
        return Request(method: String(parts[0]), path: String(parts[1]), headers: headers,
                       body: Data(body.prefix(declared)))
    }

    private func write(_ response: Response, to connection: NWConnection) {
        let head = """
            HTTP/1.1 \(response.status) \(Self.reason(response.status))\r
            Content-Type: application/json\r
            Content-Length: \(response.body.count)\r
            Connection: close\r
            \r

            """.replacingOccurrences(of: "\n\n", with: "\n")
        var data = Data(head.utf8)
        data.append(response.body)
        connection.send(content: data, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 202: return "Accepted"
        case 204: return "No Content"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 409: return "Conflict"
        case 422: return "Unprocessable Entity"
        case 500: return "Internal Server Error"
        default: return "Status"
        }
    }
}

// MARK: - Helpers

enum UploadFixture {

    static let identity = DeviceIdentity(user_id: "usr_e2e0000000000001",
                                         device_token: "dev-token-for-tests")

    static func scratch(_ label: String) throws -> String {
        // CONTRACTS.md § 9 assigns Track A `/tmp/boi-a`; Track E has no row of its own
        // and reuses it now that Track A has merged and stopped. Recorded in NOTES.md.
        let path = "/tmp/boi-a/tests/upload-\(label)-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        return path
    }

    /// A `digest.v1`-shaped document. Small on purpose — these tests are about the wire,
    /// not about the digest, and `DigestTests` already owns the shape.
    static func digest(generatedAt: String = "2026-08-03T09:00:00Z") -> Digest {
        Digest(user_id: identity.user_id,
               device_id: "dev_e2e0000000000001",
               generated_at: generatedAt,
               corpus: CorpusSummary(message_count: 12, thread_count: 3, first_message_at: nil,
                                     last_message_at: nil, span_days: 90, green_share: nil,
                                     messages_in_icloud: nil, retention_boundary: nil,
                                     days_since_newest: 1, health: .healthy,
                                     health_reasons: nil, as_of: generatedAt),
               relationships: [],
               whole_life: WholeLife(as_of: generatedAt))
    }

    static func uploader(base: URL, transport: Uploader.Transport? = nil,
                         dryRun: Bool = false) -> Uploader {
        Uploader(configuration: .init(baseURL: base, timeout: 5, dryRun: dryRun),
                 identity: identity, transport: transport)
    }

    /// Captures log events instead of printing them, so a test can assert on what a log
    /// line contains — and, more importantly, on what it does not.
    final class LogSpy: @unchecked Sendable {
        private let lock = NSLock()
        private(set) var lines: [String] = []

        func sink(_ event: String, _ level: StructuredLog.Level, _ fields: [String: Any]) {
            let line = StructuredLog.line(event, level: level, fields: fields)
            lock.lock(); lines.append(line); lock.unlock()
        }

        var joined: String { lines.joined(separator: "\n") }
    }
}

/// A transport that fails before a status exists. The one condition a live server cannot
/// produce on demand.
struct RefusingTransport: Uploader.Transport {
    let error: URLError
    func send(request: URLRequest) throws -> (status: Int, body: Data) { throw error }
}

// MARK: - Sending

final class UploaderSendTests: XCTestCase {

    func testADigestReachesARealServerAsBytesAndCredentials() throws {
        let server = try LoopbackHTTPServer()
        defer { server.stop() }

        let digest = UploadFixture.digest()
        let body = try JSONEncoder().encode(digest)
        let result = UploadFixture.uploader(base: server.baseURL)
            .send(body, to: .digest, descriptor: .forDigest(digest), log: { _, _, _ in })

        XCTAssertEqual(result, .accepted(status: 202))
        XCTAssertEqual(server.requests.count, 1, "the request must have crossed a socket")

        let request = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/v1/digest",
                       "BOI_API_BASE carries no path suffix; the routes are absolute")
        XCTAssertEqual(request.headers["authorization"],
                       "Bearer \(UploadFixture.identity.device_token)")
        XCTAssertEqual(request.headers["content-type"], "application/json")
        XCTAssertEqual(request.body, body, "the server must receive the bytes we were given")
    }

    func testTheThreeRoutesAreTheThreeRoutesInTheFrozenSpec() {
        XCTAssertEqual(Uploader.Endpoint.digest.rawValue, "/v1/digest")
        XCTAssertEqual(Uploader.Endpoint.voicePack.rawValue, "/v1/voice-pack")
        XCTAssertEqual(Uploader.Endpoint.heartbeat.rawValue, "/v1/heartbeat")
    }

    func testABaseURLWithATrailingSlashDoesNotProduceADoubleSlash() {
        let uploader = UploadFixture.uploader(base: URL(string: "http://example.test/")!)
        XCTAssertEqual(uploader.url(for: .digest).absoluteString, "http://example.test/v1/digest")
    }

    func testStatusClassification() {
        // The distinction the queue is built on. A rejected payload will be rejected
        // identically forever; a retryable one will not.
        func classify(_ status: Int, _ body: String = "", _ endpoint: Uploader.Endpoint = .digest)
            -> Uploader.Result {
            Uploader.classify(status: status, body: Data(body.utf8), endpoint: endpoint)
        }
        XCTAssertEqual(classify(202), .accepted(status: 202))
        XCTAssertEqual(classify(204), .accepted(status: 204))
        XCTAssertEqual(classify(409, #"{"error":"duplicate"}"#), .duplicate)
        XCTAssertEqual(classify(401, #"{"error":"unauthorized"}"#),
                       .rejected(status: 401, code: "unauthorized"))
        XCTAssertEqual(classify(422, #"{"error":"redaction_failed"}"#, .voicePack),
                       .rejected(status: 422, code: "redaction_failed"))
        XCTAssertEqual(classify(400, #"{"error":"validation"}"#),
                       .rejected(status: 400, code: "validation"))
        XCTAssertEqual(classify(500, #"{"error":"internal"}"#),
                       .retryable(status: 500, code: "internal"))
        XCTAssertEqual(classify(503), .retryable(status: 503, code: "server_error"))
    }

    func testAServerErrorSlugThatIsNotASlugIsNotEchoedIntoTheLog() {
        // `detail` is never read, and `error` is bounded and character-restricted. A
        // server that put user content where a slug belongs must not get it logged.
        let hostile = #"{"error":"maya asked if you are still coming on the 14th","detail":"x"}"#
        XCTAssertEqual(Uploader.errorSlug(in: Data(hostile.utf8)), "unrecognized_error_slug")
    }

    func testATransportFailureIsRetryableAndCarriesNoBody() {
        let spy = UploadFixture.LogSpy()
        let uploader = UploadFixture.uploader(base: URL(string: "http://127.0.0.1:1")!,
                                              transport: RefusingTransport(
                                                error: URLError(.cannotConnectToHost)))
        let digest = UploadFixture.digest()
        let body = try! JSONEncoder().encode(digest)
        let result = uploader.send(body, to: .digest, descriptor: .forDigest(digest),
                                   log: spy.sink)

        XCTAssertEqual(result, .retryable(status: nil, code: "cannot_connect"))
        XCTAssertFalse(result.isTerminal)
        XCTAssertTrue(spy.joined.contains("\"byte_count\":\(body.count)"))
        XCTAssertFalse(spy.joined.contains("usr_"),
                       "a failure log must not carry the payload's identifiers")
    }
}

// MARK: - The queue

final class UploadQueueTests: XCTestCase {

    func testEnqueueThenReadBackReturnsTheExactBytes() throws {
        let directory = try UploadFixture.scratch("roundtrip")
        let queue = UploadQueue(directory: directory, log: { _, _, _ in })
        let body = Data("{\"schema_version\":\"digest.v1\"}".utf8)

        let entry = try queue.enqueue(body, to: .digest,
                                      descriptor: .init(schemaVersion: "digest.v1",
                                                        asOf: "2026-08-03T09:00:00Z"))
        XCTAssertEqual(try queue.depth(), 1)
        XCTAssertEqual(try queue.body(of: entry), body)
        XCTAssertEqual(entry.attempts, 0)
        XCTAssertEqual(entry.byte_count, body.count)
    }

    func testTheEnvelopeIsWrittenAfterTheBodySoAHalfEnqueueIsInvisible() throws {
        // The ordering that makes "survives process death" true rather than aspirational:
        // a body with no envelope is swept, and an envelope can never name a body that is
        // not there. Simulated by writing the halves by hand, because the real thing is a
        // SIGKILL landing between two syscalls.
        let directory = try UploadFixture.scratch("halfwrite")
        let queue = UploadQueue(directory: directory, log: { _, _, _ in })
        try FileManager.default.createDirectory(at: queue.directory,
                                                withIntermediateDirectories: true)

        // Half one: a body, no envelope. Invisible.
        try Data("orphan".utf8).write(to: queue.bodyURL("000000000000001-aaaaaaaa"))
        XCTAssertEqual(try queue.depth(), 0, "a body with no envelope is not a queue entry")

        // Half two: an envelope whose body vanished. Swept, not retried forever.
        let entry = try queue.enqueue(Data("{}".utf8), to: .digest, descriptor: .init())
        try FileManager.default.removeItem(at: queue.bodyURL(entry.id))
        XCTAssertEqual(try queue.depth(), 0, "an envelope with no body is swept")
    }

    func testIdenticalBytesCollapseRatherThanStacking() throws {
        let directory = try UploadFixture.scratch("dedupe")
        let queue = UploadQueue(directory: directory, log: { _, _, _ in })
        let body = Data("{\"a\":1}".utf8)

        let first = try queue.enqueue(body, to: .digest, descriptor: .init())
        _ = try queue.recordFailure(first, now: Date(), random: { _ in 1 })
        let second = try queue.enqueue(body, to: .digest, descriptor: .init())

        XCTAssertEqual(try queue.depth(), 1)
        XCTAssertEqual(second.id, first.id)
        XCTAssertEqual(second.attempts, 1,
                       "a re-enqueue must not reset the backoff a failing payload earned")
    }

    func testTheQueueIsBoundedAndSaysWhatItDropped() throws {
        let directory = try UploadFixture.scratch("overflow")
        let spy = UploadFixture.LogSpy()
        let queue = UploadQueue(directory: directory, capacity: 3, log: spy.sink)

        var now = Date(timeIntervalSince1970: 1_780_000_000)
        for index in 0..<5 {
            now = now.addingTimeInterval(60)
            _ = try queue.enqueue(Data("{\"n\":\(index)}".utf8), to: .digest,
                                  descriptor: .init(), now: now)
        }
        XCTAssertEqual(try queue.depth(), 3)
        XCTAssertTrue(spy.joined.contains("upload.queue.overflow"),
                      "a silent drop is the failure this bound exists to make visible")
        // The newest survive: the freshest digest is the one worth having.
        let remaining = try queue.entries().map { try! queue.body(of: $0) }
        XCTAssertEqual(remaining.last, Data("{\"n\":4}".utf8))
    }

    func testBackoffIsExponentialCappedAndJittered() {
        let backoff = Backoff(base: 60, factor: 2, cap: 3600, jitter: 0.2)
        // Jitter off: the shape.
        let plain = Backoff(base: 60, factor: 2, cap: 3600, jitter: 0)
        XCTAssertEqual(plain.delay(forAttempt: 1), 60)
        XCTAssertEqual(plain.delay(forAttempt: 2), 120)
        XCTAssertEqual(plain.delay(forAttempt: 6), 1920)
        XCTAssertEqual(plain.delay(forAttempt: 7), 3600, "capped")
        XCTAssertEqual(plain.delay(forAttempt: 400), 3600, "and still capped, finitely")

        // Jitter on: bounded, and actually varying. A "jitter" that returns the same
        // number every time is the bug this asserts against — a fleet that lost network
        // together would retry in lockstep.
        var seen: Set<Int> = []
        for _ in 0..<50 {
            let delay = backoff.delay(forAttempt: 3)
            XCTAssertGreaterThanOrEqual(delay, 240 * 0.8)
            XCTAssertLessThanOrEqual(delay, 240 * 1.2)
            seen.insert(Int(delay * 1000))
        }
        XCTAssertGreaterThan(seen.count, 1, "jitter must vary")
    }

    func testTenConsecutiveFailuresDoNotHammerTheServer() throws {
        // THE BOUND, ON A CONTROLLED CLOCK. No `sleep`, no wall time: the queue is asked
        // what is due at a simulated instant, and the instant is advanced by hand.
        let directory = try UploadFixture.scratch("bound")
        let queue = UploadQueue(directory: directory, log: { _, _, _ in })
        let backoff = Backoff(base: 60, factor: 2, cap: 3600, jitter: 0.2)
        // Worst case for the bound is the smallest jitter, so pin it there rather than
        // sampling: a flaky bound assertion gets deleted, and then there is no bound.
        let shortestJitter: (ClosedRange<Double>) -> Double = { $0.lowerBound }

        let start = Date(timeIntervalSince1970: 1_780_000_000)
        var now = start
        var entry = try queue.enqueue(Data("{\"digest\":true}".utf8), to: .digest,
                                      descriptor: .init(), now: now)

        var attemptTimes: [TimeInterval] = []
        while attemptTimes.count < 10 {
            let due = try queue.due(now: now)
            if due.isEmpty {
                now = now.addingTimeInterval(15)   // the clock ticks; nobody sleeps
                continue
            }
            attemptTimes.append(now.timeIntervalSince(start))
            entry = try queue.recordFailure(entry, now: now, backoff: backoff,
                                            random: shortestJitter)
        }

        let inFirstHour = attemptTimes.filter { $0 <= 3600 }.count
        XCTAssertLessThanOrEqual(inFirstHour, 8,
                                 "10 consecutive failures put \(inFirstHour) requests in the "
                                 + "first hour: \(attemptTimes)")
        XCTAssertGreaterThanOrEqual(attemptTimes.count, 10)
        // Monotonically increasing gaps until the cap, and never beyond it.
        let gaps = zip(attemptTimes.dropFirst(), attemptTimes).map(-)
        for gap in gaps {
            XCTAssertLessThanOrEqual(gap, backoff.maximumDelay + 15,
                                     "a gap of \(gap)s exceeds the cap")
        }
        XCTAssertGreaterThan(attemptTimes.last!, 3600,
                             "ten failures must not all fit inside an hour")
    }
}

// MARK: - Dispatch: the failure path, the retry, and the process boundary

final class UploadDispatchTests: XCTestCase {

    private func payload(_ digest: Digest) throws -> Uploader.Payload {
        .init(body: try JSONEncoder().encode(digest), endpoint: .digest,
              descriptor: .forDigest(digest))
    }

    func testAFiveHundredEnqueuesTheDigestAndTheReportIsNotClean() throws {
        let server = try LoopbackHTTPServer { _ in .serverError }
        defer { server.stop() }
        let directory = try UploadFixture.scratch("five-hundred")
        let queue = UploadQueue(directory: directory, log: { _, _, _ in })

        let report = try UploadFixture.uploader(base: server.baseURL)
            .dispatch([try payload(UploadFixture.digest())], queue: queue,
                      log: { _, _, _ in })

        // ASSERT ON THE QUEUE, NOT ON THE LOG. A log line saying "queued" is exactly the
        // evidence this criterion refuses to accept.
        XCTAssertEqual(try queue.depth(), 1)
        XCTAssertEqual(try queue.entries().first?.endpoint, .digest)
        XCTAssertFalse(report.isClean)
        XCTAssertEqual(report.queued, 1)
        XCTAssertEqual(report.accepted, 0)
    }

    func testTheQueuedDigestUploadsOnTheNextSuccessfulSyncAndOnlyThenLeaves() throws {
        let server = try LoopbackHTTPServer { _ in .serverError }
        defer { server.stop() }
        let directory = try UploadFixture.scratch("recovery")
        let queue = UploadQueue(directory: directory, log: { _, _, _ in })
        let uploader = UploadFixture.uploader(base: server.baseURL)
        let digest = UploadFixture.digest()

        _ = try uploader.dispatch([try payload(digest)], queue: queue, log: { _, _, _ in })
        XCTAssertEqual(try queue.depth(), 1, "a failed upload is kept")

        // The server recovers. The entry is not due yet, so a run right now must not
        // clear it — the backoff is real, not decorative.
        server.respond { _ in .accepted }
        let tooSoon = try uploader.dispatch([], queue: queue, now: Date(), log: { _, _, _ in })
        XCTAssertEqual(try queue.depth(), 1)
        XCTAssertEqual(tooSoon.accepted, 0)

        // ...and once it is due, it goes, and the server receives the original bytes.
        let later = Date().addingTimeInterval(3 * 3600)
        let recovered = try uploader.dispatch([], queue: queue, now: later, log: { _, _, _ in })
        XCTAssertEqual(recovered.accepted, 1)
        XCTAssertEqual(try queue.depth(), 0, "removed only after a 2xx")

        // The document, not the bytes. `JSONEncoder` is NOT byte-stable on Darwin: it
        // serializes through an `NSDictionary`, so key order varies between calls in the
        // same process — twenty encodes of one `CorpusSummary` produce two distinct
        // strings. Asserting on bytes here would be a flaky test asserting the wrong
        // property. Recorded in NOTES.md, because anything that hashes an encoder's
        // output is affected by it.
        let last = try XCTUnwrap(server.requests.last)
        XCTAssertEqual(try JSONDecoder().decode(Digest.self, from: last.body).generated_at,
                       digest.generated_at)
        XCTAssertEqual(try JSONDecoder().decode(Digest.self, from: last.body).user_id,
                       digest.user_id)
    }

    func testTheQueueReplaysTheExactBytesItWasGivenRatherThanReEncoding() throws {
        // The stronger version of the assertion above, on bytes this test controls.
        // A queue that re-encoded its payload could ship a document that differs from
        // the one on disk, and the file is what a support conversation asks for.
        let server = try LoopbackHTTPServer { _ in .serverError }
        defer { server.stop() }
        let directory = try UploadFixture.scratch("byte-exact")
        let queue = UploadQueue(directory: directory, log: { _, _, _ in })
        let uploader = UploadFixture.uploader(base: server.baseURL)
        let body = Data(#"{"schema_version":"digest.v1","marker":"exact-bytes-é"}"#.utf8)

        _ = try uploader.dispatch([.init(body: body, endpoint: .digest, descriptor: .init())],
                              queue: queue, log: { _, _, _ in })
        server.respond { _ in .accepted }
        _ = try uploader.dispatch([], queue: queue, now: Date().addingTimeInterval(3 * 3600),
                              log: { _, _, _ in })

        XCTAssertEqual(server.requests.last?.body, body)
        XCTAssertEqual(try queue.depth(), 0)
    }

    func testAFourTwentyTwoLeavesTheQueueRatherThanRetryingForever() throws {
        // `422 redaction_failed`: the pack was NOT stored and identical bytes will be
        // rejected identically forever. A Mac re-sending it every half hour is the
        // failure mode this branch exists to prevent.
        let server = try LoopbackHTTPServer { _ in
            .json(422, ["error": "redaction_failed", "detail": "exemplars[3]"])
        }
        defer { server.stop() }
        let directory = try UploadFixture.scratch("redaction")
        let spy = UploadFixture.LogSpy()
        let queue = UploadQueue(directory: directory, log: spy.sink)

        let report = try UploadFixture.uploader(base: server.baseURL).dispatch(
            [.init(body: Data("{}".utf8), endpoint: .voicePack, descriptor: .init())],
            queue: queue, log: spy.sink)

        XCTAssertEqual(report.rejected, 1)
        XCTAssertEqual(try queue.depth(), 0)
        XCTAssertTrue(spy.joined.contains("redaction_failed"))
        XCTAssertFalse(spy.joined.contains("exemplars[3]"),
                       "`detail` is free text and is never read into a log")
    }

    func testADuplicateDigestIsASuccessForQueuePurposes() throws {
        let server = try LoopbackHTTPServer { _ in .json(409, ["error": "duplicate"]) }
        defer { server.stop() }
        let directory = try UploadFixture.scratch("duplicate")
        let queue = UploadQueue(directory: directory, log: { _, _, _ in })

        let report = try UploadFixture.uploader(base: server.baseURL)
            .dispatch([try payload(UploadFixture.digest())], queue: queue, log: { _, _, _ in })

        XCTAssertEqual(report.duplicates, 1)
        XCTAssertTrue(report.isClean, "the server already holds this exact digest")
        XCTAssertEqual(try queue.depth(), 0)
    }

    func testOneRetryableFailureStopsTheDrainRatherThanWorkingThroughTheQueue() throws {
        let server = try LoopbackHTTPServer { _ in .serverError }
        defer { server.stop() }
        let directory = try UploadFixture.scratch("stop-drain")
        let queue = UploadQueue(directory: directory, log: { _, _, _ in })
        for index in 0..<4 {
            _ = try queue.enqueue(Data("{\"n\":\(index)}".utf8), to: .digest,
                                  descriptor: .init())
        }

        _ = try UploadFixture.uploader(base: server.baseURL)
            .dispatch([], queue: queue, log: { _, _, _ in })

        XCTAssertEqual(server.requests.count, 1,
                       "a Mac waking to a down server makes one request, not four")
        XCTAssertEqual(try queue.depth(), 4)
    }

    func testTheHeartbeatIsNotQueuedBecauseAStaleOneIsWorseThanNone() throws {
        let server = try LoopbackHTTPServer { _ in .serverError }
        defer { server.stop() }
        let directory = try UploadFixture.scratch("heartbeat")
        let queue = UploadQueue(directory: directory, log: { _, _, _ in })

        let beat = HeartbeatUpload(device_id: "dev_1", app_version: "1.0.0",
                                   digest_as_of: "2026-08-03T09:00:00Z")
        _ = try UploadFixture.uploader(base: server.baseURL).dispatch(
            [.init(body: try JSONEncoder().encode(beat), endpoint: .heartbeat,
                   descriptor: .forHeartbeat(beat))],
            queue: queue, log: { _, _, _ in })

        XCTAssertEqual(try queue.depth(), 0,
                       "replaying yesterday's liveness signal would read as a live Mac")
    }

    func testDryRunOverANonEmptyQueueDeletesNothing() throws {
        // THE REGRESSION THIS TEST EXISTS FOR. `leavesQueue` was `isTerminal`, and
        // `.dryRun` is terminal — so a `--sync --dry-run` over a queue holding three days
        // of undelivered digests DEQUEUED EVERY ONE without sending a byte. The flag whose
        // entire promise is "uploads nothing" destroyed the backlog instead.
        //
        // The two dry-run tests below both start from an empty queue, where `depth() == 0`
        // is satisfied just as well by a wiped queue as by an untouched one. This one
        // starts full on purpose.
        let server = try LoopbackHTTPServer()
        defer { server.stop() }
        let directory = try UploadFixture.scratch("dry-run-preserves")
        let queue = UploadQueue(directory: directory, log: { _, _, _ in })

        var ids: [String] = []
        for index in 0..<3 {
            let entry = try queue.enqueue(Data("{\"n\":\(index)}".utf8), to: .digest,
                                          descriptor: .init(schemaVersion: "digest.v1"))
            ids.append(entry.id)
        }
        XCTAssertEqual(try queue.depth(), 3)

        let digest = UploadFixture.digest()
        let report = try UploadFixture.uploader(base: server.baseURL, dryRun: true).dispatch(
            [.init(body: try JSONEncoder().encode(digest), endpoint: .digest,
                   descriptor: .forDigest(digest))],
            queue: queue, log: { _, _, _ in })

        XCTAssertEqual(server.requests.count, 0, "--dry-run must not open a socket")
        XCTAssertEqual(try queue.depth(), 3, "--dry-run must not delete a queued digest")
        XCTAssertEqual(try queue.entries().map(\.id), ids, "and must not reorder or replace")
        // Every queued entry was reported, plus the new payload.
        XCTAssertEqual(report.dryRun, 4)
        XCTAssertEqual(report.accepted, 0)

        // And the bodies still round-trip: not truncated, not rewritten.
        XCTAssertEqual(try queue.body(of: try XCTUnwrap(queue.entries().first)),
                       Data("{\"n\":0}".utf8))
    }

    func testDryRunIsTerminalButDoesNotLeaveTheQueue() {
        // The two properties that were conflated, asserted separately so they cannot be
        // re-conflated by someone simplifying `leavesQueue` back to `isTerminal`.
        XCTAssertTrue(Uploader.Result.dryRun.isTerminal, "there is nothing to retry")
        XCTAssertFalse(Uploader.Result.dryRun.leavesQueue, "and nothing to delete")
        for terminal in [Uploader.Result.accepted(status: 202), .duplicate,
                         .rejected(status: 422, code: "redaction_failed")] {
            XCTAssertTrue(terminal.leavesQueue, "\(terminal) is done with the payload")
        }
        XCTAssertFalse(Uploader.Result.retryable(status: 500, code: "internal").leavesQueue)
    }

    func testAnUnwritableQueueThrowsRatherThanReportingACleanRun() throws {
        // `(try? queue.due(now:)) ?? []` and `try? queue.enqueue(…)` turned an unusable
        // queue into an empty drain, a tidy report and exit 0 — a silent success on a
        // failed upload arriving through the queue instead of the socket. Worse, the
        // swallowed enqueues still incremented `report.queued`, so `Deferred` announced
        // "1 queued" over a directory that held nothing.
        let server = try LoopbackHTTPServer { _ in .serverError }
        defer { server.stop() }
        let directory = try UploadFixture.scratch("unwritable")

        // A FILE where the queue's directory needs to be. Every write fails.
        try Data("not a directory".utf8)
            .write(to: URL(fileURLWithPath: directory).appendingPathComponent("upload-queue"))
        let queue = UploadQueue(directory: directory, log: { _, _, _ in })

        let digest = UploadFixture.digest()
        XCTAssertThrowsError(
            try UploadFixture.uploader(base: server.baseURL).dispatch(
                [.init(body: try JSONEncoder().encode(digest), endpoint: .digest,
                       descriptor: .forDigest(digest))],
                queue: queue, log: { _, _, _ in })
        ) { error in
            guard let unavailable = error as? Uploader.QueueUnavailable else {
                return XCTFail("expected QueueUnavailable, got \(error)")
            }
            // The message must not promise a retry that cannot happen.
            XCTAssertTrue(unavailable.description.contains("nothing will be retried"),
                          unavailable.description)
        }
    }

    func testDryRunSendsNothingAtAll() throws {
        let server = try LoopbackHTTPServer()
        defer { server.stop() }
        let directory = try UploadFixture.scratch("dry-run")
        let queue = UploadQueue(directory: directory, log: { _, _, _ in })
        let spy = UploadFixture.LogSpy()

        let digest = UploadFixture.digest()
        let body = try JSONEncoder().encode(digest)
        let report = try UploadFixture.uploader(base: server.baseURL, dryRun: true).dispatch(
            [.init(body: body, endpoint: .digest, descriptor: .forDigest(digest))],
            queue: queue, log: spy.sink)

        XCTAssertEqual(server.requests.count, 0, "--dry-run must not open a socket")
        XCTAssertEqual(report.dryRun, 1)
        XCTAssertTrue(report.isClean)
        XCTAssertTrue(spy.joined.contains("\"byte_count\":\(body.count)"),
                      "the byte count is the thing --dry-run is for")
        XCTAssertTrue(spy.joined.contains("digest.v1"))
    }
}

// MARK: - The wire shape of the heartbeat

final class HeartbeatUploadTests: XCTestCase {

    /// A seam disagreement, asserted so it cannot be un-found.
    ///
    /// Track A's on-disk `Heartbeat` and the frozen `POST /v1/heartbeat` body share
    /// exactly one field name. Track D implements the contract with a strict schema, so
    /// posting Track A's struct is `400 validation` on every field. This test pins the
    /// mapping this track wrote, and would fail if somebody "simplified" it back to
    /// encoding `Heartbeat` directly.
    func testTheOnDiskHeartbeatIsNotTheHeartbeatOnTheWire() throws {
        let onDisk = Heartbeat(as_of: "2026-08-03T09:00:00Z",
                               app_version: "1.2.3",
                               bundle_path_stable: false,
                               full_disk_access: true,
                               last_successful_sync_at: "2026-08-03T08:00:00Z",
                               mirror_message_count: 84_000,
                               corpus_health: CorpusHealth.healthy.rawValue)

        let wire = HeartbeatUpload.from(onDisk, deviceID: "dev_abc",
                                        digestGeneratedAt: "2026-08-03T09:00:00Z")
        XCTAssertEqual(wire.device_id, "dev_abc")
        XCTAssertEqual(wire.app_version, "1.2.3")
        XCTAssertEqual(wire.digest_as_of, "2026-08-03T09:00:00Z")
        XCTAssertEqual(wire.fda_granted, true)

        // The contract sets `additionalProperties: false`. Every key the encoder emits
        // must be one the frozen spec names, or the strict schema rejects the whole body.
        let permitted: Set<String> = ["device_id", "app_version", "digest_as_of",
                                      "macos_version", "fda_granted"]
        let encoded = try JSONSerialization.jsonObject(
            with: try JSONEncoder().encode(wire)) as? [String: Any] ?? [:]
        XCTAssertTrue(Set(encoded.keys).isSubset(of: permitted),
                      "extra keys \(Set(encoded.keys).subtracting(permitted)) would 400")

        // And the signals Track A's own documentation says the fleet-wide alarm needs
        // have nowhere to go. Named here so the gap is visible in the suite, not only in
        // NOTES.md.
        XCTAssertFalse(permitted.contains("bundle_path_stable"))
        XCTAssertFalse(permitted.contains("mirror_message_count"))
    }

    func testDigestAsOfPrefersTheDigestRatherThanReportingWorkThatDidNotHappen() {
        let onDisk = Heartbeat(as_of: "2026-08-03T09:00:00Z", app_version: "1.0.0",
                               bundle_path_stable: true, full_disk_access: false,
                               last_successful_sync_at: nil, mirror_message_count: 0,
                               corpus_health: CorpusHealth.thin.rawValue)
        // No digest this run — a thin corpus produces none — so the field falls back
        // rather than claiming a digest was computed now.
        let wire = HeartbeatUpload.from(onDisk, deviceID: "dev_abc", digestGeneratedAt: nil)
        XCTAssertEqual(wire.digest_as_of, "2026-08-03T09:00:00Z")
        XCTAssertEqual(wire.fda_granted, false)
    }
}

// MARK: - Identity

final class TokenStoreTests: XCTestCase {

    // Neither directory exists, so neither the walking `.env` lookup nor the Application
    // Support lookup can accidentally pick up the developer's real config or credentials —
    // that is exactly what broke these tests before `applicationSupportDirectory` was made
    // injectable (it used to unconditionally read `~/Library/Application Support/Boi/.env`).
    private let noDirectory = "/nonexistent"
    private let noAppSupport = "/nonexistent-app-support"

    func testAMissingIdentityMeansNoUploadRatherThanAnAnonymousOne() {
        let store = EnvironmentTokenStore(environment: [:], searchingFrom: noDirectory,
                                          applicationSupportDirectory: noAppSupport)
        XCTAssertNil(store.identity())
    }

    func testTheProcessEnvironmentSupplesTheIdentity() {
        let store = EnvironmentTokenStore(
            environment: ["BOI_USER_ID": "usr_123", "BOI_DEVICE_TOKEN": "tok"],
            searchingFrom: noDirectory, applicationSupportDirectory: noAppSupport)
        XCTAssertEqual(store.identity(),
                       DeviceIdentity(user_id: "usr_123", device_token: "tok"))
    }

    func testAHalfConfiguredIdentityIsNoIdentity() {
        // A token with no user id would post a digest whose `user_id` is the locally
        // derived HMAC, which the server answers with 401. Better to not send.
        let store = EnvironmentTokenStore(environment: ["BOI_DEVICE_TOKEN": "tok"],
                                          searchingFrom: noDirectory,
                                          applicationSupportDirectory: noAppSupport)
        XCTAssertNil(store.identity())
    }

    func testConfigurationReadsTheVariableThatAlreadyExists() {
        let configuration = Uploader.Configuration.fromEnvironment(
            ["BOI_API_BASE": "http://localhost:3041"],
            searchingFrom: noDirectory, applicationSupportDirectory: noAppSupport,
            arguments: ["boi-cli"])
        XCTAssertEqual(configuration?.baseURL.absoluteString, "http://localhost:3041")
        XCTAssertEqual(configuration?.dryRun, false)
    }

    func testDryRunIsReadableFromArgvBecauseTheSyncEntryPointIsNotOurs() {
        // `Boi.app --sync --dry-run` — BoiApp.swift belongs to Track A and cannot thread
        // a flag through, so the configuration reads argv directly.
        let configuration = Uploader.Configuration.fromEnvironment(
            ["BOI_API_BASE": "http://localhost:3041"],
            searchingFrom: noDirectory, applicationSupportDirectory: noAppSupport,
            arguments: ["Boi", "--sync", "--dry-run"])
        XCTAssertEqual(configuration?.dryRun, true)
    }

    func testNoBaseURLMeansNoUploadRatherThanADefaultPort() {
        XCTAssertNil(Uploader.Configuration.fromEnvironment(
            [:], searchingFrom: noDirectory, applicationSupportDirectory: noAppSupport,
            arguments: []))
    }
}

// MARK: - The whole run

/// `boi-cli sync-run` end to end: read the synthetic corpus, build the mirror, write the
/// digest and the voice packs, and upload all of it to a real server.
///
/// The subprocess tests here are the ones that matter. A queue that "survives process
/// death" asserted by the process that wrote it is not an assertion at all, and a log
/// that contains no message content is only worth checking on the bytes a real run
/// actually printed to a real stdout.
final class SyncRunUploadTests: XCTestCase {

    /// The built CLI. Built on demand, because `swift test` has no reason to link an
    /// executable no test target depends on — and a test that silently skips when the
    /// binary is missing is the failure mode `Fixture.FixtureUnavailable` exists for.
    static func boiCLI() throws -> String {
        let debug = Bundle(for: SyncRunUploadTests.self).bundleURL.deletingLastPathComponent()
        let candidate = debug.appendingPathComponent("boi-cli").path
        if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        _ = try? Fixture.run("/usr/bin/env", [
            "swift", "build", "--package-path",
            Fixture.repositoryRoot.appendingPathComponent("mac").path,
            "--product", "boi-cli",
        ])
        guard FileManager.default.isExecutableFile(atPath: candidate) else {
            throw Fixture.FixtureUnavailable(detail: "boi-cli is not at \(candidate)")
        }
        return candidate
    }

    struct Run {
        var status: Int32
        var stdout: String
        var stderr: String
    }

    static func runCLI(_ arguments: [String], environment: [String: String]) throws -> Run {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: try boiCLI())
        process.arguments = arguments
        // A CLOSED ENVIRONMENT. `DotEnv` walks up from the working directory looking for
        // a `.env`, and the repository has one — so an inherited environment would make
        // this test depend on a developer's local file.
        process.environment = environment
        process.currentDirectoryURL = URL(fileURLWithPath: NSTemporaryDirectory())

        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        try process.run()
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        let errData = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return Run(status: process.terminationStatus,
                   stdout: String(data: outData, encoding: .utf8) ?? "",
                   stderr: String(data: errData, encoding: .utf8) ?? "")
    }

    static let salt = "boi-dev-salt-do-not-ship-0001"

    static func environment(base: URL, extra: [String: String] = [:]) -> [String: String] {
        var environment = [
            "BOI_DEV_USER_SALT": salt,
            "BOI_API_BASE": base.absoluteString,
            "BOI_USER_ID": UploadFixture.identity.user_id,
            "BOI_DEVICE_TOKEN": UploadFixture.identity.device_token,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": NSTemporaryDirectory(),
        ]
        extra.forEach { environment[$0.key] = $0.value }
        return environment
    }

    override func setUpWithError() throws {
        try Fixture.ensureChatDatabase()
    }

    // MARK: In-process, whole pipeline

    func testAFullSyncUploadsTheDigestAndEveryVoicePack() throws {
        let server = try LoopbackHTTPServer { request in
            request.path == "/v1/heartbeat" ? .noContent : .accepted
        }
        defer { server.stop() }
        let state = try UploadFixture.scratch("full-sync")

        let outcome = try SyncRun(
            paths: .init(chatDatabase: Fixture.chatDatabasePath,
                         mirror: state + "/mirror.db",
                         outputDirectory: state + "/out",
                         stateDirectory: state),
            salt: Self.salt,
            uploader: UploadFixture.uploader(base: server.baseURL)).run()

        XCTAssertTrue(outcome.ran)
        let digestPath = try XCTUnwrap(outcome.digestPath)
        XCTAssertFalse(outcome.voicePackPaths.isEmpty, "the corpus must produce voice packs")

        let paths = server.requests.map(\.path)
        XCTAssertEqual(paths.filter { $0 == "/v1/digest" }.count, 1)
        XCTAssertEqual(paths.filter { $0 == "/v1/voice-pack" }.count,
                       outcome.voicePackPaths.count)
        XCTAssertEqual(paths.filter { $0 == "/v1/heartbeat" }.count, 1)
        XCTAssertEqual(outcome.upload?.accepted, server.requests.count)
        XCTAssertEqual(outcome.upload?.queued, 0)

        // THE FILE ON DISK STAYS, and it is byte-for-byte what was uploaded. The digest
        // is written with explicit nulls that a re-encode would drop, so the uploader
        // reads the file rather than re-serializing the struct.
        let onDisk = try Data(contentsOf: URL(fileURLWithPath: digestPath))
        let uploaded = try XCTUnwrap(server.requests.first { $0.path == "/v1/digest" }?.body)
        XCTAssertEqual(uploaded, onDisk)

        // And the digest carries the PAIRED user_id, not the locally derived one. The
        // server answers 401 to anything else, so this is the difference between a join
        // and a 401 nobody notices until integration.
        let digest = try JSONDecoder().decode(Digest.self, from: uploaded)
        XCTAssertEqual(digest.user_id, UploadFixture.identity.user_id)
    }

    func testAFiveHundredDuringAFullSyncQueuesTheDigestAndThrows() throws {
        let server = try LoopbackHTTPServer { _ in .serverError }
        defer { server.stop() }
        let state = try UploadFixture.scratch("full-sync-500")
        let run = SyncRun(paths: .init(chatDatabase: Fixture.chatDatabasePath,
                                       mirror: state + "/mirror.db",
                                       outputDirectory: state + "/out",
                                       stateDirectory: state),
                          salt: Self.salt,
                          uploader: UploadFixture.uploader(base: server.baseURL))

        XCTAssertThrowsError(try run.run()) { error in
            guard let deferred = error as? Uploader.Deferred else {
                return XCTFail("expected Uploader.Deferred, got \(error)")
            }
            XCTAssertGreaterThan(deferred.queued, 0)
            XCTAssertTrue(deferred.endpoints.contains("/v1/digest"))
        }

        // ASSERT ON THE QUEUE. The digest is durable and the local artefacts survived
        // the throw — a failed upload must not cost the run.
        let queue = UploadQueue(directory: state, log: { _, _, _ in })
        XCTAssertTrue(try queue.entries().contains { $0.endpoint == .digest })
        XCTAssertTrue(FileManager.default.fileExists(atPath: state + "/out/digest.json"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: state + "/heartbeat.json"))
    }

    func testAnUnconfiguredMacRunsLocallyAndUploadsNothing() throws {
        // No BOI_API_BASE, no identity: a developer run, and it must not throw, must not
        // queue, and must not post a digest at whatever is listening on port 3041.
        let state = try UploadFixture.scratch("unconfigured")
        let outcome = try SyncRun(paths: .init(chatDatabase: Fixture.chatDatabasePath,
                                               mirror: state + "/mirror.db",
                                               outputDirectory: state + "/out",
                                               stateDirectory: state),
                                  salt: Self.salt,
                                  tokenStore: EnvironmentTokenStore(
                                      environment: [:],
                                      searchingFrom: "/nonexistent",
                                      applicationSupportDirectory: "/nonexistent-app-support"))
            .run()
        XCTAssertTrue(outcome.ran)
        XCTAssertNil(outcome.upload)
        XCTAssertNotNil(outcome.digestPath)
    }

    // MARK: Across a process boundary

    func testTheQueueSurvivesTheProcessThatWroteItAndTheNextRunDrainsIt() throws {
        let server = try LoopbackHTTPServer { _ in .serverError }
        defer { server.stop() }
        let state = try UploadFixture.scratch("process-death")

        // Process one: a real `boi-cli sync-run` against a server returning 500. It must
        // exit NON-ZERO — a silent success on a failed upload is the defect prompt 01
        // exists to catch.
        let failed = try Self.runCLI(["sync-run", "--db", Fixture.chatDatabasePath,
                                      "--state", state, "--force"],
                                     environment: Self.environment(base: server.baseURL))
        XCTAssertEqual(failed.status, 1, "stdout:\n\(failed.stdout)\nstderr:\n\(failed.stderr)")
        XCTAssertTrue(failed.stdout.contains("sync_run.upload_deferred"))

        // That process is gone. This one reads the queue it left behind.
        let queue = UploadQueue(directory: state, log: { _, _, _ in })
        let queued = try queue.entries()
        XCTAssertTrue(queued.contains { $0.endpoint == .digest },
                      "the digest must outlive the process that failed to upload it")
        XCTAssertEqual(try queue.body(of: try XCTUnwrap(queued.first)).isEmpty, false)

        // Process two: the server recovers, but the backoff has not elapsed. The entry
        // must NOT be retried — and that the backoff holds across a process restart is
        // the property an in-memory retry counter would silently lose.
        server.respond { request in request.path == "/v1/heartbeat" ? .noContent : .accepted }
        func digestEntry() throws -> UploadQueue.Entry {
            try XCTUnwrap(try queue.entries().first { $0.endpoint == .digest })
        }
        let attemptsBefore = try digestEntry().attempts
        XCTAssertEqual(attemptsBefore, 1, "the attempt that just failed is recorded")

        let tooSoon = try Self.runCLI(["sync-run", "--db", Fixture.chatDatabasePath,
                                       "--state", state, "--force"],
                                      environment: Self.environment(base: server.baseURL))
        // This run uploads its OWN fresh digest, which succeeds, and drains the voice
        // packs — they were enqueued without an attempt, so they are due. The assertion
        // is about the queued digest specifically: untouched, because it is not due.
        XCTAssertEqual(try digestEntry().attempts, attemptsBefore,
                       "a queued digest inside its backoff window is not retried")
        XCTAssertEqual(tooSoon.status, 0, tooSoon.stderr)

        // Advance the clock by hand rather than sleeping through a real backoff. This is
        // the test moving time, and it says so — the envelope is the only state involved.
        let entry = try digestEntry()
        var rewound = entry
        rewound.next_attempt_at = StructuredLog.timestamp(Date().addingTimeInterval(-1))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(rewound).write(to: queue.envelopeURL(entry.id), options: .atomic)

        // Process three: due, and it goes.
        let recovered = try Self.runCLI(["sync-run", "--db", Fixture.chatDatabasePath,
                                         "--state", state, "--force"],
                                        environment: Self.environment(base: server.baseURL))
        XCTAssertEqual(recovered.status, 0,
                       "stdout:\n\(recovered.stdout)\nstderr:\n\(recovered.stderr)")
        XCTAssertEqual(try queue.depth(), 0, "removed only after a 2xx")
        XCTAssertTrue(server.requests.contains { $0.path == "/v1/digest" })
    }

    /// **The grep.** Twenty real message bodies from the fixture corpus, checked against
    /// everything a full run printed.
    ///
    /// The substrings are read out of the mirror rather than hard-coded, so this cannot
    /// rot into checking twenty strings the fixture stopped producing. An uploader is the
    /// single most likely place in the system to leak the corpus, because the natural
    /// thing to log on a failure is the request body — and the request body is the digest.
    func testAFullSyncPrintsNoMessageContentAnywhere() throws {
        let server = try LoopbackHTTPServer { request in
            // Deliberately a mix, including the failure paths — a 400 and a 500 are
            // exactly where a body would get logged "for debugging".
            switch request.path {
            case "/v1/heartbeat": return .noContent
            case "/v1/voice-pack": return .json(422, ["error": "redaction_failed",
                                                      "detail": "exemplars[0]"])
            default: return .json(400, ["error": "validation", "detail": "corpus.span_days"])
            }
        }
        defer { server.stop() }
        let state = try UploadFixture.scratch("log-grep")

        let run = try Self.runCLI(["sync-run", "--db", Fixture.chatDatabasePath,
                                   "--state", state, "--force"],
                                  environment: Self.environment(base: server.baseURL))

        let mirror = try MirrorDatabase(path: state + "/mirror.db")
        var bodies: [String] = []
        try mirror.forEachMessage { message in
            guard let text = message.text, text.count >= 8 else { return }
            bodies.append(text)
        }
        // Longest first: the most distinctive strings, and the ones a naive body log
        // would definitely contain.
        let needles = Array(Set(bodies)).sorted { $0.count > $1.count }.prefix(20)
        XCTAssertEqual(needles.count, 20, "the fixture must supply 20 message bodies to grep for")

        let haystack = [run.stdout, run.stderr,
                        (try? String(contentsOfFile: state + "/boi.log", encoding: .utf8)) ?? ""]
            .joined(separator: "\n")
            .lowercased()

        var hits: [String] = []
        for needle in needles where haystack.contains(needle.lowercased()) {
            hits.append(String(needle.prefix(12)) + "…")
        }
        XCTAssertEqual(hits, [], "message content reached a log: \(hits.count) of 20 matched")

        // The grep is only worth anything if the run actually logged something.
        XCTAssertTrue(run.stdout.contains("upload."), "the run produced no upload logs at all")
        XCTAssertTrue(run.stdout.contains("redaction_failed"), "and it saw the 422")
        XCTAssertFalse(run.stdout.contains("exemplars[0]"),
                       "the server's free-text `detail` is never logged")
    }

    func testDryRunUploadsNothingAndItsOutputCarriesTheByteCountAndNoBody() throws {
        let server = try LoopbackHTTPServer()
        defer { server.stop() }
        let state = try UploadFixture.scratch("cli-dry-run")

        let run = try Self.runCLI(["sync-run", "--db", Fixture.chatDatabasePath,
                                   "--state", state, "--force", "--dry-run"],
                                  environment: Self.environment(base: server.baseURL))

        XCTAssertEqual(run.status, 0, run.stderr)
        XCTAssertEqual(server.requests.count, 0, "--dry-run must not open a socket")
        XCTAssertTrue(run.stdout.contains("upload.dry_run"))
        XCTAssertTrue(run.stdout.contains("byte_count"))
        XCTAssertTrue(run.stdout.contains("digest.v1"))
        XCTAssertEqual(try UploadQueue(directory: state, log: { _, _, _ in }).depth(), 0)

        // Same grep, on the dry run: "print what would be uploaded" is the single most
        // tempting place in the codebase to print the payload.
        let mirror = try MirrorDatabase(path: state + "/mirror.db")
        var bodies: [String] = []
        try mirror.forEachMessage { message in
            guard let text = message.text, text.count >= 8 else { return }
            bodies.append(text)
        }
        let needles = Array(Set(bodies)).sorted { $0.count > $1.count }.prefix(20)
        let haystack = run.stdout.lowercased()
        XCTAssertEqual(needles.filter { haystack.contains($0.lowercased()) }.count, 0)
    }

    /// The voice pack crosses the wire, and the artefact that crossed it still passes the
    /// guard-three checker. CONTRACTS.md § 7: the packs are the one payload where a
    /// mistake makes every privacy claim in the architecture false.
    func testTheUploadedVoicePacksStillPassTheLeakChecker() throws {
        let server = try LoopbackHTTPServer { request in
            request.path == "/v1/heartbeat" ? .noContent : .accepted
        }
        defer { server.stop() }
        let state = try UploadFixture.scratch("leak-check")

        let outcome = try SyncRun(paths: .init(chatDatabase: Fixture.chatDatabasePath,
                                               mirror: state + "/mirror.db",
                                               outputDirectory: state + "/out",
                                               stateDirectory: state),
                                  salt: Self.salt,
                                  uploader: UploadFixture.uploader(base: server.baseURL)).run()
        XCTAssertFalse(outcome.voicePackPaths.isEmpty)

        // Write exactly the bytes the SERVER received back out, and check those — not the
        // files on disk. If the uploader ever transformed a pack on the way out, this is
        // the assertion that sees it.
        let received = state + "/uploaded"
        try FileManager.default.createDirectory(atPath: received, withIntermediateDirectories: true)
        var uploadedPacks: [String] = []
        for (index, request) in server.requests.enumerated()
        where request.path == "/v1/voice-pack" {
            let path = received + "/pack-\(index).json"
            try request.body.write(to: URL(fileURLWithPath: path))
            uploadedPacks.append(path)
        }
        XCTAssertEqual(uploadedPacks.count, outcome.voicePackPaths.count)

        let script = Fixture.repositoryRoot
            .appendingPathComponent("scripts/check_voice_pack_leak.py").path
        for path in uploadedPacks {
            // `--mirror`, never `--db`. CONTRACTS.md § 7, corrected 3 Aug: on a real
            // corpus only about a third of sent rows have a `text` column, so pointing
            // guard three at `chat.db` flags a quarter of real users as leaking.
            let check = try Self.runCLI(python: ["--mirror", state + "/mirror.db",
                                                 "--pack", path],
                                        script: script)
            XCTAssertEqual(check.status, 0,
                           "guard three on an UPLOADED pack:\n\(check.stdout)\(check.stderr)")
            XCTAssertTrue(check.stdout.contains("OK"), check.stdout)
        }
    }

    /// `Fixture.run` discards the exit status, and for a guard the status is the point.
    static func runCLI(python arguments: [String], script: String) throws -> Run {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = [script] + arguments
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        try process.run()
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        let errData = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return Run(status: process.terminationStatus,
                   stdout: String(data: outData, encoding: .utf8) ?? "",
                   stderr: String(data: errData, encoding: .utf8) ?? "")
    }
}
