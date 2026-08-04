import Foundation

/// What the user is looking at, and what they should do about it.
///
/// **The anchor of this track is that the grant is the product's cliff edge and a user
/// standing on it can see nothing.** Before this type existed, `PermissionModel` had four
/// renderings for the whole grant — a spinner, "Not granted yet", a poll counter, and one
/// `"Something went wrong"` that caught every distinct failure. A user who granted the
/// wrong app, whose bundle sat in `~/Downloads`, or whose relaunch silently failed all saw
/// the same screen as somebody who simply had not clicked yet.
///
/// So the stages are enumerated here rather than inlined in the view, for two reasons that
/// are both load-bearing:
///
/// 1. **`BoiApp` is an executable target and `BoiKitTests` cannot import it**
///    (`Package.swift`). Copy that lives in the view is copy no test can read. Putting the
///    stage and its words in `BoiKit` is what makes "every state names what to do next" an
///    assertion instead of an intention.
/// 2. **`CaseIterable` lets the test iterate the whole enumeration.** A test that checks
///    the five stages somebody remembered is a test that a sixth stage silently defeats.
///
/// Deliberately **no associated values.** The poll count and a failure's detail string are
/// live data the view renders *alongside* a stage, not part of its identity — otherwise
/// `CaseIterable` is unavailable and the exhaustiveness this type exists for goes with it.
public enum GrantStage: String, CaseIterable, Sendable, Equatable {

    /// Probing at launch, before we know anything.
    case checking
    /// The consent screen. Named here so the enumeration covers onboarding end to end.
    case needsConsent

    /// **Failure path 1, and it is caught BEFORE the deep link.** The grant binds to the
    /// responsible bundle; a bundle outside an Applications folder can be granted and the
    /// grant still will not survive, so sending the user to System Settings first wastes
    /// the one trip they are willing to make. See `InstallLocation` for why *both*
    /// Applications folders count.
    case notInApplications

    /// The deep link is open and we are polling.
    ///
    /// **The relaunch is named here, at the start, not after thirty seconds.** The manual
    /// run settled that `GrantWatcher` never observes the grant: the app does not
    /// auto-advance, so restarting is not a safety net, it is the only path. A screen that
    /// waits half a minute before mentioning the one thing that works is half a minute of
    /// the product looking broken while a counter climbs to `checked 43×`.
    case waiting
    /// **Failure paths 2 and 3, which the platform cannot tell apart.** A grant given to
    /// the wrong entry and a user who never flipped anything both leave the probe
    /// `denied`, byte-identical. So this stage does not *claim* a diagnosis — it escalates
    /// with the two things worth checking and a way out that does not depend on us
    /// detecting anything.
    ///
    /// No longer where the relaunch is first offered — `waiting` does that now. This is
    /// only the "you have been here a while, check the row says Boi" escalation.
    case waitingStalled
    /// The user came back to Boi with the switch still off. A real signal — the app became
    /// frontmost again — and distinct from never having left.
    case returnedWithoutGranting

    /// The user asked Boi to restart itself, from the button. **There is no automatic
    /// relaunch any more** — macOS's own Quit & Reopen dialog performs it, and Boi
    /// competing with that dialog was the friction the manual run found.
    case relaunching
    /// **Failure path 4.** The relaunch was asked for and this process is still here past
    /// `FullDiskAccess.relaunchBudget`. Distinct from `deniedAfterRelaunch` in both the UI
    /// and the log, because the remedies are different: this one is "quit us by hand", the
    /// other is "the switch is on the wrong row".
    case relaunchStalled
    /// **Failure path 5.** We relaunched and the probe is still denied. The switch is off,
    /// or it is on for something that is not this bundle.
    case deniedAfterRelaunch

    /// Not a permission problem, and telling the user to grant access would not fix it.
    case noDatabase
    /// Granted and verified; reading the corpus.
    case syncing
    /// **The terminal screen, and the handoff to the thread.**
    ///
    /// The flow used to end on the health list — *"Boi can see more than this"*, two things
    /// that are wrong. Honest, and the wrong last impression: the user just granted full
    /// disk access and the reward was a list of problems. The hierarchy is **what worked →
    /// what to do next → what could be better**, and the health findings move below this
    /// rather than being the last thing on screen.
    case handoff
    /// Reached only when the scan produced findings and the handoff cannot be rendered —
    /// `ready` is no longer terminal on its own.
    case ready
    /// A genuine unexpected error — and *only* that. Every condition above has its own
    /// stage precisely so this one stops being the drain everything falls into.
    case failed

