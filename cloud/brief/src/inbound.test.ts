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
import { handleInbound, parsePairingToken, parseReportRequest } from "./inbound.js";
import { cardFieldsForTest } from "./run.js";
import type { Digest, Relationship } from "../../shared/src/index.js";
import { insertDigest, newDigestId, upsertRelationships } from "../../db/src/index.js";
import { readFileSync } from "node:fs";
import path from "node:path";

const TZ = "America/Los_Angeles";

/** A stored digest, so "no corpus" and "not enough corpus" are different states. */
async function seedDigest(scope: UserScope): Promise<void> {
  const file = path.resolve(import.meta.dirname, "..", "..", "..",
    "contracts", "fixtures", "digest", "healthy.json");
  const digest = JSON.parse(readFileSync(file, "utf8")) as Digest;
  digest.user_id = scope.user_id;
  digest.generated_at = NOW.toISOString();
  digest.corpus.as_of = NOW.toISOString();
  await insertDigest(scope, { digest_id: newDigestId(), digest });
  await upsertRelationships(scope, digest.relationships as Relationship[]);
}

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

// ---------------------------------------------------------------------------
// Prompt 09: ask Boi for your report.
//
// This is the path that makes the kill test runnable — twenty people asking and
// screenshotting is the same evidence as twenty receiving, with no scheduler and no
// waiting until 8am tomorrow.

describe("the report intent matches loosely and loses to every narrow matcher", () => {
  it("matches the canonical phrase, a polite long form, and the bare word", () => {
    // Advertise one phrase, match generously around it. Being told the magic words and
    // having them not work is worse than never being offered them.
    expect(parseReportRequest("send my friends report")).toBe(true);
    expect(parseReportRequest("hi boi, i'd like to receive my friends report")).toBe(true);
    expect(parseReportRequest("report")).toBe(true);
    expect(parseReportRequest("REPORT please")).toBe(true);
  });

  it("does not match three things that must keep meaning what they meant", () => {
    // Generous in ONE direction. A bare "friends" is not enough — "how are my friends"
    // is a question this product cannot answer and must not pretend to.
    expect(parseReportRequest("how are my friends")).toBe(false);
    expect(parseReportRequest("1")).toBe(false);
    expect(parseReportRequest("reporter")).toBe(false);
  });

  it("still routes 1, 2, six digits and a token to their own handlers", async () => {
    // Asserted AFTER the new matcher exists, which is the only version of this assertion
    // worth having: the risk is a widened matcher swallowing an anchored one.
    const { scope, phone } = await seed();
    const token = await mint(scope);
    const channel = new StubChannel();

    const paired = await handleInbound({
      inbound: inboundFrom(phone, token), channel, now: NOW,
    });
    expect(paired.selection.kind).toBe("paired");

    const digits = await handleInbound({
      inbound: inboundFrom(phone, "418293"), channel, now: NOW,
    });
    expect(digits.selection.kind).toBe("pairing_code");

    for (const pick of ["1", "2"]) {
      const selected = await handleInbound({
        inbound: inboundFrom(phone, pick), channel, now: NOW,
      });
      // No brief exists for this user, so `1` reaches the brief lookup rather than the
      // report — which is the ordering under test.
      expect(selected.selection.kind).toBe("no_brief");
    }
  }, 120_000);
});

