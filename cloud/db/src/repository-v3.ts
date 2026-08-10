// v3 repository functions — persons, identities, interactions, moat, relationships, cache.
// Imported and re-exported from repository.ts's index.

import { getPool, type Queryable } from "./pool.js";
import { scopedQuery, type UserScope } from "./scope.js";

// ── persons ──

export async function upsertPerson(
  scope: UserScope,
  input: { person_id: string; display: string },
  db: Queryable = getPool(),
): Promise<{ person_id: string }> {
  await scopedQuery(
    db, scope,
    `insert into persons (user_id, person_id, display)
     values ($1, $2, $3)
     on conflict (user_id, person_id)
     do update set display = excluded.display`,
    [scope.user_id, input.person_id, input.display],
  );
  return { person_id: input.person_id };
}

// ── identities ──

export async function upsertIdentity(
  scope: UserScope,
  input: {
    identity_id: string;
    person_id: string;
    source: string;
    handle: string;
    confidence: string;
    merged_by?: string | null;
    as_of: Date;
  },
  db: Queryable = getPool(),
): Promise<{ identity_id: string }> {
  await scopedQuery(
    db, scope,
    `insert into identities (user_id, identity_id, person_id, source, handle, confidence, merged_by, as_of)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (user_id, source, handle)
     do update set person_id = excluded.person_id, confidence = excluded.confidence,
                   merged_by = excluded.merged_by, as_of = excluded.as_of`,
    [scope.user_id, input.identity_id, input.person_id, input.source, input.handle,
     input.confidence, input.merged_by ?? null, input.as_of.toISOString()],
  );
  return { identity_id: input.identity_id };
}

// ── interactions ──

