// Every string that can appear on the card, in one file, so the copy review the
// Definition of Done asks for is a thing you can actually do.
//
// THE RULE, from CONTRACTS.md § 6: **invitation, never verdict.**
// `"you've reached out to Sarah 12 times this month"`, never
// `"Sarah doesn't text you back"`. The difference is not politeness. The first is a
// fact about the user, who consented and is holding the phone; the second is a claim
// about somebody who never agreed to be measured. Snapchat built friend-ranking twice
// and suppressed it both times, and this is why.
//
// Two tests enforce what a comment cannot: `copy.test.ts` asserts every template here
// is second-person-about-the-user, and that no template can name a person as the
// SUBJECT of a verb. A string added below that breaks the rule fails the build.

/** The five names CONTRACTS.md fixes for `relationship.archetype`. */
export type Archetype =
  | "fade"
  | "chapter"
  | "one_way_enthusiasm"
  | "the_one_you_keep_waiting"
  | "rising_fastest";

/**
 * The archetype taxonomy, as it appears on the card.
 *
 * Named archetypes are what people post, because posting one says something about the
 * poster. That is also exactly why each label has to describe a SHAPE rather than a
 * person's failing: "the fade" is a thing that happens to two people, and "the chapter"
 * is a thing that closes. Neither blames whoever is standing on the other side of it.
 */
export const ARCHETYPE_LABEL: Record<Archetype, string> = {
  fade: "the fade",
  chapter: "a chapter",
  one_way_enthusiasm: "one-way enthusiasm",
  the_one_you_keep_waiting: "the one you keep waiting",
  rising_fastest: "rising fastest",
};

/**
 * The line under each archetype. Second person, about the user, every time.
 *
 * `one_way_enthusiasm` is the one that wants to become a verdict — the honest reading
 * of the data is "they don't reply" — so it is deliberately phrased as the user's own
 * behaviour: you are the one reaching, which is a fact about you.
 */
export const ARCHETYPE_LINE: Record<Archetype, string> = {
  fade: "you used to talk every week",
  chapter: "this one had its season",
  one_way_enthusiasm: "you've been the one reaching out",
  the_one_you_keep_waiting: "you take longest to reply here",
  rising_fastest: "you're talking more than ever",
};

export const CARD_TITLE = "your year in messages";

/** The judgmental number. Specific, about the user's own circle, instantly quotable. */
export function quietHeadline(gone: number, ranked: number): string {
  const pct = Math.round((gone / ranked) * 100);
  return `${pct}%`;
}

export function quietCaption(gone: number, ranked: number): string {
  return `of your ${ranked} closest friendships went quiet this year`;
}

/**
 * The honest alternative for a corpus too thin to say anything about.
 *
 * NEVER hand someone a bad report and call it their year in messages. A card built
 * from nineteen people and four hundred messages would look exactly as authoritative
 * as one built from four hundred and twenty-two people and eighty-four thousand — same
 * layout, same confident percentage — and the number would be noise. Degrade, never
 * fabricate.
 */
export const THIN_TITLE = "not enough history yet";
export const THIN_BODY = [
  "Boi needs more of your message history",
  "before it can tell you anything true.",
];
export const THIN_HINT = "check Settings › Messages › Keep Messages";

export const FOOTER = "boi";

/** Everything above, flattened. The copy-review test iterates this. */
export function allCopyStrings(): string[] {
  return [
    CARD_TITLE,
    ...Object.values(ARCHETYPE_LABEL),
    ...Object.values(ARCHETYPE_LINE),
    quietCaption(10, 25),
    THIN_TITLE,
    ...THIN_BODY,
    THIN_HINT,
    FOOTER,
  ];
}
