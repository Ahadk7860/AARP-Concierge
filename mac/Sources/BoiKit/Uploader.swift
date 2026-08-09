import Foundation

/// The first byte the Mac has ever sent.
///
/// Everything above this file was built to produce artefacts on disk: the mirror, the
/// digest, the voice packs, the heartbeat. `grep -rl "URLSession" mac/Sources/` returned
/// nothing until this file existed, which means four tracks shipped a pipe with no join.
///
/// **The failure mode of an uploader is a log line that says success.** Two things follow
/// from that and they shape every decision below:
///
/// 1. A response is classified before it is logged, and the classification decides whether
///    the payload is *dropped*, *retried* or *abandoned*. There is no path where a
///    non-2xx produces a quiet return.
/// 2. **The request body is the digest.** The natural debugging convenience — log the body
///    on a 400 — is a data breach here, and it is the single most likely accidental
///    violation of CONTRACTS.md § 7 in the entire system. This file logs the byte count,
///    the schema version, the `as_of` and the HTTP status. Never the body, never a slice
///    of it, never a "first 200 characters for context".
public struct Uploader: Sendable {

    // MARK: - Configuration

    public struct Configuration: Sendable {

        /// `BOI_API_BASE`, and it carries **no path suffix** — the routes below are
        /// absolute. Prompt `01` asked for a new `BOI_API_URL`; `.env.example` already
        /// ships `BOI_API_BASE` with exactly these semantics, and two names for one
        /// endpoint is how a Mac ends up posting to whichever one somebody remembered.
        /// Recorded in `prompts/track-e-the-join/NOTES.md`.
        public var baseURL: URL

        /// Bounded so a hung server cannot hold a scheduled run open indefinitely. The
        /// LaunchAgent fires every half hour; a request outliving that is a bug.
        public var timeout: TimeInterval

        /// `--dry-run`. Prints what *would* be sent, sends nothing.
        public var dryRun: Bool

        public init(baseURL: URL, timeout: TimeInterval = 30, dryRun: Bool = false) {
            self.baseURL = baseURL
            self.timeout = timeout
            self.dryRun = dryRun
        }

        public static let baseURLVariable = "BOI_API_BASE"
        public static let dryRunVariable = "BOI_UPLOAD_DRY_RUN"

        /// Where a DMG-installed app's `.env` lives. A GUI app launched from Finder (or a
        /// LaunchAgent) does not inherit a developer's shell `cwd` — it typically starts at
        /// `/` or the app bundle's own directory — so `searchingFrom: currentDirectoryPath`
        /// alone never reaches this file. That is the actual cause of `upload.not_configured`
        /// on an installed app: not that the walking lookup is unreliable, just that nothing
        /// ever pointed it at the one directory the installed app actually writes to.
        public static var defaultApplicationSupportDirectory: String {
            FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support/Boi").path
        }

        /// Reads the process environment, then the installed app's `.env` in Application
        /// Support, then a developer's `.env` found by walking up from `directory`, then
        /// gives up.
        ///
        /// `applicationSupportDirectory` is injectable so tests can point it at an empty
        /// temp directory instead of silently reading the developer's real config.
        public static func fromEnvironment(
            _ environment: [String: String] = ProcessInfo.processInfo.environment,
            searchingFrom directory: String = FileManager.default.currentDirectoryPath,
            applicationSupportDirectory: String = defaultApplicationSupportDirectory,
            arguments: [String] = CommandLine.arguments
        ) -> Configuration? {
            let appSupportEnvFile = URL(fileURLWithPath: applicationSupportDirectory)
                .appendingPathComponent(DotEnv.fileName).path
            let raw = environment[baseURLVariable]
                ?? DotEnv.value(of: baseURLVariable, inFile: appSupportEnvFile)
                ?? DotEnv.value(of: baseURLVariable, searchingFrom: directory)
            guard let raw, let url = URL(string: raw.trimmingCharacters(in: .whitespaces)),
                  url.scheme != nil else { return nil }
            let dryRun = arguments.contains("--dry-run")
                || truthy(environment[dryRunVariable]
                    ?? DotEnv.value(of: dryRunVariable, inFile: appSupportEnvFile)
                    ?? DotEnv.value(of: dryRunVariable, searchingFrom: directory))
            return Configuration(baseURL: url, dryRun: dryRun)
        }