    // MARK: - What the user is told

    public var title: String {
        switch self {
        case .checking: return "Checking this Mac"
        case .needsConsent: return "Boi reads your message history on this Mac"
        case .notInApplications: return "Move Boi to your Applications folder first"
        case .waiting: return "Switch Boi on, then let it restart"
        case .waitingStalled: return "Still waiting — two things worth checking"
        case .returnedWithoutGranting: return "The switch is still off"
        case .relaunching: return "Restarting Boi"
        case .relaunchStalled: return "Boi could not restart itself"
        case .deniedAfterRelaunch: return "Boi restarted, and the switch is still off"
        case .noDatabase: return "This Mac has no Messages history yet"
        case .syncing: return "Reading your messages"
        case .handoff: return "Boi is texting you"
        case .ready: return "You're all set"
        case .failed: return "Boi hit an error it did not expect"
        }
    }

    public var body: String {
        switch self {
        case .checking:
            return "Looking at whether Boi can already read your messages. This takes a "
                + "moment and needs nothing from you."
        case .needsConsent:
            return "To tell you who you are drifting from, Boi reads the conversations on "
                + "this Mac — including the messages other people sent you. That reading "
                + "happens here, on your machine, and nowhere else."
        case .notInApplications:
            return "macOS ties Full Disk Access to where an app lives. Granted from any "
                + "other folder, the permission will not stick — and you would not find "
                + "out until Boi stopped working."
        case .waiting:
            // Says the quiet part first: macOS will ask, and the answer is yes. A user who
            // already chose Later reads the same screen and finds the way back, because
            // "flipped it and deferred the restart" and "has not flipped it" are the same
            // `denied` probe and nothing can tell them apart.
            return "When you switch Boi on, macOS will ask whether to quit and reopen it. "
                + "Choose Quit & Reopen — Boi cannot use the access until it restarts. If "
                + "you chose Later, the button below does the same thing whenever you're "
                + "ready."
        case .waitingStalled:
            return "Boi still cannot read your messages. Almost always this is one of two "
                + "things: the switch went on for a different app in the list, or Boi has "
                + "not been restarted since you flipped it."
        case .returnedWithoutGranting:
            return "You're back, and Boi still cannot read your messages. Nothing is "
                + "broken — the switch just is not on yet."
        case .relaunching:
            return "Boi is closing and reopening itself. This is expected, it takes about "
                + "a second, and you do not need to do anything."
        case .relaunchStalled:
            return "The switch is on, but Boi could not close and reopen itself — so it "
                + "still cannot use the access you just granted. Quitting it by hand does "
                + "exactly the same job."
        case .deniedAfterRelaunch:
            return "Boi restarted and still cannot read your messages, so the switch it "
                + "needs is not the one that got flipped. The row has to say Boi, and the "
                + "toggle has to be blue."
        case .noDatabase:
            return "Boi could not find a Messages database on this Mac. This is not a "
                + "permissions problem — there is simply nothing here to read yet."
        case .syncing:
            return "Boi is reading your message history. It stays on this Mac; only counts "
                + "and dates ever leave."
        case .handoff:
            return "That's the setup done — everything from here happens in Messages, not "
                + "in this window. You can close it."
        case .ready:
            return "Boi can read your messages. The thread is where the rest happens."
        case .failed:
            return "This is not a permissions problem and not something you did. The "
                + "details are below and in Boi's log."
        }
    }

