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

    // By the time the confirmation page is in hand, the message already exists. The
    // page tells the user to go look at a text; if the send were queued, that sentence
    // would be a lie for however long the queue took.
    expect(h.channel.sent).toHaveLength(1);
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
