import Foundation

/// The persistent Mac <-> cloud WebSocket client for the `ask_device` protocol
/// (V3_ARCHITECTURE.md §4.3). This is the piece `SearchRequestHandler`'s own doc comment
/// names as still missing: "the persistent WebSocket client that decodes/encodes JSON off
/// the wire and keeps the connection to the cloud gateway alive belongs to the running
/// app... not touched here."
///
/// Deliberately thin. Every byte of search logic already lives in `SearchRequestHandler`
/// (pure, already tested) and `SearchIndex` (queries the FTS mirror). This file adds
/// exactly one thing: sockets. It connects, authenticates with the same `Bearer
/// <device_token>` scheme `Uploader` already uses over HTTP (`DeviceIdentity`,
/// `KeychainTokenStore`/`EnvironmentTokenStore`), decodes one `AskDeviceSearchRequest`
/// per inbound frame, calls `SearchRequestHandler.handle(_:)`, and encodes the
/// `AskDeviceSearchResponse` straight back — no buffering, no batching, no logic.
///
/// **Reconnects with exponential backoff whenever the socket drops.** The cloud gateway's
/// own `hasConnection(userId)` (`cloud/device-search/src/gateway.ts`) is only as truthful
/// as this client's uptime: a Mac that is running the app but not linked answers every
/// `search_messages` call with `{ok:false, reason:"asleep"}` forever, which is the
/// "indistinguishable from broken" failure this whole track exists to close.
public actor DeviceLinkClient {

    /// Everything the client needs to open and authenticate the connection. Built once,
    /// from the exact same identity/base-URL sources `Uploader` already reads — see
    /// `DeviceLinkConfiguration.discover(...)`.
    public struct Configuration: Sendable {
        /// `wss://.../v1/device-link?user_id=<user_id>` — see `discover(...)`.
        public var gatewayURL: URL
        public var deviceToken: String
        public var minBackoffSeconds: TimeInterval
        public var maxBackoffSeconds: TimeInterval

        public init(gatewayURL: URL, deviceToken: String,
                    minBackoffSeconds: TimeInterval = 1, maxBackoffSeconds: TimeInterval = 30) {
            self.gatewayURL = gatewayURL
            self.deviceToken = deviceToken
            self.minBackoffSeconds = minBackoffSeconds
            self.maxBackoffSeconds = maxBackoffSeconds
        }

        /// Derives the gateway URL from `Uploader`'s own `BOI_API_BASE`
        /// (`http(s)://host[:port]`, no path) — `http`/`https` become `ws`/`wss`, the path
        /// is fixed at `/v1/device-link` (gateway.ts's default), and `user_id` is carried
        /// as a query param the way `authenticateDeviceLinkRequest` (gateway.ts) expects
        /// to cross-check against the token's own scope. Returns `nil` if `apiBase` has no
        /// recognizable http(s) scheme — never silently guesses a scheme.
        public static func gatewayURL(fromAPIBase apiBase: URL, userID: String) -> URL? {
            guard var components = URLComponents(url: apiBase, resolvingAgainstBaseURL: false) else {
                return nil
            }
            switch components.scheme {
            case "https": components.scheme = "wss"
            case "http": components.scheme = "ws"
            default: return nil
            }
            components.path = "/v1/device-link"
            components.queryItems = [URLQueryItem(name: "user_id", value: userID)]
            return components.url
        }

        /// The one call site production code needs: reads `identity` (Keychain, or the
        /// `BOI_USER_ID`/`BOI_DEVICE_TOKEN` env fallback) and `apiBase`
        /// (`Uploader.Configuration.fromEnvironment`'s `baseURL`) and combines them.
        /// `nil` means "not paired yet" or "no API base configured" — either is a reason
        /// to not start the client at all, never a reason to connect to a guessed URL.
        public static func discover(
            identity: DeviceIdentity?,
            apiBase: URL?
        ) -> Configuration? {
            guard let identity, let apiBase,
                  let url = gatewayURL(fromAPIBase: apiBase, userID: identity.user_id) else {
                return nil
            }
            return Configuration(gatewayURL: url, deviceToken: identity.device_token)
        }
    }

    private let configuration: Configuration
    private let handler: SearchRequestHandler
    private let session: URLSession
    private let log: (String, StructuredLog.Level, [String: Any]) -> Void

    private var task: URLSessionWebSocketTask?
    private var stopped = false
    private var runLoopTask: Task<Void, Never>?

    public init(
        configuration: Configuration,
        handler: SearchRequestHandler,
        session: URLSession = .shared,
        log: @escaping (String, StructuredLog.Level, [String: Any]) -> Void = { event, level, fields in
            StructuredLog.emit(event, level: level, fields: fields)
        }
    ) {
        self.configuration = configuration
        self.handler = handler
        self.session = session
        self.log = log
    }

    /// Starts the connect/reconnect loop in the background. Safe to call once; a second
    /// call while already running is a no-op rather than a second competing loop.
    public func start() {
        guard runLoopTask == nil else { return }
        stopped = false
        runLoopTask = Task { [weak self] in
            await self?.runLoop()
        }
    }

    /// Stops reconnecting and closes the live socket, if any. `runLoopTask` is cleared so
    /// a later `start()` begins a fresh loop rather than being swallowed as a no-op.
    public func stop() {
        stopped = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        runLoopTask?.cancel()
        runLoopTask = nil
    }

    private func runLoop() async {
        var backoff = configuration.minBackoffSeconds
        while !stopped {
            do {
                try await connectAndServeUntilDropped()
                // A clean return (server closed normally) is still a disconnect from this
                // client's perspective — reconnect, but starting the backoff back at the
                // floor since the previous connection was evidently healthy.
                backoff = configuration.minBackoffSeconds
            } catch {
                log("device_link.disconnected", .warn, ["detail": String(describing: error)])
            }
            if stopped { return }
            try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            backoff = min(backoff * 2, configuration.maxBackoffSeconds)
        }
    }

    private func connectAndServeUntilDropped() async throws {
        var request = URLRequest(url: configuration.gatewayURL)
        request.setValue("Bearer \(configuration.deviceToken)", forHTTPHeaderField: "Authorization")
        let socket = session.webSocketTask(with: request)
        task = socket
        socket.resume()
        log("device_link.connected", .info, ["url": configuration.gatewayURL.absoluteString])
        defer {
            if task === socket { task = nil }
        }

        while !stopped {
            let message = try await receive(socket)
            switch message {
            case .string(let text):
                await respond(to: text, over: socket)
            case .data(let data):
                if let text = String(data: data, encoding: .utf8) {
                    await respond(to: text, over: socket)
                }
            @unknown default:
                break
            }
        }
    }

    /// Bridges the completion-handler `receive(completionHandler:)` API (there is no
    /// native `async` receive on `URLSessionWebSocketTask` as of this SDK) into `async`.
    private func receive(_ socket: URLSessionWebSocketTask) async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { continuation in
            socket.receive { result in
                continuation.resume(with: result)
            }
        }
    }

    /// One frame in, one frame out — exactly `SearchRequestHandler.handle(_:)`'s contract.
    /// A frame this client cannot decode as `AskDeviceSearchRequest` is dropped silently,
    /// matching the cloud gateway's own `handleMessage` convention for a malformed frame
    /// it cannot correlate (gateway.ts): nothing here logs message content or search
    /// snippets (I5) — only the fact that a frame arrived and, on failure, the class of
    /// error, never its payload.
    private func respond(to text: String, over socket: URLSessionWebSocketTask) async {
        guard let data = text.data(using: .utf8),
              let request = try? JSONDecoder().decode(AskDeviceSearchRequest.self, from: data) else {
            return
        }
        let response = handler.handle(request)
        guard let encoded = try? JSONEncoder().encode(response),
              let responseText = String(data: encoded, encoding: .utf8) else {
            return
        }
        do {
            try await socket.send(.string(responseText))
        } catch {
            log("device_link.send_failed", .warn, ["detail": String(describing: error)])
        }
    }
}