    /// The one thing to do now. **Non-nil for every stage that needs the user**, which is
    /// the criterion: a state that renders without naming a next step is the spinner this
    /// track exists to delete.
    public var nextStep: String? {
        switch self {
        case .checking, .syncing:
            // Nothing is being asked. These are the only two, and the test pins that.
            // `handoff` and `ready` both ask for something now — the whole point of the
            // handoff is that the terminal screen has a next action.
            return nil
        case .needsConsent:
            return "Read the four points above, then continue."
        case .notInApplications:
            return "Drag Boi into Applications, open it from there, and come back to this "
                + "screen."
        case .waiting:
            return "Find Boi in the list, switch it on, and choose Quit & Reopen."
        case .waitingStalled:
            return "Check that the row you switched on says Boi, then restart Boi."
        case .returnedWithoutGranting:
            return "Reopen the settings pane and switch Boi on."
        case .relaunching:
            return "Wait about a second."
        case .relaunchStalled:
            return "Quit Boi with Command-Q and open it again."
        case .deniedAfterRelaunch:
            return "Open the pane again and switch on the row that says Boi."
        case .noDatabase:
            return "Open Messages, sign in with your Apple Account, then come back."
        case .handoff:
            return "Open the thread — that's where Boi talks to you."
        case .ready:
            // Reached when the handoff link cannot be built. Says what will happen rather
            // than offering a button that would go nowhere.
            return "Keep an eye on Messages — Boi will text you there."
        case .failed:
            return "Try again. If it keeps happening, the log will say why."
        }
    }

    /// Whether this stage is the user stuck rather than the user progressing. Drives the
    /// icon and the log level, and pins which stages must carry a remedy.
    public var isFailure: Bool {
        switch self {
        case .notInApplications, .waitingStalled, .returnedWithoutGranting,
             .relaunchStalled, .deniedAfterRelaunch, .noDatabase, .failed:
            return true
        case .checking, .needsConsent, .waiting, .relaunching, .syncing, .handoff, .ready:
            return false
        }
    }

    /// Whether the Full Disk Access deep link is worth offering here.
    ///
    /// **`notInApplications` is deliberately false.** Sending somebody to System Settings
    /// to grant a bundle that cannot hold the grant is the wasted trip this stage exists
    /// to prevent.
    public var offersSettingsLink: Bool {
        switch self {
        case .waiting, .waitingStalled, .returnedWithoutGranting, .deniedAfterRelaunch:
            return true
        case .checking, .needsConsent, .notInApplications, .relaunching, .relaunchStalled, .noDatabase, .syncing, .handoff, .ready, .failed:
            return false
        }
    }

    /// Whether to offer "quit and reopen Boi yourself".
    ///
    /// Offered wherever restarting is what moves the user forward.
    ///
    /// **`waiting` is on this list, and that is the whole correction from the manual run.**
    /// The probe never observes the grant from inside the process that was running when it
    /// was made, so no automatic relaunch is ever triggered and this button is the only
    /// exit. Offering it only after thirty seconds — as `01` did — means half a minute
    /// where the sole thing that works is hidden behind a counter.
    ///
    /// It is also the resume path for a user who chose **Later** on the system dialog,
    /// which is undetectable and therefore has to be answered on the screen they are
    /// already looking at.
    public var offersManualRelaunch: Bool {
        switch self {
        case .waiting, .waitingStalled, .relaunchStalled, .deniedAfterRelaunch:
            return true
        // `returnedWithoutGranting` is false on purpose: nothing has been granted yet, so
        // restarting would accomplish exactly nothing and offering it implies otherwise.
        case .checking, .needsConsent, .notInApplications,
             .returnedWithoutGranting, .relaunching, .noDatabase, .syncing,
             .handoff, .ready, .failed:
            return false
        }
    }

    /// The structured-log event for this stage. One slug per stage so
    /// `relaunchStalled` and `deniedAfterRelaunch` are distinguishable in the log as well
    /// as on screen, which the Definition of Done requires separately.
    public var logEvent: String { "fda.stage.\(rawValue)" }

    /// How long somebody waits before "it is working, keep going" becomes a lie.
    ///
    /// A correct grant is observed in a second or two. Thirty seconds of nothing means
    /// something is wrong that more waiting will not fix — but it is deliberately not
    /// three, because escalating over a user who is still reading the settings list is how
    /// a helpful screen becomes a nagging one.
    public static let escalateAfter: TimeInterval = 30

