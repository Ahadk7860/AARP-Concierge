import Foundation

/// The Mac's "I am still here" signal, and the reason it carries a version number.
///
/// **THIS EXISTS BECAUSE OF WHAT GRANTING FDA BY HAND REVEALED.** The responsible
/// process's direct parent was `…/claude-code/2.1.219/claude.app` — a **version-numbered
/// bundle path**. CONTRACTS.md § 11 item 10 asks whether an FDA grant survives a Sparkle
/// auto-update and says to assume it may not. Here is why that assumption is right and
/// why the consequence is worse than per-user breakage:
///
/// > If TCC binds a grant to a versioned bundle path, an auto-update drops the grant for
/// > **every Mac in the fleet on the same day.** All of them stop syncing. None of them
/// > raise an error. The first signal is briefs quietly going stale across the whole
/// > user base simultaneously, and nobody is paged.
///
/// A per-user staleness notice — "we haven't seen your Mac since Sunday" — is a support
/// ticket. A fleet-wide drop is an outage. They look identical from inside one Mac, and
/// they are told apart **only by correlating across users**, which requires the server to
/// know which app version each silent Mac was last running.
///
/// So the payload carries `app_version` and `bundle_path_stable`. Without the version, a
/// server can see that many Macs went quiet; it cannot see that *every Mac on 1.2.3 went
/// quiet the day 1.2.4 shipped*, which is the difference between an alarm that fires in
/// an hour and one that fires when the support queue fills up a week later.
///
/// **What ships here is the Mac half.** The alarm itself is a server-side rule and Track
/// D owns `POST /v1/heartbeat`; the request is written up in `NOTES.md`. This track makes
/// no network calls in this round, so heartbeats are recorded durably on disk and the
/// send is a later wiring change rather than a rewrite.
public struct Heartbeat: Codable, Sendable, Equatable {

    /// ISO 8601 UTC, per CONTRACTS.md § 6. No epoch integers cross a process line.
    public var as_of: String
    /// **The field the fleet-wide alarm is built on.** A silent Mac is ambiguous; a
    /// cohort of silent Macs sharing one version is a diagnosis.
    public var app_version: String
    /// The bundle the OS holds responsible for the privileged read. Reported so a
    /// version number appearing in it is visible from the server rather than discovered
    /// by a support ticket.
    public var bundle_path_stable: Bool
    /// Whether the last attempt to read `chat.db` actually worked — probed by opening,
    /// never by looking. This is what turns "quiet" into "quiet *and* denied", which is
    /// the exact signature of a grant dropped by an update.
    public var full_disk_access: Bool
    public var last_successful_sync_at: String?
    public var mirror_message_count: Int
    public var corpus_health: String

    public static let fileName = "heartbeat.json"

    /// Records a heartbeat next to the mirror, overwriting the previous one.
    ///
    /// Deliberately last-write-wins rather than an append log: the server needs the most
    /// recent state, and an unbounded file on a machine that may be offline for months is
    /// a disk-usage bug waiting to happen.
    @discardableResult
    public static func write(_ heartbeat: Heartbeat, toDirectory directory: String) throws -> String {
        let url = URL(fileURLWithPath: directory).appendingPathComponent(fileName)
        try FileManager.default.createDirectory(at: URL(fileURLWithPath: directory),
                                                withIntermediateDirectories: true)
        // Explicit null again: a Mac that has never completed a sync must say so, and an
        // absent key would read as an older build that did not report it.
        let data = try ExplicitNullJSON.data(encoding: heartbeat) { object in
            ExplicitNullJSON.fillNull(&object, ["last_successful_sync_at"])
        }
        try data.write(to: url, options: .atomic)
        return url.path
    }

    public static func read(fromDirectory directory: String) -> Heartbeat? {
        let url = URL(fileURLWithPath: directory).appendingPathComponent(fileName)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Heartbeat.self, from: data)
    }

    /// Builds the payload from what this Mac can observe right now.
    public static func current(now: Date,
                               appVersion: String,
                               bundlePath: String?,
                               fullDiskAccess: Bool,
                               lastSuccessfulSyncAt: Date?,
                               mirrorMessageCount: Int,
                               corpusHealth: CorpusHealth) -> Heartbeat {
        Heartbeat(
            as_of: StructuredLog.timestamp(now),
            app_version: appVersion,
            bundle_path_stable: bundlePath.map {
                !ResponsibleBundle.containsVersionedComponent($0)
            } ?? false,
            full_disk_access: fullDiskAccess,
            last_successful_sync_at: lastSuccessfulSyncAt.map(StructuredLog.timestamp),
            mirror_message_count: mirrorMessageCount,
            corpus_health: corpusHealth.rawValue
        )
    }

    /// How long a Mac may be quiet before its own user is told.
    ///
    /// The per-user notice. The fleet-wide rule is the server's and is deliberately
    /// tighter, because a correlated drop is visible long before any individual Mac
    /// looks unusual — see `NOTES.md`.
    public static let userVisibleStalenessHours = 24

    public func isStale(now: Date, hours: Int = userVisibleStalenessHours) -> Bool {
        guard let last = last_successful_sync_at.flatMap(StructuredLog.date(from:)) else {
            return true
        }
        return now.timeIntervalSince(last) > Double(hours) * 3600
    }
}
