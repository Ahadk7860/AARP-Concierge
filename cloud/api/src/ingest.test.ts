// The ingest surface, end to end against a live `boi_dev_d`.
//
// One database-touching file per track, for the reason documented at the top of
// cloud/db/src/schema.test.ts: vitest runs FILES in parallel and this one migrates.
// It uses `app.inject()` rather than a listening socket, so it never binds port 3041
// and cannot collide with a server left running from a manual curl session.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { Digest, VoicePack } from "../../shared/src/index.js";
import { StubChannel } from "../../shared/src/index.js";
import {
  closePool,
  createUser,
  deleteUser,
  getDeviceState,
  getPool,
  migrate,
  newDeviceId,
  registerDevice,
  residueByTable,
  acquireSuiteLock,
  releaseSuiteLock,
  unsafeScopeFromUserId,
  voicePackFor,
  type UserScope,
} from "../../db/src/index.js";
import { buildServer } from "./server.js";
import { makeLogger } from "./logging.js";
import { checkResponse, spec } from "./openapi.js";
import { MINIMAL_DIGEST } from "./differential.test.js";

const FIXTURES = join(process.cwd(), "contracts", "fixtures");
const pool = getPool();

async function fixture<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(join(FIXTURES, ...parts), "utf8")) as T;
}

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+1556${String(1_000_000 + phoneCounter).slice(-7)}`;
}

type Account = { scope: UserScope; deviceId: string; token: string };

async function newAccount(): Promise<Account> {
  const { scope } = await createUser({ phone_e164: nextPhone() });
  const deviceId = newDeviceId();
  const { device_token } = await registerDevice(scope, {
    device_id: deviceId,
    platform: "test",
  });
  return { scope, deviceId, token: device_token };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** A digest fixture rebound to a real account, since the fixture names usr_demo0001. */
async function digestFor(account: Account): Promise<Digest> {
  const digest = await fixture<Digest>("digest", "healthy.json");
  digest.user_id = account.scope.user_id;
  digest.device_id = account.deviceId;
  return digest;
}

let app: FastifyInstance;
// Exposed so heartbeat tests can assert on what WOULD have been sent, never sending
// anything real — `StubChannel.sent` records the outbound.v1 documents in memory.
let channel: StubChannel;

beforeAll(async () => {
  // Serialised against cloud/db/src/schema.test.ts, which drops and rebuilds this same
  // database. See cloud/db/src/test-lock.ts.
  await acquireSuiteLock();
  await migrate(pool);
  // Logs go to a sink, not stdout: the suite's output is what a human reads to judge
  // the gate, and 30 lines of structured JSON per run buries it. The one test that
  // asserts ON log content builds its own server with its own capturing sink.
  channel = new StubChannel();
  app = buildServer({ logger: makeLogger(new PassThrough()), channel });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await closePool();
  await releaseSuiteLock();
});

// ---------------------------------------------------------------------------

describe("POST /v1/digest", () => {
  it("accepts a healthy digest with 202 and a digest_id, then 409 on a repeat", async () => {
    const account = await newAccount();
    const digest = await digestFor(account);

    const first = await app.inject({
      method: "POST",
      url: "/v1/digest",
      headers: auth(account.token),
      payload: digest,
    });
    expect(first.statusCode).toBe(202);
    const body = first.json() as { digest_id: string; received_at: string };
    expect(body.digest_id).toMatch(/^dig_[0-9a-f]{8,32}$/);
    expect(body.received_at).toMatch(/Z$/);

    // The same generated_at again. CONTRACTS.md § 2: 409 {"error":"duplicate"}.
    const second = await app.inject({
      method: "POST",
      url: "/v1/digest",
      headers: auth(account.token),
      payload: digest,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "duplicate" });

    await deleteUser(account.scope);
  });

  it("stores the relationships the digest carried", async () => {
    const account = await newAccount();
    const digest = await digestFor(account);
    await app.inject({
      method: "POST",
      url: "/v1/digest",
      headers: auth(account.token),
      payload: digest,
    });

    const residue = await residueByTable(account.scope.user_id, pool);
    expect(residue["relationships"]).toBe(digest.relationships.length);
    await deleteUser(account.scope);
  });

  it("rejects a body that fails the schema with 400 validation", async () => {
    const account = await newAccount();
    const digest = await digestFor(account);
    // `health` is an enum in digest.v1.json.
    (digest.corpus as unknown as Record<string, unknown>)["health"] = "excellent";

    const res = await app.inject({
      method: "POST",
      url: "/v1/digest",
      headers: auth(account.token),
      payload: digest,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; detail: string };
    expect(body.error).toBe("validation");
    expect(typeof body.detail).toBe("string");
    expect(body.detail.length).toBeGreaterThan(0);

    await deleteUser(account.scope);
  });

  it("rejects an epoch integer where § 6 requires an ISO 8601 Z string", async () => {
    const account = await newAccount();
    const digest = await digestFor(account);
    (digest as unknown as Record<string, unknown>)["generated_at"] = 1_754_000_000;

    const res = await app.inject({
      method: "POST",
      url: "/v1/digest",
      headers: auth(account.token),
      payload: digest,
    });
    expect(res.statusCode).toBe(400);
    await deleteUser(account.scope);
  });

  it("refuses a digest claiming another user, without storing it", async () => {
    const mine = await newAccount();
    const theirs = await newAccount();

    const digest = await digestFor(mine);
    digest.user_id = theirs.scope.user_id; // the claim, made with MY token

    const res = await app.inject({
      method: "POST",
      url: "/v1/digest",
      headers: auth(mine.token),
      payload: digest,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });

    // Neither account gained a row.
    expect((await residueByTable(theirs.scope.user_id, pool))["digests"]).toBe(0);
    expect((await residueByTable(mine.scope.user_id, pool))["digests"]).toBe(0);

    await deleteUser(mine.scope);
    await deleteUser(theirs.scope);
  });

  it("accepts a MINIMAL digest — only the frozen schema's required fields", async () => {
    // The document Track A is entitled to send. Every committed fixture is fully
    // populated, so a mirror that marks an optional field required passes every other
    // test in this file and 400s a conforming upload. That is what happened.
    const account = await newAccount();
    const digest = JSON.parse(JSON.stringify(MINIMAL_DIGEST)) as Digest;
    digest.user_id = account.scope.user_id;
    digest.device_id = account.deviceId;

    const res = await app.inject({
      method: "POST",
      url: "/v1/digest",
      headers: auth(account.token),
      payload: digest,
    });
    expect(res.statusCode, res.body).toBe(202);

    // And it round-trips: the relationship stored from a minimal digest reads back.
    const residue = await residueByTable(account.scope.user_id, pool);
    expect(residue["relationships"]).toBe(1);
    await deleteUser(account.scope);
  });

  it("refuses a device_id the caller does not own", async () => {
    const account = await newAccount();
    const digest = await digestFor(account);
    digest.device_id = newDeviceId(); // well-formed, never registered

    const res = await app.inject({
      method: "POST",
      url: "/v1/digest",
      headers: auth(account.token),
      payload: digest,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("validation");
    await deleteUser(account.scope);
  });
});

// ---------------------------------------------------------------------------

describe("POST /v1/voice-pack", () => {
  it("accepts the maya fixture with 202", async () => {
    const account = await newAccount();
    const pack = await fixture<VoicePack>("voice_pack", "maya.json");

    const res = await app.inject({
      method: "POST",
      url: "/v1/voice-pack",
      headers: auth(account.token),
      payload: pack,
    });
    expect(res.statusCode).toBe(202);

    const stored = await voicePackFor(account.scope, pack.contact_id);
    expect(stored?.voice_pack_version).toBe(pack.voice_pack_version);
    await deleteUser(account.scope);
  });

  it("accepts the global fallback pack", async () => {
    const account = await newAccount();
    const pack = await fixture<VoicePack>("voice_pack", "global_fallback.json");
    const res = await app.inject({
      method: "POST",
      url: "/v1/voice-pack",
      headers: auth(account.token),
      payload: pack,
    });
    expect(res.statusCode).toBe(202);
    await deleteUser(account.scope);
  });

  // THE SECOND is_from_me GUARD. Three patterns, three tests, each asserting the pack
  // was stored NOWHERE — a rejection that quietly persisted the row would be worse
  // than no guard at all, because the 422 would read as proof it had not.
  const leaks: Array<[string, string]> = [
    ["a phone number", "call me on 415-555-0142 when you land"],
    ["an email address", "forward it to maya.chen@example.com and ill look"],
    ["a dollar amount", "i still owe u $40 from dinner lol"],
  ];

  for (const [label, exemplar] of leaks) {
    it(`rejects ${label} with 422 redaction_failed and stores nothing`, async () => {
      const account = await newAccount();
      const pack = await fixture<VoicePack>("voice_pack", "maya.json");
      pack.exemplars = [...pack.exemplars.slice(0, 3), exemplar];

      const res = await app.inject({
        method: "POST",
        url: "/v1/voice-pack",
        headers: auth(account.token),
        payload: pack,
      });

      expect(res.statusCode).toBe(422);
      const body = res.json() as { error: string; detail: string };
      expect(body.error).toBe("redaction_failed");
      expect(typeof body.detail).toBe("string");
      // The detail names the pattern and the index, never the offending text.
      expect(body.detail).not.toContain(exemplar);

      // NOTHING STORED. Both the repository read and the raw row count.
      expect(await voicePackFor(account.scope, pack.contact_id)).toBeNull();
      expect((await residueByTable(account.scope.user_id, pool))["voice_packs"]).toBe(0);

      await deleteUser(account.scope);
    });
  }

  // THE FIELD THE GUARD USED TO MISS. Spotless exemplars, the leak in
  // register.apology_openers — which holds verbatim message prefixes and is persisted
  // with the rest of the document. This returned 202 before the fix, with all three
  // per-pattern tests green. CONTRACTS.md § 7.
  const leakyFields: Array<[string, (p: VoicePack, leak: string) => void]> = [
    ["exemplars", (p, leak) => { p.exemplars = [leak]; }],
    ["register.apology_openers", (p, leak) => { p.register.apology_openers = [leak]; }],
    ["register.abbreviations", (p, leak) => { p.register.abbreviations = [leak]; }],
    ["register.top_emoji", (p, leak) => { p.register.top_emoji = [leak]; }],
  ];

  for (const [field, mutate] of leakyFields) {
    it(`rejects a leak in ${field} with 422 and stores nothing`, async () => {
      const account = await newAccount();
      const pack = await fixture<VoicePack>("voice_pack", "maya.json");
      pack.exemplars = ["ok that works for me"]; // spotless
      mutate(pack, "sorry i still owe you $40, call me on 415-555-0142");

      const res = await app.inject({
        method: "POST",
        url: "/v1/voice-pack",
        headers: auth(account.token),
        payload: pack,
      });

      expect(res.statusCode, `${field} was not scanned`).toBe(422);
      const body = res.json() as { error: string; detail: string };
      expect(body.error).toBe("redaction_failed");
      expect(body.detail).not.toContain("415-555-0142");

      // Nothing persisted — the whole document is what gets stored, so a 422 that
      // wrote the row would have leaked through a field nobody was looking at.
      expect(await voicePackFor(account.scope, pack.contact_id)).toBeNull();
      expect((await residueByTable(account.scope.user_id, pool))["voice_packs"]).toBe(0);
      await deleteUser(account.scope);
    });
  }

  it("rejects a street address too, though the checklist only named three", async () => {
    const account = await newAccount();
    const pack = await fixture<VoicePack>("voice_pack", "maya.json");
    pack.exemplars = ["meet me at 742 Evergreen Terrace around 8"];

    const res = await app.inject({
      method: "POST",
      url: "/v1/voice-pack",
      headers: auth(account.token),
      payload: pack,
    });
    expect(res.statusCode).toBe(422);
    expect((await residueByTable(account.scope.user_id, pool))["voice_packs"]).toBe(0);
    await deleteUser(account.scope);
  });

  it("rejects more than 40 exemplars", async () => {
    const account = await newAccount();
    const pack = await fixture<VoicePack>("voice_pack", "maya.json");
    pack.exemplars = Array.from({ length: 41 }, (_, i) => `ok sounds good ${i}`);

    const res = await app.inject({
      method: "POST",
      url: "/v1/voice-pack",
      headers: auth(account.token),
      payload: pack,
    });
    // 400, not 422: `maxItems: 40` is a schema violation, and the OpenAPI document
    // reserves 422 for the redaction assertions specifically.
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("validation");
    expect((await residueByTable(account.scope.user_id, pool))["voice_packs"]).toBe(0);
    await deleteUser(account.scope);
  });

  it("rejects an exemplar over 200 characters", async () => {
    const account = await newAccount();
    const pack = await fixture<VoicePack>("voice_pack", "maya.json");
    pack.exemplars = ["a".repeat(201)];

    const res = await app.inject({
      method: "POST",
      url: "/v1/voice-pack",
      headers: auth(account.token),
      payload: pack,
    });
    expect(res.statusCode).toBe(400);
    expect((await residueByTable(account.scope.user_id, pool))["voice_packs"]).toBe(0);
    await deleteUser(account.scope);
  });

  it("rejects a pack whose scope and contact_id disagree", async () => {
    const account = await newAccount();
    const pack = await fixture<VoicePack>("voice_pack", "global_fallback.json");
    pack.contact_id = "h_8f21a4c0"; // global packs carry no contact

    const res = await app.inject({
      method: "POST",
      url: "/v1/voice-pack",
      headers: auth(account.token),
      payload: pack,
    });
    expect(res.statusCode).toBe(400);
    await deleteUser(account.scope);
  });
});

// ---------------------------------------------------------------------------

describe("POST /v1/heartbeat", () => {
  it("returns 204 and records digest_as_of so staleness is computable", async () => {
    const account = await newAccount();
    const digestAsOf = "2026-08-01T09:14:00Z";

    const res = await app.inject({
      method: "POST",
      url: "/v1/heartbeat",
      headers: auth(account.token),
      payload: {
        device_id: account.deviceId,
        app_version: "0.1.0",
        digest_as_of: digestAsOf,
        macos_version: "26.0",
        fda_granted: true,
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");

    const state = await getDeviceState(account.scope, account.deviceId);
    expect(state?.digest_as_of?.toISOString()).toBe(new Date(digestAsOf).toISOString());
    expect(state?.app_version).toBe("0.1.0");
    expect(state?.fda_granted).toBe(true);
    expect(state?.last_heartbeat_at).not.toBeNull();

    await deleteUser(account.scope);
  });

  it("rejects a heartbeat for a device the token does not belong to", async () => {
    const account = await newAccount();
    const res = await app.inject({
      method: "POST",
      url: "/v1/heartbeat",
      headers: auth(account.token),
      payload: {
        device_id: newDeviceId(),
        app_version: "0.1.0",
        digest_as_of: "2026-08-01T09:14:00Z",
      },
    });
    expect(res.statusCode).toBe(400);
    await deleteUser(account.scope);
  });

  it("rejects an unknown field, since the spec sets additionalProperties false", async () => {
    const account = await newAccount();
    const res = await app.inject({
      method: "POST",
      url: "/v1/heartbeat",
      headers: auth(account.token),
      payload: {
        device_id: account.deviceId,
        app_version: "0.1.0",
        digest_as_of: "2026-08-01T09:14:00Z",
        chat_db_path: "/Users/someone/Library/Messages/chat.db",
      },
    });
    expect(res.statusCode).toBe(400);
    await deleteUser(account.scope);
  });

  // -------------------------------------------------------------------------
  // messages_access_state — the fleet-wide alarm CONTRACTS.md UNRESOLVED item 10 calls
  // for. `channel` is the SAME `StubChannel` this whole file's `app` was built with, so
  // no real message is ever sent — `.sent` only ever records outbound.v1 documents.

  function heartbeat(account: Account, state?: string, digestAsOf: string | null = null) {
    return app.inject({
      method: "POST",
      url: "/v1/heartbeat",
      headers: auth(account.token),
      payload: {
        device_id: account.deviceId,
        app_version: "0.1.0",
        digest_as_of: digestAsOf,
        ...(state === undefined ? {} : { messages_access_state: state }),
      },
    });
  }

  function alertsFor(deviceId: string) {
    return channel.sent.filter((m) => m.idempotency_key.startsWith(`messages-access-lost-`) && m.idempotency_key.includes(deviceId));
  }

  it("sends the lost-access alert exactly once for a run of repeated `lost` heartbeats", async () => {
    const account = await newAccount();

    expect((await heartbeat(account, "lost")).statusCode).toBe(204);
    expect((await heartbeat(account, "lost")).statusCode).toBe(204);
    expect((await heartbeat(account, "lost")).statusCode).toBe(204);

    const sent = alertsFor(account.deviceId);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.user_id).toBe(account.scope.user_id);
    expect(sent[0]?.blocks).toEqual([
      { type: "text", text: expect.stringContaining("open the Boi app") as unknown as string },
    ]);

    await deleteUser(account.scope);
  });

  it("does not alert on ok, never_configured, or an absent field", async () => {
    const account = await newAccount();

    await heartbeat(account, "ok");
    await heartbeat(account, "never_configured");
    await heartbeat(account, undefined);

    expect(alertsFor(account.deviceId)).toHaveLength(0);
    await deleteUser(account.scope);
  });

  it("re-alerts on a second, distinct loss episode after a recovery", async () => {
    const account = await newAccount();

    await heartbeat(account, "lost");
    await heartbeat(account, "lost");
    expect(alertsFor(account.deviceId)).toHaveLength(1);

    await heartbeat(account, "ok"); // recovered — the gate reopens
    await heartbeat(account, "lost");
    await heartbeat(account, "lost");

    // Two episodes, two alerts — never one per heartbeat (12 would mean every beat fired).
    expect(alertsFor(account.deviceId)).toHaveLength(2);

    await deleteUser(account.scope);
  });

  it("still accepts the heartbeat (204) even when the channel throws while alerting", async () => {
    const account = await newAccount();
    const throwing = new StubChannel("banned"); // StubChannel.send throws in this mode
    const throwingApp = buildServer({ logger: makeLogger(new PassThrough()), channel: throwing });
    await throwingApp.ready();

    const res = await throwingApp.inject({
      method: "POST",
      url: "/v1/heartbeat",
      headers: auth(account.token),
      payload: {
        device_id: account.deviceId,
        app_version: "0.1.0",
        digest_as_of: null,
        messages_access_state: "lost",
      },
    });

    // Fail-safe: a notification failure must never reject the heartbeat.
    expect(res.statusCode).toBe(204);
    expect(throwing.sent).toHaveLength(0); // the throw happened before anything was recorded as sent

    await throwingApp.close();
    await deleteUser(account.scope);
  });
});

// ---------------------------------------------------------------------------

describe("DELETE /v1/users/{id}", () => {
  it("returns 204 and the delete from 01 holds when driven through the endpoint", async () => {
    const account = await newAccount();

    // Seed through the API, so this exercises the real ingest path.
    await app.inject({
      method: "POST",
      url: "/v1/digest",
      headers: auth(account.token),
      payload: await digestFor(account),
    });
    await app.inject({
      method: "POST",
      url: "/v1/voice-pack",
      headers: auth(account.token),
      payload: await fixture<VoicePack>("voice_pack", "maya.json"),
    });
    await app.inject({
      method: "POST",
      url: "/v1/heartbeat",
      headers: auth(account.token),
      payload: {
        device_id: account.deviceId,
        app_version: "0.1.0",
        digest_as_of: "2026-08-01T09:14:00Z",
      },
    });

    const before = await residueByTable(account.scope.user_id, pool);
    for (const table of ["users", "devices", "digests", "relationships", "voice_packs"]) {
      expect(before[table], `${table} should be seeded`).toBeGreaterThan(0);
    }

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/users/${account.scope.user_id}`,
      headers: auth(account.token),
    });
    expect(res.statusCode).toBe(204);

    // Enumerated by walking foreign keys from `users`, not from a list here.
    const after = await residueByTable(account.scope.user_id, pool);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const [table, n] of Object.entries(after)) {
      expect(n, `${table} survived the delete`).toBe(0);
    }
  }, 60_000);

  it("refuses to delete an account the token does not own — the IDOR", async () => {
    const mine = await newAccount();
    const victim = await newAccount();
    await app.inject({
      method: "POST",
      url: "/v1/digest",
      headers: auth(victim.token),
      payload: await digestFor(victim),
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/users/${victim.scope.user_id}`,
      headers: auth(mine.token),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });

    // The victim is untouched.
    const residue = await residueByTable(victim.scope.user_id, pool);
    expect(residue["users"]).toBe(1);
    expect(residue["digests"]).toBe(1);

    await deleteUser(mine.scope);
    await deleteUser(victim.scope);
  });

  it("does not leak whether a user id exists", async () => {
    const mine = await newAccount();
    const missing = unsafeScopeFromUserId("usr_neverexisted01");

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/users/${missing.user_id}`,
      headers: auth(mine.token),
    });
    // Identical to the response for a user that DOES exist but is not yours.
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
    await deleteUser(mine.scope);
  });
});

