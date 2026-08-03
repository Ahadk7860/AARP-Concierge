// The bridge, seen from the brief rather than from the bridge.
//
// `bridge.test.ts` asks whether the subprocess boundary behaves. This file asks the
// only question that matters to a user: **when the intelligence fails, does the morning
// text still arrive?** Every criterion here is asserted on `StubChannel.sent` — on a
// brief that actually went out — rather than on a return value or a log line.
//
// The separate file is deliberate. These tests drive `runForUser`, which writes briefs
// and outbound messages; keeping them out of `bridge.test.ts` means the subprocess
// assertions there cannot be perturbed by delivery state.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Digest, VoicePack } from "../../shared/src/index.js";
import { StubChannel } from "../../shared/src/index.js";
import { runForUser, runForUserWithRetry } from "../../brief/src/run.js";
import { buildServer } from "../../api/src/server.js";
import {
  closePool,
  createUser,
  issuePairingCode,
  newDeviceId,
  newPairingCode,
  upsertVoicePack,
  type UserScope,
} from "../../db/src/index.js";
import { migrate } from "../../db/src/migrate.js";
import { acquireSuiteLock, releaseSuiteLock } from "../../db/src/test-lock.js";
import { REPO_ROOT, bridgeDeps, draftsForGists, gistOutcomeFor, gistsFor } from "./index.js";

const SALT = "boi-dev-salt-do-not-ship-0001";
const CORPUS = "/tmp/boi-a/chat.db";

function fixture<T>(...parts: string[]): T {
  return JSON.parse(
    readFileSync(path.join(REPO_ROOT, "contracts", "fixtures", ...parts), "utf8"),
  ) as T;
}

function baseConfig(over: Record<string, unknown> = {}) {
  return { corpusDb: CORPUS, salt: SALT, provider: "fake", timeoutMs: 60_000, ...over };
}

/** 08:00 local in this timezone, which is the only instant the scheduler acts on. */
function eightAmLocal(timezone: string): Date {
  const now = new Date();
  for (let minutes = 0; minutes < 60 * 24 * 2; minutes += 5) {
    const candidate = new Date(now.getTime() + minutes * 60_000);
    const hour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false })
        .format(candidate),
    );
    const minute = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, minute: "numeric" })
        .format(candidate),
    );
    if (hour === 8 && minute < 5) return candidate;
  }
  throw new Error("could not find 08:00 local");
}

const TZ = "America/Los_Angeles";

/**
 * A `digest.v1` built by the real Swift binary from the same `chat.db` the gist
 * producer reads, under the same salt.
 *
 * Built once and reused: `boi-cli sync` over the synthetic corpus is a few seconds, and
 * every test in this file needs the same document.
 */
let cachedDigest: Digest | null = null;
function macDigest(): Digest {
  if (cachedDigest !== null) return structuredClone(cachedDigest);
  const cli = path.join(REPO_ROOT, "mac", ".build", "debug", "boi-cli");
  if (!existsSync(cli)) {
    execFileSync("/usr/bin/env", [
      "swift", "build", "--package-path", path.join(REPO_ROOT, "mac"), "--product", "boi-cli",
    ]);
  }
  const dir = "/tmp/boi-a/bridge-pipeline";
  execFileSync("/bin/mkdir", ["-p", dir]);
  const mirror = path.join(dir, "mirror.db");
  const out = path.join(dir, "digest.json");
  const env = { ...process.env, BOI_DEV_USER_SALT: SALT };
  execFileSync(cli, ["sync", "--db", CORPUS, "--mirror", mirror], { env });
  execFileSync(cli, ["digest", "--mirror", mirror, "--out", out], { env });
  cachedDigest = JSON.parse(readFileSync(out, "utf8")) as Digest;
  return structuredClone(cachedDigest);
}

