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
       boi-cli text-coverage --db <path>
       boi-cli sync --db <path> --mirror <path> [--search <text>]
                    [--trailing-window-days <n>]
       boi-cli digest --mirror <path> --out <path>
                    [--contacts <abcddb>] [--calls <storedata>]
                    [--top <n>]

  --db <path>                 chat.db to read. Opened file:<path>?mode=ro, always.
  --snapshot                  copy the db and both sidecars first, then read the copy
  --scratch <dir>             where snapshots go (default /tmp/boi-a/snapshot)
  --poll                      keep polling instead of running one pass
  --interval <seconds>        poll interval (default 30 when foregrounded)
  --iterations <n>            stop after n passes (default 1; unlimited with --poll)
  --sample <n>                also print n redacted row summaries
  --state <path>              watermark state, carried across runs
                              (default /tmp/boi-a/watermark.json; "none" disables)
  --stall-alarm-seconds <n>   alarm once MAX(ROWID) has been flat this long
                              (default 3600)
  --include-tapbacks          keep associated_message_type 2000-3999
  --include-group-chats       keep chat.style = 43

  --mirror <path>             the local mirror (digest reads this and only this)
  --out <path>                where the digest.v1 document is written
  --contacts <path>           AddressBook-v22.abcddb; auto-discovered when omitted
  --calls <path>              CallHistory.storedata; auto-discovered when omitted
  --top <n>                   also print n relationship summaries, names redacted
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
        stallAlarmAfterSeconds: value("stall-alarm-seconds").flatMap(Int.init)
            ?? ScanPoller.defaultStallAlarmSeconds
    )

    // The watermark has to outlive the process or a single-pass run can only ever
    // report .first, and the stall alarm never fires on the default path.
    let statePath = value("state") ?? "/tmp/boi-a/watermark.json"
    let store = statePath == "none"
        ? nil
        : WatermarkStore(url: URL(fileURLWithPath: statePath))

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
            store: store,
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

case "sync":
    guard let databasePath = value("db"), let mirrorPath = value("mirror") else { fail(usage) }
    do {
        let reader = try MessageReader(path: databasePath)
        let mirror = try MirrorDatabase(path: mirrorPath)
        let before = try mirror.messageCount()
        let window = value("trailing-window-days").flatMap(Int.init)
            ?? MirrorSync.defaultTrailingWindowDays
        let stats = try MirrorSync(reader: reader, mirror: mirror,
                                   trailingWindowDays: window).run()

        StructuredLog.emit("sync.complete", at: stats.startedAt, fields: [
            "db": databasePath,
            "mirror": mirrorPath,
            "rows_scanned": stats.scanned,
            "rows_inserted": stats.inserted,
            "rows_updated": stats.updated,
            "rows_skipped_duplicate": stats.duplicatesSkipped,
            "mirror_rows_before": before,
            "mirror_rows_after": try mirror.messageCount(),
            "watermark_before": stats.watermarkBefore,
            "watermark_after": stats.watermarkAfter,
            "trailing_window_days": stats.trailingWindowDays,
            "window_start": stats.windowStart.map(StructuredLog.timestamp) ?? "all",
            "previous_sync_at": stats.previousSyncAt.map(StructuredLog.timestamp) ?? "never",
            "mirror_schema_version": MirrorDatabase.schemaVersion,
        ])

        if let needle = value("search") {
            let hits = try mirror.search(needle)
            StructuredLog.emit("sync.search", fields: ["query": needle, "hits": hits.count])
            for guid in hits.prefix(5) {
                StructuredLog.emit("sync.search.hit", fields: ["guid": guid])
            }
        }
    } catch {
        StructuredLog.emit("sync.failed", level: .error, fields: ["detail": "\(error)"])
        exit(1)
    }

