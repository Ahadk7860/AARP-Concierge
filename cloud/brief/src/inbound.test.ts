// The first message the user ever sends, and everything they might send instead.
//
// AMENDMENT-002 makes inbound the FIRST step rather than a reply: the user opens the
// thread from a deep link whose body is prefilled with a pairing token. Which means the
// interesting cases are not "did the token work" but the three ways a prefilled body
// stops being prefilled — the user deletes it, types around it, or sends nothing at all.
//
// Every assertion here is on what the CHANNEL received and what the database holds, never
// on a return value alone: `handleInbound` returning `{kind: "paired"}` while sending
// nothing is a paired account with no download link, which is a dead end the user cannot
// escape.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { InboundMessage } from "../../shared/src/index.js";
import { StubChannel } from "../../shared/src/index.js";
import {
  closePool,
  createUser,
  deleteUser,
  issuePairingCode,
  liveCodeFor,
  migrate,
  type UserScope,
} from "../../db/src/index.js";
import { acquireSuiteLock, releaseSuiteLock } from "../../db/src/test-lock.js";
import { newPairingToken } from "../../api/src/welcome.js";
import { handleInbound, parsePairingToken } from "./inbound.js";

const NOW = new Date("2026-09-14T16:00:00Z");
const created: UserScope[] = [];

async function seed(over: { email?: string } = {}): Promise<{ scope: UserScope; phone: string }> {
  const phone = `+1558${String(Math.floor(Math.random() * 9_000_000 + 1_000_000))}`;
  const { scope } = await createUser({
    phone_e164: phone,
    email: over.email ?? null,
    timezone: "America/Los_Angeles",
  });
  created.push(scope);
  return { scope, phone };
}

async function mint(scope: UserScope): Promise<string> {
  const token = newPairingToken();
  await issuePairingCode(scope, { code: token, ttl_seconds: 600, now: NOW });
  return token;
}

function inboundFrom(handle: string, text: string | null): InboundMessage {
  return {
    schema_version: "inbound.v1",
    provider: "mock",
    provider_message_id: `lmsg_${Math.random().toString(16).slice(2, 10)}`,
    line_id: "line_test",
    from_handle: handle,
    user_id: null,
    received_at: NOW.toISOString(),
    kind: "text",
    text,
  };
}

beforeAll(async () => {
  await acquireSuiteLock();
  await migrate();
}, 180_000);

afterEach(async () => {
  while (created.length > 0) {
    const scope = created.pop();
    if (scope !== undefined) await deleteUser(scope);
  }
});

afterAll(async () => {
  await releaseSuiteLock();
  await closePool();
});

describe("the token, as it actually arrives", () => {
  it("is found anywhere in the message, because the body is editable", () => {
    // People add "hi", they add punctuation, some type a whole sentence around it before
    // hitting send. Rejecting those would answer the one thing we asked them to do with
    // a re-prompt.
    expect(parsePairingToken("boi-4f2a91")).toBe("boi-4f2a91");
    expect(parsePairingToken("hi! boi-4f2a91")).toBe("boi-4f2a91");
    expect(parsePairingToken("hey there — boi-4f2a91, thanks")).toBe("boi-4f2a91");
    expect(parsePairingToken("BOI-4F2A91")).toBe("boi-4f2a91");
  });

  it("does not swallow the messages that already mean something", () => {
    // Generous in ONE direction. `1`, `2` and six bare digits still route where they
    // always did, and a matcher that grabbed them would break draft selection for every
    // existing user.
    expect(parsePairingToken("1")).toBeNull();
    expect(parsePairingToken("2")).toBeNull();
    expect(parsePairingToken("418293")).toBeNull();
    expect(parsePairingToken("boi")).toBeNull();
    expect(parsePairingToken("boi-zzz")).toBeNull();
    expect(parsePairingToken(null)).toBeNull();
  });
});

