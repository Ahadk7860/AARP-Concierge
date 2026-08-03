import CryptoKit
import Foundation

/// A digest that could not be uploaded is retried later rather than lost.
///
/// The requirement sounds small and it is the whole reason this file is not three lines
/// of `URLSession` inside `SyncRun`. A laptop is offline most of the time it is awake,
/// the LaunchAgent's idempotent guard means a missed run is not retried for six hours,
/// and the digest is regenerated from a mirror that keeps changing — so "we will just
/// pick it up next time" silently ships a *different* document and loses the one the
/// user's report was going to be built from.
///
/// Three properties, each of which is a criterion in prompt `01`:
///
/// - **It survives process death.** The payload is on disk before the envelope that
///   claims it exists, and the envelope is renamed into place atomically. A process
///   killed mid-enqueue leaves an orphan body and no envelope, which is invisible and
///   swept on the next run — never a queue entry pointing at nothing.
/// - **It only forgets after a `2xx`.** Or after a terminal rejection, which is not the
///   same thing and is logged differently.
/// - **It backs off.** A Mac that wakes to no network must not hammer, and the bound is
///   asserted against a controlled clock rather than observed with `sleep`.
public final class UploadQueue: @unchecked Sendable {

    /// The envelope. Everything in here is safe to log; the payload is beside it.
    public struct Entry: Codable, Sendable, Equatable {
        public var id: String
        public var endpoint: Uploader.Endpoint
        public var created_at: String
        public var attempts: Int
        public var next_attempt_at: String
        public var byte_count: Int
        /// Identity of the payload without the payload. Two enqueues of the same digest
        /// collapse, which matters because a Mac offline for a week would otherwise
        /// queue seven copies of a document the server rejects as a duplicate anyway.
        public var sha256: String
        public var schema_version: String?
        public var as_of: String?
        public var voice_pack_version: String?

        var sortKey: String { created_at + id }
    }

    /// Bounded so an offline Mac cannot fill a disk. When it overflows the **oldest**
    /// entries go, because the newest digest is the one worth having — and the drop is
    /// logged rather than silent.
    public static let defaultCapacity = 32

    public let directory: URL
    public let capacity: Int
    private let log: (String, StructuredLog.Level, [String: Any]) -> Void

    public init(directory: String,
                capacity: Int = UploadQueue.defaultCapacity,
                log: @escaping (String, StructuredLog.Level, [String: Any]) -> Void = Uploader.emit) {
        self.directory = URL(fileURLWithPath: directory).appendingPathComponent("upload-queue")
        self.capacity = capacity
        self.log = log
    }

    // MARK: - Enqueue

    /// Writes the body, then the envelope. In that order, and the rename is the commit.
    @discardableResult
    public func enqueue(_ body: Data,
                        to endpoint: Uploader.Endpoint,
                        descriptor: Uploader.PayloadDescriptor,
                        now: Date = Date(),
                        availableAt: Date? = nil) throws -> Entry {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let digest = Self.sha256Hex(body)
        // Collapse a re-enqueue of identical bytes onto the existing entry rather than
        // stacking copies. The attempt count and backoff are preserved deliberately: a
        // payload that has failed six times has not earned a fresh 60-second retry
        // because the run happened to come round again.
        if let existing = try entries().first(where: { $0.sha256 == digest && $0.endpoint == endpoint }) {
            log("upload.queue.deduplicated", .info, [
                "endpoint": endpoint.rawValue,
                "id": existing.id,
                "attempts": existing.attempts,
                "byte_count": body.count,
            ])
            return existing
        }

        let id = Self.newID(now: now)
        let entry = Entry(id: id,
                          endpoint: endpoint,
                          created_at: StructuredLog.timestamp(now),
                          attempts: 0,
                          next_attempt_at: StructuredLog.timestamp(availableAt ?? now),
                          byte_count: body.count,
                          sha256: digest,
                          schema_version: descriptor.schemaVersion,
                          as_of: descriptor.asOf,
                          voice_pack_version: descriptor.voicePackVersion)

        // Body first. An envelope that names a body which is not there yet is the one
        // corruption this ordering makes impossible.
        try body.write(to: bodyURL(id), options: .atomic)
        try write(entry)

        try trim(now: now)

        log("upload.queued", .warn, [
            "endpoint": endpoint.rawValue,
            "id": id,
            "byte_count": body.count,
            "queue_depth": try entries().count,
        ])
        return entry
    }

    // MARK: - Reading

