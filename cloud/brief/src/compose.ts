// digest + gists + draft bundles -> brief.v1
//
// **Ranking is acquisition; the brief is retention.** The card gets someone in the door
// once. What keeps them is three people, every morning, each with two drafts already
// written — and three is the number because twenty is a list and three is a habit.

import type { Brief, BriefItem, DraftBundle, Gist, Relationship } from "../../shared/src/index.js";
import { assessStaleness, type StalenessDecision } from "./staleness.js";

export const DEFAULT_MAX_ITEMS = 3;

/** `brief.v1.json` sets `maxItems: 3`. The env var can only lower it, never raise it. */
export function maxItems(): number {
  const configured = Number(process.env["BOI_BRIEF_MAX_ITEMS"] ?? DEFAULT_MAX_ITEMS);
  return Math.min(Number.isFinite(configured) ? configured : DEFAULT_MAX_ITEMS, DEFAULT_MAX_ITEMS);
}

const HEADLINE_MAX = 120;
const GIST_MAX = 140;

function clamp(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * The headline. Invitation, never verdict — CONTRACTS.md § 6.
 *
 * Every one of these is a sentence about the user or about the pair. None makes the
 * other person the subject of a verb, because a brief that says "Maya hasn't replied"
 * is making a claim about someone who never agreed to be measured, and it is also
 * usually wrong: the reason is nearly always something Boi cannot see.
 */
export function headlineFor(gist: Gist, display: string): string {
  const days = gist.days_silent;
  switch (gist.state) {
    case "action_needed":
      return clamp(
        gist.unanswered_question
          ? `${display} asked you something ${days} days ago`
          : `you left something open with ${display} ${days} days ago`,
        HEADLINE_MAX,
      );
    case "fading":
      return clamp(`you and ${display} haven't talked in ${days} days`, HEADLINE_MAX);
    case "birthday":
      return clamp(`${display}'s birthday is coming up`, HEADLINE_MAX);
    case "dormant":
      return clamp(`${days} days since you and ${display} talked`, HEADLINE_MAX);
    case "revived":
      return clamp(`you and ${display} started talking again`, HEADLINE_MAX);
  }
}

/**
 * The one-tap remedy. **Never a verdict without an action.**
 *
 * Guilt without agency is repellent; guilt with a button is a product. The return type
 * is the non-nullable enum from `brief.v1`, so an item cannot be built without one —
 * there is no code path here that yields null.
 */
export function remedyFor(gist: Gist): BriefItem["remedy"] {
  if (gist.state === "birthday") return "call";
  // A long silence is a call, not a text: at that distance a text is another thing to
  // reply to, and the whole problem is that neither of them replied.
  if (gist.state === "dormant" || gist.days_silent >= 90) return "call";
  return "reply";
}

export type ComposeInput = {
  user_id: string;
  scheduled_for: Date;
  now: Date;
  timezone: string;
  digest_as_of: Date;
  relationships: readonly Relationship[];
  gists: readonly Gist[];
  /** Keyed by `gist_id`. A gist with no bundle is a legitimate degraded item. */
  drafts: ReadonlyMap<string, DraftBundle>;
  card_url?: string | null;
};

export type ComposeResult = {
  brief: Brief;
  decision: StalenessDecision;
  /** Candidates considered but dropped by the cap, for the log line. */
  dropped: number;
};

export function composeBrief(input: ComposeInput): ComposeResult {
  const decision = assessStaleness({
    digest_as_of: input.digest_as_of,
    now: input.now,
    timezone: input.timezone,
  });

  const byContact = new Map(input.relationships.map((r) => [r.contact_id, r]));

  // Highest priority first. Ties broken by contact_id so the same input always yields
  // the same brief — a morning message that reorders itself between runs looks broken.
  const ranked = [...input.gists].sort(
    (a, b) => b.priority - a.priority || a.contact_id.localeCompare(b.contact_id),
  );

  const items: BriefItem[] = [];
  for (const gist of ranked) {
    if (items.length >= maxItems()) break;
    const relationship = byContact.get(gist.contact_id);
    // A gist about someone the digest does not know about cannot be rendered honestly:
    // there is no display name, and inventing one is fabrication.
    if (relationship === undefined) continue;

    const bundle = input.drafts.get(gist.gist_id) ?? null;

    items.push({
      contact_id: gist.contact_id,
      display: relationship.display,
      headline: headlineFor(gist, relationship.display),
      gist: clamp(gist.gist, GIST_MAX),
      remedy: remedyFor(gist),
      // `draft_bundle.v1` is exactly two candidates or exactly zero. Zero is a
      // legitimate degraded outcome, and it must reach the brief as `null` rather than
      // as an empty bundle — "no drafts" and "a bundle that happens to be empty" render
      // differently, and only one of them is honest.
      drafts: bundle !== null && bundle.candidates.length > 0 ? bundle : null,
    });
  }

  const eligible = ranked.filter((g) => byContact.has(g.contact_id)).length;

  const brief: Brief = {
    schema_version: "brief.v1",
    user_id: input.user_id,
    scheduled_for: input.scheduled_for.toISOString(),
    staleness: decision.staleness,
    items,
    card_url: input.card_url ?? null,
  };

  return { brief, decision, dropped: Math.max(0, eligible - items.length) };
}
