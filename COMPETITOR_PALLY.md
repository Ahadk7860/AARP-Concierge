# Pally Companion 0.1.18 — Architecture Teardown

Static analysis of `Pally.dmg` (`com.pally.companion-kit`, build 193.1, macOS 13+).
Bundle metadata, entitlements, linked frameworks, and observable strings only. The app was
**not executed**. No code was copied; this documents architecture and approach.

---

## 1. Shape of the thing

| | Pally | Boi |
|---|---|---|
| Bundle | `PallyCompanion.app`, 133 MB | `Boi.app`, ~3 MB |
| UI shell | SwiftUI, 989 KB, `LSUIElement` (menu-bar, no dock) | SwiftUI + dock app |
| Worker | `pallykit-daemon`, **127 MB Bun 1.3.14 single-file binary** | Swift, in-process |
| Arch | Universal (x86_64 + arm64) | arm64 only |
| Transport | **Persistent WebSocket** to Cloudflare Workers | HTTP POST batches to Railway |
| Auto-update | **Sparkle 2.9.5**, EdDSA-signed appcast | none |
| Disk access | **Security-scoped bookmarks — no FDA** | **Full Disk Access required** |
| Outbound iMessage | AppleScript → Messages.app, as the user | Spectrum shared line |

A thin Swift shell that owns *permissions and UI*, and a fat Bun daemon that owns *all
logic*. The Swift layer exists mainly because TCC grants and security-scoped bookmarks must
come from a real app bundle.

---

## 2. The big one: no Full Disk Access

Their onboarding markets this directly — *"it never needs full disk access."* It is the
single biggest onboarding difference between the two products, and you just spent a session
regranting FDA after every rebuild.

Entitlements:

```xml
com.apple.security.files.user-selected.read-only   ✅
com.apple.security.files.bookmarks.app-scope       ✅
com.apple.security.personal-information.addressbook ✅
com.apple.security.automation.apple-events         ✅
com.apple.security.cs.allow-jit                    ✅
com.apple.security.cs.disable-library-validation   ✅
```

Note there is **no `com.apple.security.app-sandbox`** — the app is not sandboxed.

Confirmed symbols in the Swift shell: `NSOpenPanel`, `directoryURL`, `bookmarkData`,
`BookmarkCreationOptions`, `BookmarkResolutionOptions`,
`startAccessingSecurityScopedResource`, and the literal strings `~/Library/Messages` and
`~/Library/Messages/chat.db`.

The mechanism:

1. Present `NSOpenPanel` pre-pointed at `~/Library/Messages`.
2. The user's explicit selection is itself the TCC consent for that path — no
   System Settings trip, no relaunch.
3. Persist a **security-scoped bookmark** so access survives relaunch.
4. On start, resolve the bookmark and `startAccessingSecurityScopedResource()`.

Daemon side carries `PALLYKIT_GRANTED_DIRS` and `apps/daemon/src/folder-grant.ts` /
`granted-dirs.ts`, so the Swift shell hands resolved paths down to Bun.

Their setup UI splits this into three separately-grantable steps — Messages folder,
Contacts, Automation→Messages — each with its own button and status. Compare Boi's
`FullDiskAccess.swift` + `GrantNarrator` + `GrantWatcher`, which exist to nurse a user
through a System Settings toggle and a relaunch.

**Caveat before you copy it**: verify on your target macOS versions. Apple has tightened
user-selected-file consent for `~/Library` subpaths repeatedly, and the behavior differs
sandboxed vs not. They ship it at macOS 13+, so it works today — but test it, don't assume
it from this document.

---

## 3. They embed Claude Code on the user's Mac

The most consequential finding. The daemon bundles **`@anthropic-ai/claude-code`** — the
Agent SDK — and runs it locally:

```
apps/daemon/src/session-host.ts
apps/daemon/src/session-permission-server.ts
apps/daemon/src/terminal.ts
apps/daemon/src/terminal-environment.ts
apps/daemon/src/control-channel.ts
ClaudeAdapter · CLAUDE.md · CLAUDECODE · CLAUDE_CODE_AGENT_RULE_DISABLED
query( · sessionId · resume · permissionMode
```

Tool names present: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `Task`.

So the architecture is: **iMessage → Cloudflare relay → local Claude Code agent with tools,
running on the user's own machine.** `session-permission-server.ts` is the `canUseTool`
gate; `resume`/`sessionId` give conversation continuity across texts.

This is the polar opposite of Boi's design. Boi is a closed vocabulary where model output
never reaches the user and every sentence is licensed by evidence. Pally is a general agent
with filesystem and shell access, gated by a permission server.

**Directly relevant to your v3 question.** Pally answers "what's the weather in NY" because
it's an agent with `WebFetch`, not because it has a weather tool. That's one valid answer to
the open-lane problem — and it also means Pally structurally *can* fabricate about your
relationships in a way Boi currently cannot. That difference is a positioning choice, not
merely a technical one.

---

## 4. Data model and sync

`packages/imessage/src/{read,send,spawn}.ts` — a shared package, used by both daemon and
(presumably) their cloud. `packages/protocol/src/index.ts` is their contracts equivalent.

Reading: `chat.db` opened **readonly**, `journal_mode = WAL`, with `ROWID`, `handle_id`,
`is_from_me`, `typedstream` all present — the same decoding problem Boi solved in
`TypedStream.swift`. They also index **attachments** (`~/Library/Messages/Attachments`,
`apps/daemon/src/attachments.ts`, 164 hits) — Boi does not touch attachments at all.

