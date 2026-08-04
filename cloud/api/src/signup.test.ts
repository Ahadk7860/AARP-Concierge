// US-only at launch, which is one regex character and a legal invariant.
//
// Both strategy documents say it in the same words: "US only at launch. GDPR grants
// non-users rights we structurally cannot fulfill." Boi holds abstractions about people
// who never signed up to anything — a counterparty in the EU has a right to erasure over
// data derived from their messages, and we cannot honour it by construction, because we
// cannot identify them. `signup.ts` validated `/^\+[1-9][0-9]{6,14}$/`, which is every
// country on earth, and there was no geo gate anywhere else either.
//
// A separate file from `pairing.test.ts`, which is Track D's: this is the amendment's
// grant and it should be readable on its own at merge.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

import { StubChannel } from "../../shared/src/index.js";
import {
  acquireSuiteLock,
  closePool,
  deleteUser,
  findUserIdByPhone,
  migrate,
  releaseSuiteLock,
} from "../../db/src/index.js";
import { buildServer } from "./server.js";
import { allowedCountryCodes, countryCodeAllowed } from "./routes/signup.js";
import { firstSyncOffer } from "./welcome.js";
import { parseReportRequest } from "../../brief/src/inbound.js";

let app: FastifyInstance;

beforeAll(async () => {
  await acquireSuiteLock();
  await migrate();
  app = buildServer({ channel: new StubChannel() });
}, 120_000);

afterAll(async () => {
  await app.close();
  await releaseSuiteLock();
  await closePool();
});

async function signup(phone: string): Promise<{ status: number; body: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/signup",
    payload: { phone_e164: phone, accept_terms: true },
  });
  return { status: response.statusCode, body: response.body };
}

describe("signup is US-only at launch", () => {
  it("rejects a valid non-US number, with a message that says why", async () => {
    // +44 is a perfectly well-formed E.164 number. It is the geography that is refused,
    // and the two failures have to read differently or a UK user is told their phone
    // number is malformed.
    const uk = await signup("+447700900123");
    expect(uk.status).toBe(400);
    expect(uk.body).toContain("US-only");

    // And no account was created on the way to the rejection.
    expect(await findUserIdByPhone("+447700900123")).toBeNull();
  });

  it("rejects every other country the same way", async () => {
    for (const phone of ["+33612345678", "+4915112345678", "+819012345678", "+61412345678"]) {
      const result = await signup(phone);
      expect(result.status, phone).toBe(400);
    }
  });

  it("still accepts a US number, so this is not just a broken signup", async () => {
    const phone = `+1557${String(1_000_000 + Math.floor(Math.random() * 900_000)).slice(-7)}`;
    const result = await signup(phone);
    expect([200, 201, 202]).toContain(result.status);
    const scope = await findUserIdByPhone(phone);
    expect(scope).not.toBeNull();
    if (scope !== null) await deleteUser(scope);
  });

  it("keeps a malformed number's message about the FORMAT, not the geography", async () => {
    const result = await signup("+1555");
    expect(result.status).toBe(400);
    expect(result.body).toContain("E.164");
  });

  it("takes the launch geography from config, not from a literal", async () => {
    // Adding Canada is an env change; adding the UK is an env change plus a lawyer. A
    // hard-coded `+1` would make the next one a code change and a release.
    const saved = process.env["BOI_ALLOWED_COUNTRY_CODES"];
    try {
      expect(allowedCountryCodes()).toEqual(["1"]);
      expect(countryCodeAllowed("+447700900123")).toBe(false);

      process.env["BOI_ALLOWED_COUNTRY_CODES"] = "1,44";
      expect(countryCodeAllowed("+447700900123")).toBe(true);
      expect(countryCodeAllowed("+33612345678")).toBe(false);

      // Garbage in the variable must not silently open the gate to everyone.
      process.env["BOI_ALLOWED_COUNTRY_CODES"] = "; drop table users, ++, ";
      expect(allowedCountryCodes()).toEqual([]);
      expect(countryCodeAllowed("+15551234567")).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["BOI_ALLOWED_COUNTRY_CODES"];
      else process.env["BOI_ALLOWED_COUNTRY_CODES"] = saved;
    }
  });
});

describe("the first sync offers the report", () => {
  // Prompt 09's other end. Until this existed the earliest a new user could see their
  // report was 8am tomorrow — and people are most curious in the ninety seconds after
  // their history finishes loading, not the next morning.

  it("says the corpus size, where it stayed, and the exact phrase to text back", () => {
    const offer = firstSyncOffer("usr_firstsync001", {
      corpus: { message_count: 83887, thread_count: 422 },
    });
    const said = offer.blocks.map((b) => (b.type === "text" ? b.text : "")).join(" ");

    // The size is the first evidence anything happened on their machine, and it is
    // checkable against their own sense of how much they text.
    expect(said).toContain("83,887");
    expect(said).toContain("422");
    // The sentence the architecture exists to earn.
    expect(said).toContain("stayed on your mac");
    // PRINTED, not hinted at. "Just ask me for your report" is a guessing game.
    expect(said).toContain("send my friends report");
  });

  it("is keyed so a re-uploading Mac cannot make it arrive twice", () => {
    expect(firstSyncOffer("usr_firstsync001", {}).idempotency_key).toBe("firstsync-usr_firstsync001");
  });

  it("is the phrase the matcher actually accepts", () => {
    // The two halves of this requirement live in different packages, and the failure is
    // silent in both directions: a phrase nobody matches, or a matcher for a phrase
    // nobody was given.
    const offer = firstSyncOffer("usr_firstsync001", {});
    const phrase = /text me: (.+)$/m.exec(
      offer.blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n"),
    );
    expect(phrase).not.toBeNull();
    expect(parseReportRequest(phrase![1] as string)).toBe(true);
  });
});