        static func truthy(_ value: String?) -> Bool {
            guard let value = value?.lowercased() else { return false }
            return value == "1" || value == "true" || value == "yes"
        }
    }

    // MARK: - Endpoints

    /// The three routes in `contracts/openapi/boi-api.v1.yaml` this track uploads to.
    /// Absolute paths, appended to `baseURL` with no interpretation.
    public enum Endpoint: String, Sendable, Codable, CaseIterable {
        case digest = "/v1/digest"
        case voicePack = "/v1/voice-pack"
        case heartbeat = "/v1/heartbeat"

        /// Whether a failure is worth keeping. A heartbeat is a liveness signal about
        /// *now*; replaying yesterday's is worse than skipping it, because the server
        /// would read a stale timestamp as a live Mac. The digest and the voice pack are
        /// artefacts and they queue.
        public var isDurable: Bool {
            switch self {
            case .digest, .voicePack: return true
            case .heartbeat: return false
            }
        }
    }

    // MARK: - Outcome

    /// What the server said, classified before anything is logged.
    ///
    /// The distinction that carries the weight is `rejected` vs `retryable`. A rejected
    /// payload will be rejected identically forever — retrying a `422 redaction_failed`
    /// is a Mac shouting the same rejected voice pack at the server every half hour —
    /// so it leaves the queue. A retryable one stays.
    public enum Result: Sendable, Equatable {
        /// `202`, or `204` for the heartbeat.
        case accepted(status: Int)
        /// `409 duplicate` on a repeated `generated_at`. The server already holds this
        /// exact digest, so this is a *success* for queue purposes: dequeue, do not retry.
        case duplicate
        /// `--dry-run`. Nothing left the machine.
        case dryRun
        /// Terminal. `400 validation`, `401 unauthorized`, `422 redaction_failed`.
        /// The `code` is the server's error slug — never the payload that produced it.
        case rejected(status: Int, code: String)
        /// Transport failure, `429`, or `5xx`. Enqueue and back off.
        case retryable(status: Int?, code: String)

        /// Whether this run is finished with the payload. `.dryRun` is terminal for the
        /// *attempt* — there is nothing to retry, because nothing was tried.
        public var isTerminal: Bool {
            switch self {
            case .accepted, .duplicate, .dryRun, .rejected: return true
            case .retryable: return false
            }
        }

        /// Whether the entry may be **deleted** from the durable queue.
        ///
        /// **`.dryRun` is terminal and does NOT leave the queue, and conflating those two
        /// was a data-loss bug.** `leavesQueue` used to be `isTerminal`, so a
        /// `--sync --dry-run` over a queue holding three days of undelivered digests
        /// dequeued every one of them without sending a byte — the flag whose entire
        /// promise is "uploads nothing" silently destroyed the backlog instead. A dry run
        /// must be observation only.
        ///
        /// A rejection is different: it is not a reason to lose the artefact from disk,
        /// but it *is* a reason to stop resending it.
        public var leavesQueue: Bool {
            if case .dryRun = self { return false }
            return isTerminal
        }
    }

    /// Raised when everything durable has been written but something did not reach the
    /// server. It exists so `--sync` exits non-zero: a silent success on a failed upload
    /// is the defect prompt `01` exists to catch, and the only mechanism that reaches the
    /// shipping `--sync` entry point (`BoiApp.swift`, not owned by this track) is a throw.
    ///
    /// Deliberately carries counts and endpoint names. No bodies, no error detail from a
    /// server that might echo one back.
    /// The durable queue could not be written or read.
    ///
    /// Deliberately **not** a `Deferred`. `Deferred` means "the server did not take it,
    /// and the next sync will retry from the queue" — a promise that depends on the queue
    /// existing. When the queue itself is the thing that failed, that promise is false and
    /// the run must say so differently, because the digest is now nowhere.
    public struct QueueUnavailable: Swift.Error, CustomStringConvertible, Equatable {
        public var endpoint: String
        public var detail: String

