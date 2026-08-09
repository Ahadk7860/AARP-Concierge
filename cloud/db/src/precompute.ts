// Precompute cache — compute answers at sync time so the cache-hit path
// is <800ms with no agent turn at all.
//
// Track G. Uses the repository functions from Track E and the frozen intent
// keys from cloud/shared/src/intents.ts.

import type { UserScope } from "./scope.js";
import type { Queryable } from "./pool.js";
import { getPool } from "./pool.js";
import {
  relationshipsWaitingOnMe,
  relationshipsDrifting,
} from "./repository.js";
import {
  getOpenLoops,
  setPrecomputedAnswer,
} from "./repository-v3.js";
import { INTENTS, type Intent } from "../../shared/src/intents.js";

export type PrecomputedBlock = { type: "text"; text: string };
export type PrecomputedAnswer = { blocks: PrecomputedBlock[]; evidence: Array<{ source: string; id: string }> };

/** Compute and store answers for all frozen intents. Call at the end of a sync. */
export async function precomputeAll(
  scope: UserScope,
  db: Queryable = getPool(),
): Promise<void> {
  await Promise.all(INTENTS.map((intent) => precomputeOne(scope, intent, db)));
}

async function precomputeOne(
  scope: UserScope,
  intent: Intent,
  db: Queryable,
): Promise<void> {
  let answer: PrecomputedAnswer;
  switch (intent) {
    case "waiting_on_me": {
      const rows = await relationshipsWaitingOnMe(scope, 20, db);
      const blocks: PrecomputedBlock[] = rows.length === 0
        ? [{ type: "text", text: "no one is waiting on a reply right now." }]
        : rows.map((r) => ({
            type: "text" as const,
            text: `${r.display} — last messaged ${r.days_since_last_contact} days ago`,
          }));
      answer = { blocks, evidence: rows.map((r) => ({ source: "relationships", id: r.contact_id })) };
      break;
    }
    case "drifting": {
      const rows = await relationshipsDrifting(scope, 20, db);
      const blocks: PrecomputedBlock[] = rows.length === 0
        ? [{ type: "text", text: "all your relationships are within their expected cadence." }]
        : rows.map((r) => ({
            type: "text" as const,
            text: `${r.display} — ${r.overdue_by_days} days past expected gap`,
          }));
      answer = { blocks, evidence: rows.map((r) => ({ source: "relationships", id: r.contact_id })) };
      break;
    }
    case "overdue": {
      const loops = await getOpenLoops(scope, { direction: "they_owe_me", limit: 20 }, db);
      const blocks: PrecomputedBlock[] = loops.length === 0
        ? [{ type: "text", text: "no open loops are overdue." }]
        : loops.map((l: typeof loops[number]) => ({
            type: "text" as const,
            text: `${l.display}: ${l.description} (${l.age_days}d open)`,
          }));
      answer = { blocks, evidence: loops.map((l: typeof loops[number]) => ({ source: "open_loops", id: l.loop_id })) };
      break;
    }
    case "morning_brief": {
      const [waiting, drifting, loops] = await Promise.all([
        relationshipsWaitingOnMe(scope, 5, db),
        relationshipsDrifting(scope, 5, db),
        getOpenLoops(scope, { limit: 5 }, db),
      ]);
      const blocks: PrecomputedBlock[] = [
        { type: "text", text: `morning. ${waiting.length} people waiting on you, ${drifting.length} relationships drifting, ${loops.length} open loops.` },
      ];
      answer = { blocks, evidence: [] };
      break;
    }
  }
  await setPrecomputedAnswer(scope, { intent, answer }, db);
}

/** Invalidate all precomputed answers for a user. Call after digest ingest. */
export async function invalidatePrecomputed(
  scope: UserScope,
  db: Queryable = getPool(),
): Promise<void> {
  await db.query(
    `delete from precomputed_answers where user_id = $1`,
    [scope.user_id],
  );
}