    /// Which waiting screen to show, given how many polls have gone by.
    ///
    /// **This is an escalation, not a detection.** A grant given to the wrong entry and a
    /// user who never flipped anything both leave the probe `denied`, byte-identical —
    /// macOS offers nothing that tells them apart. So the stalled screen offers the two
    /// things worth checking and a way out, and claims no diagnosis it cannot support.
    public static func whileWaiting(polls: Int) -> GrantStage {
        Double(polls) * FullDiskAccess.pollInterval >= escalateAfter ? .waitingStalled : .waiting
    }
}

/// Decides **when** a change in the Full Disk Access grant is worth telling the cloud
/// about, and rate-limits it.
///
/// Not *what* the message says — the copy is the cloud's, and this type never sees it.
/// Under AMENDMENT-002 the iMessage thread already exists by the time the Mac app is
/// installed, so the cloud can narrate the grant on the phone in the user's hand while
/// they work on the Mac. This is the Mac half of that: the signal, and nothing else.
///
/// ## Two rules, and the first one outranks the second
///
/// **The first false→true fires immediately, always.** That message is the entire reason
/// this track exists. A rate limiter that delays it would satisfy a "one signal per
/// minute" criterion while defeating the thing the criterion was written to protect.
///
/// **The cap applies to flapping thereafter** — at most one signal per
/// `minimumInterval`. A grant that toggles repeatedly is a user experimenting in System
/// Settings, and it must not become a burst of heartbeats.
///
/// ## Why the state is persisted
///
/// The happy path **relaunches the process.** An in-memory limiter would signal the grant,
/// relaunch, come back with an empty memory and signal again — two heartbeats about the
/// same event, roughly two seconds apart, straight through a cap that reads as one per
/// minute in the tests. Persisting `lastSignalled` across the relaunch is what makes the
/// limit true on the one path that actually happens.
public final class GrantNarrator {

    /// The floor between two signals about the same device.
    public static let minimumInterval: TimeInterval = 60

    public enum Decision: Equatable, Sendable {
        /// Send a heartbeat now, carrying this grant state.
        case signal(granted: Bool)
        /// Nothing new to say. The cloud already believes this.
        case unchanged
        /// The state genuinely changed, but too soon after the last signal. Carries how
        /// long until a signal would be allowed, so the caller can log a number rather
        /// than "suppressed".
        case suppressed(granted: Bool, retryAfter: TimeInterval)

        public var isSignal: Bool {
            if case .signal = self { return true }
            return false
        }
    }

    /// What the cloud was last told, and when. `nil` state means "never told it anything".
    public struct Memory: Codable, Sendable, Equatable {
        public var granted: Bool
        public var at: Date

        public init(granted: Bool, at: Date) {
            self.granted = granted
            self.at = at
        }
    }

    private var memory: Memory?
    private let persist: (Memory) -> Void

    /// - Parameters:
    ///   - memory: what a previous process already signalled, or nil on a first run.
    ///   - persist: called whenever a signal is issued, so the limit survives the relaunch.
    ///     Defaults to doing nothing, which is what a unit test wants.
    public init(memory: Memory? = nil, persist: @escaping (Memory) -> Void = { _ in }) {
        self.memory = memory
        self.persist = persist
    }

    /// What the cloud currently believes, or nil if it has never been told.
    public var lastSignalled: Memory? { memory }

    /// One observation of the grant state.
    ///
    /// Called on every poll rather than only on a detected edge, and that is deliberate:
    /// it is what lets a suppressed change **converge**. If the grant flips true (signal),
    /// then flips false and is suppressed, the cloud would otherwise be left believing a
    /// grant that no longer exists, forever, because no further edge ever arrives. Driving
    /// off the difference between the current state and the last *signalled* state instead
    /// of off an edge means the next observation after the interval elapses corrects it.
    public func observe(granted: Bool, now: Date) -> Decision {
        guard let memory else {
            // Never signalled anything. A Mac that starts up denied is not news — the
            // cloud's default assumption is already "not granted", and announcing it would
            // spend the user's first heartbeat saying nothing.
            guard granted else { return .unchanged }
            return issue(granted: granted, now: now)
        }

        // The cloud already believes this. Not a change, whatever the clock says.
        guard memory.granted != granted else { return .unchanged }

        let elapsed = now.timeIntervalSince(memory.at)
        guard elapsed >= Self.minimumInterval else {
            return .suppressed(granted: granted,
                               retryAfter: Self.minimumInterval - elapsed)
        }
        return issue(granted: granted, now: now)
    }