        public var description: String {
            "the upload queue is unavailable (\(endpoint): \(detail)). Nothing was queued, "
                + "so nothing will be retried — the digest on disk is the only copy."
        }
    }

    public struct Deferred: Swift.Error, CustomStringConvertible, Equatable {
        public var queued: Int
        public var rejected: Int
        public var endpoints: [String]

        public var description: String {
            "upload deferred: \(queued) queued, \(rejected) rejected "
                + "(\(endpoints.joined(separator: ", "))). "
                + "The digest is on disk and in the queue; the next sync retries it."
        }
    }

    // MARK: - Transport

    /// The seam a test replaces — and the one it must **not** replace to be a real test.
    ///
    /// `UploaderTests` runs a genuine HTTP server on a loopback socket and lets
    /// `URLSessionTransport` talk to it, because *a join that passes because both sides
    /// were stubbed is not a join*. This protocol exists for the two cases where no
    /// server can express the condition: a transport-level error (connection refused
    /// mid-flight) and a controlled clock.
    public protocol Transport: Sendable {
        /// Returns the status code and the response body, or throws on a transport
        /// failure. The body is read but never logged.
        func send(request: URLRequest) throws -> (status: Int, body: Data)
    }

    public struct URLSessionTransport: Transport {
        let timeout: TimeInterval

        public init(timeout: TimeInterval = 30) { self.timeout = timeout }

        public func send(request: URLRequest) throws -> (status: Int, body: Data) {
            // A box rather than a captured `var`: the completion handler runs on
            // URLSession's own queue, and the semaphore is what makes this safe to call
            // from `SyncRun.run`, which is synchronous by design.
            final class Box: @unchecked Sendable {
                var status: Int?
                var body = Data()
                var error: Swift.Error?
            }
            let box = Box()
            let semaphore = DispatchSemaphore(value: 0)

            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = timeout
            configuration.timeoutIntervalForResource = timeout
            // No caching of anything: the request bodies are the user's digest and the
            // responses are ids. Neither belongs in a URL cache on disk.
            configuration.urlCache = nil
            configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            let session = URLSession(configuration: configuration)
            defer { session.finishTasksAndInvalidate() }

            let task = session.dataTask(with: request) { data, response, error in
                box.error = error
                box.status = (response as? HTTPURLResponse)?.statusCode
                box.body = data ?? Data()
                semaphore.signal()
            }
            task.resume()
            if semaphore.wait(timeout: .now() + timeout + 5) == .timedOut {
                task.cancel()
                throw URLError(.timedOut)
            }
            if let error = box.error { throw error }
            guard let status = box.status else { throw URLError(.badServerResponse) }
            return (status, box.body)
        }
    }

    // MARK: - Construction

    public let configuration: Configuration
    public let identity: DeviceIdentity
    let transport: Transport

    public init(configuration: Configuration,
                identity: DeviceIdentity,
                transport: Transport? = nil) {
        self.configuration = configuration
        self.identity = identity
        self.transport = transport ?? URLSessionTransport(timeout: configuration.timeout)
    }

    // MARK: - Sending

