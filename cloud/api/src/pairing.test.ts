// Signup, the first message, and the pairing exchange.
//
// Serialised against the other database-touching files by the advisory lock in
// cloud/db/src/test-lock.ts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import { StubChannel, StubRegistrar } from "../../shared/src/index.js";
import {
  acquireSuiteLock,
  closePool,
  deleteUser,
  findUserIdByPhone,
  getPool,
  getUser,
  migrate,
  issuePairingCode,
  newPairingCode,
  releaseSuiteLock,
  residueByTable,
  unsafeScopeFromUserId,
} from "../../db/src/index.js";
import { buildServer } from "./server.js";
import { makeLogger } from "./logging.js";
import { checkResponse } from "./openapi.js";
import { boiHandle } from "./welcome.js";
import { PAIRING_TTL_SECONDS } from "./routes/signup.js";
import { FixedWindowLimiter, PAIR_LIMIT } from "./limiter.js";
import { handleInbound, parsePairingCode } from "../../brief/src/inbound.js";
import type { InboundMessage } from "../../shared/src/index.js";

const pool = getPool();

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+1557${String(1_000_000 + phoneCounter).slice(-7)}`;
}

/** A server with a channel and a clock the test owns. */
function harness(
  opts: { mode?: "up" | "degraded" | "banned"; at?: Date; registrar?: StubRegistrar } = {},
) {
  const channel = new StubChannel(opts.mode ?? "up");
  const registrar = opts.registrar ?? new StubRegistrar();
  let clock = opts.at ?? new Date();
  const app = buildServer({
    channel,
    registrar,
    now: () => clock,
    logger: makeLogger(new PassThrough()),
  });
  return {
    app,
    channel,
    registrar,
    /** Move the clock. No sleeping: expiry is ten minutes and a test is not. */
    advance(seconds: number) {
      clock = new Date(clock.getTime() + seconds * 1000);
    },
  };
}

async function signup(
  h: { app: FastifyInstance },
  phone: string,
  email = "a@example.com",
): Promise<{ status: number; html: string; token: string; line: string; userId: string }> {
  const res = await h.app.inject({
    method: "POST",
    url: "/signup",
    payload: { phone_e164: phone, email, accept_terms: true },
  });
  const scope = await findUserIdByPhone(phone);
  // The token now leaves ONLY inside the deep link, which is the point: it is prefilled
  // into the user's own message rather than handed to them to type. Parsing it out of the
  // page is what a test has to do because it is what the user's Messages app does.
  // `&amp;` because the href is HTML-escaped, which is correct — the browser unescapes
  // it before Messages ever sees it.
  const link = /href="sms:([^&"]+)&amp;body=([^"]+)"/.exec(res.body);
  return {
    status: res.statusCode,
    html: res.body,
    line: link?.[1] ?? "",
    token: decodeURIComponent(link?.[2] ?? ""),
    userId: scope?.user_id ?? "",
  };
}

/**
 * A six-digit code, issued directly.
 *
 * `POST /v1/pair` still takes one and Track F is mid-flight against it, but signup no
 * longer texts one — so the pairing tests below mint their own rather than reading a
 * response header that AMENDMENT-002 deleted.
 */
async function mintCode(userId: string, now: Date): Promise<string> {
  const code = newPairingCode();
  await issuePairingCode(unsafeScopeFromUserId(userId), { code, ttl_seconds: 600, now });
  return code;
}

let cleanup: string[] = [];

beforeAll(async () => {
  await acquireSuiteLock();
  await migrate(pool);
}, 120_000);

afterAll(async () => {
  for (const id of cleanup) {
    try {
      await deleteUser(unsafeScopeFromUserId(id));
    } catch {
      // already gone
    }
  }
  await closePool();
  await releaseSuiteLock();
});

// ---------------------------------------------------------------------------

describe("signup lets the USER go first", () => {
  // AMENDMENT-002 replaced this describe wholesale. Ten assertions lived here about a
  // flow where Boi texted first; roughly half were about a moment that MOVED rather than
  // about a requirement that died, and `NOTES.md` carries the ten-row
  // deleted/relocated/replaced table with a reason for every deleted line. An amendment
  // is perfect cover for losing coverage, so the accounting is mechanical.

  it("SENDS NOTHING at signup", async () => {
    // Replaces "sends the welcome message BEFORE the response returns". The old test was
    // right about its flow: the page told the user to go look at a text, so the text had
    // to exist first. Under the inverted flow there is no text to exist — a line that
    // initiates to somebody who has not written first gets iMessage's spam-report
    // affordance attached to Boi's first words.
    const h = harness();
    await h.app.ready();

    const out = await signup(h, nextPhone());
    cleanup.push(out.userId);

    expect(out.status).toBe(200);
    expect(h.channel.sent).toHaveLength(0);
    // And no outbound row either: nothing was sent, so nothing is recorded as sent.
    const residue = await residueByTable(out.userId, pool);
    expect(residue["messages_out"]).toBe(0);
    await h.app.close();
  });

  it("registers BOTH handles with the transport, in one call", async () => {
    // New. Messages on a Mac frequently sends from the Apple Account email rather than
    // the phone number, the transport cannot tell us which Apple will pick, and inbound
    // from an unregistered handle is silent. One call rather than two, so there is no way
    // to register half of a user.
    const h = harness();
    await h.app.ready();
    const phone = nextPhone();
    const out = await signup(h, phone, "mac-user@example.com");
    cleanup.push(out.userId);

    expect(h.registrar.calls).toHaveLength(1);
    expect(h.registrar.calls[0]?.handles).toEqual([phone, "mac-user@example.com"]);
    await h.app.close();
  });

  it("puts THAT USER'S line in the deep link, with the token prefilled", async () => {
    // Replaces "puts a working sms: deep link on the confirmation page", which asserted
    // `href="sms:${boiHandle()}"` — a CONSTANT. The pool is shared and the number differs
    // per recipient, so a constant link opens a thread with a line that is not theirs.
    const h = harness();
    await h.app.ready();
    const out = await signup(h, nextPhone());
    cleanup.push(out.userId);

    const assigned = await h.registrar.lineFor(out.userId);
    expect(out.line).toBe(assigned?.handle);
    expect(out.line).not.toBe(boiHandle());
    expect(out.token).toMatch(/^boi-[0-9a-f]{6}$/);
    // HTML-escaped in the attribute, which is correct: the browser unescapes before
    // Messages ever sees the URL.
    expect(out.html).toContain("&amp;body=");
    await h.app.close();
  });

  it("resolves the line BEFORE the page renders", async () => {
    // Ordering, asserted rather than assumed: a page rendered before the line exists
    // would carry a link to nowhere, and the user would have done everything right.
    const h = harness();
    await h.app.ready();
    const out = await signup(h, nextPhone());
    cleanup.push(out.userId);

    expect(h.registrar.registered.has(out.userId)).toBe(true);
    expect(out.html).toContain("Open Messages");
    await h.app.close();
  });

  it("says so when the transport is unreachable, rather than rendering a dead link", async () => {
    // Replaces "does not report success when the line is banned". The requirement
    // survives the move: silently succeeding at signup is the same defect wearing new
    // clothes, and under this flow the link IS the next step, so a confirmation page
    // with a dead link surfaces as "I sent it and nothing happened".
    const h = harness({ registrar: new StubRegistrar("unreachable") });
    await h.app.ready();
    const phone = nextPhone();
    const res = await h.app.inject({
      method: "POST",
      url: "/signup",
      payload: { phone_e164: phone, email: "a@example.com", accept_terms: true },
    });

    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("signup-unavailable");
    expect(res.body).not.toContain("sms:");
    // The ACCOUNT still exists. Losing the signup would be worse than failing the line.
    const scope = await findUserIdByPhone(phone);
    expect(scope).not.toBeNull();
    if (scope !== null) cleanup.push(scope.user_id);
    await h.app.close();
  });

  it("RE-ISSUES a fresh token on re-signup, so an expired one is not a dead end", async () => {
    // Relocated, not deleted: re-signup must re-issue whether the secret is a code or a
    // token. Somebody signs up again precisely because the first attempt went stale.
    const h = harness();
    await h.app.ready();
    const phone = nextPhone();
    const first = await signup(h, phone);
    cleanup.push(first.userId);
    const second = await signup(h, phone);

    expect(second.status).toBe(200);
    expect(second.token).toMatch(/^boi-[0-9a-f]{6}$/);
    expect(second.token).not.toBe(first.token);
    expect(second.userId).toBe(first.userId);
    await h.app.close();
  });

  it("rejects signup without accepted terms, and does not send", async () => {
    const h = harness();
    await h.app.ready();
    const res = await h.app.inject({
      method: "POST",
      url: "/signup",
      payload: { phone_e164: nextPhone(), accept_terms: false },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("validation");
    expect(h.channel.sent).toHaveLength(0);
    await h.app.close();
  });

  it("accepts the HTML form's urlencoded body, not just JSON", async () => {
    const h = harness();
    await h.app.ready();
    const phone = nextPhone();
    const res = await h.app.inject({
      method: "POST",
      url: "/signup",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `phone_e164=${encodeURIComponent(phone)}&accept_terms=true`,
    });

    expect(res.statusCode).toBe(200);
    const scope = await findUserIdByPhone(phone);
    expect(scope).not.toBeNull();
    if (scope !== null) cleanup.push(scope.user_id);
    await h.app.close();
  });

  it("does not treat the string \"false\" as consent", async () => {
    const h = harness();
    await h.app.ready();
    const res = await h.app.inject({
      method: "POST",
      url: "/signup",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `phone_e164=${encodeURIComponent(nextPhone())}&accept_terms=false`,
    });

    expect(res.statusCode).toBe(400);
    expect(h.channel.sent).toHaveLength(0);
    await h.app.close();
  });
});

describe("handle-mismatch detection, relocated to the inbound", () => {
  // Both of these survive AMENDMENT-002 and neither could stay where it was: the fact
  // used to come from the protocol of the message WE sent, and nothing is sent now. It
  // arrives from the other direction instead — the protocol of the message the USER sent
  // — which is strictly better evidence. An outbound tells us how we reached them; an
  // inbound tells us what their Messages app actually is.

  async function pairViaInbound(
    protocol: InboundMessage["protocol"],
  ): Promise<{ userId: string; status: string | undefined }> {
    const h = harness();
    await h.app.ready();
    const phone = nextPhone();
    const out = await signup(h, phone);
    cleanup.push(out.userId);

    await handleInbound({
      inbound: {
        schema_version: "inbound.v1",
        provider: "mock",
        provider_message_id: `lmsg_${out.userId.slice(4, 12)}`,
        line_id: "line_test",
        from_handle: phone,
        user_id: null,
        received_at: new Date().toISOString(),
        kind: "text",
        text: out.token,
        protocol,
      },
      channel: h.channel,
    });

    const user = await getUser(unsafeScopeFromUserId(out.userId));
    await h.app.close();
    return { userId: out.userId, status: user?.handle_status };
  }

  it("records imessage when the user's own message arrives blue", async () => {
    expect((await pairViaInbound("imessage")).status).toBe("imessage");
  });

  it("flags a mismatch when it arrives green", async () => {
    // In production this means the handle they typed is not registered to iMessage, and
    // we know it at pairing time rather than when the first brief lands green.
    expect((await pairViaInbound("sms")).status).toBe("mismatch");
  });

  it("claims nothing when the transport reports no protocol", async () => {
    // "We don't know whether this was blue" and "this was green" are different facts and
    // only one of them is true. A transport that does not report a protocol must not be
    // silently recorded as a mismatch.
    expect((await pairViaInbound(null)).status).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------

describe("POST /v1/pair", () => {
  it("exchanges a valid code for a device token and a 32-byte salt", async () => {
    const h = harness();
    await h.app.ready();
    const out = await signup(h, nextPhone());
    cleanup.push(out.userId);
    const code = await mintCode(out.userId, new Date());

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: code, device_id: "dev_macbook00000a" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user_id: string; device_token: string; user_salt: string };
    expect(body.user_id).toBe(out.userId);
    expect(body.device_token.startsWith(`${out.userId}.`)).toBe(true);
    expect(Buffer.from(body.user_salt, "base64").length).toBeGreaterThanOrEqual(32);

    // The salt is the one issued at account creation, not a fresh one.
    const user = await getUser(unsafeScopeFromUserId(out.userId));
    expect(Buffer.from(body.user_salt, "base64").equals(user!.user_salt)).toBe(true);

    // And the token it returned actually authenticates.
    const beat = await h.app.inject({
      method: "POST",
      url: "/v1/heartbeat",
      headers: { authorization: `Bearer ${body.device_token}` },
      payload: {
        device_id: "dev_macbook00000a",
        app_version: "0.1.0",
        digest_as_of: "2026-08-01T09:14:00Z",
      },
    });
    expect(beat.statusCode).toBe(204);
    await h.app.close();
  });

  it("is single use — the same code twice returns 404 invalid_code", async () => {
    const h = harness();
    await h.app.ready();
    const out = await signup(h, nextPhone());
    cleanup.push(out.userId);
    const code = await mintCode(out.userId, new Date());

    const first = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: code, device_id: "dev_first00000001" },
    });
    expect(first.statusCode).toBe(200);

    const second = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: code, device_id: "dev_second0000001" },
    });
    expect(second.statusCode).toBe(404);
    expect(second.json()).toEqual({ error: "invalid_code" });
    await h.app.close();
  });

  it("expires after ten minutes — by moving the clock, not by sleeping", async () => {
    const start = new Date("2026-08-01T09:00:00Z");
    const h = harness({ at: start });
    await h.app.ready();
    const out = await signup(h, nextPhone());
    cleanup.push(out.userId);
    // Minted against the HARNESS clock, not the wall clock: the endpoint reads `deps.now`
    // and a code stamped from `new Date()` would expire on a schedule the test does not
    // control.
    const code = await mintCode(out.userId, start);

    // One second before the boundary: still good.
    h.advance(PAIRING_TTL_SECONDS - 1);
    const early = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: code, device_id: "dev_intime00000001" },
    });
    expect(early.statusCode).toBe(200);
    await h.app.close();

    // A fresh account, and this time step past the boundary.
    const h2 = harness({ at: start });
    await h2.app.ready();
    const out2 = await signup(h2, nextPhone());
    cleanup.push(out2.userId);
    const out2Code = await mintCode(out2.userId, start);

    h2.advance(PAIRING_TTL_SECONDS + 1);
    const late = await h2.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: out2Code, device_id: "dev_late000000001" },
    });
    expect(late.statusCode).toBe(404);
    expect(late.json()).toEqual({ error: "invalid_code" });
    await h2.app.close();
  }, 60_000);

  it("binds a code to one user — B's device cannot present A's code and become B", async () => {
    const h = harness();
    await h.app.ready();
    const a = await signup(h, nextPhone());
    const b = await signup(h, nextPhone());
    cleanup.push(a.userId, b.userId);
    const aCode = await mintCode(a.userId, new Date());
    const bCode = await mintCode(b.userId, new Date());

    // A's code, presented from a device that intends to be B's. It pairs as A, which
    // is the point: the code carries the identity, and the device_id cannot override
    // it. The dangerous outcome would be a token scoped to B.
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: aCode, device_id: "dev_bsdevice00001" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user_id: string; device_token: string };
    expect(body.user_id).toBe(a.userId);
    expect(body.user_id).not.toBe(b.userId);

    // And the token it issued reaches only A's data.
    const residueB = await residueByTable(b.userId, pool);
    expect(residueB["devices"]).toBe(0);

    // B's own code still works and is still B's.
    const second = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: bCode, device_id: "dev_bsdevice00002" },
    });
    expect((second.json() as { user_id: string }).user_id).toBe(b.userId);
    await h.app.close();
  });

  it("returns 404 for an unknown code, a malformed one, and a consumed one alike", async () => {
    const h = harness();
    await h.app.ready();
    for (const payload of [
      { code: "000000", device_id: "dev_x00000000001" },
      { code: "abc", device_id: "dev_x00000000001" },
      { code: "12345", device_id: "dev_x00000000001" },
      { device_id: "dev_x00000000001" },
      { code: "123456" },
    ]) {
      const res = await h.app.inject({ method: "POST", url: "/v1/pair", payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(404);
      expect(res.json()).toEqual({ error: "invalid_code" });
    }
    await h.app.close();
  });

  it("matches the OpenAPI document for both documented responses", async () => {
    const h = harness();
    await h.app.ready();
    const out = await signup(h, nextPhone());
    cleanup.push(out.userId);
    const code = await mintCode(out.userId, new Date());

    const ok = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: code, device_id: "dev_conform000001" },
    });
    const okCheck = checkResponse("/v1/pair", "post", 200, ok.json());
    expect(okCheck.errors).toEqual([]);
    expect(okCheck.ok).toBe(true);

    const bad = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: "000000", device_id: "dev_conform000002" },
    });
    const badCheck = checkResponse("/v1/pair", "post", 404, bad.json());
    expect(badCheck.errors).toEqual([]);
    expect(badCheck.ok).toBe(true);
    await h.app.close();
  });
});

// ---------------------------------------------------------------------------

describe("pairing codes are unguessable", () => {
  it("are six digits, CSPRNG, and not sequential across 1000 draws", () => {
    const codes = Array.from({ length: 1000 }, () => newPairingCode());
    for (const c of codes) expect(c).toMatch(/^[0-9]{6}$/);

    // Sequential would mean seeing a code lets you predict the next. Assert directly.
    let consecutive = 0;
    for (let i = 1; i < codes.length; i += 1) {
      if (Number(codes[i]) === Number(codes[i - 1]!) + 1) consecutive += 1;
    }
    expect(consecutive).toBe(0);

    // A counter, or a low-entropy source, collides far more than chance allows. With
    // 10^6 codes and 1000 draws, expected distinct is ~999.5.
    expect(new Set(codes).size).toBeGreaterThanOrEqual(995);

    // And the space is actually used: a generator stuck in one decade would pass the
    // two checks above.
    expect(new Set(codes.map((c) => c[0])).size).toBeGreaterThan(5);
    expect(codes.some((c) => c.startsWith("0"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("the pairing secret actually reaches the user", () => {
  // "is TEXTED at signup, not just returned as an HTTP header" was DELETED. It fixed a
  // real bug — the code used to leave only as a response header, on a page the user is
  // not reading — and AMENDMENT-002 dissolves the bug rather than fixing it: the secret
  // is now PREFILLED INTO THE USER'S OWN MESSAGE, so it does not have to reach them at
  // all. Nothing is texted at signup because nothing is sent at signup.
  //
  // The property it protected — the user ends up holding a live secret without being
  // asked to copy anything — is asserted by "puts THAT USER'S line in the deep link,
  // with the token prefilled" above, and by the inbound suite, which pairs using exactly
  // the string the deep link carried.

  // "RE-ISSUES on re-signup, so an expired code is not a dead end" was DELETED here and
  // REPLACED above by "RE-ISSUES a fresh token on re-signup". The requirement is
  // identical and survives; what died is the assertion that the new secret is TEXTED,
  // because signup no longer sends anything. See the table in NOTES.md.

  it("understands a texted six-digit code instead of answering 'reply 1 or 2'", async () => {
    // What a user who follows the welcome message literally actually does. Before this,
    // they hit `parseSelection`, matched nothing, and were told to reply 1 or 2.
    expect(parsePairingCode("410100")).toBe("410100");
    expect(parsePairingCode(" 410100 ")).toBe("410100");
    expect(parsePairingCode("2")).toBeNull();
    expect(parsePairingCode("41010")).toBeNull();
    expect(parsePairingCode("hello")).toBeNull();

    const h = harness();
    await h.app.ready();
    const phone = nextPhone();
    const out = await signup(h, phone);
    cleanup.push(out.userId);

    // The Mac shows a code; the user texts it.
    const macCode = "778812";
    const inbound: InboundMessage = {
      schema_version: "inbound.v1",
      provider: "mock",
      provider_message_id: "mmsg_pair_1",
      line_id: "line_a1",
      from_handle: phone,
      user_id: null, // resolved from the handle
      received_at: new Date().toISOString(),
      kind: "text",
      text: macCode,
      reply_to_message_id: null,
      protocol: "imessage",
      trace_id: null,
    };

    const result = await handleInbound({ inbound, channel: h.channel });
    expect(result.selection.kind).toBe("pairing_code");
    const reply = h.channel.sent.at(-1)!;
    const replyText = reply.blocks.map((b) => (b.type === "text" ? b.text : "")).join(" ");
    expect(replyText).not.toContain("reply 1 or 2");
    expect(replyText).toContain("got it");

    // And the Mac can now pair with the code the user texted.
    const paired = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: macCode, device_id: "dev_texted0000001" },
    });
    expect(paired.statusCode, paired.body).toBe(200);
    expect((paired.json() as { user_id: string }).user_id).toBe(out.userId);
    await h.app.close();
  }, 60_000);

  it("refuses to rebind a code another account is holding", async () => {
    const h = harness();
    await h.app.ready();
    const victimPhone = nextPhone();
    const attackerPhone = nextPhone();
    const victim = await signup(h, victimPhone);
    const attacker = await signup(h, attackerPhone);
    cleanup.push(victim.userId, attacker.userId);
    const victimCode = await mintCode(victim.userId, new Date());

    // The attacker texts the victim's live code. Rebinding would point the victim's Mac
    // at the attacker's account — the advisory lock in issuePairingCode is what stops it.
    const inbound: InboundMessage = {
      schema_version: "inbound.v1",
      provider: "mock",
      provider_message_id: "mmsg_pair_attack",
      line_id: "line_a1",
      from_handle: attackerPhone,
      user_id: null,
      received_at: new Date().toISOString(),
      kind: "text",
      text: victimCode,
      reply_to_message_id: null,
      protocol: "imessage",
      trace_id: null,
    };
    const result = await handleInbound({ inbound, channel: h.channel });
    expect(result.selection.kind === "pairing_code" && result.selection.bound).toBe(false);

    // The victim's code still resolves to the victim.
    const paired = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: victimCode, device_id: "dev_victim0000001" },
    });
    expect((paired.json() as { user_id: string }).user_id).toBe(victim.userId);
    await h.app.close();
  }, 60_000);
});

describe("/v1/pair is rate limited", () => {
  it("stops a brute-force sweep of the six-digit space", async () => {
    // Unauthenticated, a million codes, ten-minute windows, and a hit returns the
    // user_salt — which is issued once and never rotated.
    const limiter = new FixedWindowLimiter(PAIR_LIMIT);
    const at = new Date("2026-08-03T09:00:00Z");
    const app = buildServer({
      channel: new StubChannel(),
      now: () => at,
      logger: makeLogger(new PassThrough()),
      pairLimiter: limiter,
    });
    await app.ready();
    try {
      const codes = Array.from({ length: PAIR_LIMIT.limit }, (_, i) =>
        String(100000 + i),
      );
      for (const code of codes) {
        const res = await app.inject({
          method: "POST",
          url: "/v1/pair",
          payload: { code, device_id: "dev_sweep00000001" },
        });
        expect(res.statusCode, `code ${code}`).toBe(404);
      }

      // One past the limit.
      const blocked = await app.inject({
        method: "POST",
        url: "/v1/pair",
        payload: { code: "999999", device_id: "dev_sweep00000001" },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toEqual({ error: "rate_limited" });
      expect(blocked.headers["retry-after"]).toBeDefined();
    } finally {
      await app.close();
    }
  }, 60_000);

  it("opens a fresh window once the old one passes — clock, not sleep", () => {
    const limiter = new FixedWindowLimiter({ limit: 2, windowSeconds: 60 });
    const t0 = new Date("2026-08-03T09:00:00Z");
    expect(limiter.check("ip", t0).allowed).toBe(true);
    expect(limiter.check("ip", t0).allowed).toBe(true);
    expect(limiter.check("ip", t0).allowed).toBe(false);

    const t1 = new Date(t0.getTime() + 61_000);
    expect(limiter.check("ip", t1).allowed).toBe(true);
  });

  it("counts each source separately", () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowSeconds: 60 });
    const t0 = new Date("2026-08-03T09:00:00Z");
    expect(limiter.check("a", t0).allowed).toBe(true);
    expect(limiter.check("a", t0).allowed).toBe(false);
    // A different caller is not punished for the first one's spraying.
    expect(limiter.check("b", t0).allowed).toBe(true);
  });
});
