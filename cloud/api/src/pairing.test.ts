// Signup, the first message, and the pairing exchange.
//
// Serialised against the other database-touching files by the advisory lock in
// cloud/db/src/test-lock.ts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import { StubChannel, type OutboundMessage } from "../../shared/src/index.js";
import {
  acquireSuiteLock,
  closePool,
  deleteUser,
  findUserIdByPhone,
  getPool,
  getUser,
  migrate,
  newPairingCode,
  releaseSuiteLock,
  residueByTable,
  unsafeScopeFromUserId,
} from "../../db/src/index.js";
import { buildServer } from "./server.js";
import { makeLogger } from "./logging.js";
import { checkResponse } from "./openapi.js";
import { boiHandle, welcomeMessage, WELCOME_TEXT } from "./welcome.js";
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
function harness(opts: { mode?: "up" | "degraded" | "banned"; at?: Date } = {}) {
  const channel = new StubChannel(opts.mode ?? "up");
  let clock = opts.at ?? new Date();
  const app = buildServer({
    channel,
    now: () => clock,
    logger: makeLogger(new PassThrough()),
  });
  return {
    app,
    channel,
    /** Move the clock. No sleeping: expiry is ten minutes and a test is not. */
    advance(seconds: number) {
      clock = new Date(clock.getTime() + seconds * 1000);
    },
  };
}

async function signup(
  h: { app: FastifyInstance },
  phone: string,
): Promise<{ status: number; html: string; code: string; userId: string }> {
  const res = await h.app.inject({
    method: "POST",
    url: "/signup",
    payload: { phone_e164: phone, email: "a@example.com", accept_terms: true },
  });
  const scope = await findUserIdByPhone(phone);
  return {
    status: res.statusCode,
    html: res.body,
    code: res.headers["x-boi-pairing-code"] as string,
    userId: scope?.user_id ?? "",
  };
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

describe("signup sends first, because the alternative fails silently", () => {
  it("sends the welcome message BEFORE the response returns", async () => {
    const h = harness();
    await h.app.ready();

    // Nothing sent yet.
    expect(h.channel.sent).toHaveLength(0);

    const out = await signup(h, nextPhone());
    cleanup.push(out.userId);

    // By the time the confirmation page is in hand, the messages already exist. The
    // page tells the user to go look at a text; if the send were queued, that sentence
    // would be a lie for however long the queue took.
    //
    // Two now: the welcome, then the pairing code. The code used to leave only as an
    // HTTP header, which is not a path to the user — see the pairing tests below.
    expect(h.channel.sent).toHaveLength(2);
    expect(h.channel.sent[0]?.blocks.map((b) => b.type)).toEqual(["text", "contact_card"]);
    expect(out.status).toBe(200);
    await h.app.close();
  });

  it("sends both a text block and a contact_card block", async () => {
    const h = harness();
    await h.app.ready();
    const out = await signup(h, nextPhone());
    cleanup.push(out.userId);

    const sent = h.channel.sent[0]!;
    expect(sent.schema_version).toBe("outbound.v1");
    expect(sent.user_id).toBe(out.userId);

    const kinds = sent.blocks.map((b) => b.type);
    expect(kinds).toContain("text");
    // THE BLOCK THAT DOES THE WORK. Without the contact card there is nothing for the
    // user to tap, and the account stays in the filtered tab permanently.
    expect(kinds).toContain("contact_card");

    const card = sent.blocks.find((b) => b.type === "contact_card");
    expect(card).toMatchObject({ type: "contact_card", name: "Boi", handle: boiHandle() });
    expect(sent.requested_capabilities).toContain("contact_cards");
    await h.app.close();
  });

  it("matches the shape of contracts/fixtures/outbound/first_contact_card.json", async () => {
    const fixture = JSON.parse(
      readFileSync(
        join(process.cwd(), "contracts", "fixtures", "outbound", "first_contact_card.json"),
        "utf8",
      ),
    ) as OutboundMessage;

    const mine = welcomeMessage("usr_demo00000001");

    // Same keys, same block types in the same order, same text — everything except the
    // user-specific values. Compared structurally rather than by eyeballing the file.
    expect(Object.keys(mine).sort()).toEqual(Object.keys(fixture).sort());
    expect(mine.blocks.map((b) => b.type)).toEqual(fixture.blocks.map((b) => b.type));
    expect(mine.requested_capabilities).toEqual(fixture.requested_capabilities);
    expect(mine.reply_to_message_id).toBe(fixture.reply_to_message_id);
    expect(WELCOME_TEXT).toBe(
      (fixture.blocks.find((b) => b.type === "text") as { text: string }).text,
    );
  });

  it("records the send in messages_out, once, even if signup is repeated", async () => {
    const h = harness();
    await h.app.ready();
    const phone = nextPhone();
    const first = await signup(h, phone);
    cleanup.push(first.userId);

    await signup(h, phone); // the same person, hitting submit again

    // One row: `unique (user_id, idempotency_key)` on a key derived from the user id.
    const residue = await residueByTable(first.userId, pool);
    expect(residue["messages_out"]).toBe(1);
    await h.app.close();
  });

  it("puts a working sms: deep link on the confirmation page", async () => {
    const h = harness();
    await h.app.ready();
    const out = await signup(h, nextPhone());
    cleanup.push(out.userId);

    expect(out.html).toContain(`href="sms:${boiHandle()}"`);
    // The handle in the link is the one the card told them to save.
    const sent = h.channel.sent[0]!;
    const card = sent.blocks.find((b) => b.type === "contact_card") as { handle: string };
    expect(out.html).toContain(`sms:${card.handle}`);
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
      payload: `phone_e164=${encodeURIComponent(phone)}&email=&accept_terms=true`,
    });
    expect(res.statusCode).toBe(200);
    const scope = await findUserIdByPhone(phone);
    expect(scope).not.toBeNull();
    cleanup.push(scope!.user_id);
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

// ---------------------------------------------------------------------------

describe("handle-mismatch detection", () => {
  it("flags a send that came back as sms rather than imessage", async () => {
    // StubChannel in `degraded` mode returns protocol 'sms'. In production that means
    // the number they typed is not registered to iMessage — and we find out here,
    // before they download anything, rather than when the first brief lands green.
    const h = harness({ mode: "degraded" });
    await h.app.ready();
    const out = await signup(h, nextPhone());
    cleanup.push(out.userId);

    const user = await getUser(unsafeScopeFromUserId(out.userId));
    expect(user?.handle_status).toBe("mismatch");

    // And the user is told, on the page, rather than it being a silent server-side flag.
    expect(out.html).toContain("handle-mismatch");
    await h.app.close();
  });

  it("records imessage when the send lands as imessage", async () => {
    const h = harness({ mode: "up" });
    await h.app.ready();
    const out = await signup(h, nextPhone());
    cleanup.push(out.userId);

    const user = await getUser(unsafeScopeFromUserId(out.userId));
    expect(user?.handle_status).toBe("imessage");
    expect(out.html).not.toContain("handle-mismatch");
    await h.app.close();
  });

  it("does not report success when the line is banned", async () => {
    const h = harness({ mode: "banned" });
    await h.app.ready();
    const out = await signup(h, nextPhone());
    cleanup.push(out.userId);

    // The account exists — losing the signup would be worse — but the status says
    // plainly that nothing was delivered, rather than defaulting to 'imessage'.
    const user = await getUser(unsafeScopeFromUserId(out.userId));
    expect(user?.handle_status).toBe("unreachable");
    expect(h.channel.sent).toHaveLength(0);
    await h.app.close();
  });
});

// ---------------------------------------------------------------------------

describe("POST /v1/pair", () => {
  it("exchanges a valid code for a device token and a 32-byte salt", async () => {
    const h = harness();
    await h.app.ready();
    const out = await signup(h, nextPhone());
    cleanup.push(out.userId);

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: out.code, device_id: "dev_macbook00000a" },
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

    const first = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: out.code, device_id: "dev_first00000001" },
    });
    expect(first.statusCode).toBe(200);

    const second = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: out.code, device_id: "dev_second0000001" },
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

    // One second before the boundary: still good.
    h.advance(PAIRING_TTL_SECONDS - 1);
    const early = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: out.code, device_id: "dev_intime00000001" },
    });
    expect(early.statusCode).toBe(200);
    await h.app.close();

    // A fresh account, and this time step past the boundary.
    const h2 = harness({ at: start });
    await h2.app.ready();
    const out2 = await signup(h2, nextPhone());
    cleanup.push(out2.userId);

    h2.advance(PAIRING_TTL_SECONDS + 1);
    const late = await h2.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: out2.code, device_id: "dev_late000000001" },
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

    // A's code, presented from a device that intends to be B's. It pairs as A, which
    // is the point: the code carries the identity, and the device_id cannot override
    // it. The dangerous outcome would be a token scoped to B.
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: a.code, device_id: "dev_bsdevice00001" },
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
      payload: { code: b.code, device_id: "dev_bsdevice00002" },
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

    const ok = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: out.code, device_id: "dev_conform000001" },
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