    /// Posts `body` to `endpoint` and classifies the answer.
    ///
    /// `descriptor` carries the metadata that is safe to log — schema version, `as_of`,
    /// byte count. It is built by the caller from the *parsed* artefact rather than by
    /// this function from the bytes, so there is no code path here that reads inside the
    /// payload at all.
    @discardableResult
    public func send(_ body: Data,
                     to endpoint: Endpoint,
                     descriptor: PayloadDescriptor,
                     attempt: Int = 1,
                     log: (String, StructuredLog.Level, [String: Any]) -> Void = Uploader.emit
    ) -> Result {
        var fields: [String: Any] = [
            "endpoint": endpoint.rawValue,
            "byte_count": body.count,
            "attempt": attempt,
        ]
        if let version = descriptor.schemaVersion { fields["schema_version"] = version }
        if let asOf = descriptor.asOf { fields["as_of"] = asOf }
        if let version = descriptor.voicePackVersion { fields["voice_pack_version"] = version }

        guard !configuration.dryRun else {
            // The dry run prints the same fields a real send would and nothing else, so
            // "what would you have uploaded" is answerable without the answer being the
            // payload.
            log("upload.dry_run", .info, fields)
            return .dryRun
        }

        var request = URLRequest(url: url(for: endpoint))
        request.httpMethod = "POST"
        request.httpBody = body
        request.timeoutInterval = configuration.timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(identity.device_token)", forHTTPHeaderField: "Authorization")
        request.setValue(String(body.count), forHTTPHeaderField: "Content-Length")

        let status: Int
        let responseBody: Data
        do {
            (status, responseBody) = try transport.send(request: request)
        } catch {
            // A transport failure has no status. `error_kind` is the URLError code or the
            // type name — never `error.localizedDescription` of something that might have
            // interpolated the request.
            let kind = Self.transportErrorKind(error)
            fields["error_kind"] = kind
            log("upload.failed", .warn, fields)
            return .retryable(status: nil, code: kind)
        }

        fields["status"] = status
        let result = Self.classify(status: status, body: responseBody, endpoint: endpoint)
        switch result {
        case .accepted:
            log("upload.accepted", .info, fields)
        case .duplicate:
            // Not an error. The server already holds this exact `generated_at`, which is
            // what a retry of an upload that actually landed looks like.
            log("upload.duplicate", .info, fields)
        case .rejected(_, let code):
            fields["error"] = code
            log("upload.rejected", .error, fields)
        case .retryable(_, let code):
            fields["error"] = code
            log("upload.failed", .warn, fields)
        case .dryRun:
            log("upload.dry_run", .info, fields)
        }
        return result
    }

    func url(for endpoint: Endpoint) -> URL {
        // `appendingPathComponent` would escape the slash in "/v1/digest" into a single
        // component. The routes are absolute paths and the base carries no suffix, so
        // string concatenation with one normalization is the honest construction.
        let base = configuration.baseURL.absoluteString
        let trimmed = base.hasSuffix("/") ? String(base.dropLast()) : base
        return URL(string: trimmed + endpoint.rawValue) ?? configuration.baseURL
    }

    /// Status → disposition. The shapes are `contracts/openapi/boi-api.v1.yaml`.
    ///
    /// The error slug is read out of the response body, which is the server's own
    /// `{"error": "<slug>"}` — a value this system produced, not user content. `detail`
    /// is deliberately **not** read: it is a free-text field and a future server change
    /// could put a field path with a value in it.
    static func classify(status: Int, body: Data, endpoint: Endpoint) -> Result {
        let slug = errorSlug(in: body)
        switch status {
        case 200...299:
            return .accepted(status: status)
        case 409:
            return endpoint == .digest ? .duplicate : .rejected(status: status, code: slug ?? "conflict")
        case 401, 403:
            // Terminal until somebody re-pairs. Retrying a bad token every half hour is
            // how a device gets rate-limited into looking like an attacker.
            return .rejected(status: status, code: slug ?? "unauthorized")
        case 422:
            // `redaction_failed`. The pack was NOT stored, and the identical bytes will
            // be rejected identically forever. This must be loud and it must not retry.
            return .rejected(status: status, code: slug ?? "unprocessable")
        case 400...499:
            return .rejected(status: status, code: slug ?? "client_error")
        default:
            return .retryable(status: status, code: slug ?? "server_error")
        }
    }

    /// Pulls `error` out of a JSON error body. Returns nil for anything else, and never
    /// reads `detail`.
    static func errorSlug(in body: Data) -> String? {
        guard !body.isEmpty,
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let slug = object["error"] as? String else { return nil }
        // Bounded and character-restricted. CONTRACTS.md § 6: "Slugs are lowercase
        // snake." Anything else is not a slug and does not get logged as one.
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz_")
        guard slug.count <= 40, slug.unicodeScalars.allSatisfy(allowed.contains) else {
            return "unrecognized_error_slug"
        }
        return slug
    }

