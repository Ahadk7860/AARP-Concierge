import CryptoKit
import Foundation

/// Turns raw iMessage handles into stable, salted contact identities.
///
/// TWO THINGS HAPPEN HERE AND THEY ARE DIFFERENT.
///
/// **Normalization** makes `"(555) 010-0001"`, `"+15550100001"` and `"5550100001"` the
/// same string, so the same phone number does not produce two identities.
///
/// **Merging** makes a phone number and an email address the same *person*, and it can
/// only be done from the AddressBook, because nothing in `chat.db` says they belong
/// together. `MERGING ON THE HANDLE STRING IS THE BUG THIS TYPE EXISTS TO NOT HAVE`:
/// the existing Python prototype merges that way, so a friend who texts from a phone
/// and emails from an Apple ID splits into two rows, each with half the volume, and
/// both land below where the one real relationship belongs. That corrupts the top of
/// the ranking, which is the only part of the ranking anybody reads.
public struct ContactResolver: Sendable {

    /// A person, as far as this Mac can tell.
    public struct Identity: Sendable, Equatable {
        /// `h_` + HMAC hex. Stable for one user, and arithmetically unrelatable across
        /// users because the salt differs — see CONTRACTS.md § 3.
        public let contact_id: String
        /// What the card shows. The AddressBook name when there is one, otherwise the
        /// handle itself, because a digest that says "unknown" for half the ranking is
        /// worse than one that says a phone number.
        public let display: String
        /// Every normalized handle that resolved to this person.
        public let handles: [String]
        /// The AddressBook record this came from, when merging found one. Diagnostic;
        /// never serialized into the digest.
        public let addressBookRecordID: Int64?
    }

    /// HMAC-SHA256 keyed on the user salt, lowercase hex, truncated.
    ///
    /// Truncation length is 16 hex characters — 64 bits. The schema permits 8 to 32; 8
    /// is a birthday collision every few thousand contacts, which on a merge-by-id
    /// design would silently fuse two people back together and undo the whole point of
    /// this type. 16 is free and puts that beyond reach.
    public static let identifierHexLength = 16

    private let salt: SymmetricKey
    private let directory: AddressBookDirectory

    public init(salt: String, directory: AddressBookDirectory = .empty) {
        self.salt = SymmetricKey(data: Data(salt.utf8))
        self.directory = directory
    }

    /// Reads the dev salt from the environment, matching Track B's reference builder.
    ///
    /// The real salt arrives from `POST /v1/pair` and is never this value; until then
    /// both implementations must agree or the same person gets two `contact_id`s and a
    /// cross-implementation diff is unreadable.
    public static let developmentSaltVariable = "BOI_DEV_USER_SALT"

    /// Falls back to the worktree's `.env`, which is where the value actually lives —
    /// `swift run` does not source it, and requiring every invocation to export it by
    /// hand is how somebody eventually runs without it and gets a digest full of
    /// identifiers nobody else can reproduce. Absent everywhere returns nil, and the
    /// caller refuses to build rather than inventing a salt.
    public static func developmentSalt(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        searchingFrom directory: String = FileManager.default.currentDirectoryPath
    ) -> String? {
        if let value = environment[developmentSaltVariable], !value.isEmpty { return value }
        return DotEnv.value(of: developmentSaltVariable, searchingFrom: directory)
    }

    // MARK: - Normalization

    /// Collapses the spellings of one handle into one string.
    ///
    /// Emails lowercase. Phone numbers reduce to digits and are given a country code
    /// when the shape is unambiguous: a bare 10-digit number and `+1` on the same 10
    /// digits are the same person, and treating them as two is the same ranking bug as
    /// not merging at all, arriving from a different direction.
    public static func normalize(_ handle: String) -> String {
        let trimmed = handle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        if trimmed.contains("@") { return trimmed.lowercased() }

        let digits = trimmed.filter(\.isNumber)
        guard !digits.isEmpty else { return trimmed.lowercased() }
        if trimmed.hasPrefix("+") { return "+" + digits }
        if digits.count == 10 { return "+1" + digits }
        if digits.count == 11, digits.hasPrefix("1") { return "+" + digits }
        return "+" + digits
    }