    private func issue(granted: Bool, now: Date) -> Decision {
        let updated = Memory(granted: granted, at: now)
        memory = updated
        persist(updated)
        return .signal(granted: granted)
    }

    // MARK: - Persistence

    public static let fileName = "grant-narrator.json"

    /// Loads what a previous process signalled. A missing or unreadable file means "never
    /// signalled", which is the safe direction: the worst case is one extra heartbeat, and
    /// the alternative — assuming we already told the cloud — silently loses the message
    /// this whole track exists to send.
    public static func load(fromDirectory directory: String) -> Memory? {
        let url = URL(fileURLWithPath: directory).appendingPathComponent(fileName)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Memory.self, from: data)
    }

    public static func save(_ memory: Memory, toDirectory directory: String) {
        let url = URL(fileURLWithPath: directory).appendingPathComponent(fileName)
        try? FileManager.default.createDirectory(at: URL(fileURLWithPath: directory),
                                                 withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(memory) else { return }
        try? data.write(to: url, options: .atomic)
    }

    /// A narrator wired to the on-disk memory in `directory`.
    public static func persisted(inDirectory directory: String) -> GrantNarrator {
        GrantNarrator(memory: load(fromDirectory: directory),
                      persist: { save($0, toDirectory: directory) })
    }
}

/// The way into the conversation, which is the last thing the user should see.
///
/// **Two states, one mechanism.** `sms:` opens an existing conversation or composes a new
/// one, so the paired and unpaired paths differ in copy and in whether a pairing token
/// rides along — not in machinery.
///
/// The link format is the cloud's, reproduced exactly: `cloud/api/src/welcome.ts` builds
/// `sms:${handle}&body=${encodeURIComponent(token)}`. **`&body=` rather than `?body=`** is
/// deliberate there — Apple's own documentation uses the ampersand form for `sms:` and
/// both iOS and macOS Messages accept it. Diverging here would produce a link that opens
/// Messages with an empty body and silently loses the pairing token.
public enum ThreadHandoff {

    public enum State: Sendable, Equatable {
        /// A device token exists — the normal path under AMENDMENT-002, where the thread
        /// was opened before the app was ever installed. The thread is already there.
        case paired(link: String)
        /// Direct download, or pairing never completed. The link carries the token that
        /// creates the pairing, the same one the confirmation page renders.
        case unpaired(link: String)
        /// **The line could not be resolved, so there is no honest link to render.**
        /// The number is per-user and comes from the registrar; a constant would open a
        /// thread with somebody else's line. Saying so plainly beats a malformed `sms:`
        /// URL that opens Messages addressed to nothing.
        case lineUnresolved

        /// The `sms:` URL to open, or nil when there is none to open honestly.
        public var link: String? {
            switch self {
            case .paired(let link), .unpaired(let link): return link
            case .lineUnresolved: return nil
            }
        }
    }

    /// What each handoff state says. **In `BoiKit`, not the view**, for the reason the rest
    /// of this file is: `BoiApp` is an executable target `BoiKitTests` cannot import, so
    /// copy left in `OnboardingView` is copy no test can read — and this copy in particular
    /// shipped a false claim precisely because nothing could assert on it.
    public struct Copy: Sendable, Equatable {
        public var headline: String
        public var detail: String
        /// nil when there is no link to open.
        public var button: String?
    }

