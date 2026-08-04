// Where a rendered card lives, and who is allowed to fetch it.
//
// Until prompt 05 the renderer returned PNG bytes and persisted none of them. The only
// `cardUrlFor` in the repo wrote to the end-to-end run's artifact directory and produced
// `file:///…/card.png`, which then travelled intact through `deliver.ts` into the channel
// as an image block. **No transport can fetch a `file://` URL**, so the acquisition loop
// was wired end to end and still could not reach a phone.
//
// Two properties this file exists to provide:
//
// **A URL something else can GET.** Not this process, not this machine's filesystem — a
// signed HTTP URL, because the card is the share artifact and has to survive being
// forwarded to somebody who has never heard of Boi.
//
// **A delete that reaches it.** `CONTRACTS.md` § 3: "Derived data outside Postgres counts.
// A rendered card at `briefs.card_url` is derived data; delete has to reach it too."
// `repository.ts` carried a comment saying nothing reached it and naming prompt 04 as the
// owner; prompt 04 wired the card into delivery and never closed it. Hosting and deletion
// therefore ship in the same commit — the gap is harmless exactly as long as nothing is
// stored, and this file is the thing that starts storing.
//
// **The layout is the contract between this service and the deleter**, deliberately:
//
//     <root>/<user_id>/<card_id>.png
//
// `repository.ts` removes `<root>/<user_id>` and verifies it is gone. It does not import
// this module and this module does not import it — they share a directory convention the
// way two services share a bucket name, which is what the production swap to object
// storage preserves. An import would make the legal guarantee depend on which module a
// given process happened to load.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * The root every card lives under. **Read at call time, never cached**: a test that sets
 * `BOI_CARD_DIR` after import must not be served a root captured at module load.
 */
export function cardRoot(): string {
  return process.env["BOI_CARD_DIR"] ?? "/tmp/boi-e/cards";
}

/**
 * The signing secret.
 *
 * Development default, and it is named as such: a card URL is a bearer capability, so a
 * predictable secret means anyone who can guess a `user_id` can read that user's card.
 * Production sets `BOI_CARD_SIGNING_SECRET`.
 */
export function signingSecret(): string {
  return process.env["BOI_CARD_SIGNING_SECRET"] ?? "dev-card-secret-change-me";
}

export type StoredCard = {
  user_id: string;
  card_id: string;
  file: string;
  bytes: number;
};

/** `card_<16 hex>`; one per render, so a new card never overwrites the shared one. */
export function newCardId(): string {
  return `card_${randomBytes(8).toString("hex")}`;
}

export function cardPath(userId: string, cardId: string): string {
  // Path traversal is the obvious way to turn a card server into a file server. Both
  // components are validated at the route, and joined here from basenames only.
  return path.join(cardRoot(), path.basename(userId), `${path.basename(cardId)}.png`);
}

export function putCard(userId: string, png: Buffer): StoredCard {
  const cardId = newCardId();
  const file = cardPath(userId, cardId);
  mkdirSync(path.dirname(file), { recursive: true });
  // 0600: the card is a picture of somebody's friendships, and the directory it lives
  // in is shared with whatever else runs on this box.
  writeFileSync(file, png, { mode: 0o600 });
  return { user_id: userId, card_id: cardId, file, bytes: png.length };
}

export function readCard(userId: string, cardId: string): Buffer | null {
  const file = cardPath(userId, cardId);
  if (!existsSync(file)) return null;
  return readFileSync(file);
}

/** Everything stored for one user, removed. Returns how many objects went. */
export function deleteCardsFor(userId: string): number {
  const dir = path.join(cardRoot(), path.basename(userId));
  if (!existsSync(dir)) return 0;
  const before = countCardsFor(userId);
  rmSync(dir, { recursive: true, force: true });
  return before;
}

/** What is left. Zero is the only acceptable answer after a delete. */
export function countCardsFor(userId: string): number {
  const dir = path.join(cardRoot(), path.basename(userId));
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith(".png")).length;
}

// ---------------------------------------------------------------------------
// Signed URLs
// ---------------------------------------------------------------------------

/**
 * The signature covers the path AND the expiry, together.
 *
 * Signing the path alone yields a link that never dies; signing the expiry alone lets
 * anyone move a valid signature onto another user's card. They are one string here for
 * the same reason a JWT signs its own claims.
 */
export function signCard(userId: string, cardId: string, expiresAt: number): string {
  return createHmac("sha256", signingSecret())
    .update(`${userId}/${cardId}/${expiresAt}`)
    .digest("hex");
}

export function verifyCardSignature(
  userId: string, cardId: string, expiresAt: number, signature: string, now = Date.now(),
): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 <= now) return false;
  const expected = Buffer.from(signCard(userId, cardId, expiresAt), "utf8");
  const given = Buffer.from(signature, "utf8");
  // Length-checked before `timingSafeEqual`, which throws rather than returning false
  // on a length mismatch — an exception here would be a 500 where a 401 belongs.
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/** Seven days: long enough to forward to a friend, short enough to expire. */
export const CARD_URL_TTL_SECONDS = 7 * 24 * 3600;

export function signedCardPath(
  userId: string, cardId: string, ttlSeconds = CARD_URL_TTL_SECONDS, now = Date.now(),
): string {
  const expiresAt = Math.floor(now / 1000) + ttlSeconds;
  const signature = signCard(userId, cardId, expiresAt);
  return `/cards/${userId}/${cardId}.png?exp=${expiresAt}&sig=${signature}`;
}

// ---------------------------------------------------------------------------
// Today's report card
// ---------------------------------------------------------------------------
//
// `send my friends report` is the ONE path a user can trigger as fast as they can type,
// and every trigger renders a 1080x1920 PNG. Two reasons to cache it, and the second
// matters more than the cost: **a card that changes between two requests four seconds
// apart is a card whose numbers nobody trusts.** The card's whole claim is that the user
// can check it against their own memory.
//
// It lives HERE, beside the PNG, rather than in a `report_cards` table. A table would be
// the obvious choice and it was the first attempt — but every user-data table in this
// schema must be hash-partitioned and seeded by `schema.test.ts`'s helper, which belongs
// to Track D, so a new table means an edit to another track's suite for a cache. Keeping
// it next to the artifact also means `deleteUser` already reaches it: the whole
// `<root>/<user_id>/` directory goes, pointer and PNG together, with no second thing to
// remember.
//
// Keyed on the LOCAL DAY rather than a TTL, because "your report for today" is what the
// card claims to be. A rolling 24-hour window hands somebody a card at 23:58 that is
// still called today's at 23:58 tomorrow.

export type TodaysCard = {
  day_key: string;
  card_id: string | null;
  card_url: string | null;
  kind: "standard" | "refusal";
  served_at: string;
};

function pointerPath(userId: string, dayKey: string): string {
  return path.join(cardRoot(), path.basename(userId), `report-${path.basename(dayKey)}.json`);
}

export function readTodaysCard(userId: string, dayKey: string): TodaysCard | null {
  const file = pointerPath(userId, dayKey);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as TodaysCard;
  } catch {
    // A truncated pointer is a cache miss, never a crash: the worst case is one extra
    // render, and the alternative is a user who cannot get their report at all.
    return null;
  }
}

export function writeTodaysCard(userId: string, card: TodaysCard): void {
  const file = pointerPath(userId, card.day_key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(card, null, 2)}\n`, { mode: 0o600 });
}