    /// `contact_id` for one already-normalized handle.
    public func identifier(forNormalizedHandle handle: String) -> String {
        var mac = HMAC<SHA256>(key: salt)
        mac.update(data: Data(handle.utf8))
        let hex = mac.finalize().map { String(format: "%02x", $0) }.joined()
        return "h_" + String(hex.prefix(Self.identifierHexLength))
    }

    /// `usr_` / `dev_` identifiers for a local, unpaired Mac.
    ///
    /// Placeholders with the right shape. The real ones arrive from `POST /v1/pair`,
    /// which this track does not call in this round — so these are derived from the
    /// salt rather than invented per run, and a digest regenerated from the same mirror
    /// keeps the same ids.
    public func localUserIdentifier() -> String { prefixed("usr_", scope: "user") }
    public func localDeviceIdentifier() -> String { prefixed("dev_", scope: "device") }

    private func prefixed(_ prefix: String, scope: String) -> String {
        var mac = HMAC<SHA256>(key: salt)
        mac.update(data: Data("boi.local.\(scope)".utf8))
        let hex = mac.finalize().map { String(format: "%02x", $0) }.joined()
        return prefix + String(hex.prefix(16))
    }

    // MARK: - Merging

    /// Groups handles into people.
    ///
    /// Two handles merge when the AddressBook says they belong to the same **record
    /// id**, never because their strings look alike. Handles the AddressBook has never
    /// heard of stay separate, which is the safe direction: failing to merge understates
    /// one relationship, while merging two strangers puts one person's messages in
    /// another person's row.
    ///
    /// The identity of a merged person is derived from the lexicographically smallest of
    /// its normalized handles, so the `contact_id` does not depend on which handle
    /// happened to be seen first.
    public func resolve(handles: [String]) -> [Identity] {
        var byRecord: [Int64: Set<String>] = [:]
        var unmatched: Set<String> = []

        for raw in handles {
            let normalized = Self.normalize(raw)
            guard !normalized.isEmpty else { continue }
            if let record = directory.recordID(forNormalizedHandle: normalized) {
                byRecord[record, default: []].insert(normalized)
            } else {
                unmatched.insert(normalized)
            }
        }

        var identities: [Identity] = []
        for (record, group) in byRecord {
            let sorted = group.sorted()
            guard let anchor = sorted.first else { continue }
            identities.append(Identity(
                contact_id: identifier(forNormalizedHandle: anchor),
                display: directory.displayName(forRecordID: record) ?? anchor,
                handles: sorted,
                addressBookRecordID: record
            ))
        }
        for handle in unmatched.sorted() {
            identities.append(Identity(
                contact_id: identifier(forNormalizedHandle: handle),
                display: directory.displayName(forNormalizedHandle: handle) ?? handle,
                handles: [handle],
                addressBookRecordID: nil
            ))
        }
        return identities.sorted { $0.contact_id < $1.contact_id }
    }

    /// `normalized handle -> identity`, for attributing each message row to a person.
    public func index(handles: [String]) -> [String: Identity] {
        var index: [String: Identity] = [:]
        for identity in resolve(handles: handles) {
            for handle in identity.handles { index[handle] = identity }
        }
        return index
    }
}

/// The AddressBook, reduced to the two questions this track asks it.
///
/// Kept as a value rather than a live connection so the metric library never holds a
/// second database open while it runs, and so a test can supply one without a file.
public struct AddressBookDirectory: Sendable {

    /// normalized handle -> AddressBook record id (`ZABCDRECORD.Z_PK`).
    private let recordsByHandle: [String: Int64]
    /// record id -> display name.
    private let namesByRecord: [Int64: String]

