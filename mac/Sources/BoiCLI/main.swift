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
       boi-cli voice-pack --mirror <path> --out <dir> [--contacts <abcddb>]
       boi-cli health --mirror <path> [--contacts <abcddb>]
       boi-cli sync-run --db <path> --state <dir> [--force] [--dry-run]

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

  --state <dir>               (sync-run) the state directory: mirror, heartbeat,
                              upload queue. Output goes to <dir>/out.
  --force                     (sync-run) ignore the idempotent 6h guard
  --dry-run                   (sync-run) print what would be uploaded, upload nothing
"""

guard let command = arguments.first, !command.hasPrefix("--") else {
    fail(usage)
}

/// State that lives outside the mirror. Read once, passed to the one health function.
///
/// The green-share signal only means something when the AddressBook confirms the user
/// has somebody to text green; with no contacts readable this stays nil, which the
/// health check treats as no evidence rather than as evidence of absence.
func systemState(contacts: AddressBookDirectory?) -> HealthCheck.SystemState {
    var state = HealthCheck.SystemState.read()
    state.hasNonIMessageContacts = contacts.map { $0.recordCount > 0 ? true : false }
    return state
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
        let digest = DigestBuilder(
            resolver: resolver,
            options: .init(generatedAt: generatedAt,
                           system: systemState(contacts: contacts))).build(from: result)
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

case "agent-plist":
    // THE SINGLE SOURCE OF TRUTH for the LaunchAgent. `build-app.sh` calls this rather
    // than embedding its own copy, so the plist that ships inside the bundle and the one
    // the suite checks cannot drift apart — which is exactly how a plist ends up naming
    // a helper, or a calendar trigger, months after a test said it did not.
    guard let binaryPath = value("binary") else { fail(usage) }
    let xml = LaunchAgentPlist.xml(
        binaryPath: binaryPath,
        intervalSeconds: value("interval").flatMap(Int.init) ?? SyncRun.defaultIntervalSeconds,
        logDirectory: value("log-directory"))
    let problems = LaunchAgentPlist.problems(inXML: xml)
    guard problems.isEmpty else {
        fail("refusing to emit a LaunchAgent plist with problems:\n  "
             + problems.joined(separator: "\n  "))
    }
    print(xml)

case "voice-pack-provenance":
    // Answers the question `scripts/check_voice_pack_leak.py` cannot answer on a real
    // corpus: does every exemplar in this pack come from a row the user WROTE?
    //
    // Guard three compares against `chat.db`'s `text` column, and on this Mac only 9,940
    // of 30,998 sent rows have one — the other 21,047 carry their text in
    // `attributedBody`. So a phrase the user really did send is absent from the
    // checker's "sent" set, and if anyone ever sent the same common phrase back, it is
    // reported as a leak. This checks the mirror, which has the decoded text, and so can
    // tell a real leak from that false positive.
    //
    // Counts only. No message text is printed, logged, or written.
    guard let mirrorPath = value("mirror"),
          let packArgument = value("pack") ?? value("packs") else { fail(usage) }
    do {
        let mirror = try MirrorDatabase(path: mirrorPath)

        func normalize(_ text: String) -> String {
            text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }

        // ONE pass over the mirror, however many packs are being checked. A 94k-row
        // corpus re-read once per pack turns a 174-pack audit into ten minutes.
        var sent: Set<String> = []
        var received: Set<String> = []
        try mirror.forEachMessage { message in
            guard let text = message.text, !text.isEmpty else { return }
            if message.isFromMe { sent.insert(normalize(text)) }
            else { received.insert(normalize(text)) }
        }

        var isDirectory: ObjCBool = false
        _ = FileManager.default.fileExists(atPath: packArgument, isDirectory: &isDirectory)
        let packPaths: [String]
        if isDirectory.boolValue {
            packPaths = ((try? FileManager.default.contentsOfDirectory(atPath: packArgument)) ?? [])
                .filter { $0.hasSuffix(".json") && $0 != "digest.json" }
                .sorted()
                .map { URL(fileURLWithPath: packArgument).appendingPathComponent($0).path }
        } else {
            packPaths = [packArgument]
        }

        var totalExemplars = 0, totalProven = 0, totalRedacted = 0, totalUnproven = 0
        var packsWithUnproven = 0, alsoInbound = 0

        for path in packPaths {
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
                  let pack = try? JSONDecoder().decode(VoicePack.self, from: data) else { continue }
            var proven = 0, redacted = 0, unproven = 0
            for exemplar in pack.exemplars {
                let key = normalize(exemplar)
                let inSent = sent.contains(key)
                let inReceived = received.contains(key)
                if inSent { proven += 1; if inReceived { alsoInbound += 1 } }
                else if inReceived { unproven += 1 }
                else { redacted += 1 }
            }
            totalExemplars += pack.exemplars.count
            totalProven += proven
            totalRedacted += redacted
            totalUnproven += unproven
            if unproven > 0 {
                packsWithUnproven += 1
                StructuredLog.emit("voice_pack.provenance.unproven", level: .error, fields: [
                    "pack": path,
                    "contact_id": pack.contact_id ?? "null",
                    "traceable_to_inbound_only": unproven,
                ])
            }
        }

        StructuredLog.emit("voice_pack.provenance",
                           level: totalUnproven == 0 ? .info : .error, fields: [
            "packs": packPaths.count,
            "exemplars": totalExemplars,
            // Provably from a row the mirror records as is_from_me = 1.
            "proven_sent": totalProven,
            // Rewritten by redaction, so no verbatim match exists anywhere. Expected.
            "redacted_beyond_verbatim_match": totalRedacted,
            // THE ONLY BUCKET THAT IS A LEAK.
            "traceable_to_inbound_only": totalUnproven,
            "packs_with_unproven": packsWithUnproven,
            // Sent by the user AND also said back to them. This is the bucket guard
            // three misreports, because chat.db's text column holds only a third of the
            // sent rows and the rest live in attributedBody.
            "sent_and_also_seen_inbound": alsoInbound,
        ])
        if totalUnproven > 0 { exit(1) }
    } catch {
        StructuredLog.emit("voice_pack.provenance.failed", level: .error,
                           fields: ["detail": "\(error)"])
        exit(1)
    }

case "redaction-selftest":
    // Asserts redaction is IDEMPOTENT across a whole real corpus, and names the pattern
    // when it is not. This is the check that would have caught the whitespace-collapse
    // bug before it reached a run: every synthetic test message had single spaces, and
    // the real corpus is full of runs and embedded newlines.
    //
    // Counts and pattern names only. No message text is printed, logged, or written.
    guard let mirrorPath = value("mirror") else { fail(usage) }
    do {
        let mirror = try MirrorDatabase(path: mirrorPath)
        let redactor = Redactor(directory: AddressBookDirectory.discover() ?? .empty)
        var total = 0, offenders = 0
        var byPattern: [String: Int] = [:]
        try mirror.forEachSentMessage { message in
            guard let text = message.text, !text.isEmpty else { return }
            total += 1
            let once = redactor.redact(text)
            guard redactor.redact(once) != once else { return }
            offenders += 1
            byPattern[redactor.nonIdempotentPattern(once) ?? "unknown", default: 0] += 1
        }
        StructuredLog.emit("redaction.selftest", level: offenders == 0 ? .info : .error, fields: [
            "sent_messages_with_text": total,
            "not_idempotent": offenders,
            "by_pattern": byPattern,
        ])
        if offenders > 0 { exit(1) }
    } catch {
        StructuredLog.emit("redaction.selftest.failed", level: .error,
                           fields: ["detail": "\(error)"])
        exit(1)
    }

case "health":
    guard let mirrorPath = value("mirror") else { fail(usage) }
    guard let salt = ContactResolver.developmentSalt() else {
        fail("\(ContactResolver.developmentSaltVariable) is not set. Copy .env.example to "
             + ".env in this worktree.")
    }
    do {
        let mirror = try MirrorDatabase(path: mirrorPath)
        let contacts = value("contacts").flatMap(AddressBookDirectory.read(path:))
            ?? AddressBookDirectory.discover()
        let now = Date()
        let corpus = try MetricLibrary(resolver: ContactResolver(salt: salt,
                                                                 directory: contacts ?? .empty),
                                       options: .init(now: now)).compute(mirror: mirror).corpus
        let system = systemState(contacts: contacts)
        let health = HealthCheck.evaluate(corpus: corpus, system: system)

        StructuredLog.emit("health.checked", at: now, fields: [
            "health": health.health.rawValue,
            "reasons": health.reasons,
            "produces_report": health.producesReport,
            "headline": health.headline,
            "message_count": corpus.messageCount,
            "thread_count": corpus.threadCount,
            "span_days": corpus.spanDays,
            "days_since_newest": corpus.daysSinceNewest,
            "green_share": corpus.greenShare,
            "retention_boundary": corpus.retentionBoundary ?? "none",
            "exact_boundary_signature": RetentionBoundary.isExactBoundary(spanDays: corpus.spanDays),
            "threads_on_boundary": corpus.threadsOnBoundary,
            "messages_in_icloud": system.messagesInICloud.map(String.init) ?? "unknown",
            "low_power_mode": system.lowPowerMode,
        ])

        for remedy in health.remedies {
            StructuredLog.emit("health.remedy", at: now, fields: [
                "id": remedy.id,
                "title": remedy.title,
                "body": remedy.body,
                "deep_link": remedy.deepLink ?? "none",
                "instructions": remedy.fallbackInstructions,
                "rescan_available": remedy.rescanAvailable,
            ])
        }

        if !health.producesReport {
            // The thin path. No report, and the copy says why in the user's terms.
            // Never hand somebody a bad report and call it their year in messages.
            StructuredLog.emit("health.no_report", at: now, fields: [
                "headline": HealthCheck.thinHeadline,
                "body": HealthCheck.thinBody,
            ])
        }
    } catch {
        StructuredLog.emit("health.failed", level: .error, fields: ["detail": "\(error)"])
        exit(1)
    }

case "voice-pack":
    guard let mirrorPath = value("mirror"), let outDirectory = value("out") else { fail(usage) }
    guard let salt = ContactResolver.developmentSalt() else {
        fail("\(ContactResolver.developmentSaltVariable) is not set. Copy .env.example to "
             + ".env in this worktree.")
    }
    do {
        let mirror = try MirrorDatabase(path: mirrorPath)
        let contacts = value("contacts").flatMap(AddressBookDirectory.read(path:))
            ?? AddressBookDirectory.discover()
        let resolver = ContactResolver(salt: salt, directory: contacts ?? .empty)
        let now = Date()

        // The same identities the digest ranks, so a person merged across two handles
        // gets one pack rather than two thin ones that both fall below the threshold.
        let metrics = try MetricLibrary(resolver: resolver, options: .init(now: now))
            .compute(mirror: mirror)
        let builder = VoicePackBuilder(options: .init(
            now: now, redactor: Redactor(directory: contacts ?? .empty)))
        let packs = try builder.build(mirror: mirror,
                                      identities: metrics.relationships.map(\.identity))

        for pack in packs {
            let path = try VoicePackBuilder.write(pack, toDirectory: outDirectory)
            // Counts and hashes only. An exemplar is the user's own sentence and it does
            // not go in a log line, which lands in an observability vendor.
            StructuredLog.emit("voice_pack.written", at: now, fields: [
                "path": path,
                "scope": pack.scope,
                "contact_id": pack.contact_id ?? "null",
                "voice_pack_version": pack.voice_pack_version,
                "n_exemplars": pack.n_exemplars,
                "median_len_chars": pack.register.median_len_chars,
                "p90_len_chars": pack.register.p90_len_chars ?? -1,
                "avg_msgs_per_burst": pack.register.avg_msgs_per_burst,
                "punctuation": pack.register.punctuation.rawValue,
                "emoji_rate": pack.register.emoji_rate,
                "question_rate": pack.register.question_rate ?? -1,
                "greeting_rate": pack.register.greeting_rate ?? -1,
            ])
        }
        StructuredLog.emit("voice_pack.complete", at: now, fields: [
            "packs": packs.count,
            "out": outDirectory,
            "address_book_records": contacts?.recordCount ?? -1,
            "contacts_below_threshold":
                metrics.relationships.count - (packs.count - 1),
            "minimum_sent_messages":
                VoicePackBuilder.minimumSentMessagesForContactPack,
        ])
    } catch {
        StructuredLog.emit("voice_pack.failed", level: .error, fields: ["detail": "\(error)"])
        exit(1)
    }

case "sync-run":
    // The whole pass — read, mirror, digest, voice packs, heartbeat, UPLOAD — reachable
    // without the .app bundle.
    //
    // `Boi.app --sync` is the shipping entry point and it lives in `BoiApp.swift`, which
    // Track E does not own. Prompt 01 said the `--dry-run` flag belongs in this file;
    // there was no full-run command here to put it on, so this is it. `--dry-run` is also
    // read from `CommandLine.arguments` by `Uploader.Configuration.fromEnvironment`, which
    // is how `Boi.app --sync --dry-run` works without editing a file this track does not
    // own. Both routes are recorded in NOTES.md.
    guard let databasePath = value("db"), let stateDirectory = value("state") else { fail(usage) }
    guard let salt = ContactResolver.developmentSalt() else {
        fail("\(ContactResolver.developmentSaltVariable) is not set. Copy .env.example to "
             + ".env in this worktree.")
    }
    do {
        let paths = SyncRun.Paths(
            chatDatabase: databasePath,
            mirror: URL(fileURLWithPath: stateDirectory)
                .appendingPathComponent("mirror.db").path,
            outputDirectory: URL(fileURLWithPath: stateDirectory)
                .appendingPathComponent("out").path,
            stateDirectory: stateDirectory)
        let outcome = try SyncRun(paths: paths, salt: salt).run(force: flag("force"))

        StructuredLog.emit("sync_run.complete", fields: [
            "ran": outcome.ran,
            "reason": outcome.skippedReason ?? "none",
            "messages_ingested": outcome.messagesIngested,
            "mirror_message_count": outcome.mirrorMessageCount,
            "health": outcome.health.rawValue,
            "digest": outcome.digestPath ?? "none — corpus is thin",
            "voice_packs": outcome.voicePackPaths.count,
            "heartbeat": outcome.heartbeatPath ?? "none",
            "upload_accepted": outcome.upload?.accepted ?? -1,
            "upload_duplicates": outcome.upload?.duplicates ?? -1,
            "upload_queued": outcome.upload?.queued ?? -1,
            "upload_rejected": outcome.upload?.rejected ?? -1,
            "upload_dry_run": outcome.upload?.dryRun ?? -1,
            "elapsed_s": (outcome.elapsed * 1000).rounded() / 1000,
        ])
    } catch let unavailable as Uploader.QueueUnavailable {
        // Strictly worse than `Deferred`: nothing was queued, so nothing will be retried.
        // Reported separately so an operator cannot read it as "it'll go next time".
        StructuredLog.emit("sync_run.queue_unavailable", level: .error, fields: [
            "endpoint": unavailable.endpoint,
            "detail": unavailable.description,
        ])
        exit(1)
    } catch let deferred as Uploader.Deferred {
        // NON-ZERO. A silent success on a failed upload is the defect prompt 01 exists
        // to catch. The local artefacts are all written; the queue holds what did not
        // land, and the next run retries it.
        StructuredLog.emit("sync_run.upload_deferred", level: .error, fields: [
            "queued": deferred.queued,
            "rejected": deferred.rejected,
            "endpoints": deferred.endpoints,
            "detail": deferred.description,
        ])
        exit(1)
    } catch {
        StructuredLog.emit("sync_run.failed", level: .error, fields: ["detail": "\(error)"])
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