describe("pairing from the thread", () => {
  it("pairs, and answers with the download link and the contact card", async () => {
    // THE ORDERING AMENDMENT-002 TURNS ON: Boi is useful before it asks for anything, so
    // the Full Disk Access request that follows lands as "the thing I already asked for
    // needs this" rather than as a stranger wanting a message history.
    const { scope, phone } = await seed();
    const token = await mint(scope);
    const channel = new StubChannel();

    const result = await handleInbound({
      inbound: inboundFrom(phone, `hi ${token}`),
      channel,
      now: NOW,
    });

    expect(result.selection.kind).toBe("paired");
    expect(channel.sent.length).toBe(1);
    const blocks = channel.sent[0]!.blocks;
    expect(blocks.some((b) => b.type === "text" && b.text.includes("https://"))).toBe(true);
    expect(blocks.some((b) => b.type === "contact_card")).toBe(true);
    // The token is consumed, so the message the user can see forever is now inert.
    expect(await liveCodeFor(scope, NOW)).toBeNull();
  }, 120_000);

  it("resolves an inbound from the EMAIL handle to the same user", async () => {
    // Messages on a Mac frequently sends from the Apple Account email rather than the
    // phone number. Before this, that user's first message resolved to nobody and was
    // answered with silence — the failure the both-handles registration exists to
    // prevent, and it produces no error anywhere.
    const email = `mac-${Math.random().toString(16).slice(2, 8)}@example.com`;
    const { scope } = await seed({ email });
    const token = await mint(scope);
    const channel = new StubChannel();

    const result = await handleInbound({
      inbound: inboundFrom(email, token),
      channel,
      now: NOW,
    });

    expect(result.selection.kind).toBe("paired");
    expect(channel.sent[0]?.user_id).toBe(scope.user_id);
  }, 120_000);

  it("is SINGLE USE — a replayed message pairs once", async () => {
    // The provider redelivers. The user forwards their own message. Both happen, and
    // neither may consume a token twice or send two first replies.
    const { scope, phone } = await seed();
    const token = await mint(scope);
    const channel = new StubChannel();

    const first = await handleInbound({ inbound: inboundFrom(phone, token), channel, now: NOW });
    const second = await handleInbound({ inbound: inboundFrom(phone, token), channel, now: NOW });

    expect(first.selection.kind).toBe("paired");
    expect(second.selection.kind).not.toBe("paired");
    expect(channel.sent.filter((m) => m.idempotency_key.startsWith("firstreply-")).length).toBe(1);
  }, 120_000);

  it("EXPIRES — by moving the clock, not by sleeping", async () => {
    const { scope, phone } = await seed();
    const token = await mint(scope);
    const channel = new StubChannel();

    const late = new Date(NOW.getTime() + 11 * 60_000);
    const result = await handleInbound({ inbound: inboundFrom(phone, token), channel, now: late });

    expect(result.selection.kind).not.toBe("paired");
    // And nothing was consumed, so the account is not left in a half-paired state.
    expect(await liveCodeFor(scope, NOW)).toBe(token);
  }, 120_000);

  it("is BOUND to one user — B cannot present A's token", async () => {
    // The scoped consume IS the binding: the update names both the user and the code, so
    // a token issued to A updates zero rows under B's scope. Without it, anyone who could
    // read a screenshot of somebody else's thread could claim their account.
    const a = await seed();
    const b = await seed();
    const tokenA = await mint(a.scope);
    const channel = new StubChannel();

    const result = await handleInbound({
      inbound: inboundFrom(b.phone, tokenA),
      channel,
      now: NOW,
    });

    expect(result.selection.kind).not.toBe("paired");
    // A's token is untouched: B's attempt must not burn it either.
    expect(await liveCodeFor(a.scope, NOW)).toBe(tokenA);
  }, 120_000);
});

describe("the body is user-editable, and all three edits happen", () => {
  const cases: Array<[string, string | null]> = [
    ["deleted — they typed their own greeting", "hey"],
    ["mangled — half the token survived", "boi-4f2"],
    ["emptied — they sent nothing at all", ""],
  ];

  for (const [name, text] of cases) {
    it(`re-prompts when the body was ${name}`, async () => {
      // Silence would be the worst answer: they have just done the one thing we asked
      // and got nothing back, in a thread they opened specifically to be useful.
      const { scope, phone } = await seed();
      const token = await mint(scope);
      const channel = new StubChannel();

      const result = await handleInbound({
        inbound: inboundFrom(phone, text),
        channel,
        now: NOW,
      });

      expect(result.selection.kind).toBe("needs_token");
      expect(channel.sent.length).toBe(1);
      const said = channel.sent[0]!.blocks.map((b) => (b.type === "text" ? b.text : "")).join(" ");
      // It tells them the one thing they need, and does not explain what they did wrong —
      // the honest explanation is "you deleted the code we hid in your message", which
      // reads as a scolding for something we made invisible on purpose.
      expect(said).toContain(token);
      expect(said.toLowerCase()).not.toContain("invalid");
      expect(said.toLowerCase()).not.toContain("error");
      // The token survives a fumbled attempt. Burning it here would strand the user with
      // a link that no longer works and no way to get another.
      expect(await liveCodeFor(scope, NOW)).toBe(token);
    }, 120_000);
  }

  it("does NOT re-prompt an established user who says hello", async () => {
    // The re-prompt is for somebody mid-onboarding. An existing user texting "hey" gets
    // the ordinary answer, or this becomes a bot that repeats a code at people for the
    // rest of their subscription.
    const { scope, phone } = await seed();
    void scope;
    const channel = new StubChannel();

    const result = await handleInbound({ inbound: inboundFrom(phone, "hey"), channel, now: NOW });

    expect(result.selection.kind).toBe("not_a_selection");
  }, 120_000);
});

describe("an inbound from a stranger", () => {
  it("says nothing at all", async () => {
    // Replying would confirm to whoever is probing that this number is a service, and
    // that is the whole of the answer.
    const channel = new StubChannel();
    const result = await handleInbound({
      inbound: inboundFrom("+15550000000", "boi-4f2a91"),
      channel,
      now: NOW,
    });

    expect(result.selection.kind).toBe("unknown_user");
    expect(channel.sent.length).toBe(0);
  }, 120_000);
});