    public static func copy(for state: State) -> Copy {
        switch state {
        case .paired:
            return Copy(headline: "Your thread with Boi is already open.",
                        detail: "The first report is on its way to it.",
                        button: "Open the conversation")
        case .unpaired:
            return Copy(headline: "One tap opens Messages with everything filled in.",
                        detail: "Send it and Boi takes it from there.",
                        button: "Start the conversation")
        case .lineUnresolved:
            // **Says only what is known.**
            //
            // This used to end "Boi will still text you — this window just cannot open the
            // thread for you." That is true when paired and **false when not**: an unpaired
            // user with no resolvable line has no thread and no completed pairing, so
            // nothing is going to text them.
            //
            // `lineUnresolved` collapses two different situations — *we know who you are
            // but not which line* and *you were never paired* — and pairing is knowable
            // from the token store, so this is a distinction the code declined to make
            // rather than one the platform withholds. Prompt 03 splits it and gives each
            // state accurate copy. Until then the claim is **deleted, not softened**:
            // whether Boi will text them is the part that cannot yet be determined, so
            // this says nothing about it.
            return Copy(headline: "Boi could not work out which number to text you from.",
                        detail: "Every account gets its own line, and this Mac has not been "
                            + "told which one is yours — so this window cannot open the "
                            + "thread for you.",
                        button: nil)
        }
    }

    /// - Parameters:
    ///   - handle: the user's **assigned line**, from the registrar. Per-user — never a
    ///     constant, and `nil` when it could not be resolved.
    ///   - pairingToken: the token that completes pairing, for the unpaired path.
    ///   - isPaired: whether a device token already exists. Ask the token store; this is
    ///     knowable rather than guessed.
    public static func resolve(handle: String?,
                               pairingToken: String?,
                               isPaired: Bool) -> State {
        guard let handle, isUsable(handle) else { return .lineUnresolved }
        if isPaired { return .paired(link: "sms:\(handle)") }
        // Unpaired with no token is not a usable link either: it would open a thread and
        // send nothing that pairs anything, which looks like it worked and does not.
        guard let pairingToken, !pairingToken.isEmpty else { return .lineUnresolved }
        return .unpaired(link: link(handle: handle, token: pairingToken))
    }

    /// `sms:<handle>&body=<percent-encoded token>` — byte-for-byte the cloud's shape.
    public static func link(handle: String, token: String) -> String {
        "sms:\(handle)&body=\(encode(token))"
    }

    /// A handle we are willing to put in a URL.
    ///
    /// The registrar hands back an E.164 number or an email address. Anything with
    /// whitespace, a control character, or one of `sms:`'s own delimiters would produce a
    /// URL that means something other than what it says — so it is refused rather than
    /// escaped into something plausible.
    static func isUsable(_ handle: String) -> Bool {
        guard !handle.isEmpty, handle.count <= 254 else { return false }
        let forbidden = CharacterSet.whitespacesAndNewlines
            .union(.controlCharacters)
            .union(CharacterSet(charactersIn: "&?#/\\<>\"'"))
        return handle.rangeOfCharacter(from: forbidden) == nil
    }

    /// Percent-encoding for a query value. `urlQueryAllowed` permits `&` and `=`, which
    /// would let a token split the URL, so those are removed from the allowed set.
    static func encode(_ value: String) -> String {
        let allowed = CharacterSet.urlQueryAllowed
            .subtracting(CharacterSet(charactersIn: "&=?#+"))
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }
}

/// Which stage a launch lands on.
///
/// Pure, and in `BoiKit`, because `BoiApp` is an executable target that `BoiKitTests`
/// cannot import — logic left in the view model is logic no test can reach. `PermissionModel`
/// keeps only the wiring: the probe, the timer, the window.
public enum LaunchDisposition {

    /// - Parameters:
    ///   - probe: what `FullDiskAccess.probe()` just said.
    ///   - didRelaunch: whether the previous process relaunched us for this grant. The
    ///     marker is what makes "still denied after relaunch" distinguishable from "has not
    ///     tried yet" — without it both are simply `denied` and collapse into one screen.
    ///   - install: where this bundle lives.
    public static func stage(probe: FullDiskAccess.Status,
                             didRelaunch: Bool,
                             install: InstallLocation.Verdict) -> GrantStage {
        switch probe {
        case .granted:
            return .syncing
        case .noDatabase:
            // Not a permission problem. Sending this user to System Settings would be
            // advice that cannot work.
            return .noDatabase
        case .denied:
            // **Install location outranks the relaunch marker**, because when both apply
            // the wrong folder is the *cause* of the failed relaunch. Reporting
            // "still denied after restarting" to somebody running Boi from ~/Downloads
            // sends them back to a switch that was never going to hold.
            if case .elsewhere = install { return .notInApplications }
            return didRelaunch ? .deniedAfterRelaunch : .waiting
        }
    }
}

