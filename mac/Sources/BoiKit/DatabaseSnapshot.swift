import Foundation

/// A point-in-time copy of `chat.db`, taken with `VACUUM INTO`.
///
/// Messages holds a long-lived writer on the real database, so copying under it avoids
/// contending with checkpoints mid-scan.
///
/// WHY NOT `copyItem` THE FILE AND ITS SIDECARS. That is the obvious implementation and
/// it is broken in the exact way this class exists to prevent. Copying `chat.db`, then
/// `-wal`, then `-shm` is three separate reads of a database that a live writer is
/// still checkpointing. If a checkpoint lands between the first and second copy, the
/// `-wal` that arrives carries a salt that no longer matches the header already copied.
/// SQLite treats a salt mismatch as a stale log, ignores the entire WAL, and **raises
/// no error** — a snapshot that looks fine, opens fine, and is missing every message
/// since the last checkpoint. That is the frozen-corpus bug reproduced by the thing
/// meant to prevent it.
///
/// `VACUUM INTO` runs inside a read transaction on the source, so it sees one
/// consistent view of the database *including* the WAL, and writes a single fully
/// checkpointed file. There are no sidecars to lose, and no window to lose them in.
public struct DatabaseSnapshot {

    public let url: URL
    private let directory: URL

    /// Snapshots the database at `path` into `directory`.
    public init(of path: String, into directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        self.directory = directory

        let destination = directory
            .appendingPathComponent(URL(fileURLWithPath: path).lastPathComponent)
        // VACUUM INTO refuses to overwrite, which is the behaviour we want everywhere
        // except on a re-run of the same command.
        try? FileManager.default.removeItem(at: destination)

        let source = try ChatDatabase(path: path)
        try source.vacuum(into: destination.path)

        self.url = destination
    }

    public func remove() {
        try? FileManager.default.removeItem(at: directory)
    }
}