    static func transportErrorKind(_ error: Swift.Error) -> String {
        guard let urlError = error as? URLError else { return "transport_error" }
        switch urlError.code {
        case .timedOut: return "timed_out"
        case .cannotConnectToHost, .cannotFindHost: return "cannot_connect"
        case .networkConnectionLost: return "connection_lost"
        case .notConnectedToInternet: return "offline"
        case .secureConnectionFailed, .serverCertificateUntrusted: return "tls_failed"
        default: return "urlerror_\(urlError.code.rawValue)"
        }
    }

    /// The default log sink. Separate so tests can capture without a file.
    public static func emit(_ event: String, level: StructuredLog.Level, fields: [String: Any]) {
        StructuredLog.emit(event, level: level, fields: fields)
    }

    // MARK: - One sync's worth of uploading

    /// What a run sent, queued and gave up on. Counts and endpoint names only.
    public struct Dispatch: Sendable, Equatable {
        public var accepted = 0
        public var duplicates = 0
        public var queued = 0
        public var rejected = 0
        public var dryRun = 0
        /// Endpoints that did not land. Feeds `Deferred.description`.
        public var unlanded: [String] = []

        /// The digest is on disk either way; this asks whether the *cloud* has it.
        public var isClean: Bool { queued == 0 && rejected == 0 }
    }

    public struct Payload: Sendable {
        public var body: Data
        public var endpoint: Endpoint
        public var descriptor: PayloadDescriptor

        public init(body: Data, endpoint: Endpoint, descriptor: PayloadDescriptor) {
            self.body = body
            self.endpoint = endpoint
            self.descriptor = descriptor
        }
    }

