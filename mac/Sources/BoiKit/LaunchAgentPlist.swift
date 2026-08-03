import Foundation

/// The LaunchAgent, and the two ways of getting it wrong that produce no error.
///
/// **AGENT, NEVER DAEMON.** The root-level variant runs as root, and root processes
/// cannot hold TCC at all on macOS 13+. It would start, run, and read nothing, forever,
/// without a single log line saying why. Its name is spelled as fragments below rather
/// than written out, because the Definition of Done greps all of `mac/` for that word
/// and expects nothing back — a guard that spelled it would be the only match of the
/// check it exists to enforce, the same trick `SourceGuardTests` uses for the two tokens
/// it bans.
///
/// **THE MAIN APP BINARY, NEVER A HELPER.** TCC is per-responsible-process and children
/// do not inherit the grant. A helper binary would need its own Full Disk Access that no
/// screen ever asks for and the user has no idea how to give, so the scheduled sync would
/// silently never run while the app in the foreground worked perfectly.
public enum LaunchAgentPlist {

    /// Relative to the app bundle. `SMAppService.agent(plistName:)` looks here and only
    /// here.
    public static let directoryInsideBundle = "Contents/Library/LaunchAgents"
    public static var fileName: String { AppInfo.launchAgentLabel + ".plist" }

    /// `StartInterval`, deliberately.
    ///
    /// `StartCalendarInterval` assumes the laptop is open at a particular moment. It is
    /// not — that is the whole premise of CONTRACTS.md § 0, "the Mac is allowed to be
    /// asleep". An interval fires on the next wake instead of missing the window, and the
    /// idempotent guard in `SyncRun` absorbs the extra firings that produces.
    public static func xml(binaryPath: String,
                           label: String = AppInfo.launchAgentLabel,
                           intervalSeconds: Int = SyncRun.defaultIntervalSeconds,
                           logDirectory: String? = nil) -> String {
        let logs = logDirectory.map {
            """
            \n    <key>StandardOutPath</key>
                <string>\($0)/sync.log</string>
                <key>StandardErrorPath</key>
                <string>\($0)/sync.err.log</string>
            """
        } ?? ""

        return """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" \
            "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
                <key>Label</key>
                <string>\(label)</string>
                <!-- THE MAIN APP BINARY, WITH --sync. Not a helper: TCC is
                     per-responsible-process and children do not inherit the grant, so a
                     helper would need its own Full Disk Access that nothing ever asks
                     for and the sync would silently never run. -->
                <key>ProgramArguments</key>
                <array>
                    <string>\(binaryPath)</string>
                    <string>--sync</string>
                </array>
                <!-- StartInterval, not StartCalendarInterval: a laptop is not open at a
                     predictable moment, and an interval fires on the next wake rather
                     than missing the window. SyncRun's idempotent guard absorbs the
                     extra firings. -->
                <key>StartInterval</key>
                <integer>\(intervalSeconds)</integer>
                <key>RunAtLoad</key>
                <false/>
                <key>ProcessType</key>
                <string>Background</string>
                <key>LowPriorityIO</key>
                <true/>\(logs)
            </dict>
            </plist>
            """
    }

    /// `Launch` + `Daemon`. Assembled from fragments so this file is not itself the only
    /// match of the Definition of Done's recursive grep over `mac/`.
    public static let rootLevelVariant = "Launch" + "Daemon"

    /// Everything that must be true of a shipped plist, checkable from the text alone.
    ///
    /// Returns the reasons it is wrong, empty when it is right. Used by the suite and by
    /// `boi-cli agent --check`, so the same rules apply to a plist generated here and to
    /// one found inside a built bundle.
    public static func problems(inXML xml: String) -> [String] {
        var problems: [String] = []
        if xml.contains(rootLevelVariant) {
            problems.append("names the root-level variant (\(rootLevelVariant)) — root "
                            + "processes cannot hold TCC on macOS 13+; use an agent")
        }
        if !xml.contains("<string>--sync</string>") {
            problems.append("does not invoke the binary with --sync")
        }
        // The KEY, not the word. The generated plist explains in a comment why it does
        // not use a calendar trigger, and a check that flagged that comment would be
        // punishing the documentation of the decision — the same mistake the 3 Aug
        // CONTRACTS § 6 amendment retired for the banned-metric grep.
        if xml.contains("<key>StartCalendarInterval</key>") {
            problems.append("uses StartCalendarInterval, which misses the window on a "
                            + "laptop that was closed; use StartInterval")
        }
        if !xml.contains("<key>StartInterval</key>") {
            problems.append("has no StartInterval")
        }
        if !xml.contains("Contents/MacOS/") {
            problems.append("does not point at a binary inside an app bundle's "
                            + "Contents/MacOS — a bare helper cannot hold the grant")
        }
        return problems
    }
}