// ---------------------------------------------------------------------------

describe("authentication, asserted per route", () => {
  // Every authenticated route in the OpenAPI document, asserted individually. A single
  // shared assertion would pass while three of the four routes had no auth at all.
  const authenticated = [
    { method: "POST" as const, url: "/v1/digest", payload: {} },
    { method: "POST" as const, url: "/v1/voice-pack", payload: {} },
    { method: "POST" as const, url: "/v1/heartbeat", payload: {} },
    { method: "DELETE" as const, url: "/v1/users/usr_demo00000001", payload: undefined },
  ];

  it("covers every route the spec marks with a security requirement", () => {
    const paths = spec["paths"] as Record<string, Record<string, { security?: unknown }>>;
    const secured: string[] = [];
    for (const [path, ops] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (op.security !== undefined) secured.push(`${method.toUpperCase()} ${path}`);
      }
    }
    const covered = authenticated.map((a) => `${a.method} ${a.url.replace(/usr_\w+/, "{user_id}")}`);
    for (const route of secured) {
      expect(covered, `${route} has no 401 test`).toContain(route);
    }
  });

  for (const { method, url, payload } of authenticated) {
    it(`${method} ${url} returns 401 with no token`, async () => {
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    });

    it(`${method} ${url} returns 401 with a malformed token`, async () => {
      const res = await app.inject({ method, url, headers: auth("not-a-token"), payload });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    });

    it(`${method} ${url} returns 401 with a well-formed token that was never issued`, async () => {
      const res = await app.inject({
        method,
        url,
        headers: auth("usr_neverissued1.c2VjcmV0"),
        payload,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    });
  }

  it("returns 401, not 500, for a token whose prefix is outside the frozen alphabet", async () => {
    // `usr_has-dash` parsed as a well-formed user id under the old loose regex, and
    // `unsafeScopeFromUserId` then threw — a 500 for a garbage credential. None of the
    // existing 401 tests caught it because none of their tokens contained a dot.
    for (const token of [
      "usr_has-dash_here.secret",
      "usr_short.secret",
      "usr_.secret",
      `usr_${"x".repeat(40)}.secret`,
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/heartbeat",
        headers: auth(token),
        payload: {},
      });
      expect(res.statusCode, token).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("rejects a revoked token — the account it names is gone", async () => {
    const account = await newAccount();
    await deleteUser(account.scope);

    const res = await app.inject({
      method: "POST",
      url: "/v1/heartbeat",
      headers: auth(account.token),
      payload: {
        device_id: account.deviceId,
        app_version: "0.1.0",
        digest_as_of: "2026-08-01T09:14:00Z",
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("authenticates before validating, so a bad body never reveals the schema", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/digest",
      payload: { nonsense: true },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------

describe("no user content in logs", () => {
  it("logs a voice-pack upload without any exemplar appearing", async () => {
    const captured: string[] = [];
    const sink = new PassThrough();
    sink.on("data", (chunk: Buffer) => captured.push(chunk.toString("utf8")));

    const loggingApp = buildServer({ logger: makeLogger(sink) });
    await loggingApp.ready();

    const account = await newAccount();
    const pack = await fixture<VoicePack>("voice_pack", "maya.json");

    await loggingApp.inject({
      method: "POST",
      url: "/v1/voice-pack",
      headers: auth(account.token),
      payload: pack,
    });

    // And the rejected path, which is the one that handles unredacted content.
    const leaky = await fixture<VoicePack>("voice_pack", "maya.json");
    leaky.exemplars = ["call me on 415-555-0142 when you land"];
    await loggingApp.inject({
      method: "POST",
      url: "/v1/voice-pack",
      headers: auth(account.token),
      payload: leaky,
    });

    // And a digest, whose relationship `display` names third parties.
    await loggingApp.inject({
      method: "POST",
      url: "/v1/digest",
      headers: auth(account.token),
      payload: await digestFor(account),
    });

    await new Promise((resolve) => setImmediate(resolve));
    const logs = captured.join("");
    expect(logs.length).toBeGreaterThan(0);

    for (const exemplar of [...pack.exemplars, ...leaky.exemplars]) {
      expect(logs, `an exemplar reached the log: ${exemplar.slice(0, 24)}`).not.toContain(
        exemplar,
      );
    }
    // The phone number itself, not just the whole exemplar.
    expect(logs).not.toContain("415-555-0142");

    // Third-party display names from the digest must not be logged either.
    const digest = await digestFor(account);
    for (const rel of digest.relationships) {
      expect(logs).not.toContain(`"${rel.display}"`);
    }

    // What SHOULD be there: the event, and the reproducibility handles.
    expect(logs).toContain("voice_pack.redaction_failed");
    expect(logs).toContain(pack.voice_pack_version);

    await loggingApp.close();
    await deleteUser(account.scope);
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("responses match contracts/openapi/boi-api.v1.yaml", () => {
  it("the conformance checker itself rejects a wrong body", () => {
    // Without this, a checker that silently passes everything would make every
    // assertion below meaningless — which is the failure mode the gate exists for.
    expect(checkResponse("/v1/digest", "post", 202, { digest_id: "dig_x" }).ok).toBe(false);
    expect(checkResponse("/v1/digest", "post", 409, { error: "nope" }).ok).toBe(false);
    expect(checkResponse("/v1/voice-pack", "post", 422, { error: "validation" }).ok).toBe(false);
    expect(checkResponse("/v1/heartbeat", "post", 204, { unexpected: true }).ok).toBe(false);
    // A status the document does not list is drift, not a pass.
    expect(checkResponse("/v1/heartbeat", "post", 418, {}).documented).toBe(false);
  });

  it("the spec under test is the frozen one", () => {
    expect((spec["info"] as { version: string }).version).toBe("1.0.0");
  });

  it("every endpoint's real response conforms", async () => {
    const account = await newAccount();
    const digest = await digestFor(account);

    const cases: Array<{ path: string; method: string; status: number; body: unknown }> = [];

    const accepted = await app.inject({
      method: "POST",
      url: "/v1/digest",
      headers: auth(account.token),
      payload: digest,
    });
    cases.push({ path: "/v1/digest", method: "post", status: 202, body: accepted.json() });

    const dup = await app.inject({
      method: "POST",
      url: "/v1/digest",
      headers: auth(account.token),
      payload: digest,
    });
    cases.push({ path: "/v1/digest", method: "post", status: 409, body: dup.json() });

    const badDigest = await app.inject({
      method: "POST",
      url: "/v1/digest",
      headers: auth(account.token),
      payload: { schema_version: "digest.v1" },
    });
    cases.push({ path: "/v1/digest", method: "post", status: 400, body: badDigest.json() });

    const noAuth = await app.inject({ method: "POST", url: "/v1/digest", payload: {} });
    cases.push({ path: "/v1/digest", method: "post", status: 401, body: noAuth.json() });

    const packOk = await app.inject({
      method: "POST",
      url: "/v1/voice-pack",
      headers: auth(account.token),
      payload: await fixture<VoicePack>("voice_pack", "maya.json"),
    });
    cases.push({ path: "/v1/voice-pack", method: "post", status: 202, body: undefined });
    expect(packOk.statusCode).toBe(202);

    const leaky = await fixture<VoicePack>("voice_pack", "maya.json");
    leaky.exemplars = ["i owe u $40"];
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/voice-pack",
      headers: auth(account.token),
      payload: leaky,
    });
    cases.push({
      path: "/v1/voice-pack",
      method: "post",
      status: 422,
      body: rejected.json(),
    });

    const beat = await app.inject({
      method: "POST",
      url: "/v1/heartbeat",
      headers: auth(account.token),
      payload: {
        device_id: account.deviceId,
        app_version: "0.1.0",
        digest_as_of: "2026-08-01T09:14:00Z",
      },
    });
    expect(beat.statusCode).toBe(204);
    cases.push({ path: "/v1/heartbeat", method: "post", status: 204, body: beat.body });

    const gone = await app.inject({
      method: "DELETE",
      url: `/v1/users/${account.scope.user_id}`,
      headers: auth(account.token),
    });
    expect(gone.statusCode).toBe(204);
    cases.push({ path: "/v1/users/{user_id}", method: "delete", status: 204, body: gone.body });

    const failures: string[] = [];
    for (const c of cases) {
      const result = checkResponse(c.path, c.method, c.status, c.body);
      if (!result.ok) {
        failures.push(`${c.method.toUpperCase()} ${c.path} ${c.status}: ${result.errors.join(", ")}`);
      }
    }
    expect(failures).toEqual([]);
    // Every documented endpoint in this prompt's scope was actually exercised.
    expect(new Set(cases.map((c) => c.path)).size).toBe(4);
  }, 60_000);
});