    /// Drains what is already queued, then sends this run's payloads.
    ///
    /// **The queue is drained first, and a single retryable failure stops the drain.**
    /// Both halves of that matter. Oldest-first means a digest from Tuesday reaches the
    /// server before Wednesday's, so the sequence the server sees is the sequence that
    /// happened. Stopping on the first retryable failure means a Mac that wakes to a
    /// down server makes one request and queues the rest, rather than working through
    /// thirty-two entries against a socket that is not answering.
    ///
    /// **This throws, and every `try?` that used to be here was a lie.** An unreadable
    /// queue directory produced `(try? queue.due(now:)) ?? []` — an empty drain, a clean
    /// report and exit 0, which is the exact "silent success on a failed upload" this
    /// prompt exists to catch, arriving through the queue rather than through the socket.
    /// The swallowed enqueues were worse: they incremented `report.queued` while nothing
    /// had been written, so `Deferred` announced "3 queued" over an empty directory and
    /// the digests were simply gone.
    public func dispatch(_ payloads: [Payload],
                         queue: UploadQueue,
                         now: Date = Date(),
                         backoff: Backoff = Backoff(),
                         log: (String, StructuredLog.Level, [String: Any]) -> Void = Uploader.emit)
        throws -> Dispatch {
        var report = Dispatch()
        var serverIsAnswering = true

        /// A queue write that failed. Distinct from `Deferred`, which means the *server*
        /// did not take it: this means the digest is not anywhere, and the run must not
        /// be able to report a tidy count of things it did not save.
        func queueFailure(_ error: Swift.Error, endpoint: Endpoint) -> QueueUnavailable {
            let failure = QueueUnavailable(endpoint: endpoint.rawValue,
                                           detail: "\(type(of: error))")
            log("upload.queue.unavailable", .error, [
                "endpoint": endpoint.rawValue,
                "directory": queue.directory.path,
                "detail": failure.detail,
            ])
            return failure
        }

        func note(_ result: Result, endpoint: Endpoint) {
            switch result {
            case .accepted: report.accepted += 1
            case .duplicate: report.duplicates += 1
            case .dryRun: report.dryRun += 1
            case .rejected:
                report.rejected += 1
                report.unlanded.append(endpoint.rawValue)
            case .retryable:
                report.queued += 1
                report.unlanded.append(endpoint.rawValue)
                serverIsAnswering = false
            }
        }

        // NOT `try?`. A queue we cannot read is a queue we cannot honour, and returning
        // an empty drain would report a healthy run over an unknown backlog.
        let due: [UploadQueue.Entry]
        do {
            due = try queue.due(now: now)
        } catch {
            log("upload.queue.unreadable", .error, [
                "directory": queue.directory.path,
                "detail": "\(type(of: error))",
            ])
            throw QueueUnavailable(endpoint: "drain", detail: "\(type(of: error))")
        }

        for entry in due {
            guard serverIsAnswering else { break }
            // A dry run reads the queue and reports it. It does not send, and — since
            // `leavesQueue` is false for `.dryRun` — it does not delete.
            guard !configuration.dryRun else {
                log("upload.dry_run.queued", .info, [
                    "endpoint": entry.endpoint.rawValue,
                    "id": entry.id,
                    "byte_count": entry.byte_count,
                    "attempts": entry.attempts,
                ])
                report.dryRun += 1
                continue
            }
            guard let body = try? queue.body(of: entry) else {
                queue.remove(entry, reason: "body_unreadable")
                continue
            }
            let descriptor = PayloadDescriptor(schemaVersion: entry.schema_version,
                                               asOf: entry.as_of,
                                               voicePackVersion: entry.voice_pack_version)
            let result = send(body, to: entry.endpoint, descriptor: descriptor,
                              attempt: entry.attempts + 1, log: log)
            if result.leavesQueue {
                queue.remove(entry, reason: Self.reason(for: result))
                // A dequeued retry is not a *new* upload; counting it as accepted here
                // is what makes "the queued digest uploads on the next successful sync"
                // observable in the report rather than only in the queue.
                note(result, endpoint: entry.endpoint)
            } else {
                do {
                    _ = try queue.recordFailure(entry, now: now, backoff: backoff)
                } catch {
                    throw queueFailure(error, endpoint: entry.endpoint)
                }
                serverIsAnswering = false
                report.queued += 1
                report.unlanded.append(entry.endpoint.rawValue)
            }
        }

        for payload in payloads {
            // A payload whose endpoint does not queue — the heartbeat — is skipped
            // entirely when the server is known to be down. There is nothing to save.
            guard serverIsAnswering || payload.endpoint.isDurable else {
                log("upload.skipped", .warn, [
                    "endpoint": payload.endpoint.rawValue,
                    "byte_count": payload.body.count,
                    "reason": "server_unreachable_this_run",
                ])
                continue
            }
            guard serverIsAnswering else {
                // Straight to the queue without a request. The previous failure already
                // established the server is not answering.
                do {
                    _ = try queue.enqueue(payload.body, to: payload.endpoint,
                                          descriptor: payload.descriptor, now: now)
                } catch {
                    throw queueFailure(error, endpoint: payload.endpoint)
                }
                report.queued += 1
                report.unlanded.append(payload.endpoint.rawValue)
                continue
            }
            let result = send(payload.body, to: payload.endpoint,
                              descriptor: payload.descriptor, log: log)
            if case .retryable = result, payload.endpoint.isDurable {
                // The attempt that just failed is recorded against the entry, not
                // discarded. Enqueueing at zero attempts would leave it due immediately
                // and the first backoff would never apply — a failure the queue would
                // report as healthy, since the entry is present and the depth is right.
                do {
                    let entry = try queue.enqueue(payload.body, to: payload.endpoint,
                                                  descriptor: payload.descriptor, now: now)
                    _ = try queue.recordFailure(entry, now: now, backoff: backoff)
                } catch {
                    throw queueFailure(error, endpoint: payload.endpoint)
                }
            }
            note(result, endpoint: payload.endpoint)
        }

        log("upload.dispatch", report.isClean ? .info : .warn, [
            "accepted": report.accepted,
            "duplicates": report.duplicates,
            "queued": report.queued,
            "rejected": report.rejected,
            "dry_run": report.dryRun,
            "queue_depth": (try? queue.depth()) ?? -1,
        ])
        return report
    }

