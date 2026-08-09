// STUB for cloud/shared/src/intents.ts (V3_ARCHITECTURE.md §4.2a), which does not exist
// yet — it is created by the parallel DeepSeek session (Track G0) and imported, never
// hand-authored, by Track B. Do NOT create cloud/shared/src/intents.ts from this session;
// that path belongs to them.
//
// This stub mirrors the frozen §4.2a contents EXACTLY so the swap is a one-line import
// change once the real file lands:
//
//   - import { INTENTS, type Intent } from "./intents-stub.js";
//   + import { INTENTS, type Intent } from "../../shared/src/intents.js";
//
// Never hand-write these strings anywhere else in this track — a renamed key here is a
// silent permanent cache miss against `precomputed_answers.intent`.

export const INTENTS = [
  "waiting_on_me", // who is waiting on a reply from me
  "drifting", // relationships past their expected gap
  "overdue", // open loops aged past threshold
  "morning_brief", // the daily summary
] as const;

export type Intent = typeof INTENTS[number];
