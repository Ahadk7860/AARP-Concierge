// The whole pipe, once, from an empty database to a sent message.
//
//     npm run e2e
//
// Four tracks, roughly a thousand tests, and until this file the number of times the
// product had been executed end to end was zero. Every seam below was written by an agent
// that could not see the code on the other side of it.
//
// **This runner is not the point. The artifact directory is.** The runner is a script;
// what it exists to do is make the four tracks disagree in public, with both sides of
// every disagreement written to a file a human can open. A run that goes green on the
// first attempt is the outcome to be most suspicious of.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import type {
  Brief,
  DraftBundle,
  Gist,
  OutboundMessage,
} from "../../shared/src/index.js";
import { StubChannel } from "../../shared/src/index.js";
import { buildServer } from "../../api/src/server.js";
import { buildCardServer } from "../../card/src/server.js";
import { runForUser } from "../../brief/src/run.js";
import { bridgeDeps, gistOutcomeFor, draftsForGists } from "../../intelligence-bridge/src/index.js";
import {
  createUser,
  issuePairingCode,
  latestDigest,
  listBriefs,
  listOutboundMessages,
  listRelationships,
  newPairingCode,
  unsafeScopeFromUserId,
  type UserScope,
} from "../../db/src/index.js";
import { migrate } from "../../db/src/migrate.js";
import { renderCardForDigest } from "./card-client.js";

const run = promisify(execFile);

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..",
);

const SALT = "boi-dev-salt-do-not-ship-0001";
const defaultProvider = () => process.env["BOI_MODEL_PROVIDER"] ?? "fake";
const TZ = "America/Los_Angeles";

/** One stage of the pipe, as the seam report records it. */
export type Stage = {
  name: string;
  inputBytes: number | null;
  outputBytes: number | null;
  durationMs: number;
  note: string;
};

export type E2EResult = {
  artifactDir: string;
  stages: Stage[];
  scope: UserScope;
  sent: number;
  cardUrl: string | null;
  cardKind: "standard" | "refusal" | null;
  briefItems: number;
  status: string;
  /**
   * **What `StubChannel` received**, not what was stored.
   *
   * The distinction is the whole of gap 5: the stored brief carried a `card_url` that
   * resolved, and the blocks the channel got contained no card at all. Anything asserting
   * on the product's output has to assert here — an artifact that cannot show the defect
   * is not evidence.
   */
  outbound: OutboundMessage[];
  /** The stored `brief.v1` documents, for the assertions that really are about storage. */
  briefs: Brief[];
  /** The gists and drafts as the bridge produced them, for the `contact_id` join. */
  gists: Gist[];
  drafts: DraftBundle[];
};

export type E2EOptions = {
  /**
   * `fake` by default, and `fake` CANNOT DRAFT FOR A REAL GIST.
   *
   * `providers/fake.py` replays on `gist_id_contains` against four hard-coded fixture
   * ids, so a gist the producer just made raises `LookupError` and the drafter exits 1.
   * A default run therefore produces a brief with gists and **zero drafts**, which is a
   * correct degradation and an incomplete artifact set. Set `BOI_MODEL_PROVIDER=gemini`
   * with a key for the complete one. Recorded in NOTES.md.
   */
  provider?: string;
  /** Skip the card server, to prove a brief still goes out without one. */
  withoutCard?: boolean;
  /**
   * `rich` (default) clears the renderer's ten-relationship bar and produces a real
   * report card. `minimal` is the six-person corpus, which produces a REFUSAL card — the
   * only kind this repo could make before prompt 05, and the input that proves a refusal
   * is never attached to a brief.
   */
  corpusProfile?: "minimal" | "rich";
  /** Reuse an existing account, to exercise idempotency on a second run. */
  reuseScope?: UserScope;
  artifactRoot?: string;
  log?: (event: Record<string, unknown>) => void;
};

const sizeOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v ?? null));

/** 08:00 local, the only instant the scheduler acts on. */
function eightAmLocal(timezone: string): Date {
  const now = new Date();
  for (let m = 0; m < 60 * 24 * 2; m += 5) {
    const at = new Date(now.getTime() + m * 60_000);
    const hour = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hour: "numeric", hour12: false }).format(at));
    const minute = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, minute: "numeric" }).format(at));
    if (hour === 8 && minute < 5) return at;
  }
  throw new Error("could not find 08:00 local");
}