    public static let empty = AddressBookDirectory(recordsByHandle: [:], namesByRecord: [:])

    public init(recordsByHandle: [String: Int64], namesByRecord: [Int64: String]) {
        self.recordsByHandle = recordsByHandle
        self.namesByRecord = namesByRecord
    }

    public var recordCount: Int { namesByRecord.count }
    public var handleCount: Int { recordsByHandle.count }

    public func recordID(forNormalizedHandle handle: String) -> Int64? {
        recordsByHandle[handle]
    }

    public func displayName(forRecordID record: Int64) -> String? {
        namesByRecord[record]
    }

    public func displayName(forNormalizedHandle handle: String) -> String? {
        recordsByHandle[handle].flatMap { namesByRecord[$0] }
    }

    /// Reads macOS's `AddressBook-v22.abcddb`.
    ///
    /// Core Data's generated schema, which is stable enough to read and not stable
    /// enough to require: `ZABCDRECORD` holds people, and `ZABCDPHONENUMBER` /
    /// `ZABCDEMAILADDRESS` hold their handles keyed back by `ZOWNER`. **`ZOWNER` is the
    /// record id everything merges on.**
    ///
    /// Returns `nil` rather than throwing when the file is absent or unreadable, which
    /// is the normal state before Full Disk Access is granted. Degrading to
    /// unmerged-but-honest beats refusing to produce a digest at all — but the caller is
    /// told, so "no contacts" is a reported state and never a silent one.
    public static func read(path: String) -> AddressBookDirectory? {
        guard let database = try? ChatDatabase(path: path) else { return nil }

        var names: [Int64: String] = [:]
        var handles: [String: Int64] = [:]

        let nameQuery = """
            SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION FROM ZABCDRECORD
            """
        guard (try? database.query(nameQuery) { row in
            let record = row.int64(0)
            let parts = [row.string(1), row.string(2)].compactMap { $0 }
                .filter { !$0.isEmpty }
            let display = parts.isEmpty
                ? (row.string(3).flatMap { $0.isEmpty ? nil : $0 })
                : parts.joined(separator: " ")
            if let display { names[record] = display }
        }) != nil else { return nil }

        for (table, column) in [("ZABCDPHONENUMBER", "ZFULLNUMBER"),
                                ("ZABCDEMAILADDRESS", "ZADDRESS")] {
            try? database.query("SELECT ZOWNER, \(column) FROM \(table)") { row in
                guard let raw = row.string(1) else { return }
                let normalized = ContactResolver.normalize(raw)
                guard !normalized.isEmpty else { return }
                // First writer wins, and the walk is ordered by nothing in particular —
                // so a handle listed on two records is left on whichever claimed it.
                // Preferring one over the other would need a rule the AddressBook does
                // not give us, and inventing one here is how a stranger's messages end
                // up in somebody's row.
                if handles[normalized] == nil { handles[normalized] = row.int64(0) }
            }
        }

        return AddressBookDirectory(recordsByHandle: handles, namesByRecord: names)
    }

    /// Where macOS keeps it. The source directory is a UUID, so this is a search rather
    /// than a path.
    public static func defaultPaths(
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> [String] {
        let root = home.appendingPathComponent("Library/Application Support/AddressBook")
        var candidates = [root.appendingPathComponent("AddressBook-v22.abcddb").path]
        let sources = root.appendingPathComponent("Sources")
        let contents = (try? FileManager.default.contentsOfDirectory(atPath: sources.path)) ?? []
        for source in contents.sorted() {
            candidates.append(sources.appendingPathComponent(source)
                .appendingPathComponent("AddressBook-v22.abcddb").path)
        }
        return candidates
    }

    /// The first readable AddressBook among the default locations, or nil.
    public static func discover(
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> AddressBookDirectory? {
        for path in defaultPaths(home: home) {
            if let directory = read(path: path), directory.recordCount > 0 { return directory }
        }
        return nil
    }
}