Daemon modules: `chatindex.ts`, `inbound-cursor.ts`, `history-export.ts`,
`assistant-import.ts`, `resolver.ts`, `handles.ts`, `contacts.ts`, `imessage-status.ts`,
`presence-status.ts`, `connection-policy.ts`, `keychain.ts`, `auth.ts`, `device-name.ts`.

`inbound-cursor.ts` + `chatindex.ts` ≈ Boi's `MirrorSync` + `MirrorDatabase`.
Credentials go in the **Keychain** (`PALLYKIT_KEYCHAIN_SERVICE`), not a `.env` file —
worth noting given the DotEnv problem currently breaking your Swift tests.

History import is **optional and user-toggled** ("Import iMessage history" checkbox,
`PALLYKIT_HISTORY_IMPORT_DISABLED`). Boi always ingests everything.

---

## 5. Sending as the user

```
NSAppleEventsUsageDescription = "Pally sends iMessages on your behalf through the Messages app."
tell application "Messages"  ·  osascript  ·  buddy  ·  participant
```

Pally sends from the **user's own iMessage account** via Automation→Messages. Boi sends from
a Spectrum shared line (+1 646…), which is why Pally's assistant appears as its own contact
(+1 628…) *and* can send messages that appear to come from you.

This is the capability Boi's `draft.ts` path lacks entirely — Boi can compose a draft but has
no mechanism to actually send it as the user. Cost: requires Messages.app running and the
Mac awake, which their UI says outright ("Keep this Mac on, logged in, with Messages
running").

---

## 6. LinkedIn — a second data lane

An entire subsystem Boi has no equivalent of:

```
linkedin/{session,transport,rpc,voyager,eventstream,query-ids,
          ratelimiter,send,store,sync,sync-store,embed-client}.ts
```

They drive LinkedIn's internal **Voyager** API with the user's own authenticated session —
the WebView login ("Sign in on LinkedIn's real page; your login stays on this Mac", WebKit
is linked into the Swift shell, session in Keychain). `eventstream.ts` + `linkedin_realtime_frame`
means they consume LinkedIn's realtime channel, not just polling. `ratelimiter.ts` suggests
they've been burned by rate limits.

Semantic search over it: `text-embedding-3-small`, `EMBEDDING_DIMENSIONS`,
`EMBEDDING_BATCH`, cosine similarity, local store at `PALLYKIT_LINKEDIN_STORE_PATH`.

Message types: `linkedin_connections`, `linkedin_messages`, `linkedin_invitations`,
`linkedin_chat`, `linkedin_login_start/status/state`, `linkedin_disconnect`.

Note this is scraping an undocumented internal API against LinkedIn's ToS — a real product
and legal risk they've accepted. Worth knowing they took it; not necessarily worth copying.

---

## 7. Relay and pairing

```
PallyRelayURL = wss://pallykit-relay.pally.workers.dev/device
also present:   relay.pally.dev/device
headers:        x-pallykit-pairing, x-pallykit-device-name,
                x-pallykit-capabilities, x-pallykit-app-version
env:            PALLYKIT_TOKEN, PALLYKIT_PAIRING_CODE, PALLYKIT_STATE_DIR,
                PALLYKIT_RELAY_URL, PALLYKIT_PARENT_PID
```

Cloudflare Workers (almost certainly Durable Objects for socket affinity). The Mac holds a
**persistent outbound WebSocket** — no inbound ports, no polling, and the cloud can push
commands to the Mac.

Pairing is code-based and **conversation-first**: the user texts the assistant, gets a code,
types it into the companion app. That is materially better than Boi's current
`BOI_USER_ID` + `BOI_DEVICE_TOKEN` env-file dance — and it structurally cannot produce the
identity split you hit, because the code is issued *by* the chat, so the texting identity
and the device identity are bound at pairing time by construction.

`x-pallykit-capabilities` is a nice touch: the device declares what it can do, so the server
degrades per-device instead of assuming.

---

## 8. What I'd actually take from this

Ranked by value to Boi:

1. **Security-scoped bookmarks instead of FDA.** Biggest onboarding win available to you.
   Verify on your macOS targets first.
2. **Pairing code issued in-conversation.** Fixes the identity-split class of bug by
   construction rather than by the guard I added.
3. **Sparkle auto-update.** You have shipped several fixes this week that each required a
   manual DMG, re-copy, and FDA regrant.
4. **Keychain over `.env`.** Directly relevant — the DotEnv change is currently breaking 4
   Swift tests by reading a real credentials file.
5. **Persistent WebSocket** if you want live behavior; your HTTP batch model is fine for
   daily digests and simpler to reason about. Not urgent.
6. **A single language across Mac and cloud.** Their Bun daemon shares
   `packages/protocol` and `packages/imessage` with the server. Boi's Swift/TS split with
   hand-mirrored contracts is exactly what produced the `digest.v2` zod drift that cost a
   week. This is the most expensive thing to change and the most structural.

Things I would **not** copy: the LinkedIn Voyager scraping (ToS and legal exposure), and
the general-agent-with-Bash-on-the-user's-Mac design unless you consciously decide to
abandon the licensing guarantee. Boi's "never fabricates about your relationships" property
is a real differentiator, and §3 is what giving it up looks like.
