// digest.v1 -> the handful of values the card is allowed to show.
//
// Deliberately a separate step from rendering. Everything judgemental happens here, in
// plain data that a test can assert on, rather than being computed inside an SVG
// template string where the only way to check it is to look at a picture.

import type { Digest, Relationship } from "../../shared/src/index.js";
import {
  ARCHETYPE_LABEL,
  ARCHETYPE_LINE,
  quietCaption,
  quietHeadline,
  type Archetype,
} from "./copy.js";

export type CardArchetype = {
  archetype: Archetype;
  label: string;
  line: string;
  display: string;
};

export type CardModel =
  | {
      kind: "card";
      headline: string;
      caption: string;
      /** The two numbers the headline is derived from, so a test can recompute it. */
      gone_quiet: number;
      ranked: number;
      archetypes: CardArchetype[];
      as_of: string;
    }
  | {
      kind: "refusal";
      /** Why there is no card. Shown to the user, not swallowed. */
      reason: "thin_corpus" | "not_enough_ranked" | "no_archetypes";
      as_of: string;
    };

/** Names longer than this are truncated with an ellipsis rather than overflowing. */
export const MAX_NAME_CHARS = 18;

export function truncateName(display: string): string {
  const trimmed = display.trim();
  if (trimmed.length === 0) return "—";
  if (trimmed.length <= MAX_NAME_CHARS) return trimmed;
  // `- 1` leaves room for the ellipsis, so the result is never wider than the budget.
  return `${trimmed.slice(0, MAX_NAME_CHARS - 1)}…`;
}

/**
 * The card shows at most this many archetypes. Four fits the 9:16 frame with the
 * headline; a fifth pushes the footer off the bottom.
 */
export const MAX_ARCHETYPES = 4;

/**
 * Which archetypes to show, in a deterministic order.
 *
 * Sorted by the taxonomy order and then by `contact_id`, NOT by anything that could be
 * read as a ranking of people. `message_count` descending would be a leaderboard, and
 * a leaderboard attaches a number to a human being — out of scope for this prompt, and
 * the thing Snapchat suppressed twice.
 */
const TAXONOMY_ORDER: Archetype[] = [
  "fade",
  "the_one_you_keep_waiting",
  "one_way_enthusiasm",
  "chapter",
  "rising_fastest",
];

function isArchetype(v: Relationship["archetype"]): v is Archetype {
  return v !== null && v in ARCHETYPE_LABEL;
}

export function buildCardModel(digest: Digest): CardModel {
  const as_of = digest.corpus.as_of;

  // A corpus the Mac itself called `thin` cannot support a confident percentage. The
  // card would look exactly as authoritative as a real one, which is the failure.
  if (digest.corpus.health === "thin") {
    return { kind: "refusal", reason: "thin_corpus", as_of };
  }

  const whole = digest.whole_life as { relationships_gone_quiet?: unknown; relationships_ranked?: unknown };
  const gone = typeof whole.relationships_gone_quiet === "number" ? whole.relationships_gone_quiet : null;
  const ranked = typeof whole.relationships_ranked === "number" ? whole.relationships_ranked : null;

  // "40% of your 25 closest friendships" needs a denominator worth quoting. Below ten
  // ranked relationships the percentage swings by more than ten points per person, so
  // it is a number that sounds precise and is not.
  if (gone === null || ranked === null || ranked < 10) {
    return { kind: "refusal", reason: "not_enough_ranked", as_of };
  }

  const seen = new Set<Archetype>();
  const archetypes: CardArchetype[] = [];
  for (const type of TAXONOMY_ORDER) {
    const matches = digest.relationships
      .filter((r) => isArchetype(r.archetype) && r.archetype === type)
      .sort((a, b) => a.contact_id.localeCompare(b.contact_id));
    const first = matches[0];
    if (first === undefined || seen.has(type)) continue;
    seen.add(type);
    archetypes.push({
      archetype: type,
      label: ARCHETYPE_LABEL[type],
      line: ARCHETYPE_LINE[type],
      display: truncateName(first.display),
    });
    if (archetypes.length === MAX_ARCHETYPES) break;
  }

  // The archetypes are the half of the card people post. Without them it is one
  // percentage on a black background, which is not a thing anyone screenshots.
  if (archetypes.length < 2) {
    return { kind: "refusal", reason: "no_archetypes", as_of };
  }

  return {
    kind: "card",
    headline: quietHeadline(gone, ranked),
    caption: quietCaption(gone, ranked),
    gone_quiet: gone,
    ranked,
    archetypes,
    as_of,
  };
}
