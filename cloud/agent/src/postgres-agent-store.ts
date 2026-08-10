// Postgres-backed `AgentStore` — the real implementation behind the storage-agnostic
// interface in ports.ts, now that Track E's tables (persons, identities, interactions,
// open_loops, relationship_metrics_daily, relationship_edges, memories,
// precomputed_answers — see cloud/db/migrations/017 and 019) exist.
//
// Everything here keys on `person_id`, never `contact_id` — this deliberately does NOT
// read the old contact_id-keyed `relationships` table (repository.ts's
// upsertRelationships/listRelationships/relationshipsDrifting/relationshipByContactId),
// which belongs to the live selector/reply/waiting-on-me path (cloud/phase2-runtime,
// cloud/inbound) and is out of scope for this file to touch or depend on.
//
// HONEST GAP, stated once here rather than silently: `RelationshipStateOutput` has
// `lifecycle_stage` and `relationship_kind` fields, but no v3 table (persons,
// relationship_metrics_daily) has a column for either — those are cache columns Track E
// only added to the OLD `relationships` table (migration 020), not the new person_id-keyed
// ones. Rather than fabricate a value or silently reach into the old table (which would
// reintroduce a contact_id dependency), this store always returns `null` for both. Callers
// get an honest "we don't know" instead of a made-up answer. `expected_gap_days` is read
// from `relationship_metrics_daily.median_gap_days` (the closest available proxy) and
// `overdue_by_days` is derived from it plus the most recent `interactions` row for that
// person — also computed, not read from a column, since none exists at the person_id
// level.
//
// SQL lives here, not in tools.ts (constraint: no SQL leak into the tool registry) and not
// in cloud/db (this file only imports from there — Track B does not own cloud/db/**). The
// handful of reads below (relationship state, drifting, circle, resolvePerson) have no
// existing repository-v3.ts function to call, so they're written directly against
// `scopedQuery`/`getPool`, the same primitives repository-v3.ts itself uses.

import type { Queryable } from "../../db/src/pool.js";
import { getPool } from "../../db/src/pool.js";
import { scopedQuery, type UserScope } from "../../db/src/scope.js";
import { newMemoryId } from "../../db/src/ids.js";
import { getOpenLoops, insertMemory, searchMemories } from "../../db/src/repository-v3.js";
import type { AgentStore } from "./ports.js";
import type {
  CircleConnectionRow,
  DriftingRow,
  MemoryRow,
  OpenLoopRow,
  RelationshipStateInput,
  RelationshipStateOutput,
} from "./types.js";

const MS_PER_DAY = 86_400_000;

type RelationshipStateSqlRow = {
  person_id: string;
  display: string;
  momentum: number | null;
  initiation_ratio: number | null;
  expected_gap_days: number | null;
  register: string | null;
  last_contact: Date | null;
};

/**
 * Selects the latest `relationship_metrics_daily` row and the latest `interactions` row
 * per person, joined onto `persons`. Shared by both the single and batched lookups so
 * the two can never drift apart on what "the current relationship state" means.
 *
 * `whereClause` supplies the `and ...` fragment that narrows to one or several people;
 * it must reference `p.person_id` / `p.display` and use `$2` (or later placeholders).
 */
function relationshipStateSql(whereClause: string): string {
  return `
    select
      p.person_id,
      p.display,
      m.momentum,
      m.initiation_ratio,
      m.median_gap_days as expected_gap_days,
      m.register,
      li.last_contact
    from persons p
    left join lateral (
      select momentum, initiation_ratio, median_gap_days, register
      from relationship_metrics_daily rmd
      where rmd.user_id = $1 and rmd.person_id = p.person_id
      order by day desc
      limit 1
    ) m on true
    left join lateral (
      select max(occurred_at) as last_contact
      from interactions i
      where i.user_id = $1 and i.person_id = p.person_id
    ) li on true
    where p.user_id = $1 ${whereClause}
  `;
}

function toOutput(row: RelationshipStateSqlRow, now: Date): RelationshipStateOutput | null {
  // No interaction on record for this person yet: nothing honest to report as "state".
  if (row.last_contact === null) return null;
  const overdue_by_days = row.expected_gap_days === null
    ? null
    : (now.getTime() - row.last_contact.getTime()) / MS_PER_DAY - row.expected_gap_days;
  return {
    person_id: row.person_id,
    display: row.display,
    lifecycle_stage: null, // see file header — no source column at person_id level
    expected_gap_days: row.expected_gap_days,
    overdue_by_days,
    momentum: row.momentum,
    initiation_ratio: row.initiation_ratio,
    register: row.register,
    relationship_kind: null, // see file header
    last_contact: row.last_contact.toISOString(),
  };
}

