// The runner, asserted.
//
// `npm run e2e` prints a seam report a human reads. This file is the part a machine reads,
// and every assertion in it is deliberately made on **what the channel received** rather
// than on what the pipe stored.
//
// That distinction is not stylistic. Prompt `04`'s original criterion said the brief must
// carry "a `card_url` that resolves", and it did — in the stored `brief.v1`, on a real run,
// while `deliverBrief` emitted text blocks only and the card never reached a user. The
// renderer was green, the compose edge was green, the artifact was green, and the entire
// acquisition loop was absent. An artifact that cannot show a defect is not evidence.
//
// These are slow — each `runEndToEnd` is a Swift build, a synthetic corpus, a migration, a
// real HTTP upload and two Python subprocesses. The first run is memoized rather than
// repeated; nothing here depends on test ordering.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";

import { closePool, listOutboundMessages } from "../../db/src/index.js";
import { migrate } from "../../db/src/migrate.js";
import { acquireSuiteLock, releaseSuiteLock } from "../../db/src/test-lock.js";
import { REPO_ROOT, runEndToEnd, type E2EResult } from "./run.js";

const ARTIFACT_ROOT = path.join(REPO_ROOT, "cloud", "e2e", "runs", "test");
const TIMEOUT = 900_000;

/** The full pipe, run once for every test that needs a healthy one. */
let firstRunPromise: Promise<E2EResult> | null = null;
function firstRun(): Promise<E2EResult> {
  firstRunPromise ??= runEndToEnd({ artifactRoot: ARTIFACT_ROOT, log: () => {} });
  return firstRunPromise;
}

beforeAll(async () => {
  await acquireSuiteLock();
  await migrate();
}, TIMEOUT);

afterAll(async () => {
  await releaseSuiteLock();
  await closePool();
});

describe("the whole pipe, end to end", () => {
  it("puts the card in front of the user as an image block", async () => {
    const result = await firstRun();
    expect(result.status).toBe("sent");
    expect(result.outbound.length).toBeGreaterThan(0);

    // GAP 5. Asserted over the blocks `StubChannel` received — the stored `card_url`
    // below was already true on the run that found this, and the card still never left.
    const images = result.outbound.flatMap((m) =>
      m.blocks.filter((b): b is { type: "image"; url: string; alt?: string | null } =>
        b.type === "image"),
    );
    expect(images.length, JSON.stringify(result.outbound)).toBe(1);
    expect(images[0]?.url).toBe(result.cardUrl);

    // It rides the LEAD, and it rides it before the line that leads into the items.
    const lead = result.outbound[0];
    const imageIndex = lead!.blocks.findIndex((b) => b.type === "image");
    const framingIndex = lead!.blocks.findIndex(
      (b) => b.type === "text" && /worth a message today/.test(b.text));
    expect(imageIndex).toBeGreaterThanOrEqual(0);
    expect(imageIndex).toBeLessThan(framingIndex);

    // And the stored brief agrees. This is the assertion that used to stand alone, and
    // on its own it was satisfied by a product with no acquisition loop at all.
    expect(result.briefs[0]?.card_url).toBe(result.cardUrl);
  }, TIMEOUT);

  it("keeps one contact_id across the digest, the gists, the drafts and the brief", async () => {
    const result = await firstRun();
    const brief = result.briefs[0];
    expect(brief).toBeDefined();
    expect(brief!.items.length).toBeGreaterThan(0);
    expect(brief!.items.length).toBeLessThanOrEqual(3);

    const gistByContact = new Map(result.gists.map((g) => [g.contact_id, g]));
    for (const item of brief!.items) {
      // The digest half: `composeBrief` drops any gist whose contact the digest does not
      // carry, so an item existing at all means the Mac's digest named this contact.
      const gist = gistByContact.get(item.contact_id);
      expect(gist, `no gist for ${item.contact_id}`).toBeDefined();
      expect(item.gist).toBe(gist!.gist);

      // The drafts half. `fake` cannot draft for a gist the producer just made — it
      // replays on four hard-coded fixture ids — so a default run legitimately has none,
      // and this asserts the JOIN rather than the presence. With
      // `BOI_MODEL_PROVIDER=gemini` the same line covers real candidates.
      if (item.drafts !== null) {
        expect(item.drafts.contact_id).toBe(item.contact_id);
        expect(item.drafts.gist_id).toBe(gist!.gist_id);
        expect(item.drafts.candidates.length).toBe(2);
      }
    }

    // Whatever the bridge produced was for these people and nobody else.
    for (const bundle of result.drafts) {
      expect(gistByContact.has(bundle.contact_id)).toBe(true);
    }
  }, TIMEOUT);

  it("sends once when it runs twice against the same database", async () => {
    const first = await firstRun();
    const before = await listOutboundMessages(first.scope);
    expect(before.length).toBeGreaterThan(0);

    // The same account, the same morning slot, a second full pass — including a second
    // real `boi-cli sync-run` and a second digest upload. Track D's idempotency has only
    // ever been exercised by a unit test; this is the first time a second real run has
    // reached it.
    const second = await runEndToEnd({
      artifactRoot: ARTIFACT_ROOT,
      reuseScope: first.scope,
      log: () => {},
    });

    expect(second.status).toBe("already_sent");
    expect(second.sent, JSON.stringify(second.outbound)).toBe(0);

    // Nothing new in the outbox either, so this is not passing because a fresh channel
    // simply had not been used yet.
    const after = await listOutboundMessages(first.scope);
    expect(after.length).toBe(before.length);
    expect(after.map((r) => r.idempotency_key).sort())
      .toEqual(before.map((r) => r.idempotency_key).sort());
  }, TIMEOUT);

  it("still sends the brief when the renderer is down, with card_url null", async () => {
    // A renderer that is down costs the card and not the morning. The card is the
    // acquisition loop; the brief is the product, and a missing morning text is the thing
    // the user actually notices.
    const result = await runEndToEnd({
      artifactRoot: ARTIFACT_ROOT,
      withoutCard: true,
      log: () => {},
    });

    expect(result.status).toBe("sent");
    expect(result.sent).toBeGreaterThan(0);
    expect(result.cardUrl).toBeNull();
    expect(result.briefs[0]?.card_url ?? null).toBeNull();

    // No card, and no gesture at one: no image block, no bare URL in a text block.
    for (const message of result.outbound) {
      for (const block of message.blocks) {
        expect(block.type).not.toBe("image");
        if (block.type === "text") expect(block.text).not.toContain("card.png");
      }
    }
  }, TIMEOUT);
});