/**
 * An account whose digest was **inserted through `POST /v1/digest`** on a live server,
 * not written straight into the table.
 *
 * Prompt `02` asks for exactly that, and it is worth the extra machinery: the endpoint
 * validates against the frozen schema, checks the body's `user_id` against the token,
 * and checks the `device_id` against the account. A row placed directly into `digests`
 * skips all three, and every one of them is a place the join could be broken.
 */
async function seedThroughTheAPI(): Promise<UserScope> {
  const phone = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  const { scope } = await createUser({ phone_e164: phone, timezone: TZ });
  const deviceId = newDeviceId();

  const app = buildServer({ channel: new StubChannel() });
  await app.listen({ port: 0, host: "127.0.0.1" });
  try {
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    const code = newPairingCode();
    await issuePairingCode(scope, { code, ttl_seconds: 600 });
    const paired = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, device_id: deviceId }),
    });
    expect(paired.status).toBe(200);
    const { device_token } = (await paired.json()) as { device_token: string };

    // THE DIGEST IS BUILT FROM THE SAME CORPUS THE GISTS COME FROM, by the real Swift
    // binary, because `composeBrief` drops any gist whose `contact_id` the digest does
    // not know:
    //
    //     const relationship = byContact.get(gist.contact_id);
    //     if (relationship === undefined) continue;
    //
    // Seeding `contracts/fixtures/digest/healthy.json` here produced a brief with zero
    // items and a `nothing_to_say` skip — Python's gists were about the synthetic
    // corpus's people and the fixture digest was about somebody else's. That is a real
    // property of the join, not a test artefact: **the digest and the gists must come
    // from one corpus under one salt.** A cloud-side gist producer reading a different
    // machine's corpus would produce exactly this silent empty brief.
    const digest = macDigest();
    digest.user_id = scope.user_id;
    digest.device_id = deviceId;
    digest.generated_at = new Date().toISOString();
    digest.corpus.as_of = digest.generated_at;

    const posted = await fetch(`${base}/v1/digest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${device_token}`,
      },
      body: JSON.stringify(digest),
    });
    expect(posted.status, await posted.text()).toBe(202);
  } finally {
    await app.close();
  }

  // A voice pack for every contact the producer will name, plus the global fallback.
  await upsertVoicePack(scope, fixture<VoicePack>("voice_pack", "global_fallback.json"));
  const maya = fixture<VoicePack>("voice_pack", "maya.json");
  const outcome = await gistOutcomeFor(scope, baseConfig() as never);
  for (const [index, gist] of outcome.gists.entries()) {
    await upsertVoicePack(scope, {
      ...maya,
      contact_id: gist.contact_id,
      voice_pack_version: `vp_${index.toString(16).padStart(8, "0")}`,
    });
  }
  return scope;
}

beforeAll(async () => {
  if (!existsSync(CORPUS)) {
    execFileSync("/usr/bin/python3", [
      path.join(REPO_ROOT, "scripts", "make_synthetic_chatdb.py"), "--out", CORPUS,
    ]);
  }
  await acquireSuiteLock();
  await migrate();
}, 180_000);

afterAll(async () => {
  await releaseSuiteLock();
  await closePool();
});