case "digest":
    guard let mirrorPath = value("mirror"), let outPath = value("out") else { fail(usage) }
    guard let salt = ContactResolver.developmentSalt() else {
        fail("\(ContactResolver.developmentSaltVariable) is not set. contact_id is an HMAC "
             + "keyed on the user salt; without it this would emit ids that no other "
             + "implementation can reproduce. Copy .env.example to .env in this worktree.")
    }
    do {
        let mirror = try MirrorDatabase(path: mirrorPath)

        // Both of these degrade to nil, loudly. Contacts missing means no merging, which
        // costs accuracy at the top of the ranking; calls missing means the `calls`
        // object is absent rather than zero. Either way the run says which it got, so
        // "no calls" is never mistaken for "no call history readable".
        let contacts = value("contacts").flatMap(AddressBookDirectory.read(path:))
            ?? AddressBookDirectory.discover()
        let calls = value("calls").flatMap(CallHistory.read(path:)) ?? CallHistory.discover()

        let resolver = ContactResolver(salt: salt, directory: contacts ?? .empty)
        let generatedAt = Date()
        let library = MetricLibrary(resolver: resolver,
                                    options: .init(now: generatedAt, callHistory: calls))
        let result = try library.compute(mirror: mirror)
        let digest = DigestBuilder(resolver: resolver,
                                   options: .init(generatedAt: generatedAt)).build(from: result)
        let bytes = try DigestBuilder.write(digest, to: outPath)

        StructuredLog.emit("digest.complete", at: generatedAt, fields: [
            "mirror": mirrorPath,
            "out": outPath,
            "bytes": bytes,
            "elapsed_s": (result.elapsed * 1000).rounded() / 1000,
            "relationships": digest.relationships.count,
            "corpus_message_count": digest.corpus.message_count,
            "thread_count": digest.corpus.thread_count,
            "span_days": digest.corpus.span_days,
            "retention_boundary": digest.corpus.retention_boundary ?? "none",
            "threads_on_boundary": result.corpus.threadsOnBoundary,
            "first_contact_at_nulled": digest.relationships.filter { $0.first_contact_at == nil }.count,
            "health": digest.corpus.health.rawValue,
            "address_book_records": contacts?.recordCount ?? -1,
            "call_records": calls?.callCount ?? -1,
        ])

        // Display names are the one field in the digest that is a person's actual name,
        // so the console summary replaces them positionally. The file on disk is the
        // artefact; this is just a look at it.
        if let top = value("top").flatMap(Int.init) {
            let byID = Dictionary(uniqueKeysWithValues:
                result.relationships.map { ($0.identity.contact_id, $0) })
            for (offset, relationship) in digest.relationships.prefix(top).enumerated() {
                let metrics = byID[relationship.contact_id]
                StructuredLog.emit("digest.relationship", at: generatedAt, fields: [
                    "rank": offset + 1,
                    "display": "Person \(offset + 1)",
                    "contact_id": relationship.contact_id,
                    "message_count": relationship.message_count,
                    "momentum_90d": relationship.momentum_90d,
                    "initiation_ratio": relationship.initiation_ratio,
                    // Printed beside the ratio because the ratio is meaningless without
                    // it: one opener always gives exactly 0.0 or 1.0.
                    "conversations_opened": metrics?.conversationsOpened ?? -1,
                    "days_since_last_contact": relationship.days_since_last_contact,
                    "archetype": relationship.archetype?.rawValue ?? "none",
                    "first_contact_at": relationship.first_contact_at ?? "null",
                    "muted_by_them": relationship.muted_by_them.map(String.init) ?? "unknown",
                ])
            }
        }
    } catch {
        StructuredLog.emit("digest.failed", level: .error, fields: ["detail": "\(error)"])
        exit(1)
    }

case "text-coverage":
    guard let databasePath = value("db") else { fail(usage) }
    do {
        // Counts only. No message text is printed, logged, or written anywhere.
        let coverage = try TextCoverage.measure(reader: try MessageReader(path: databasePath))
        StructuredLog.emit("text.coverage", fields: coverage.logFields)
        if !coverage.meetsBar {
            StructuredLog.emit("text.coverage.below_bar", level: .warn, fields: [
                "share_decoder_failures": coverage.decoderFailureShare,
                "bar": TextCoverage.maximumDecoderFailureShare,
            ])
        }
    } catch {
        StructuredLog.emit("text.coverage.failed", level: .error, fields: ["detail": "\(error)"])
        exit(1)
    }

case "capture-typedstream-fixture":
    // Writes real message text to a LOCAL, GITIGNORED file under this track's scratch
    // directory so the decoder has a regression anchor. Never committed, never logged.
    guard let databasePath = value("db") else { fail(usage) }
    do {
        let out = value("out") ?? TypedStreamFixture.defaultPath
        guard out.hasPrefix("/tmp/boi-a/") else {
            fail("refusing to write real message data outside /tmp/boi-a")
        }
        let captured = try TypedStreamFixture.capture(from: try MessageReader(path: databasePath),
                                                      to: out)
        StructuredLog.emit("fixture.captured", fields: ["samples": captured, "path": out])
    } catch {
        StructuredLog.emit("fixture.failed", level: .error, fields: ["detail": "\(error)"])
        exit(1)
    }

default:
    fail(usage)
}