describe("the pairing code actually reaches the user", () => {
  it("is TEXTED at signup, not just returned as an HTTP header", async () => {
    // The bug: the code left the building only as `x-boi-pairing-code`, a header on a
    // page the user is not reading, on a request their browser made. The frozen welcome
    // tells them to text their pairing code and nothing had ever given them one.
    const h = harness();
    await h.app.ready();
    const out = await signup(h, nextPhone());
    cleanup.push(out.userId);

    // Two messages: the welcome, then the code.
    expect(h.channel.sent).toHaveLength(2);
    const codeMessage = h.channel.sent[1]!;
    const text = codeMessage.blocks.map((b) => (b.type === "text" ? b.text : "")).join(" ");
    expect(text).toContain(out.code);
    expect(text).toMatch(/10 minutes/);

    // The welcome itself is untouched — it still matches the frozen fixture.
    const welcome = h.channel.sent[0]!;
    expect(welcome.blocks.map((b) => b.type)).toEqual(["text", "contact_card"]);
    expect(welcome.blocks.some((b) => b.type === "text" && b.text.includes(out.code))).toBe(false);

    await h.app.close();
  }, 60_000);

  it("RE-ISSUES on re-signup, so an expired code is not a dead end", async () => {
    // Signing up again is what somebody does when the first code expired. Returning the
    // same page without a fresh one left that account permanently unpairable.
    const start = new Date("2026-08-01T09:00:00Z");
    const h = harness({ at: start });
    await h.app.ready();
    const phone = nextPhone();

    const first = await signup(h, phone);
    cleanup.push(first.userId);

    h.advance(PAIRING_TTL_SECONDS + 60); // the first code is now dead
    const dead = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: first.code, device_id: "dev_expired000001" },
    });
    expect(dead.statusCode).toBe(404);

    const again = await signup(h, phone);
    expect(again.userId).toBe(first.userId);
    expect(again.code).not.toBe(first.code);

    // The new one is texted too, and it works.
    const texts = h.channel.sent.map((m) =>
      m.blocks.map((b) => (b.type === "text" ? b.text : "")).join(" "),
    );
    expect(texts.some((t) => t.includes(again.code))).toBe(true);

    const ok = await h.app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: again.code, device_id: "dev_reissued00001" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    await h.app.close();
  }, 60_000);

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
      text: victim.code,
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
      payload: { code: victim.code, device_id: "dev_victim0000001" },
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
