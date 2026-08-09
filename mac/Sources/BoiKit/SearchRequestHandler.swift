import Foundation

/// Wires a decoded `AskDeviceSearchRequest` to `SearchIndex` + `WhoResolver` and
/// produces the exact `AskDeviceSearchResponse` the wire protocol expects (§4.3).
///
/// This is the whole Mac-side "handler" for op `"search"`. It deliberately does not
/// touch the network: the persistent WebSocket client that decodes/encodes JSON off the
/// wire and keeps the connection to the cloud gateway alive belongs to the running app
/// (`mac/Sources/BoiApp`, Track D's file, not touched here). This type is the pure
/// function in between — `AskDeviceSearchRequest in, AskDeviceSearchResponse out` — so
/// it is unit-testable without a socket and the network plumbing can be wired up
/// independently. See `INTERFACES.md` for the exact integration point still needed.
///
/// **Timeout and "asleep" are not decided here.** Both are properties of the
/// connection as seen from the cloud gateway (no connection at all vs. a connection
/// that didn't answer in 4s) — this handler runs only when the Mac is, by definition,
/// awake and processing the request. The one failure this side can honestly produce is
/// `no_grant`: no active search consent, or a local query error that must not be
/// reported as anything sounding like a transport problem.
public struct SearchRequestHandler {
    public var index: SearchIndex
    public var who: WhoResolver
    /// Whether this Mac currently has an active search grant (consent + Full Disk
    /// Access). Injected rather than read from disk here so the handler stays testable;
    /// the real check is `GrantWatcher`'s territory.
    public var hasGrant: () -> Bool

    public init(
        index: SearchIndex,
        who: WhoResolver = WhoResolver(),
        hasGrant: @escaping () -> Bool = { true }
    ) {
        self.index = index
        self.who = who
        self.hasGrant = hasGrant
    }

    public func handle(_ request: AskDeviceSearchRequest) -> AskDeviceSearchResponse {
        guard hasGrant() else {
            return .failed(v: 1, id: request.id, reason: .no_grant)
        }
        do {
            var handles: [String]?
            if let whoHint = request.who {
                let distinct = try index.distinctHandles()
                handles = who.resolve(who: whoHint, distinctHandles: distinct)
            }
            let results = try index.search(
                query: request.query,
                whoFilterHandles: handles,
                whenFrom: request.when_from,
                whenTo: request.when_to,
                limit: request.limit
            )
            return .ok(v: 1, id: request.id, results: results)
        } catch {
            // §4.3's failure reasons are frozen to exactly asleep|timeout|no_grant. A
            // local query error is none of those in spirit, but reporting "asleep" for
            // a Mac that is plainly awake and answering would be a lie in the other
            // direction — no_grant is the least misleading of the three available.
            return .failed(v: 1, id: request.id, reason: .no_grant)
        }
    }
}
