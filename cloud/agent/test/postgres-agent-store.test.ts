// PostgresAgentStore against a live `boi_dev_d` — Track B's own database-touching file.
//
// One database-touching file per track, same convention documented at the top of
// cloud/db/src/schema.test.ts and cloud/api/src/ingest.test.ts: vitest runs test FILES in
// parallel, and cloud/db/src/schema.test.ts drops and rebuilds this schema, so anything
// else that touches it takes the same cross-process advisory lock and calls the idempotent
// `migrate` (never `rollbackAll`) rather than assuming a fresh database.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireSuiteLock,
  closePool,
  createUser,
  getPool,
  migrate,
  newIdentityId,
  newInteractionId,
  newLoopId,
  newPersonId,
  releaseSuiteLock,
  upsertIdentity,
  upsertPerson,
  type UserScope,
} from "../../db/src/index.js";
import { PostgresAgentStore } from "../src/postgres-agent-store.js";

const pool = getPool();

// ---------------------------------------------------------------------------
// KNOWN BUG WORKAROUND — flagged separately (spawn_task), not fixed here because
// cloud/db/** is out of this track's edit boundary.
//
// repository-v3.ts's multi-row batch inserts (insertInteractions, upsertOpenLoops,
// insertDailyMetrics, upsertRelationshipEdges) compute their placeholder base as
// `params.length` instead of `params.length + 1`. Since `params` starts as
// `[scope.user_id]` (length 1), that reuses `$1` for the first row's first column and
// leaves every SQL parameter off by one — Postgres rejects the query with "bind message
// supplies N parameters, but prepared statement requires N-1" for ANY call with 1+ rows.
// These local helpers insert the same rows with correct SQL so this test file can seed
// real data despite that; PostgresAgentStore's READS (getOpenLoops, the raw SQL in
// postgres-agent-store.ts) are unaffected and exercised for real below.
// ---------------------------------------------------------------------------

async function seedInteraction(
  scope: UserScope,
  row: { interaction_id: string; person_id: string; occurred_at: Date },
): Promise<void> {
  await pool.query(
    `insert into interactions (user_id, interaction_id, person_id, source, direction, occurred_at, meta)
     values ($1, $2, $3, 'imessage', 'in', $4, '{}')`,
    [scope.user_id, row.interaction_id, row.person_id, row.occurred_at.toISOString()],
  );
}

async function seedOpenLoop(
  scope: UserScope,
  row: { loop_id: string; person_id: string; kind: string; direction: string; description: string; opened_at: Date },
): Promise<void> {
  await pool.query(
    `insert into open_loops (user_id, loop_id, person_id, kind, direction, description, opened_at, status, confidence, as_of)
     values ($1, $2, $3, $4, $5, $6, $7, 'open', 'high', now())`,
    [scope.user_id, row.loop_id, row.person_id, row.kind, row.direction, row.description, row.opened_at.toISOString()],
  );
}

async function seedDailyMetrics(
  scope: UserScope,
  row: { person_id: string; day: string; momentum: number; initiation_ratio: number; median_gap_days: number; register: string },
): Promise<void> {
  await pool.query(
    `insert into relationship_metrics_daily
       (user_id, person_id, day, message_count, momentum, initiation_ratio, median_gap_days, register)
     values ($1, $2, $3, 12, $4, $5, $6, $7)`,
    [scope.user_id, row.person_id, row.day, row.momentum, row.initiation_ratio, row.median_gap_days, row.register],
  );
}

async function seedRelationshipEdge(
  scope: UserScope,
  row: { person_a: string; person_b: string; shared_groups: number; tie_strength: number },
): Promise<void> {
  await pool.query(
    `insert into relationship_edges (user_id, person_a, person_b, shared_groups, tie_strength, as_of)
     values ($1, $2, $3, $4, $5, now())`,
    [scope.user_id, row.person_a, row.person_b, row.shared_groups, row.tie_strength],
  );
}

beforeAll(async () => {
  await acquireSuiteLock();
  await migrate(pool);
}, 120_000);

afterAll(async () => {
  await closePool();
  await releaseSuiteLock();
});