describe("the three outcomes of a report request", () => {
  /** A card renderer that says what it was asked to say. */
  function renderer(kind: "standard" | "refusal") {
    let calls = 0;
    return {
      calls: () => calls,
      render: async () => {
        calls += 1;
        return kind === "standard"
          ? { url: `http://127.0.0.1:3043/cards/x/card_${calls}.png?sig=x`, kind, card_id: `card_${calls}` }
          : { url: null, kind, card_id: null };
      },
    };
  }

  it("NO CORPUS is a claim about US, not about them", async () => {
    // The likeliest report request in the product: the thread exists before the Mac app
    // does, so somebody reads "text me: send my friends report" and does it immediately.
    // Answering with a refusal card would tell a brand-new user their friendships are too
    // thin to measure when we have not looked yet.
    const { scope, phone } = await seed();
    void scope;
    const channel = new StubChannel();
    const cards = renderer("standard");

    const result = await handleInbound({
      inbound: inboundFrom(phone, "send my friends report"),
      channel,
      now: NOW,
      renderCard: cards.render,
    });

    expect(result.selection.kind).toBe("report");
    const said = channel.sent[0]!.blocks.map((b) => (b.type === "text" ? b.text : "")).join(" ");
    expect(said).toContain("don't have your history yet");
    // It names the step that fixes it.
    expect(said).toMatch(/mac|scan/i);
    // And it says nothing about how much history they have, because we have not looked.
    expect(said).not.toMatch(/isn't enough|not enough/i);
    // Nothing was rendered: there is no digest to render from.
    expect(cards.calls()).toBe(0);
    expect(channel.sent.some((m) => m.blocks.some((b) => b.type === "image"))).toBe(false);
  }, 120_000);

  it("a REFUSAL is a claim about them, and says what would change it", async () => {
    const { scope, phone } = await seed();
    await seedDigest(scope);
    const channel = new StubChannel();
    const cards = renderer("refusal");

    const result = await handleInbound({
      inbound: inboundFrom(phone, "report"),
      channel,
      now: NOW,
      renderCard: cards.render,
      timezone: TZ,
    });

    expect(result.selection.kind).toBe("report");
    if (result.selection.kind === "report") expect(result.selection.outcome).toBe("refusal");
    const said = channel.sent[0]!.blocks.map((b) => (b.type === "text" ? b.text : "")).join(" ");
    // On request a refusal is FINE — the standing rule is that it is never attached to a
    // scheduled brief, because daily it becomes a reproach. Asked for directly it is the
    // honest answer to a direct question.
    expect(said).toMatch(/isn't enough/i);
    // And it must say what would change it. A refusal with no remedy is guilt without
    // agency, which the product conventions forbid outright.
    expect(said).toContain("Keep Messages");
  }, 120_000);

  it("a REAL report comes back as an image block, over what the channel received", async () => {
    const { scope, phone } = await seed();
    await seedDigest(scope);
    const channel = new StubChannel();
    const cards = renderer("standard");

    await handleInbound({
      inbound: inboundFrom(phone, "send my friends report"),
      channel,
      now: NOW,
      renderCard: cards.render,
      timezone: TZ,
    });

    const images = channel.sent.flatMap((m) => m.blocks.filter((b) => b.type === "image"));
    expect(images.length).toBe(1);
    expect(cards.calls()).toBe(1);
  }, 120_000);
});

describe("the daily cache", () => {
  it("renders ONCE a day and says so on the second ask", async () => {
    // The one path a user can trigger as fast as they can type, and every trigger renders
    // a 1080x1920 PNG. The cost matters; the trust matters more — a card that changes
    // between two requests four seconds apart is a card whose numbers nobody believes.
    const { scope, phone } = await seed();
    await seedDigest(scope);
    const channel = new StubChannel();
    let calls = 0;
    const render = async () => {
      calls += 1;
      return {
        url: `http://127.0.0.1:3043/cards/${scope.user_id}/card_${calls}.png?sig=x`,
        kind: "standard" as const,
        card_id: `card_${calls}`,
      };
    };

    await handleInbound({
      inbound: inboundFrom(phone, "report"), channel, now: NOW, renderCard: render, timezone: TZ,
    });
    const again = await handleInbound({
      inbound: inboundFrom(phone, "report"), channel, now: NOW, renderCard: render, timezone: TZ,
    });

    expect(calls, "the renderer ran twice").toBe(1);
    if (again.selection.kind === "report") expect(again.selection.cached).toBe(true);

    // Same image both times.
    const urls = channel.sent.flatMap((m) =>
      m.blocks.filter((b) => b.type === "image").map((b) => b.url));
    expect(new Set(urls).size).toBe(1);

    // And it SAYS it is the same card, with when it next changes. A silent repeat is
    // what makes people stop believing the figure.
    const second = again.sent[0]!.blocks.map((b) => (b.type === "text" ? b.text : "")).join(" ");
    expect(second).toContain("same card as earlier today");
    expect(second).toMatch(/once a day/);
  }, 120_000);
});

describe("a request at 7am and the brief at 8am", () => {
  it("does not hand the user the same card twice with no acknowledgement", async () => {
    // Two different code paths — the report intent and the scheduled tick — and the same
    // user, an hour apart. The card is dated by design; sending it twice in an hour with
    // nothing said is how a figure people were meant to check against their own memory
    // starts reading as live.
    //
    // The decision: the brief goes out WITHOUT the image. Its subject is the three
    // people; the card is an artifact they already have.
    const { scope, phone } = await seed();
    await seedDigest(scope);
    const channel = new StubChannel();
    const render = async () => ({
      url: `http://127.0.0.1:3043/cards/${scope.user_id}/card_7am.png?sig=x`,
      kind: "standard" as const,
      card_id: "card_7am",
    });

    // 07:00 — they ask.
    await handleInbound({
      inbound: inboundFrom(phone, "send my friends report"),
      channel, now: NOW, renderCard: render, timezone: TZ,
    });
    expect(channel.sent.flatMap((m) => m.blocks).some((b) => b.type === "image")).toBe(true);

    // 08:00 — the scheduled brief composes for the same local day.
    const events: Record<string, unknown>[] = [];
    const fields = await cardFieldsForTest({
      scope,
      now: new Date(NOW.getTime() + 3_600_000),
      timezone: TZ,
      log: (e) => events.push(e),
      cardFor: render,
    });

    expect(fields.card_url).toBeNull();
    expect(fields.card_kind).toBeNull();
    expect(events.some((e) => e["msg"] === "card.already_served_today")).toBe(true);
  }, 120_000);

  it("still attaches the card for a user who did NOT ask", async () => {
    // The counter-case, and the one that stops this becoming "briefs never carry cards".
    const { scope } = await seed();
    await seedDigest(scope);
    const fields = await cardFieldsForTest({
      scope,
      now: NOW,
      timezone: TZ,
      log: () => {},
      cardFor: async () => ({
        url: "http://127.0.0.1:3043/cards/x/card_fresh.png?sig=x",
        kind: "standard" as const,
      }),
    });

    expect(fields.card_kind).toBe("standard");
    expect(fields.card_url).toContain("card_fresh");
  }, 120_000);
});

describe("a report request from a number we do not know", () => {
  it("is answered with silence, revealing nothing either way", async () => {
    // The same answer an unknown handle gets for anything else. Replying "I don't know
    // you" and replying "I don't have your history yet" are both confirmations that this
    // number is a service and that we do or do not hold an account for the sender.
    const channel = new StubChannel();
    const result = await handleInbound({
      inbound: inboundFrom("+15550000001", "send my friends report"),
      channel,
      now: NOW,
      renderCard: async () => ({ url: "http://x/card.png", kind: "standard" as const }),
    });

    expect(result.selection.kind).toBe("unknown_user");
    expect(channel.sent.length).toBe(0);
  }, 120_000);
});