export async function insertInteractions(
  scope: UserScope,
  rows: Array<{
    interaction_id: string;
    person_id: string;
    source: string;
    direction: string;
    occurred_at: Date;
    thread_ref?: string | null;
    content_ref?: string | null;
    length?: number | null;
    meta?: Record<string, unknown>;
  }>,
  db: Queryable = getPool(),
): Promise<number> {
  if (rows.length === 0) return 0;
  const params: unknown[] = [scope.user_id];
  const placeholders: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const base = params.length + 1; // +1 for SQL 1-based param numbering
    params.push(r.interaction_id, r.person_id, r.source, r.direction,
      r.occurred_at.toISOString(), r.thread_ref ?? null, r.content_ref ?? null,
      r.length ?? null, JSON.stringify(r.meta ?? {}));
    placeholders.push(
      `($1, $${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
    );
  }
  const res = await scopedQuery(
    db, scope,
    `insert into interactions (user_id, interaction_id, person_id, source, direction, occurred_at, thread_ref, content_ref, length, meta)
     values ${placeholders.join(", ")}
     on conflict (user_id, interaction_id) do nothing`,
    params,
  );
  return res.rowCount ?? rows.length;
}

// ── outcomes ──

export async function insertOutcome(
  scope: UserScope,
  input: {
    outcome_id: string;
    kind: string;
    person_id?: string | null;
    payload: Record<string, unknown>;
    suggested_at?: Date;
  },
  db: Queryable = getPool(),
): Promise<{ outcome_id: string }> {
  await scopedQuery(
    db, scope,
    `insert into outcomes (user_id, outcome_id, kind, person_id, payload, suggested_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [scope.user_id, input.outcome_id, input.kind, input.person_id ?? null,
     JSON.stringify(input.payload), (input.suggested_at ?? new Date()).toISOString()],
  );
  return { outcome_id: input.outcome_id };
}

export async function recordOutcomeResult(
  scope: UserScope,
  input: { outcome_id: string; result: string; result_at?: Date; they_replied?: boolean },
  db: Queryable = getPool(),
): Promise<void> {
  await scopedQuery(
    db, scope,
    `update outcomes set result = $3, result_at = $4, they_replied = $5
     where user_id = $1 and outcome_id = $2`,
    [scope.user_id, input.outcome_id, input.result,
     (input.result_at ?? new Date()).toISOString(), input.they_replied ?? null],
  );
}

// ── memories ──

export async function insertMemory(
  scope: UserScope,
  input: { memory_id: string; person_id?: string | null; text: string; source: string },
  db: Queryable = getPool(),
): Promise<{ memory_id: string }> {
  await scopedQuery(
    db, scope,
    `insert into memories (user_id, memory_id, person_id, text, source)
     values ($1, $2, $3, $4, $5)`,
    [scope.user_id, input.memory_id, input.person_id ?? null, input.text, input.source],
  );
  return { memory_id: input.memory_id };
}

export async function searchMemories(
  scope: UserScope,
  input: { query: string; person_id?: string | null; limit?: number },
  db: Queryable = getPool(),
): Promise<Array<{ memory_id: string; person_id: string | null; text: string; source: string; created_at: string }>> {
  const limit = input.limit ?? 10;
  const params: unknown[] = [scope.user_id, input.query];
  let personFilter = "";
  if (input.person_id) {
    params.push(input.person_id);
    personFilter = `and person_id = $${params.length}`;
  }
  const res = await scopedQuery<{ memory_id: string; person_id: string | null; text: string; source: string; created_at: string }>(
    db, scope,
    `select memory_id, person_id, text, source, created_at::text
     from memories where user_id = $1 and active = true and text ilike '%' || $2 || '%' ${personFilter}
     order by created_at desc limit $${params.length + 1}`,
    [...params, limit],
  );
  return res.rows;
}

// ── corrections ──

export async function insertCorrection(
  scope: UserScope,
  input: { correction_id: string; turn_id?: string | null; claim: string; correction: string },
  db: Queryable = getPool(),
): Promise<{ correction_id: string }> {
  await scopedQuery(
    db, scope,
    `insert into corrections (user_id, correction_id, turn_id, claim, correction)
     values ($1, $2, $3, $4, $5)`,
    [scope.user_id, input.correction_id, input.turn_id ?? null, input.claim, input.correction],
  );
  return { correction_id: input.correction_id };
}

// ── draft_edits ──

export async function insertDraftEdit(
  scope: UserScope,
  input: { edit_id: string; person_id?: string | null; drafted: string; sent?: string | null },
  db: Queryable = getPool(),
): Promise<{ edit_id: string }> {
  await scopedQuery(
    db, scope,
    `insert into draft_edits (user_id, edit_id, person_id, drafted, sent)
     values ($1, $2, $3, $4, $5)`,
    [scope.user_id, input.edit_id, input.person_id ?? null, input.drafted, input.sent ?? null],
  );
  return { edit_id: input.edit_id };
}

// ── open_loops ──

export async function upsertOpenLoops(
  scope: UserScope,
  loops: Array<{
    loop_id: string;
    person_id: string;
    kind: string;
    direction: string;
    description: string;
    opened_at: Date;
    status?: string;
    confidence: string;
    as_of: Date;
  }>,
  db: Queryable = getPool(),
): Promise<number> {
  if (loops.length === 0) return 0;
  const params: unknown[] = [scope.user_id];
  const placeholders: string[] = [];
  for (let i = 0; i < loops.length; i++) {
    const l = loops[i]!;
    const base = params.length + 1; // +1 for SQL 1-based param numbering
    params.push(l.loop_id, l.person_id, l.kind, l.direction, l.description,
      l.opened_at.toISOString(), l.status ?? "open", l.confidence, l.as_of.toISOString());
    placeholders.push(
      `($1, $${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
    );
  }
  const res = await scopedQuery(
    db, scope,
    `insert into open_loops (user_id, loop_id, person_id, kind, direction, description, opened_at, status, confidence, as_of)
     values ${placeholders.join(", ")}
     on conflict (user_id, loop_id)
     do update set kind = excluded.kind, direction = excluded.direction,
                   description = excluded.description, status = excluded.status,
                   confidence = excluded.confidence, as_of = excluded.as_of`,
    params,
  );
  return res.rowCount ?? loops.length;
}

export async function getOpenLoops(
  scope: UserScope,
  input: { direction?: string; kind?: string; limit?: number },
  db: Queryable = getPool(),
): Promise<Array<{ loop_id: string; person_id: string; display: string; kind: string; direction: string; description: string; age_days: number }>> {
  const limit = input.limit ?? 20;
  const params: unknown[] = [scope.user_id];
  let filter = "";
  if (input.direction) {
    params.push(input.direction);
    filter += ` and ol.direction = $${params.length}`;
  }
  if (input.kind) {
    params.push(input.kind);
    filter += ` and ol.kind = $${params.length}`;
  }
  params.push(limit);
  const res = await scopedQuery<{ loop_id: string; person_id: string; display: string; kind: string; direction: string; description: string; age_days: number }>(
    db, scope,
    `select ol.loop_id, ol.person_id, coalesce(p.display, 'unknown') as display,
            ol.kind, ol.direction, ol.description,
            extract(day from now() - ol.opened_at)::int as age_days
     from open_loops ol
     left join persons p on p.person_id = ol.person_id
     where ol.user_id = $1 and ol.status = 'open' ${filter}
     order by ol.opened_at desc limit $${params.length}`,
    params,
  );
  return res.rows;
}

// ── relationship_metrics_daily ──

export async function insertDailyMetrics(
  scope: UserScope,
  rows: Array<{
    person_id: string;
    day: string;
    message_count: number;
    momentum?: number | null;
    initiation_ratio?: number | null;
    median_gap_days?: number | null;
    response_latency_me_min?: number | null;
    response_latency_them_min?: number | null;
    register?: string | null;
  }>,
  db: Queryable = getPool(),
): Promise<number> {
  if (rows.length === 0) return 0;
  const params: unknown[] = [scope.user_id];
  const placeholders: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const base = params.length + 1; // +1 for SQL 1-based param numbering
    params.push(r.person_id, r.day, r.message_count, r.momentum ?? null,
      r.initiation_ratio ?? null, r.median_gap_days ?? null,
      r.response_latency_me_min ?? null, r.response_latency_them_min ?? null,
      r.register ?? null);
    placeholders.push(
      `($1, $${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
    );
  }
  const res = await scopedQuery(
    db, scope,
    `insert into relationship_metrics_daily (user_id, person_id, day, message_count, momentum, initiation_ratio, median_gap_days, response_latency_me_min, response_latency_them_min, register)
     values ${placeholders.join(", ")}
     on conflict (user_id, person_id, day)
     do update set message_count = excluded.message_count, momentum = excluded.momentum,
                   initiation_ratio = excluded.initiation_ratio, median_gap_days = excluded.median_gap_days,
                   response_latency_me_min = excluded.response_latency_me_min,
                   response_latency_them_min = excluded.response_latency_them_min,
                   register = excluded.register`,
    params,
  );
  return res.rowCount ?? rows.length;
}

// ── relationship_edges ──

export async function upsertRelationshipEdges(
  scope: UserScope,
  edges: Array<{
    person_a: string;
    person_b: string;
    shared_groups?: number;
    co_mentions?: number;
    tie_strength?: number | null;
    as_of: Date;
  }>,
  db: Queryable = getPool(),
): Promise<number> {
  if (edges.length === 0) return 0;
  const params: unknown[] = [scope.user_id];
  const placeholders: string[] = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    const base = params.length + 1; // +1 for SQL 1-based param numbering
    params.push(e.person_a, e.person_b, e.shared_groups ?? 0,
      e.co_mentions ?? 0, e.tie_strength ?? null, e.as_of.toISOString());
    placeholders.push(
      `($1, $${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`,
    );
  }
  const res = await scopedQuery(
    db, scope,
    `insert into relationship_edges (user_id, person_a, person_b, shared_groups, co_mentions, tie_strength, as_of)
     values ${placeholders.join(", ")}
     on conflict (user_id, person_a, person_b)
     do update set shared_groups = excluded.shared_groups, co_mentions = excluded.co_mentions,
                   tie_strength = excluded.tie_strength, as_of = excluded.as_of`,
    params,
  );
  return res.rowCount ?? edges.length;
}

// ── precomputed_answers ──

export async function setPrecomputedAnswer(
  scope: UserScope,
  input: { intent: string; answer: { blocks: Array<{ type: string; text: string }>; evidence: Array<unknown> } },
  db: Queryable = getPool(),
): Promise<void> {
  await scopedQuery(
    db, scope,
    `insert into precomputed_answers (user_id, intent, answer)
     values ($1, $2, $3)
     on conflict (user_id, intent)
     do update set answer = excluded.answer, computed_at = now()`,
    [scope.user_id, input.intent, JSON.stringify(input.answer)],
  );
}

export async function getPrecomputedAnswer(
  scope: UserScope,
  intent: string,
  db: Queryable = getPool(),
): Promise<{ blocks: Array<{ type: string; text: string }>; evidence: Array<unknown> } | null> {
  const res = await scopedQuery<{ answer: { blocks: Array<{ type: string; text: string }>; evidence: Array<unknown> } }>(
    db, scope,
    `select answer from precomputed_answers where user_id = $1 and intent = $2`,
    [scope.user_id, intent],
  );
  return res.rows[0]?.answer ?? null;
}
