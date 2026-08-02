import BoiKit
import Foundation

// boi-cli — the developer-facing entry point to the Mac sensor.
//
// There is no .app bundle until prompt 07. This binary makes no network calls, holds
// no account, and writes nothing outside the scratch directory it is given.

let arguments = CommandLine.arguments.dropFirst().filter { $0 != "--" }

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

func value(_ name: String) -> String? {
    guard let index = arguments.firstIndex(of: "--" + name) else { return nil }
    let next = arguments.index(after: index)
    guard next < arguments.endIndex else { fail("--\(name) needs a value") }
    return arguments[next]
}

func flag(_ name: String) -> Bool { arguments.contains("--" + name) }

let usage = """
usage: boi-cli scan --db <path> [options]

  --db <path>                 chat.db to read. Opened file:<path>?mode=ro, always.
  --snapshot                  copy the db and both sidecars first, then read the copy
  --scratch <dir>             where snapshots go (default /tmp/boi-a/snapshot)
  --poll                      keep polling instead of running one pass
  --interval <seconds>        poll interval (default 30 when foregrounded)
  --iterations <n>            stop after n passes (default 1; unlimited with --poll)
  --sample <n>                also print n redacted row summaries
  --stall-alarm-seconds <n>   alarm once MAX(ROWID) has been flat this long (default 0)
  --include-tapbacks          keep associated_message_type 2000-3999
  --include-group-chats       keep chat.style = 43
"""

guard let command = arguments.first, !command.hasPrefix("--") else {
    fail(usage)
}

switch command {
case "scan":
    guard let databasePath = value("db") else { fail(usage) }

    var readPath = databasePath
    var snapshot: DatabaseSnapshot?
    if flag("snapshot") {
        let scratch = URL(fileURLWithPath: value("scratch") ?? "/tmp/boi-a/snapshot")
        do {
            let taken = try DatabaseSnapshot(of: databasePath, into: scratch)
            snapshot = taken
            readPath = taken.url.path
        } catch {
            fail("snapshot failed: \(error)")
        }
    }
    defer { snapshot?.remove() }

    let options = ScanOptions(excludeTapbacks: !flag("include-tapbacks"),
                              excludeGroupChats: !flag("include-group-chats"))

    let sampleSize = value("sample").flatMap(Int.init)
    let polling = flag("poll")
    let interval = value("interval").flatMap(Double.init) ?? ScanPoller.foregroundInterval
    let iterations = value("iterations").flatMap(Int.init) ?? (polling ? nil : 1)
    let configuration = ScanPoller.Configuration(
        interval: polling ? interval : 0,
        iterations: iterations,
        stallAlarmAfterSeconds: value("stall-alarm-seconds").flatMap(Int.init) ?? 0
    )

    do {
        let reader = try MessageReader(path: readPath)
        StructuredLog.emit("scan.open", fields: [
            "db": databasePath,
            "uri": ChatDatabase.readOnlyURI(forPath: readPath),
            "snapshot": snapshot != nil,
            "poll_interval_s": configuration.interval,
        ])

        try ScanPoller(configuration: configuration).run(
            options: options,
            scan: { _ in
                try reader.scan(options: options,
                                loadMessages: sampleSize != nil,
                                now: Date())
            },
            onPass: { pass in
                let result = pass.result
                StructuredLog.emit("scan.complete", at: result.scannedAt, fields: [
                    "pass": pass.index,
                    "message_count": result.matchedCount,
                    "raw_message_count": result.rawMessageCount,
                    "thread_count": result.threadCount,
                    "messages_without_text": result.messagesWithoutText,
                    "excluded_tapbacks": result.excludedTapbackCount,
                    "excluded_group_chat_rows": result.excludedGroupChatCount,
                    "rows_in_no_chat": result.rowsInNoChat,
                    "max_rowid": result.maxROWID,
                ])

                switch pass.watermark {
                case .first(let rowID):
                    StructuredLog.emit("watermark.first", at: result.scannedAt,
                                       fields: ["max_rowid": rowID])
                case .advanced(let from, let to):
                    StructuredLog.emit("watermark.advanced", at: result.scannedAt,
                                       fields: ["from": from, "to": to])
                case .stalled(let at, let forSeconds):
                    if pass.raisesAlarm {
                        StructuredLog.emit("watermark.stalled", level: .warn, at: result.scannedAt,
                                           fields: ["max_rowid": at, "flat_for_s": forSeconds])
                    }
                case .regressed(let from, let to):
                    StructuredLog.emit("watermark.regressed", level: .error, at: result.scannedAt,
                                       fields: ["from": from, "to": to])
                }

                if let sampleSize {
                    for message in result.messages.suffix(sampleSize) {
                        StructuredLog.emit("scan.sample", at: result.scannedAt, fields: [
                            "rowid": message.rowID,
                            "guid": message.guid,
                            "is_from_me": message.isFromMe,
                            "service": message.service ?? "unknown",
                            "chat_style": message.chatStyle,
                            "has_text": message.text != nil,
                            "has_attributed_body": message.hasAttributedBody,
                            "sent_at": message.date.map(StructuredLog.timestamp) ?? "unknown",
                        ])
                    }
                }
            }
        )
    } catch {
        StructuredLog.emit("scan.failed", level: .error, fields: ["detail": "\(error)"])
        exit(1)
    }

default:
    fail(usage)
}