/// The heartbeat sent at the moment the grant lands, on the wire.
///
/// **This is not `HeartbeatUpload`, and the difference is AMENDMENT-003.** That struct
/// declares `digest_as_of: String` — non-optional — because it was written for a heartbeat
/// that follows a sync. The grant heartbeat by definition precedes the first digest, so
/// there is no timestamp to put there, and Track E's own comment is right that inventing
/// one "would report a Mac that produced nothing as having produced something now."
///
/// AMENDMENT-003 makes `digest_as_of` **required and nullable**: `null` is the claim "this
/// device has never synced", which turns *granted but never synced* into a queryable fleet
/// state instead of an invisible one. The amendment is Track E's to implement in the
/// struct and the route; this track does not wait for it and does not edit
/// `Uploader.swift`. So the body is encoded here to the amended shape and handed to the
/// existing `Uploader.send(_:to:descriptor:)`, which takes raw `Data` and is unchanged.
///
/// When Track E lands the amendment in `HeartbeatUpload`, this type collapses into it and
/// one call site moves. That is the seam working as intended.
public struct GrantHeartbeat: Sendable, Equatable {

    public var device_id: String
    public var app_version: String
    /// AMENDMENT-003. `nil` encodes as an explicit `null`, never as an absent key —
    /// omitting it would be rejected by a schema that still requires the field, and would
    /// read as "an older build that did not report it" rather than "never synced".
    public var digest_as_of: String?
    public var macos_version: String?
    public var fda_granted: Bool

    public init(device_id: String,
                app_version: String,
                digest_as_of: String?,
                macos_version: String? = nil,
                fda_granted: Bool) {
        self.device_id = device_id
        self.app_version = app_version
        self.digest_as_of = digest_as_of
        self.macos_version = macos_version
        self.fda_granted = fda_granted
    }

    /// The exact property set `POST /v1/heartbeat` declares. The route sets
    /// `additionalProperties: false`, so an extra key is a `400` — this is written out
    /// rather than derived so the test can compare against it and a drift shows up here.
    public static let wireKeys: Set<String> = [
        "device_id", "app_version", "digest_as_of", "macos_version", "fda_granted",
    ]

    /// JSON with `digest_as_of` present-and-null when there has been no digest.
    ///
    /// `macos_version` is omitted when absent rather than nulled: the contract marks it
    /// optional, and `additionalProperties: false` with a null on an optional string is a
    /// validation failure on a strict schema.
    public func encoded() throws -> Data {
        var object: [String: Any] = [
            "device_id": device_id,
            "app_version": app_version,
            "fda_granted": fda_granted,
        ]
        if let macos_version { object["macos_version"] = macos_version }
        if let digest_as_of {
            object["digest_as_of"] = digest_as_of
        } else {
            object["digest_as_of"] = NSNull()
        }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}

/// Ties the narrator's decision to the byte that leaves the machine.
///
/// Kept in `BoiKit` rather than in the view model for the reason the whole track turns on:
/// `BoiApp` is an executable target and `BoiKitTests` cannot import it, so anything living
/// there cannot be asserted against a real server. The Definition of Done asks for the
/// heartbeat that left the machine, which means this has to be reachable from a test.
public struct GrantSignaller: Sendable {

    private let uploader: Uploader
    private let appVersion: String
    private let deviceID: String

    /// `DeviceIdentity` stays injected, per AMENDMENT-003. `device_id` is derivable on the
    /// Mac and `/v1/pair` accepts a client-supplied one; the device *token* comes from
    /// pairing, which under AMENDMENT-002 now happens in the iMessage thread before the
    /// app is ever installed — so by the time the grant lands, the device is already
    /// paired.
    public init(uploader: Uploader, deviceID: String, appVersion: String) {
        self.uploader = uploader
        self.deviceID = deviceID
        self.appVersion = appVersion
    }