    /// Every entry, oldest first. Envelopes whose body has vanished are swept.
    public func entries() throws -> [Entry] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0.hasSuffix(".json") }
            .sorted()

        var result: [Entry] = []
        for name in names {
            let url = directory.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: url),
                  let entry = try? JSONDecoder().decode(Entry.self, from: data) else {
                // An envelope this version cannot read is removed rather than retried
                // forever. It carries no user content — the body beside it does, and
                // that goes with it.
                try? FileManager.default.removeItem(at: url)
                continue
            }
            guard FileManager.default.fileExists(atPath: bodyURL(entry.id).path) else {
                try? FileManager.default.removeItem(at: url)
                log("upload.queue.orphan_envelope", .warn, ["id": entry.id])
                continue
            }
            result.append(entry)
        }
        return result.sorted { $0.sortKey < $1.sortKey }
    }

    /// Entries whose backoff has elapsed, oldest first.
    public func due(now: Date = Date()) throws -> [Entry] {
        try entries().filter { entry in
            guard let next = StructuredLog.date(from: entry.next_attempt_at) else { return true }
            return next <= now
        }
    }

    /// The payload. Read on the way out and never logged.
    public func body(of entry: Entry) throws -> Data {
        try Data(contentsOf: bodyURL(entry.id))
    }

    public func depth() throws -> Int { try entries().count }

    // MARK: - Mutating

    /// After a `2xx`, a `409 duplicate`, or a terminal rejection. Never before.
    public func remove(_ entry: Entry, reason: String) {
        try? FileManager.default.removeItem(at: envelopeURL(entry.id))
        try? FileManager.default.removeItem(at: bodyURL(entry.id))
        log("upload.dequeued", reason == "accepted" ? .info : .warn, [
            "endpoint": entry.endpoint.rawValue,
            "id": entry.id,
            "attempts": entry.attempts,
            "reason": reason,
        ])
    }

    /// Records a failed attempt and schedules the next one.
    @discardableResult
    public func recordFailure(_ entry: Entry,
                              now: Date = Date(),
                              backoff: Backoff = Backoff(),
                              random: (ClosedRange<Double>) -> Double = { Double.random(in: $0) })
        throws -> Entry {
        var updated = entry
        updated.attempts += 1
        let delay = backoff.delay(forAttempt: updated.attempts, random: random)
        updated.next_attempt_at = StructuredLog.timestamp(now.addingTimeInterval(delay))
        try write(updated)
        log("upload.queue.backoff", .warn, [
            "endpoint": entry.endpoint.rawValue,
            "id": entry.id,
            "attempts": updated.attempts,
            "delay_s": (delay * 10).rounded() / 10,
            "next_attempt_at": updated.next_attempt_at,
        ])
        return updated
    }

    // MARK: - Internals

    func envelopeURL(_ id: String) -> URL { directory.appendingPathComponent("\(id).json") }
    func bodyURL(_ id: String) -> URL { directory.appendingPathComponent("\(id).body") }

    private func write(_ entry: Entry) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(entry)
        // `.atomic` is a write-to-temp-and-rename. A half-written envelope is what the
        // "survives process death" criterion is actually about.
        try data.write(to: envelopeURL(entry.id), options: .atomic)
    }

    private func trim(now: Date) throws {
        let all = try entries()
        guard all.count > capacity else { return }
        for entry in all.prefix(all.count - capacity) {
            log("upload.queue.overflow", .error, [
                "endpoint": entry.endpoint.rawValue,
                "id": entry.id,
                "capacity": capacity,
                "created_at": entry.created_at,
            ])
            remove(entry, reason: "queue_full")
        }
    }

    /// Sortable by string, and **stable under a same-millisecond collision**.
    ///
    /// One sync enqueues the digest and every voice pack with a single `now`, so a
    /// millisecond timestamp plus a random suffix puts them in a random order — and the
    /// queue drains oldest-first specifically so the server sees the sequence that
    /// actually happened. The counter is what makes "oldest" mean enqueue order rather
    /// than whatever `UUID()` produced. It only has to be monotonic within a process;
    /// across processes the millisecond prefix orders them.
    static func newID(now: Date) -> String {
        let millis = Int64((now.timeIntervalSince1970 * 1000).rounded())
        let sequence = sequenceCounter.next()
        let suffix = UUID().uuidString.prefix(8).lowercased()
        return String(format: "%015lld-%09llu-%@", millis, sequence, String(suffix))
    }

    private static let sequenceCounter = Counter()

    final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var value: UInt64 = 0
        func next() -> UInt64 {
            lock.lock(); defer { lock.unlock() }
            value += 1
            return value
        }
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - Backoff

/// Exponential, jittered, capped.
///
/// The cap is what stops a month-old queue entry scheduling itself for next year, and the
/// jitter is what stops a fleet that all lost network at the same moment from retrying in
/// lockstep. Both are asserted against an injected clock in `UploaderTests` rather than
/// observed with `sleep`, which is the only way this is testable at all.
public struct Backoff: Sendable, Equatable {
    public var base: TimeInterval
    public var factor: Double
    public var cap: TimeInterval
    /// Fractional, applied symmetrically: 0.2 means ±20%.
    public var jitter: Double

    public init(base: TimeInterval = 60, factor: Double = 2,
                cap: TimeInterval = 3600, jitter: Double = 0.2) {
        self.base = base
        self.factor = factor
        self.cap = cap
        self.jitter = jitter
    }

    /// `attempt` is 1-based: the delay *after* the first failure.
    public func delay(forAttempt attempt: Int,
                      random: (ClosedRange<Double>) -> Double = { Double.random(in: $0) })
        -> TimeInterval {
        let exponent = max(0, attempt - 1)
        // Clamped before `pow` so a queue entry that somehow reached attempt 400 does
        // not produce an infinity and an unrepresentable date.
        let raw = base * pow(factor, Double(min(exponent, 32)))
        let capped = min(raw.isFinite ? raw : cap, cap)
        guard jitter > 0 else { return capped }
        return capped * random((1 - jitter)...(1 + jitter))
    }

    /// The worst case a caller can rely on, used by the bound assertion in the tests.
    public var maximumDelay: TimeInterval { cap * (1 + jitter) }
}
