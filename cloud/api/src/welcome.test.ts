// The onboarding surface: the token, the deep link, and what the first reply carries.
//
// These are pure functions and the assertions are cheap, which is exactly why they are
// worth writing: every one of them encodes a decision AMENDMENT-002 made, and the way
// they get lost is somebody "simplifying" a link builder that looks like string
// concatenation.

import { describe, expect, it } from "vitest";

import {
  PAIRING_SECRET,
  boiHandle,
  newPairingToken,
  pairingDeepLink,
  smsDeepLink,
  welcomeMessage,
} from "./welcome.js";

describe("the pairing token", () => {
  it("looks like plumbing rather than like a secret", () => {
    // It lives in the thread forever and the user rereads it every time they scroll up.
    // A user who believes they leaked a credential has had a bad experience whether or
    // not they did.
    for (let i = 0; i < 200; i += 1) {
      const token = newPairingToken();
      expect(token).toMatch(/^boi-[0-9a-f]{6}$/);
      expect(token.length).toBe(10);
    }
  });

  it("is drawn fresh every time", () => {
    // Not an entropy assertion — entropy is not what protects this. It is an assertion
    // that the generator is a generator: a constant would pair every user with the first
    // one's token and nothing else in the system would notice.
    const draws = new Set(Array.from({ length: 500 }, () => newPairingToken()));
    expect(draws.size).toBeGreaterThan(400);
  });

  it("matches the shape the database constraint accepts", () => {
    // Migration 009 widened `pairing_codes` to six digits OR `boi-` + six hex. A
    // generator that drifted from the constraint would fail at issue time, in
    // production, on the first signup after deploy.
    expect(PAIRING_SECRET.test(newPairingToken())).toBe(true);
    expect(PAIRING_SECRET.test("418293")).toBe(true);
    expect(PAIRING_SECRET.test("boi-4F2A91")).toBe(false);
    expect(PAIRING_SECRET.test("boi-zzzzzz")).toBe(false);
  });
});

describe("the deep link", () => {
  it("targets the user's own line and carries the prefilled body", () => {
    const link = pairingDeepLink({ handle: "+15551234567", token: "boi-4f2a91" });
    expect(link).toBe("sms:+15551234567&body=boi-4f2a91");
  });

  it("is built from a PARAMETER, never from the constant handle", () => {
    // The shared pool means the number differs per recipient. A link built from
    // `boiHandle()` would open a thread with a line that is not theirs — the message
    // would land in a stranger's conversation or nowhere, and the user would have done
    // everything right.
    const link = pairingDeepLink({ handle: "+15559998888", token: "boi-000001" });
    expect(link).not.toContain(boiHandle());
    expect(link).toContain("+15559998888");
  });

  it("escapes the body rather than trusting it", () => {
    const link = pairingDeepLink({ handle: "+15551234567", token: "a b&c=d" });
    expect(link).toBe("sms:+15551234567&body=a%20b%26c%3Dd");
  });

  it("still offers the bare link for the fallback flow", () => {
    // The amendment's fallback if the filter test had failed was the old flow PLUS the
    // deep link, so the unprefilled form keeps working.
    expect(smsDeepLink("+15551234567")).toBe("sms:+15551234567");
  });
});

describe("the retired cold open", () => {
  it("still conforms to the frozen fixture", () => {
    // `welcomeMessage` is no longer sent by anything. It stays because
    // `contracts/fixtures/outbound/first_contact_card.json` is FROZEN and this is what
    // conforms to it — deleting the producer would leave a fixture nothing can build.
    const message = welcomeMessage("usr_test00000001");
    expect(message.blocks.map((b) => b.type)).toEqual(["text", "contact_card"]);
    expect(message.idempotency_key).toBe("welcome-usr_test00000001");
  });
});
