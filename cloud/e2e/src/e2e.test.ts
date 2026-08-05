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
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { StubChannel } from "../../shared/src/index.js";
import { deliverBrief } from "../../brief/src/deliver.js";
import { countCardsFor, signCard } from "../../card/src/store.js";
import { closePool, deleteUser, listOutboundMessages } from "../../db/src/index.js";
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

/**
 * A renderer in ITS OWN PROCESS, for the whole file.
 *
 * `runEndToEnd` closes its in-process card server when the run ends, so a URL fetched
 * afterwards is dead — and fetching an in-process server proves nothing about a phone
 * anyway. This is a second OS process over a real socket, reading the same store off
 * disk, which is what "reachable by something that is not this process" has to mean.
 *
 * Port 3043: inside Track D's 3040-3049 block, dormant now that D has merged, and
 * deliberately not 3042 — a renderer somebody left running must not answer for this one.
 */
const CHILD_CARD_BASE = "http://127.0.0.1:3043";
let childRenderer: ReturnType<typeof spawn> | null = null;

/** The signed path from a card URL, re-pointed at the child renderer. */
function viaChild(cardUrl: string): string {
  const url = new URL(cardUrl);
  return `${CHILD_CARD_BASE}${url.pathname}${url.search}`;
}

/** Poll until the child renderer answers, or give up loudly rather than hang the suite. */
async function waitForServer(base: string, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fetch(`${base}/cards/usr_nobody/card_nothing.png`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`child card server never answered on ${base}`);
}

beforeAll(async () => {
  await acquireSuiteLock();
  await migrate();
  // Pinned BEFORE the child is spawned, and this is the bug it prevents: the child runs
  // under `vite-node`, which loads `.env`; this suite runs under `vitest`, which does not.
  // Left to themselves they sign and verify with different keys, and every fetch is a 401
  // that reads as a signature bug rather than as two processes disagreeing about a file.
  process.env["BOI_CARD_SIGNING_SECRET"] ??= randomBytes(32).toString("hex");
  process.env["BOI_CARD_WRITE_SECRET"] ??= randomBytes(24).toString("hex");
  childRenderer = spawn(
    process.execPath,
    [path.join(REPO_ROOT, "node_modules", "vite-node", "vite-node.mjs"),
      path.join(REPO_ROOT, "cloud", "card", "src", "main.ts")],
    { env: { ...process.env, CARD_PORT: "3043" }, stdio: "ignore" },
  );
  await waitForServer(CHILD_CARD_BASE);
}, TIMEOUT);

afterAll(async () => {
  childRenderer?.kill("SIGKILL");
  await releaseSuiteLock();
  await closePool();
});