export class PostgresAgentStore implements AgentStore {
  constructor(
    private readonly db: Queryable = getPool(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async relationshipState(
    scope: UserScope,
    input: RelationshipStateInput,
  ): Promise<RelationshipStateOutput | null> {
    if (input.person_id !== undefined) {
      const res = await scopedQuery<RelationshipStateSqlRow>(
        this.db, scope,
        relationshipStateSql("and p.person_id = $2"),
        [scope.user_id, input.person_id],
      );
      const row = res.rows[0];
      return row === undefined ? null : toOutput(row, this.now());
    }
    if (input.display !== undefined) {
      const res = await scopedQuery<RelationshipStateSqlRow>(
        this.db, scope,
        relationshipStateSql("and p.display = $2"),
        [scope.user_id, input.display],
      );
      // Matches InMemoryAgentStore: an ambiguous display (>1 person) resolves to no match
      // rather than guessing which one was meant.
      if (res.rows.length !== 1) return null;
      return toOutput(res.rows[0]!, this.now());
    }
    return null;
  }

  async relationshipStateBatch(
    scope: UserScope,
    personIds: readonly string[],
  ): Promise<ReadonlyMap<string, RelationshipStateOutput>> {
    const out = new Map<string, RelationshipStateOutput>();
    if (personIds.length === 0) return out;
    const res = await scopedQuery<RelationshipStateSqlRow>(
      this.db, scope,
      relationshipStateSql("and p.person_id = any($2::text[])"),
      [scope.user_id, personIds],
    );
    const now = this.now();
    for (const row of res.rows) {
      const output = toOutput(row, now);
      if (output !== null) out.set(row.person_id, output);
    }
    return out;
  }

  async openLoops(
    scope: UserScope,
    input: { direction?: "i_owe_them" | "they_owe_me"; kind?: string; limit: number },
  ): Promise<OpenLoopRow[]> {
    const rows = await getOpenLoops(scope, input, this.db);
    return rows.map((row) => ({
      loop_id: row.loop_id,
      person_id: row.person_id,
      display: row.display,
      kind: row.kind,
      direction: row.direction as "i_owe_them" | "they_owe_me",
      description: row.description,
      age_days: row.age_days,
    }));
  }

  async drifting(scope: UserScope, input: { limit: number }): Promise<DriftingRow[]> {
    const res = await scopedQuery<{
      person_id: string;
      display: string;
      expected_gap_days: number;
      overdue_by_days: number;
    }>(
      this.db, scope,
      `select p.person_id, p.display,
              m.median_gap_days as expected_gap_days,
              (extract(epoch from (now() - li.last_contact)) / 86400.0) - m.median_gap_days
                as overdue_by_days
       from persons p
       join lateral (
         select median_gap_days
         from relationship_metrics_daily rmd
         where rmd.user_id = $1 and rmd.person_id = p.person_id and rmd.median_gap_days is not null
         order by day desc
         limit 1
       ) m on true
       join lateral (
         select max(occurred_at) as last_contact
         from interactions i
         where i.user_id = $1 and i.person_id = p.person_id
       ) li on true
       where p.user_id = $1 and li.last_contact is not null
       order by overdue_by_days desc
       limit $2`,
      [scope.user_id, input.limit],
    );
    return res.rows;
  }

  async circle(scope: UserScope, personId: string): Promise<CircleConnectionRow[]> {
    const res = await scopedQuery<CircleConnectionRow>(
      this.db, scope,
      `select
         case when e.person_a = $2 then e.person_b else e.person_a end as person_id,
         coalesce(p.display, 'unknown') as display,
         e.shared_groups,
         e.tie_strength
       from relationship_edges e
       left join persons p
         on p.user_id = $1
        and p.person_id = case when e.person_a = $2 then e.person_b else e.person_a end
       where e.user_id = $1 and (e.person_a = $2 or e.person_b = $2)
       order by e.tie_strength desc nulls last`,
      [scope.user_id, personId],
    );
    return res.rows;
  }

  async memoryWrite(
    scope: UserScope,
    input: { text: string; person_id?: string },
  ): Promise<{ memory_id: string }> {
    return insertMemory(
      scope,
      { memory_id: newMemoryId(), person_id: input.person_id ?? null, text: input.text, source: "agent" },
      this.db,
    );
  }

  async memorySearch(scope: UserScope, query: string): Promise<MemoryRow[]> {
    const rows = await searchMemories(scope, { query }, this.db);
    return rows.map((row) => ({ memory_id: row.memory_id, person_id: row.person_id, text: row.text }));
  }

  async resolvePerson(
    scope: UserScope,
    display: string,
  ): Promise<{ person_id: string; display: string } | null> {
    const res = await scopedQuery<{ person_id: string; display: string }>(
      this.db, scope,
      `select person_id, display from persons where user_id = $1 and display = $2`,
      [scope.user_id, display],
    );
    if (res.rows.length !== 1) return null;
    return res.rows[0]!;
  }
}