export async function runEndToEnd(options: E2EOptions = {}): Promise<E2EResult> {
  const log = options.log ?? ((e) => process.stdout.write(`${JSON.stringify(e)}\n`));
  const provider = options.provider ?? defaultProvider();
  const stages: Stage[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactDir = path.join(
    options.artifactRoot ?? path.join(REPO_ROOT, "cloud", "e2e", "runs"), stamp);
  await mkdir(artifactDir, { recursive: true });

  async function stage<T>(name: string, note: string, fn: () => Promise<T>,
                          sizes: (out: T) => [number | null, number | null] = () => [null, null],
  ): Promise<T> {
    const started = Date.now();
    const out = await fn();
    const [inputBytes, outputBytes] = sizes(out);
    stages.push({ name, inputBytes, outputBytes, durationMs: Date.now() - started, note });
    log({ msg: `e2e.${name}`, duration_ms: Date.now() - started, note });
    return out;
  }

  // ---------------------------------------------------------------- 1. the database
  await stage("migrate", "schema from empty", () => migrate());

  // ---------------------------------------------------------------- 2. the corpus
  // `--profile rich`, and it is the difference between a demo and the kill test.
  //
  // The default six-person corpus yields six ranked relationships; `buildCardModel`
  // refuses anything under ten, so every card this repo had ever rendered was a refusal
  // card. The contacts directory matters for the same reason at a smaller scale: without
  // one every archetype on the card is headed `+15550100014`, and the card's whole claim
  // is that the user can check it against their own memory.
  const profile = options.corpusProfile ?? "rich";
  const runsDir = path.join(REPO_ROOT, "cloud", "e2e", "runs");
  const corpus = path.join(runsDir, `chat-${profile}.db`);
  const contacts = path.join(runsDir, `AddressBook-${profile}.abcddb`);
  await stage("corpus", `synthetic chat.db (${profile}) + address book, open WAL`,
    async () => {
      if (!existsSync(corpus) || !existsSync(contacts)) {
        await mkdir(runsDir, { recursive: true });
        await run("/usr/bin/python3", [
          path.join(REPO_ROOT, "scripts", "make_synthetic_chatdb.py"),
          "--out", corpus, "--profile", profile, "--contacts-out", contacts,
        ]);
      }
    });

  // ---------------------------------------------------------------- 3. servers
  const channel = new StubChannel();
  const api = buildServer({ channel });
  await api.listen({ port: 0, host: "127.0.0.1" });
  const apiPort = (api.server.address() as { port: number }).port;

  let cardBase: string | null = null;
  let cardServer: ReturnType<typeof buildCardServer> | null = null;
  if (!options.withoutCard) {
    cardServer = buildCardServer();
    await cardServer.listen({ port: 0, host: "127.0.0.1" });
    cardBase = `http://127.0.0.1:${(cardServer.server.address() as { port: number }).port}`;
  }

  try {
    // -------------------------------------------------------------- 4. signup + pair
    const scope = options.reuseScope ?? (await stage("signup", "account, phone is the join key",
      async () => {
        const phone = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
        const { scope } = await createUser({ phone_e164: phone, timezone: TZ });
        return scope;
      }));

    // The device id the Mac derives for itself, so pairing registers the one it will use.
    const deviceId = await stage("pair", "six digits for a device token", async () => {
      const { stdout } = await run("/usr/bin/python3", ["-c",
        "import hmac,hashlib,sys;" +
        "print('dev_'+hmac.new(sys.argv[1].encode(),b'boi.local.device',hashlib.sha256)" +
        ".hexdigest()[:16])", SALT]);
      const id = stdout.trim();
      const code = newPairingCode();
      await issuePairingCode(scope, { code, ttl_seconds: 600 });
      const paired = await fetch(`http://127.0.0.1:${apiPort}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, device_id: id }),
      });
      if (paired.status !== 200) throw new Error(`pair failed: ${paired.status}`);
      const body = (await paired.json()) as { device_token: string };
      await writeFile(path.join(artifactDir, "pairing.json"),
        JSON.stringify({ device_id: id, user_id: scope.user_id }, null, 2));
      return { id, token: body.device_token };
    });

    // -------------------------------------------------------------- 5. THE MAC
    //
    // A real `boi-cli sync-run`: reads chat.db, builds the mirror, decodes typedstream,
    // computes the digest INCLUDING the four AMENDMENT-001 fields, extracts voice packs,
    // and uploads all of it over HTTP. Not a fixture, not an injection.
    await stage("mac-sync", "boi-cli sync-run: read, mirror, digest, upload", async () => {
      const cli = path.join(REPO_ROOT, "mac", ".build", "debug", "boi-cli");
      if (!existsSync(cli)) {
        await run("/usr/bin/env", ["swift", "build", "--package-path",
          path.join(REPO_ROOT, "mac"), "--product", "boi-cli"]);
      }
      const state = path.join(artifactDir, "mac");
      await run(cli, ["sync-run", "--db", corpus, "--state", state, "--force",
                      "--contacts", contacts], {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/tmp",
          BOI_DEV_USER_SALT: SALT,
          BOI_API_BASE: `http://127.0.0.1:${apiPort}`,
          BOI_USER_ID: scope.user_id,
          BOI_DEVICE_TOKEN: deviceId.token,
        },
      });
    });

    // What the server actually stored, as the server has it.
    const digestRow = await stage("digest-stored", "read back from Postgres",
      () => latestDigest(scope), (d) => [null, sizeOf(d?.payload)]);
    if (digestRow === null) throw new Error("the Mac uploaded nothing");
    await writeFile(path.join(artifactDir, "digest.json"),
      JSON.stringify(digestRow.payload, null, 2));

    // -------------------------------------------------------------- 6. intelligence
    const gistOutcome = await stage("gists", "boi_intel over the stored digest",
      () => gistOutcomeFor(scope, { provider, log }),
      (o) => [sizeOf(digestRow.payload), sizeOf(o.gists)]);
    await writeFile(path.join(artifactDir, "gists.json"),
      JSON.stringify(gistOutcome, null, 2));

    const drafts = await stage("drafts", "two candidates per gist, in the user's voice",
      () => draftsForGists(scope, gistOutcome.gists, { provider, log }),
      (d) => [sizeOf(gistOutcome.gists), sizeOf([...d.values()])]);
    await writeFile(path.join(artifactDir, "drafts.json"),
      JSON.stringify([...drafts.values()], null, 2));

    // -------------------------------------------------------------- 7. the tick
    let cardUrl: string | null = null;
    let cardKind: "standard" | "refusal" | null = null;
    const outcome = await stage("tick", "compose, render, deliver", async () => {
      const deps = bridgeDeps({ provider, log });
      return runForUser({ user_id: scope.user_id, timezone: TZ }, {
        now: eightAmLocal(TZ),
        channel,
        log,
        gistsFor: deps.gistsFor,
        draftsFor: deps.draftsFor,
        cardFor: async (_scope: UserScope, digest: unknown) => {
          if (cardBase === null) return { url: null, kind: null };
          const card = await renderCardForDigest(digest, {
            baseUrl: cardBase, userId: scope.user_id, artifactDir, log,
          });
          stages.push({
            name: "card", inputBytes: sizeOf(digest), outputBytes: card.bytes,
            durationMs: card.durationMs,
            note: card.url ? `${card.kind} card, hosted` : `no card: ${card.error ?? card.reason}`,
          });
          cardUrl = card.url;
          cardKind = card.kind as "standard" | "refusal" | null;
          return { url: card.url, kind: cardKind };
        },
      });
    });

    // -------------------------------------------------------------- 8. artifacts
    const outboundRows = await listOutboundMessages(scope);
    // The BRIEF DOCUMENT, not the tick's return value. The first version wrote the
    // outcome — three counters — which would have hidden the `card_url` finding below,
    // because the outcome has no card field to be empty.
    const storedBriefs = await listBriefs(scope);
    await writeFile(path.join(artifactDir, "brief.json"),
      JSON.stringify({ outcome, briefs: storedBriefs.map((b) => b.payload) }, null, 2));
    await writeFile(path.join(artifactDir, "outbound.json"),
      JSON.stringify(channel.sent, null, 2));
    await writeFile(path.join(artifactDir, "relationships.json"),
      JSON.stringify(await listRelationships(scope), null, 2));

    const report = seamReport(stages);
    await writeFile(path.join(artifactDir, "seam-report.md"), report);
    process.stdout.write(`\n${report}\n`);

    return {
      artifactDir,
      stages,
      scope,
      sent: channel.sent.length,
      cardUrl,
      cardKind,
      briefItems: outboundRows.length,
      status: outcome.status,
      outbound: channel.sent,
      briefs: storedBriefs.map((b) => b.payload),
      gists: gistOutcome.gists,
      drafts: [...drafts.values()],
    };
  } finally {
    await api.close();
    if (cardServer !== null) await cardServer.close();
  }
}

/** Per-stage timings and payload sizes. What went in, what came out, how long. */
export function seamReport(stages: readonly Stage[]): string {
  const total = stages.reduce((n, s) => n + s.durationMs, 0);
  const rows = stages.map((s) =>
    `| ${s.name} | ${s.inputBytes ?? "—"} | ${s.outputBytes ?? "—"} | ${s.durationMs} | ${s.note} |`);
  return [
    "# Seam report",
    "",
    "Every row is a boundary between two tracks that had never exchanged data.",
    "",
    "| stage | in (bytes) | out (bytes) | ms | note |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    `**Total: ${total} ms.** Numbers are recorded, not tuned — prompt \`04\` puts`,
    "performance explicitly out of scope.",
  ].join("\n");
}

export { unsafeScopeFromUserId };