    static func reason(for result: Result) -> String {
        switch result {
        case .accepted: return "accepted"
        case .duplicate: return "duplicate"
        case .dryRun: return "dry_run"
        case .rejected(_, let code): return "rejected_\(code)"
        case .retryable(_, let code): return "retryable_\(code)"
        }
    }

    // MARK: - Payload metadata

    /// The only things about a payload that are allowed into a log line.
    ///
    /// Built from the decoded artefact by the functions below, so no caller has to
    /// remember which fields are safe. There is no initializer taking free text.
    public struct PayloadDescriptor: Sendable, Equatable {
        public var schemaVersion: String?
        public var asOf: String?
        public var voicePackVersion: String?

        public init(schemaVersion: String? = nil, asOf: String? = nil,
                    voicePackVersion: String? = nil) {
            self.schemaVersion = schemaVersion
            self.asOf = asOf
            self.voicePackVersion = voicePackVersion
        }

        public static func forDigest(_ digest: Digest) -> PayloadDescriptor {
            PayloadDescriptor(schemaVersion: digest.schema_version, asOf: digest.generated_at)
        }

        public static func forDigest(_ digest: DigestV2) -> PayloadDescriptor {
            PayloadDescriptor(schemaVersion: digest.schema_version, asOf: digest.generated_at)
        }

        public static func forVoicePack(_ pack: VoicePack) -> PayloadDescriptor {
            PayloadDescriptor(schemaVersion: pack.schema_version, asOf: pack.as_of,
                              voicePackVersion: pack.voice_pack_version)
        }

        public static func forVoicePack(_ pack: VoicePackV2) -> PayloadDescriptor {
            PayloadDescriptor(schemaVersion: pack.schema_version, asOf: pack.as_of,
                              voicePackVersion: pack.voice_pack_version)
        }

        public static func forHeartbeat(_ beat: HeartbeatUpload) -> PayloadDescriptor {
            PayloadDescriptor(schemaVersion: "heartbeat", asOf: beat.digest_as_of)
        }
    }
}

// MARK: - Identity

/// What `POST /v1/pair` hands back, and the two fields an upload cannot happen without.
///
/// `user_id` is here because of a seam disagreement worth stating plainly: **the Mac
/// cannot derive it.** `ContactResolver.localUserIdentifier()` computes
/// `usr_ + HMAC(salt, "boi.local.user")`, which was a reasonable local placeholder, but
/// the server issues `user_id` at signup with `newUserId()` and `POST /v1/digest` rejects
/// a body whose `user_id` is not the authenticated one with `401 unauthorized`. So the
/// paired identity has to be stored and threaded into `DigestBuilder`, not recomputed.
/// Recorded in `prompts/track-e-the-join/NOTES.md`.
public struct DeviceIdentity: Sendable, Equatable, Codable {
    public var user_id: String
    public var device_token: String

    public init(user_id: String, device_token: String) {
        self.user_id = user_id
        self.device_token = device_token
    }
}

/// Where the paired identity comes from.
///
/// **A protocol with one implementation, on purpose.** The shipping store is the macOS
/// Keychain, and it is not here yet for a reason that is a testing fact rather than a
/// scheduling one: Keychain ACLs are per-code-signing-identity, so an unsigned
/// `swift test` binary cannot read what the signed app wrote. A Keychain-backed store
/// today would need a signed test host, or the test would get weakened until it passed —
/// which is the exact anchor-bending this repo's gate exists to catch.
///
/// So Keychain becomes a second implementation of this protocol, not a rewrite of the
/// call site. There is also no Mac-side pairing client at all yet: `POST /v1/pair` exists
/// server-side (Track D) and nothing on the Mac calls it. That is a contract gap and it
/// is written up in `NOTES.md`.
public protocol TokenStore: Sendable {
    func identity() -> DeviceIdentity?
}

/// Reads the identity from the process environment, then `.env`.
public struct EnvironmentTokenStore: TokenStore {

    public static let userIDVariable = "BOI_USER_ID"
    public static let deviceTokenVariable = "BOI_DEVICE_TOKEN"

    let environment: [String: String]
    let directory: String
    let applicationSupportDirectory: String