describe("the brief, over a real bridge", () => {
  it("gets its gists from boi_intel, over a digest that came in through POST /v1/digest", async () => {
    const scope = await seedThroughTheAPI();
    const channel = new StubChannel();
    const events: Record<string, unknown>[] = [];

    const outcome = await runForUser(
      { user_id: scope.user_id, timezone: TZ },
      {
        now: eightAmLocal(TZ),
        channel,
        log: (e) => events.push(e),
        ...bridgeDeps(baseConfig() as never),
      },
    );

    expect(outcome.status, JSON.stringify(events)).toBe("sent");
    expect(channel.sent.length).toBeGreaterThan(0);
    // The gists are NOT the committed fixtures. If this ever starts matching them, the
    // bridge has quietly gone back to reading fixtures off disk.
    const produced = await gistOutcomeFor(scope, baseConfig() as never);
    expect(produced.gists.map((g) => g.gist_id)).not.toContain("g_11aa22bb");
  }, 300_000);

  it("still sends the gists when Python crashes — zero drafts, never a failed brief", async () => {
    // THE CRITERION THIS FILE EXISTS FOR. `provider=no-such-provider` makes
    // `boi_intel.draft` exit 1 on every gist. The brief must still go out.
    const scope = await seedThroughTheAPI();
    const channel = new StubChannel();
    const events: Record<string, unknown>[] = [];
    const config = baseConfig({ provider: "no-such-provider" });

    const outcome = await runForUser(
      { user_id: scope.user_id, timezone: TZ },
      {
        now: eightAmLocal(TZ),
        channel,
        log: (e) => events.push(e),
        ...bridgeDeps(config as never),
      },
    );

    expect(outcome.status, JSON.stringify(events)).toBe("sent");
    expect(channel.sent.length).toBeGreaterThan(0);

    // And the drafts really were zero, so this is not passing because the drafter
    // happened to work.
    const gists = (await gistOutcomeFor(scope, config as never)).gists;
    expect(gists.length).toBeGreaterThan(0);
    const bundles = await draftsForGists(scope, gists, config as never);
    expect(bundles.size).toBe(0);

    // Nothing fabricated reached the wire: no candidate text at all.
    const body = JSON.stringify(channel.sent);
    expect(body).not.toContain('"draft"');
  }, 300_000);

  it("fails the tick cleanly when Python hangs, rather than hanging the scheduler", async () => {
    // A 1ms timeout kills the child mid-start. `runForUserWithRetry` must come back with
    // a bounded outcome and a next attempt time — not sit there holding the scheduler.
    const scope = await seedThroughTheAPI();
    const channel = new StubChannel();
    const started = Date.now();

    const outcome = await runForUserWithRetry(
      { user_id: scope.user_id, timezone: TZ },
      {
        now: eightAmLocal(TZ),
        channel,
        ...bridgeDeps(baseConfig({ timeoutMs: 1 }) as never),
      },
    );

    // `["skipped","sent","failed"]` accepted three of the four possible outcomes, which
    // is a test that cannot fail for any reason worth catching. The producer is killed at
    // the timeout, so there are no gists, so the brief has nothing to say — that is the
    // one correct answer.
    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") {
      expect(outcome.reason).toBe("nothing_to_say");
    }
    // And it RETURNED rather than holding the scheduler.
    expect(Date.now() - started).toBeLessThan(120_000);

    // The degradation reached an operator even though the composer could not see it.
    const degraded: string[] = [];
    await gistsFor(baseConfig({ timeoutMs: 1, onDegraded: (o: { status: string }) => degraded.push(o.status) }) as never)(scope);
    expect(degraded).toEqual(["timed_out"]);
  }, 300_000);

  it("renders a dead bridge as nothing_to_say to the user AND as an alarm to an operator", async () => {
    // This test used to assert that `unavailable` rendering as `nothing_to_say` was
    // correct, full stop. Half of that is right and it is the dangerous half: the
    // composer must not know why there are no gists, but somebody has to. A bridge that
    // has been down since Tuesday and a user who had a quiet week are indistinguishable
    // from the brief, and only one of them is fine.
    const scope = await seedThroughTheAPI();
    const channel = new StubChannel();
    const degraded: Array<{ status: string }> = [];

    const outcome = await runForUser(
      { user_id: scope.user_id, timezone: TZ },
      {
        now: eightAmLocal(TZ),
        channel,
        // No corpus configured at all.
        ...bridgeDeps({ onDegraded: (o: { status: string }) => degraded.push(o) } as never),
      },
    );

    // To the user: a quiet morning, never a wrong answer and never a crash.
    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") {
      // Never `no_digest` — that would misreport the bridge's failure as the Mac never
      // having reported, and send somebody to debug the wrong machine.
      expect(outcome.reason).toBe("nothing_to_say");
    }
    // To an operator: the actual reason, exactly once for the tick.
    expect(degraded.map((d) => d.status)).toEqual(["unavailable"]);
  }, 300_000);
});