    /// Sends the grant heartbeat. Returns what the server said, or `nil` if the body could
    /// not be encoded at all.
    ///
    /// **Synchronous, and blocking.** `Uploader.URLSessionTransport` waits on a semaphore,
    /// so every caller on the main actor must get this off it — a 30-second timeout on the
    /// main thread would freeze the exact screen this track exists to keep alive.
    @discardableResult
    public func send(granted: Bool,
                     digestGeneratedAt: String?,
                     macOSVersion: String? =
                        ProcessInfo.processInfo.operatingSystemVersionString,
                     log: (String, StructuredLog.Level, [String: Any]) -> Void = Uploader.emit
    ) -> Uploader.Result? {
        let beat = GrantHeartbeat(device_id: deviceID,
                                  app_version: appVersion,
                                  digest_as_of: digestGeneratedAt,
                                  macos_version: macOSVersion,
                                  fda_granted: granted)
        guard let body = try? beat.encoded() else { return nil }
        // `digest_as_of` is the descriptor's `asOf` when there is one. Nothing else about
        // the payload is loggable and none of it is user content.
        let descriptor = Uploader.PayloadDescriptor(schemaVersion: "heartbeat",
                                                    asOf: digestGeneratedAt)
        return uploader.send(body, to: .heartbeat, descriptor: descriptor, log: log)
    }
}

/// Whether this app is somewhere the grant can actually stick.
///
/// **Checked before the deep link is shown, never after the grant fails.** macOS ties Full
/// Disk Access to the responsible bundle's path. A bundle in `~/Downloads` can be granted
/// and the permission still will not hold, and the user finds out by Boi silently not
/// working — after they have already spent the one trip to System Settings they were
/// willing to make.
public enum InstallLocation {

    /// The directories a bundle can durably hold the grant from.
    ///
    /// **`~/Applications` counts, and that was established empirically rather than
    /// assumed.** TRACK.md states the bundle must be "in `/Applications`". This project's
    /// own log disproves the strict reading: on 3 Aug, `~/Applications/Boi.app` held Full
    /// Disk Access and completed a full sync of 94,897 messages. A check requiring
    /// `/Applications` exactly would tell that user to move a working install — advice
    /// that is both wrong and destructive, because moving the bundle is what actually
    /// breaks the grant.
    ///
    /// The property that matters is not which folder it is, but that the path is **stable
    /// and user-installed**. Both Applications folders are; `~/Downloads`, `/Volumes`,
    /// `/tmp` and Gatekeeper's randomized `AppTranslocation` paths are not.
    ///
    /// Not a prefix test — a bundle at `~/Downloads/Applications/Boi.app` contains the
    /// word and is still not installed. These are matched as the *enclosing directory*.
    public static func installDirectories(
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> [String] {
        ["/Applications", home.appendingPathComponent("Applications").path]
    }

    public enum Verdict: Sendable, Equatable {
        case installed
        /// Runnable but not durably grantable. Carries the path so the screen can show the
        /// user where the copy they opened actually is.
        case elsewhere(path: String)
        /// No enclosing `.app` at all — `swift run`, or a unit test. A bare binary cannot
        /// hold the grant, and it is also not a case any shipping user reaches.
        case notABundle
    }

    public static func verdict(
        bundlePath: String?,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> Verdict {
        guard let bundlePath, bundlePath.hasSuffix(".app") else { return .notABundle }
        // The enclosing directory, resolved: `/tmp` is a symlink to `/private/tmp`, and a
        // path comparison that ignores that reports two different strings for one folder.
        let parent = URL(fileURLWithPath: bundlePath).deletingLastPathComponent()
            .resolvingSymlinksInPath().path
        let allowed = installDirectories(home: home)
            .map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }
        return allowed.contains(parent) ? .installed : .elsewhere(path: bundlePath)
    }

    /// The verdict for the running process, via the responsible bundle — not
    /// `Bundle.main` directly, because the grant binds to the outermost enclosing bundle
    /// and that is the path that has to be installed.
    public static func current() -> Verdict {
        verdict(bundlePath: ResponsibleBundle.current())
    }
}