    /// `applicationSupportDirectory` is injectable — defaults to the real
    /// `~/Library/Application Support/Boi`, but tests pass an empty temp directory so they
    /// never read the developer's actual device credentials off disk.
    public init(environment: [String: String] = ProcessInfo.processInfo.environment,
                searchingFrom directory: String = FileManager.default.currentDirectoryPath,
                applicationSupportDirectory: String =
                    Uploader.Configuration.defaultApplicationSupportDirectory) {
        self.environment = environment
        self.directory = directory
        self.applicationSupportDirectory = applicationSupportDirectory
    }

    public func identity() -> DeviceIdentity? {
        guard let userID = value(Self.userIDVariable),
              let token = value(Self.deviceTokenVariable) else { return nil }
        return DeviceIdentity(user_id: userID, device_token: token)
    }

    private func value(_ key: String) -> String? {
        if let value = environment[key], !value.isEmpty { return value }
        // Application Support carries the config for a user who installed the DMG. Use the
        // exact file path rather than the walking `searchingFrom` variant: the walk starts
        // at `directory`, which for a GUI app launched from Finder (or a LaunchAgent) is
        // not the developer's project tree — it's typically `/` or the app bundle's own
        // directory — so it would never reach the user's home directory at all. This is a
        // wrong starting point, not an unreliable lookup.
        let envPath = URL(fileURLWithPath: applicationSupportDirectory)
            .appendingPathComponent(DotEnv.fileName)
        if let value = DotEnv.value(of: key, inFile: envPath.path) { return value }
        return DotEnv.value(of: key, searchingFrom: directory)
    }
}

// MARK: - The heartbeat, on the wire

/// The heartbeat shape `contracts/openapi/boi-api.v1.yaml` documents — which is **not**
/// the shape `Heartbeat.swift` records on disk.
///
/// A seam disagreement found by this track, and one no test on either side could have
/// caught. Track A's `Heartbeat` carries `as_of`, `bundle_path_stable`,
/// `full_disk_access`, `last_successful_sync_at`, `mirror_message_count` and
/// `corpus_health`. The frozen contract requires `device_id`, `app_version` and
/// `digest_as_of`, permits `macos_version` and `fda_granted`, and sets
/// `additionalProperties: false` — which Track D implements as a strict schema. Posting
/// Track A's struct produces `400 validation` on every field it has.
///
/// The fields do not conflict so much as **fail to overlap**: `bundle_path_stable` and
/// `mirror_message_count` are exactly the fleet-wide-alarm signals `Heartbeat.swift`'s
/// own documentation says the server needs, and the contract has nowhere to put them.
/// This track maps what it can and drops the rest rather than editing either side. See
/// `NOTES.md` — the right resolution is a contract amendment, and that is the user's.
public struct HeartbeatUpload: Codable, Sendable, Equatable {
    public var device_id: String
    public var app_version: String
    public var digest_as_of: String
    public var macos_version: String?
    public var fda_granted: Bool?

    public init(device_id: String, app_version: String, digest_as_of: String,
                macos_version: String? = nil, fda_granted: Bool? = nil) {
        self.device_id = device_id
        self.app_version = app_version
        self.digest_as_of = digest_as_of
        self.macos_version = macos_version
        self.fda_granted = fda_granted
    }

    /// Projects the on-disk heartbeat onto the contract's shape.
    ///
    /// `digest_as_of` takes the digest's own `generated_at` when there is one, because
    /// the server reads this field as "what the device last computed" — see Track D's
    /// route comment. Falling back to the heartbeat's `as_of` would report a Mac that
    /// produced nothing as having produced something now.
    public static func from(_ beat: Heartbeat,
                            deviceID: String,
                            digestGeneratedAt: String?) -> HeartbeatUpload {
        HeartbeatUpload(
            device_id: deviceID,
            app_version: beat.app_version,
            digest_as_of: digestGeneratedAt ?? beat.last_successful_sync_at ?? beat.as_of,
            macos_version: ProcessInfo.processInfo.operatingSystemVersionString,
            fda_granted: beat.full_disk_access)
    }
}