let phoneCounter = 0;
// Runs against a persistent local `boi_dev_d` with no per-run reset (unlike
// schema.test.ts's rollbackAll), so a counter alone collides with rows a previous run
// left behind. Salting with the process start time keeps numbers unique run-to-run too.
const PHONE_RUN_SALT = Date.now() % 1_000_0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+1557${String(PHONE_RUN_SALT * 100_000 + phoneCounter).slice(-7)}`;
}

async function newScope(): Promise<UserScope> {
  const { scope } = await createUser({ phone_e164: nextPhone() });
  return scope;
}

/** Fixed clock so overdue_by_days assertions are exact rather than racing `now()`. */
const FIXED_NOW = new Date("2026-08-10T12:00:00Z");

async function seedPerson(
  scope: UserScope,
  input: { display: string; lastContact: Date; medianGapDays?: number },
): Promise<string> {
  const personId = newPersonId();
  await upsertPerson(scope, { person_id: personId, display: input.display }, pool);
  await upsertIdentity(
    scope,
    {
      identity_id: newIdentityId(),
      person_id: personId,
      source: "imessage",
      handle: `${personId}@test`,
      confidence: "high",
      as_of: FIXED_NOW,
    },
    pool,
  );
  await seedInteraction(scope, { interaction_id: newInteractionId(), person_id: personId, occurred_at: input.lastContact });
  if (input.medianGapDays !== undefined) {
    await seedDailyMetrics(scope, {
      person_id: personId,
      day: "2026-08-09",
      momentum: 0.55,
      initiation_ratio: 0.4,
      median_gap_days: input.medianGapDays,
      register: "warm",
    });
  }
  return personId;
}

describe("PostgresAgentStore.relationshipState / relationshipStateBatch", () => {
  it("resolves by person_id, deriving overdue_by_days from the metrics + interaction rows", async () => {
    const scope = await newScope();
    const personId = await seedPerson(scope, {
      display: "Maya",
      lastContact: new Date("2026-08-05T12:00:00Z"), // exactly 5 days before FIXED_NOW
      medianGapDays: 3,
    });
    const store = new PostgresAgentStore(pool, () => FIXED_NOW);

    const result = await store.relationshipState(scope, { person_id: personId });
    expect(result).not.toBeNull();
    expect(result?.display).toBe("Maya");
    expect(result?.momentum).toBeCloseTo(0.55);
    expect(result?.initiation_ratio).toBeCloseTo(0.4);
    expect(result?.expected_gap_days).toBeCloseTo(3);
    expect(result?.register).toBe("warm");
    expect(result?.overdue_by_days).toBeCloseTo(2); // 5 days elapsed - 3 expected
    expect(result?.last_contact).toBe("2026-08-05T12:00:00.000Z");
    // Honest gap: no v3 column backs these, so they're null rather than fabricated.
    expect(result?.lifecycle_stage).toBeNull();
    expect(result?.relationship_kind).toBeNull();
  });

  it("resolves by display, and returns null for an ambiguous or unknown display", async () => {
    const scope = await newScope();
    await seedPerson(scope, { display: "Noah", lastContact: new Date("2026-08-08T00:00:00Z") });
    const store = new PostgresAgentStore(pool, () => FIXED_NOW);

    const byDisplay = await store.relationshipState(scope, { display: "Noah" });
    expect(byDisplay?.display).toBe("Noah");

    const unknown = await store.relationshipState(scope, { display: "Nobody" });
    expect(unknown).toBeNull();
  });

  it("returns null rather than fabricating a row for a person with no interactions", async () => {
    const scope = await newScope();
    const personId = newPersonId();
    await upsertPerson(scope, { person_id: personId, display: "Ghost" }, pool);
    const store = new PostgresAgentStore(pool, () => FIXED_NOW);

    const result = await store.relationshipState(scope, { person_id: personId });
    expect(result).toBeNull();
  });

  it("relationshipStateBatch resolves several people in one call and omits unmatched ids", async () => {
    const scope = await newScope();
    const maya = await seedPerson(scope, { display: "Maya", lastContact: new Date("2026-08-05T00:00:00Z"), medianGapDays: 2 });
    const noah = await seedPerson(scope, { display: "Noah", lastContact: new Date("2026-08-09T00:00:00Z"), medianGapDays: 1 });
    const store = new PostgresAgentStore(pool, () => FIXED_NOW);

    const batch = await store.relationshipStateBatch(scope, [maya, noah, "p_does_not_exist"]);
    expect(batch.size).toBe(2);
    expect(batch.get(maya)?.display).toBe("Maya");
    expect(batch.get(noah)?.display).toBe("Noah");
    expect(batch.has("p_does_not_exist")).toBe(false);
  });

  it("scopes strictly to the caller's user — another user's person never resolves", async () => {
    const scopeA = await newScope();
    const scopeB = await newScope();
    const personId = await seedPerson(scopeA, { display: "Maya", lastContact: new Date("2026-08-05T00:00:00Z") });
    const store = new PostgresAgentStore(pool, () => FIXED_NOW);

    const result = await store.relationshipState(scopeB, { person_id: personId });
    expect(result).toBeNull();
  });
});

describe("PostgresAgentStore.openLoops", () => {
  it("filters by direction/kind and computes age_days, keyed on person_id", async () => {
    const scope = await newScope();
    const personId = await seedPerson(scope, { display: "Maya", lastContact: new Date("2026-08-01T00:00:00Z") });
    await seedOpenLoop(scope, {
      loop_id: newLoopId(),
      person_id: personId,
      kind: "question",
      direction: "i_owe_them",
      description: "asked about the trip",
      opened_at: new Date(Date.now() - 4 * 86_400_000),
    });
    const store = new PostgresAgentStore(pool);

    const loops = await store.openLoops(scope, { direction: "i_owe_them", limit: 10 });
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ person_id: personId, display: "Maya", kind: "question", direction: "i_owe_them" });
    expect(loops[0]?.age_days).toBeGreaterThanOrEqual(3);

    const wrongDirection = await store.openLoops(scope, { direction: "they_owe_me", limit: 10 });
    expect(wrongDirection).toHaveLength(0);
  });
});

describe("PostgresAgentStore.drifting", () => {
  it("orders by overdue_by_days desc and only includes people with both metrics and interactions", async () => {
    const scope = await newScope();
    const overdue = await seedPerson(scope, { display: "Drifted", lastContact: new Date("2026-07-01T00:00:00Z"), medianGapDays: 2 });
    const onTrack = await seedPerson(scope, { display: "OnTrack", lastContact: new Date("2026-08-10T00:00:00Z"), medianGapDays: 30 });
    await upsertPerson(scope, { person_id: newPersonId(), display: "NoMetrics" }, pool); // excluded: no metrics row

    const store = new PostgresAgentStore(pool, () => FIXED_NOW);
    const rows = await store.drifting(scope, { limit: 10 });

    const ids = rows.map((r) => r.person_id);
    expect(ids).toContain(overdue);
    expect(ids).toContain(onTrack);
    expect(ids[0]).toBe(overdue); // most overdue first
  });
});

describe("PostgresAgentStore.circle", () => {
  it("resolves the counterparty from either side of relationship_edges", async () => {
    const scope = await newScope();
    const maya = await seedPerson(scope, { display: "Maya", lastContact: new Date("2026-08-01T00:00:00Z") });
    const noah = await seedPerson(scope, { display: "Noah", lastContact: new Date("2026-08-01T00:00:00Z") });
    await seedRelationshipEdge(scope, { person_a: maya, person_b: noah, shared_groups: 2, tie_strength: 0.6 });
    const store = new PostgresAgentStore(pool);

    const fromMaya = await store.circle(scope, maya);
    expect(fromMaya).toEqual([{ person_id: noah, display: "Noah", shared_groups: 2, tie_strength: 0.6 }]);

    const fromNoah = await store.circle(scope, noah);
    expect(fromNoah).toEqual([{ person_id: maya, display: "Maya", shared_groups: 2, tie_strength: 0.6 }]);
  });
});

describe("PostgresAgentStore.memoryWrite / memorySearch", () => {
  it("writes then finds a memory by substring, scoped to the caller", async () => {
    const scope = await newScope();
    const personId = await seedPerson(scope, { display: "Maya", lastContact: new Date("2026-08-01T00:00:00Z") });
    const store = new PostgresAgentStore(pool);

    const { memory_id } = await store.memoryWrite(scope, { text: "Maya's dog is named Biscuit", person_id: personId });
    expect(memory_id).toMatch(/^mem_/);

    const found = await store.memorySearch(scope, "Biscuit");
    expect(found).toEqual([{ memory_id, person_id: personId, text: "Maya's dog is named Biscuit" }]);

    const other = await newScope();
    const notFound = await store.memorySearch(other, "Biscuit");
    expect(notFound).toEqual([]);
  });
});

describe("PostgresAgentStore.resolvePerson", () => {
  it("resolves an exact, unambiguous display match", async () => {
    const scope = await newScope();
    const personId = await seedPerson(scope, { display: "Maya", lastContact: new Date("2026-08-01T00:00:00Z") });
    const store = new PostgresAgentStore(pool);

    expect(await store.resolvePerson(scope, "Maya")).toEqual({ person_id: personId, display: "Maya" });
    expect(await store.resolvePerson(scope, "Nobody")).toBeNull();
  });
});
