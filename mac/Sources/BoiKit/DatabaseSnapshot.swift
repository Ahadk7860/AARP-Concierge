import Foundation

/// A point-in-time copy of `chat.db` **and both of its sidecars**.
///
/// The existing Python prototype does this and it is worth keeping: Messages holds a
/// long-lived writer on the real database, and copying under it avoids contending with
/// checkpoints mid-scan.
///
/// The part that is easy to get wrong is copying `chat.db` alone. The `-wal` file is
/// where the newest messages live; a snapshot without it is the frozen-corpus failure
/// wearing a different hat — no error, a plausible-looking count, and every message
/// since the last checkpoint missing. So a snapshot that finds a `-wal` beside the
/// source and fails to copy it throws.
public struct DatabaseSnapshot {

    public enum Error: Swift.Error, CustomStringConvertible {
        case sidecarLost(String)

        public var description: String {
            switch self {
            case .sidecarLost(let name):
                return "snapshot dropped \(name); the newest messages live there. Refusing a silently frozen corpus."
            }
        }
    }

    public static let sidecarSuffixes = ["-wal", "-shm"]

    public let url: URL
    private let directory: URL

    /// Copies `path` plus any `-wal`/`-shm` beside it into `directory`.
    public init(of path: String, into directory: URL) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        self.directory = directory

        let source = URL(fileURLWithPath: path)
        let destination = directory.appendingPathComponent(source.lastPathComponent)
        try? fileManager.removeItem(at: destination)
        try fileManager.copyItem(at: source, to: destination)

        for suffix in Self.sidecarSuffixes {
            let sidecar = URL(fileURLWithPath: path + suffix)
            guard fileManager.fileExists(atPath: sidecar.path) else { continue }
            let sidecarDestination = URL(fileURLWithPath: destination.path + suffix)
            try? fileManager.removeItem(at: sidecarDestination)
            try fileManager.copyItem(at: sidecar, to: sidecarDestination)
            guard fileManager.fileExists(atPath: sidecarDestination.path) else {
                throw Error.sidecarLost(source.lastPathComponent + suffix)
            }
        }

        self.url = destination
    }

    public func remove() {
        try? FileManager.default.removeItem(at: directory)
    }
}
