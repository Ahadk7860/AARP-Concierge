// The placeholder-handle guard, at its edges.
//
// This exists because a hand-seeded user carried `+15550009998`: the digest ingested
// cleanly and returned 202, and the failure only appeared at the first inbound text,
// where the REAL number resolved to a different, empty user. The guard names that at
// upload time instead.
//
// It must be narrow. A false positive here would accuse a real user's number of being
// fake, and the suite's own fixtures use the reserved ranges on purpose.

import { describe, it, expect } from "vitest";
import { unroutableHandle } from "./routes/ingest.js";
import type { UserScope } from "../../db/src/index.js";

const scope = { user_id: "usr_test000000001" } as UserScope;

/** A db stub that answers `getUser` with one phone number. */
function dbWith(phone: string | null) {
  return { query: async () => ({ rows: phone === null ? [] : [{ phone_e164: phone }] }) } as never;
}

describe("unroutable handles", () => {
  it("names area code 555 — the seeded placeholder that caused this", async () => {
    expect(await unroutableHandle(scope, dbWith("+15550009998"))).toBe("+15550009998");
  });

  it("names the 555-01xx block reserved for fiction", async () => {
    expect(await unroutableHandle(scope, dbWith("+14155550142"))).toBe("+14155550142");
    expect(await unroutableHandle(scope, dbWith("+14155550199"))).toBe("+14155550199");
  });

  it("passes a real number, including one with 555 outside the reserved block", async () => {
    // 555-0200 is assignable. Flagging it would call a real person's number fake.
    expect(await unroutableHandle(scope, dbWith("+15108906637"))).toBeNull();
    expect(await unroutableHandle(scope, dbWith("+14155550200"))).toBeNull();
    expect(await unroutableHandle(scope, dbWith("+16465792868"))).toBeNull();
  });

  it("passes non-NANP numbers rather than guessing at their conventions", async () => {
    expect(await unroutableHandle(scope, dbWith("+447570570836"))).toBeNull();
  });

  it("passes when the user is absent, because that is a different failure", async () => {
    expect(await unroutableHandle(scope, dbWith(null))).toBeNull();
  });
});
