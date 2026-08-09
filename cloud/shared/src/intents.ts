// cloud/shared/src/intents.ts — frozen intent keys for the router and precompute cache.
//
// These strings are shared between the router (Track B), the precompute cache (Track G),
// and the precomputed_answers.intent column. They are FROZEN per V3_ARCHITECTURE.md §4.2a.
// Neither session may rename, add, or remove one without editing that section and logging
// it in INTERFACES.md.
//
// Created by Track G. Track B imports it and does not edit it.

export const INTENTS = [
  "waiting_on_me",   // who is waiting on a reply from me
  "drifting",        // relationships past their expected gap
  "overdue",         // open loops aged past threshold
  "morning_brief",   // the daily summary
] as const;

export type Intent = typeof INTENTS[number];