describe("the whole pipe, end to end", () => {
  it("renders a REAL report card, not a refusal", async () => {
    // The kill test — "show 20 people the card, they screenshot it or they close it" —
    // is the stop condition both strategy documents name for the whole product, and
    // until the rich corpus existed this repo had never produced the artifact it needs.
    // Every card ever rendered here was `not_enough_ranked`.
    const result = await firstRun();
    expect(result.cardKind).toBe("standard");
    expect(result.cardUrl).not.toBeNull();
  }, TIMEOUT);

  it("hosts the card at a URL a DIFFERENT PROCESS can fetch, and refuses an unsigned one",
    async () => {
      const result = await firstRun();
      const url = result.cardUrl as string;

      // `file://` was the finding: it resolved on the machine that rendered it, no
      // transport on earth can fetch it, and the acquisition loop was therefore wired
      // end to end and unable to reach a phone.
      expect(url.startsWith("http://") || url.startsWith("https://")).toBe(true);

      // Fetched from a renderer this file started, in its own OS process, which never
      // rendered this card and shares only the store on disk. An in-process fetch would
      // prove nothing about a phone.
      const fetched = await fetch(viaChild(url));
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get("content-type")).toBe("image/png");
      const bytes = Buffer.from(await fetched.arrayBuffer());
      // A PNG by its magic number rather than by its extension.
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(bytes.length).toBeGreaterThan(10_000);

      // The URL is a bearer capability, so the signature has to be the thing carrying
      // it — not the obscurity of the path.
      const signed = new URL(viaChild(url));
      const unsigned = `${signed.origin}${signed.pathname}`;
      expect((await fetch(unsigned)).status).toBe(401);
      expect((await fetch(`${unsigned}?exp=99999999999&sig=deadbeef`)).status).toBe(401);

      // Expired, carrying a signature that was genuinely valid for that expiry — so
      // this fails on the clock rather than on the HMAC.
      const [, , userId, file] = signed.pathname.split("/");
      const cardId = (file ?? "").replace(/\.png$/, "");
      const past = Math.floor(Date.now() / 1000) - 60;
      const expired = signCard(userId as string, cardId, past);
      expect((await fetch(`${unsigned}?exp=${past}&sig=${expired}`)).status).toBe(401);

      // A valid signature moved onto another user's card. This is why the signed string
      // covers the user id and the card id together rather than the path alone.
      const moved = `${signed.origin}/cards/${userId}x/${file}${signed.search}`;
      expect((await fetch(moved)).status).toBe(401);
    }, TIMEOUT);

  it("never attaches a refusal card to a brief", async () => {
    // The policy, and it is a policy rather than a bug: "not enough history yet" is
    // information once, on the onboarding surface. Attached to a brief it arrives every
    // morning forever, which is a reproach — and it violates "never hand someone a bad
    // report and call it their year in messages".
    const result = await runEndToEnd({
      artifactRoot: ARTIFACT_ROOT, corpusProfile: "minimal", log: () => {},
    });

    expect(result.status).toBe("sent");
    expect(result.cardKind).toBe("refusal");
    expect(result.cardUrl).toBeNull();
    expect(result.briefs[0]?.card_kind).toBe("refusal");

    for (const message of result.outbound) {
      for (const block of message.blocks) expect(block.type).not.toBe("image");
    }
    // And the refusal was never stored, so there is no URL to leak and nothing to delete.
    expect(countCardsFor(result.scope.user_id)).toBe(0);
  }, TIMEOUT);

  it("drops a refusal card at the BLOCK level, even when one has a URL", async () => {
    // The end-to-end refusal test above cannot see this gate, and that is worth being
    // explicit about: a refusal card is never stored, so `card_url` is null, so no image
    // block appears whether or not `deliver.ts` checks the kind. Deleting the check
    // leaves that test green.
    //
    // So the policy is asserted here too, on the one input that can tell them apart: a
    // brief carrying BOTH a url and `card_kind: "refusal"`. Two independent guards, and
    // this is the one that bites if the store ever starts keeping refusals.
    const channel = new StubChannel();
    const base = {
      schema_version: "brief.v1" as const,
      user_id: "usr_refusalgate",
      scheduled_for: new Date().toISOString(),
      staleness: { digest_as_of: new Date().toISOString(), hours_stale: 1, warn: false },
      items: [{
        contact_id: "h_0000000000000001", display: "Ade Oyelaran",
        headline: "you left something open", gist: "50 days, no reply",
        remedy: "reply" as const, drafts: null,
      }],
      card_url: "http://127.0.0.1:3043/cards/usr_refusalgate/card_x.png?exp=1&sig=x",
    };

    await deliverBrief({ brief: { ...base, card_kind: "refusal" }, channel });
    expect(channel.sent.flatMap((m) => m.blocks).some((b) => b.type === "image")).toBe(false);

    // And the same brief with the same URL DOES carry the card when it is a real one,
    // so this is not passing because images are broken.
    const standard = new StubChannel();
    await deliverBrief({ brief: { ...base, card_kind: "standard" }, channel: standard });
    expect(standard.sent.flatMap((m) => m.blocks).some((b) => b.type === "image")).toBe(true);
  }, TIMEOUT);

  it("deletes the stored card when the user is deleted", async () => {
    // CONTRACTS.md section 3: derived data outside Postgres counts. `repository.ts`
    // carried "prompt 04 owns that" for a whole prompt while prompt 04 wired the card in
    // and never closed it. A residue check that only walks Postgres cannot see this.
    const result = await runEndToEnd({ artifactRoot: ARTIFACT_ROOT, log: () => {} });
    const url = viaChild(result.cardUrl as string);
    expect((await fetch(url)).status).toBe(200);
    // At least one: the brief's card, plus the report's if the run asked for one. The
    // assertion that matters is the one after the delete.
    expect(countCardsFor(result.scope.user_id)).toBeGreaterThanOrEqual(1);

    const deleted = await deleteUser(result.scope);
    expect(deleted.deleted).toBe(true);
    expect(deleted.verified_external).toContain("cards(filesystem)");

    // 404 rather than 200: the signature is still valid and the bytes are gone, which is
    // the only order that makes deletion mean anything.
    expect((await fetch(url)).status).toBe(404);
    expect(countCardsFor(result.scope.user_id)).toBe(0);
  }, TIMEOUT);

  it("puts the card in front of the user as an image block", async () => {
    const result = await firstRun();
    expect(result.status).toBe("sent");
    expect(result.outbound.length).toBeGreaterThan(0);

    // GAP 5. Asserted over the blocks `StubChannel` received — the stored `card_url`
    // below was already true on the run that found this, and the card still never left.
    // Scoped to the BRIEF's messages. Since prompt 09 the run also answers a report
    // request, which carries its own card — a count over every outbound would be
    // asserting "how many cards exist" rather than "did the brief carry one".
    const briefMessages = result.outbound.filter((m) =>
      m.idempotency_key.startsWith("brief-"));
    const images = briefMessages.flatMap((m) =>
      m.blocks.filter((b): b is { type: "image"; url: string; alt?: string | null } =>
        b.type === "image"),
    );
    expect(images.length, JSON.stringify(briefMessages)).toBe(1);
    expect(images[0]?.url).toBe(result.cardUrl);

    // It rides the LEAD, and it rides it before the line that leads into the items.
    //
    // Found by KEY rather than by position: since AMENDMENT-002 the channel's first
    // message is Boi's reply to the user's pairing text, so `outbound[0]` is no longer
    // the brief's lead. A positional assumption that was true when it was written and
    // false two prompts later.
    const lead = result.outbound.find((m) => m.idempotency_key.endsWith("-lead"));
    expect(lead, JSON.stringify(result.outbound.map((m) => m.idempotency_key))).toBeDefined();
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
    // No second BRIEF. The report intent legitimately answers again — a user may ask
    // twice and gets the cached card with "same card as earlier today" — so counting
    // every send would assert that the product ignores its own user.
    const secondLeads = second.outbound.filter((m) => m.idempotency_key.endsWith("-lead"));
    expect(secondLeads.length, JSON.stringify(second.outbound.map((m) => m.idempotency_key)))
      .toBe(0);

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

describe("the write route is not on the public prefix, and is authenticated anyway", () => {
  // The card is a named breakdown of one person's relationships, and the public hostname
  // is fronted by a tunnel whose ingress matches HOSTNAME AND PATH ONLY — a Go regex,
  // `^/cards/`, with no method matching. A write route sharing that prefix is forwarded by
  // the edge whatever verb it carries.
  //
  // So: it lives at `/internal/cards/:user_id`, which the existing rule excludes, AND it
  // checks a shared secret. Relying on the edge rule alone means a mistyped regex or a
  // deleted DNS record silently reopens an unauthenticated write into any user's card
  // directory, and nothing in the app would notice.

  const digest = () => JSON.parse(readFileSync(
    path.join(REPO_ROOT, "contracts", "fixtures", "digest", "healthy.json"), "utf8"));

  /**
   * A fresh id per run, because the card store is a DIRECTORY that outlives the process.
   *
   * The first version used a fixed `usr_writeprobe01` and asserted nothing had been
   * written — which was true until a falsification run disabled the auth check, stored a
   * card under that id, and left it there. The test then failed on the leftover rather
   * than on the behaviour, one run later and for a reason with no connection to what it
   * was asserting.
   */
  const probeUser = () => `usr_wp${randomBytes(5).toString("hex")}`;

  it("refuses a write with no secret, a wrong secret, and the old public path", async () => {
    const user = probeUser();
    const body = JSON.stringify(digest());
    const json = { "content-type": "application/json" };

    // No secret at all.
    const none = await fetch(`${CHILD_CARD_BASE}/internal/cards/${user}`, {
      method: "POST", headers: json, body,
    });
    expect(none.status).toBe(401);

    // A wrong one, same length as the real secret so this fails on the comparison rather
    // than on the length check.
    const real = process.env["BOI_CARD_WRITE_SECRET"] as string;
    const wrong = await fetch(`${CHILD_CARD_BASE}/internal/cards/${user}`, {
      method: "POST",
      headers: { ...json, "x-boi-card-write": "z".repeat(real.length) },
      body,
    });
    expect(wrong.status).toBe(401);

    // And the old path is gone from the server entirely, so the tunnel's `^/cards/` rule
    // has nothing to forward even if it were pointed at a POST.
    const oldPath = await fetch(`${CHILD_CARD_BASE}/cards/${user}`, {
      method: "POST", headers: json, body,
    });
    expect(oldPath.status).toBe(404);

    // Nothing was written by any of the three.
    expect(countCardsFor(user)).toBe(0);
  }, TIMEOUT);

  it("accepts the write with the secret, so the 401s above are not a broken route", async () => {
    const response = await fetch(`${CHILD_CARD_BASE}/internal/cards/${probeUser()}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-boi-card-write": process.env["BOI_CARD_WRITE_SECRET"] as string,
      },
      body: JSON.stringify(digest()),
    });
    expect([200, 201]).toContain(response.status);
    // The fixture digest is below the renderer's bar, so this is a refusal — which is
    // rendered and deliberately NOT stored.
    const card = (await response.json()) as { kind: string };
    expect(["standard", "refusal"]).toContain(card.kind);
  }, TIMEOUT);
});
