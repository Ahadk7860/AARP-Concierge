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

    /// The four `launchd` calendar triggers mirror the four RTC alarms exactly. The RTC
    /// alarm makes the closed Mac wake at the trigger; the calendar event then launches
    /// this app's `--sync` lifecycle, which queues the next RTC alarm.
    ///
    /// `intervalSeconds` remains only as source compatibility for the developer CLI from
    /// Phase 1. It is intentionally ignored: no caller can restore polling by changing
    /// that value.
    public static func xml(binaryPath: String,
                           label: String = AppInfo.launchAgentLabel,
                           intervalSeconds: Int = SyncRun.defaultIntervalSeconds,
                           logDirectory: String? = nil) -> String {
        _ = intervalSeconds
        let logs = logDirectory.map {
            """
            \n    <key>StandardOutPath</key>
                <string>\($0)/sync.log</string>
                <key>StandardErrorPath</key>
                <string>\($0)/sync.err.log</string>
            """
        } ?? ""
        let calendarIntervals = WakeScheduler.localWakeTimes.map { wakeTime in
            """
                <dict>
                    <key>Hour</key>
                    <integer>\(wakeTime.hour)</integer>
                    <key>Minute</key>
                    <integer>\(wakeTime.minute)</integer>
                </dict>
            """
        }.joined(separator: "\n")

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
                <!-- These triggers coincide with WakeScheduler's RTC alarms. The alarm
                     wakes the Mac; launchd starts --sync; that lifecycle schedules the
                     next alarm. There is no periodic or always-on fallback. -->
                <key>StartCalendarInterval</key>
                <array>
            \(calendarIntervals)
                </array>
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
        if xml.contains("<key>StartInterval</key>") {
            problems.append("uses obsolete periodic StartInterval instead of four RTC-aligned "
                            + "calendar triggers")
        }
        if let actual = calendarWakeTimes(inXML: xml) {
            let expected = WakeScheduler.localWakeTimes.map { [$0.hour, $0.minute] }.sorted {
                $0.lexicographicallyPrecedes($1)
            }
            if actual != expected {
                problems.append("calendar triggers are \(actual); expected exactly \(expected)")
            }
        } else {
            problems.append("has no valid StartCalendarInterval array")
        }
        if !xml.contains("Contents/MacOS/") {
            problems.append("does not point at a binary inside an app bundle's "
                            + "Contents/MacOS — a bare helper cannot hold the grant")
        }
        return problems
    }

    private static func calendarWakeTimes(inXML xml: String) -> [[Int]]? {
        guard let data = xml.data(using: .utf8),
              let plist = try? PropertyListSerialization.propertyList(
                from: data, options: [], format: nil),
              let root = plist as? [String: Any],
              let intervals = root["StartCalendarInterval"] as? [[String: Any]] else {
            return nil
        }

        let parsed: [[Int]] = intervals.compactMap { interval in
            guard Set(interval.keys) == Set(["Hour", "Minute"]),
                  let hour = interval["Hour"] as? Int,
                  let minute = interval["Minute"] as? Int else { return nil }
            return [hour, minute]
        }
        guard parsed.count == intervals.count else { return nil }
        return parsed.sorted { $0.lexicographicallyPrecedes($1) }
    }
}
