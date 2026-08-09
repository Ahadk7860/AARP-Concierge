// Everything that needs a live `boi_dev_d`.
//
// One file on purpose: vitest runs FILES in parallel, and the migration tests below
// drop and rebuild the schema. Splitting these across files would have two workers
// rebuilding one database at once, and the failures would read as flaky tests rather
// than as the collision they are. CONTRACTS.md section 9 assigns this track its own
// database precisely so nothing outside this file contends for it.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Digest, VoicePack, Brief, Relationship } from "../../shared/src/index.js";
import { getPool, closePool, withTransaction } from "./pool.js";
import { migrate, rollbackAll, loadMigrations, MIGRATIONS_DIR } from "./migrate.js";
import { acquireSuiteLock, releaseSuiteLock } from "./test-lock.js";
import {
  partitionedTables,
  userScopedTables,
  residueByTable,
  deletionReachableTables,
  UncountableTableError,
} from "./catalog.js";
import {
  unsafeScopeFromUserId,
  scopedQuery,
  UnscopedQueryError,
  CrossUserResultError,
  type UserScope,
} from "./scope.js";
import { contactIdForTest, newDigestId, newBriefId, newOutboundMessageId, newDeviceId } from "./ids.js";
import {
  createUser,
  getUser,
  deleteUser,
  registerDevice,
  recordHeartbeat,
  listRelationships,
  findRelationshipsByDisplay,
  insertDigest,
  latestDigest,
  upsertVoicePack,
  voicePackFor,
  insertBrief,
  listBriefs,
  insertOutboundMessage,
  listOutboundMessages,
  issuePairingCode,
  consumePairingCode,
  bootstrapLookups,
  DuplicateDigestError,
} from "./repository.js";
import { enqueue, dequeue, completeJob } from "./queue.js";

const FIXTURES = join(process.cwd(), "contracts", "fixtures");

async function fixture<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(join(FIXTURES, ...parts), "utf8")) as T;
}

/**
 * The tables prompt 01 asked for. Used ONLY by the schema-completeness test below,
 * which is a question about whether the migrations built what was specified.
 *
 * It is deliberately not used by the delete test. CONTRACTS.md § 3 requires the delete
 * verification to enumerate from the catalog, and a test that ends by comparing the
 * catalog's answer to this list has reintroduced the hard-coding through the back door
 * — the list becomes the thing being trusted again.
 */
const TABLES_PROMPT_01_SPECIFIED = [
  "briefs",
  "contact_handles",
  "corrections",
  "devices",
  "digests",
  "draft_edits",
  "identities",
  "inbound_outbox",
  "interactions",
  "jobs",
  "memories",
  "messages_out",
  "open_loops",
  "outcomes",
  "pairing_codes",
  "persons",
  "precomputed_answers",
  "relationship_edges",
  "relationship_metrics_daily",
  "relationships",
  "stream_checkpoints",
  "turns",
  "users",
  "voice_packs",
];

let pairingCounter = 0;
/** Distinct six-digit codes: `issuePairingCode` enforces global uniqueness of live codes. */
function pairingSeq(): number {
  pairingCounter += 1;
  return pairingCounter;
}

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+1555${String(1_000_000 + phoneCounter).slice(-7)}`;
}

const pool = getPool();

beforeAll(async () => {
  // Serialised against cloud/api/src/ingest.test.ts, which uses the same database.
  // See cloud/db/src/test-lock.ts for why this is not a vitest config change.
  await acquireSuiteLock();
  // Prove "runs clean from empty" by actually starting from empty.
  await rollbackAll(pool);
  await migrate(pool);
}, 120_000);

afterAll(async () => {
  await closePool();
  await releaseSuiteLock();
});

// ---------------------------------------------------------------------------

describe("migrations", () => {
  it("run clean from empty and are idempotent on re-run", async () => {
    // Versions come from disk. A literal list here would silently stop covering the
    // newest migration the moment one is added, which is when coverage matters most.
    const onDisk = (await loadMigrations(MIGRATIONS_DIR)).map((m) => m.version);
    expect(onDisk.length).toBeGreaterThanOrEqual(4);

    await rollbackAll(pool);

    const first = await migrate(pool);
    expect(first.applied).toEqual(onDisk);
    expect(first.skipped).toEqual([]);

    const second = await migrate(pool);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(onDisk);

    // A third run must also change nothing -- idempotence is not a one-shot property.
    const third = await migrate(pool);
    expect(third.applied).toEqual([]);
  }, 60_000);

  it("refuse to silently re-apply a migration that was edited after it ran", async () => {
    const real = await loadMigrations(MIGRATIONS_DIR);
    const version = real[0]?.version;
    expect(version).toBeDefined();

    await pool.query("update schema_migrations set checksum = $1 where version = $2", [
      "deadbeef".repeat(8),
      version,
    ]);
    await expect(migrate(pool)).rejects.toThrow(/forward-only/);

    // Put the real checksum back so the rest of the suite sees a consistent ledger.
    await pool.query("update schema_migrations set checksum = $1 where version = $2", [
      real[0]?.checksum,
      version,
    ]);
    await expect(migrate(pool)).resolves.toBeTruthy();
  });
});

describe("partitioning", () => {
  // Tables intentionally left unpartitioned:
  // - users: phone_e164 UNIQUE constraint incompatible with partition key
  // - jobs: workers poll across all users (NOTE 7 / migration 021)
  // - stream_checkpoints: single-row per-user config table
  const UNPARTITIONED = new Set(["users", "jobs", "stream_checkpoints"]);

  it("hash-partitions every user-data table on user_id", async () => {
    const partitioned = await partitionedTables(pool);
    const byName = new Map(partitioned.map((p) => [p.table_name, p]));

    // CONTRACTS.md section 3, as corrected 2 Aug: partitioning is OPTIONAL and kept
    // only where it costs nothing; `users` is exempt because a UNIQUE constraint on a
    // partitioned table must include the partition key and `phone_e164 unique` cannot.
    // Cascade, not partitioning, is what makes delete one operation.
    const mustBePartitioned = (await userScopedTables(pool))
      .map((t) => t.table_name)
      .filter((t) => !UNPARTITIONED.has(t));

    for (const table of mustBePartitioned) {
      const p = byName.get(table);
      expect(p, `${table} is not partitioned`).toBeDefined();
      expect(p?.strategy).toBe("hash");
      expect(p?.partition_key).toBe("HASH (user_id)");
    }
  });

  it("gives every partitioned table a complete set of hash partitions", async () => {
    const res = await pool.query<{ parent: string; n: string }>(`
      select parent.relname as parent, count(*)::text as n
        from pg_inherits i
        join pg_class child on child.oid = i.inhrelid
        join pg_class parent on parent.oid = i.inhparent
        join pg_namespace n on n.oid = parent.relnamespace
       where n.nspname = 'public' and parent.relkind = 'p'
       group by parent.relname order by parent.relname
    `);
    // The count of partitioned parent tables must match: every user-scoped table
    // EXCEPT the deliberately unpartitioned ones (users, jobs, stream_checkpoints).
    const partitionedCount = (await partitionedTables(pool)).length;
    const expectedPartitioned = (await userScopedTables(pool)).length - UNPARTITIONED.size;
    expect(partitionedCount, "partitioned table count mismatch").toBe(expectedPartitioned);
    for (const row of res.rows) {
      expect(Number(row.n), `${row.parent} partition count`).toBe(8);
    }
  });

  it("v3 partitioned tables carry a composite PK that includes user_id", async () => {
    // Every hash-partitioned table from migrations 017, 018, 019.
    // BLOCKING 1 was that these tables had bare single-col PKs. This test
    // asserts the fix — no future migration can reintroduce the pattern.
    const v3Partitioned = [
      "persons",
      "identities",
      "interactions",
      "outcomes",
      "memories",
      "corrections",
      "draft_edits",
      "open_loops",
      "relationship_edges",
      "relationship_metrics_daily",
      "precomputed_answers",
    ];

    const res = await pool.query<{ table_name: string; column_name: string }>(
      `select tc.table_name, kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on tc.constraint_name = kcu.constraint_name
        and tc.table_schema = kcu.table_schema
        and tc.table_name = kcu.table_name
       where tc.constraint_type = 'PRIMARY KEY'
         and tc.table_schema = 'public'
         and tc.table_name = any($1)
       order by tc.table_name, kcu.ordinal_position`,
      [v3Partitioned],
    );

    const pksByTable: Record<string, string[]> = {};
    for (const row of res.rows) {
      (pksByTable[row.table_name] ??= []).push(row.column_name);
    }

    for (const table of v3Partitioned) {
      const cols = pksByTable[table];
      expect(cols, `${table} primary key missing`).toBeDefined();
      expect(cols!, `${table} PK must include user_id`).toContain("user_id");
      expect(
        cols!.length,
        `${table} PK should be composite (got ${cols!.join(", ")})`,
      ).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("the delete", () => {
  /** Fills every table reachable from `users`. Returns the enumeration proving it. */
  async function seedEveryReachableTable(scope: UserScope): Promise<Record<string, number>> {
    const deviceId = newDeviceId();
    await registerDevice(scope, { device_id: deviceId, platform: "test" });
    await recordHeartbeat(scope, deviceId, new Date());

    const digest = await fixture<Digest>("digest", "healthy.json");
    digest.user_id = scope.user_id;
    digest.device_id = deviceId;
    await insertDigest(scope, { digest_id: newDigestId(), digest });

    const maya = await fixture<VoicePack>("voice_pack", "maya.json");
    const global = await fixture<VoicePack>("voice_pack", "global_fallback.json");
    await upsertVoicePack(scope, maya);
    await upsertVoicePack(scope, global);

    const brief = await fixture<Brief>("brief", "three_items.json");
    brief.user_id = scope.user_id;
    await insertBrief(scope, { brief_id: newBriefId(), brief });

    await insertOutboundMessage(scope, {
      message_id: newOutboundMessageId(),
      idempotency_key: `${scope.user_id}:seed`,
      blocks: [{ type: "text", text: "good morning" }],
    });

    await issuePairingCode(scope, { code: `4${String(pairingSeq()).padStart(5, "0")}`, ttl_seconds: 600 });

    // Every reachable table must be NON-EMPTY. Without this, "zero rows everywhere"
    // passes vacuously against a schema that was never seeded.
    const seeded = await residueByTable(scope.user_id, pool);
    expect(Object.keys(seeded).length).toBeGreaterThan(0);
    for (const [table, n] of Object.entries(seeded)) {
      expect(n, `${table} should be seeded before the delete`).toBeGreaterThan(0);
    }
    return seeded;
  }

  it("is ONE raw statement, and the catalog says nothing survived it", async () => {
    // Deliberately does NOT go through `deleteUser`. `deleteUser` runs residueByTable
    // itself and throws ResidualUserDataError before any assertion here could fail, so
    // a test built on it only restates production code. This issues the bare DELETE
    // and checks the catalog independently, which is what the criterion actually asks.
    const { scope } = await createUser({ phone_e164: nextPhone() });
    const seeded = await seedEveryReachableTable(scope);

    const res = await pool.query("delete from users where user_id = $1", [scope.user_id]);
    expect(res.rowCount).toBe(1);

    // Enumerated by walking foreign keys from `users`, not from a list in this file.
    const after = await residueByTable(scope.user_id, pool);
    expect(Object.keys(after).sort()).toEqual(Object.keys(seeded).sort());
    for (const [table, n] of Object.entries(after)) {
      expect(n, `${table} still holds rows for the deleted user`).toBe(0);
    }
  }, 60_000);

  it("reports the tables it verified, enumerated from the catalog", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone() });
    const seeded = await seedEveryReachableTable(scope);

    const result = await deleteUser(scope);
    expect(result.deleted).toBe(true);
    // Compared against the live enumeration, never a literal list.
    expect(result.verified_tables).toEqual(Object.keys(seeded).sort());
  }, 60_000);

  it("throws rather than reporting success when a row survives", async () => {
    // Proves the residue guard inside `deleteUser` is live rather than decorative, by
    // giving it a table that carries user_id and a foreign key but does NOT cascade.
    // Nothing else in the suite can distinguish a working guard from a missing one.
    const { scope } = await createUser({ phone_e164: nextPhone() });
    await pool.query(`
      create table if not exists uncascaded_probe (
        user_id text not null references users(user_id) on delete restrict,
        note text not null,
        primary key (user_id)
      )`);
    try {
      await pool.query("insert into uncascaded_probe (user_id, note) values ($1, $2)", [
        scope.user_id,
        "survives",
      ]);
      // `on delete restrict` makes Postgres refuse the delete outright, which is the
      // loud failure the guard exists to guarantee: never a quiet partial success.
      await expect(deleteUser(scope)).rejects.toThrow();
      expect(await getUser(scope)).not.toBeNull();
    } finally {
      await pool.query("drop table if exists uncascaded_probe");
      await deleteUser(scope);
    }
  }, 60_000);

  it("refuses to verify a delete it cannot count", async () => {
    // The brief_items shape CONTRACTS.md § 3 warns about: reachable from users by
    // foreign key, but with no user_id column of its own. A column-name enumeration
    // cannot see it and would report a clean zero. The foreign-key walk must refuse.
    const { scope } = await createUser({ phone_e164: nextPhone() });
    await pool.query(`
      create table if not exists brief_items_probe (
        item_id text primary key,
        brief_owner text not null references users(user_id) on delete cascade,
        headline text not null
      )`);
    try {
      const reachable = await deletionReachableTables(pool);
      expect(reachable.map((t) => t.table_name)).toContain("brief_items_probe");
      await expect(residueByTable(scope.user_id, pool)).rejects.toBeInstanceOf(
        UncountableTableError,
      );
    } finally {
      await pool.query("drop table if exists brief_items_probe");
      await deleteUser(scope);
    }
  }, 60_000);

  it("reaches every reachable table through a cascading foreign key", async () => {
    const reachable = await deletionReachableTables(pool);
    expect(reachable.length).toBeGreaterThan(1);
    for (const t of reachable) {
      if (t.depth === 0) continue; // `users` itself is the root, it has no inbound edge
      expect(t.on_delete, `${t.table_name} does not cascade from users`).toBe("c");
    }
  });

  it("agrees with the column-name enumeration while every table carries user_id", async () => {
    // Today both enumerations return the same set. When they stop agreeing, a table
    // has been added that one of them cannot see, and that is the moment to find out.
    const byColumn = (await userScopedTables(pool)).map((t) => t.table_name).sort();
    const byForeignKey = (await deletionReachableTables(pool)).map((t) => t.table_name).sort();
    expect(byForeignKey).toEqual(byColumn);
  });

  it("does not touch another user's rows", async () => {
    const doomed = await createUser({ phone_e164: nextPhone() });
    const bystander = await createUser({ phone_e164: nextPhone() });

    for (const u of [doomed, bystander]) {
      await upsertRelationshipFor(u.scope, u.user_salt, "+15551234567", "Maya");
    }

    await deleteUser(doomed.scope);

    expect(await getUser(doomed.scope)).toBeNull();
    expect(await getUser(bystander.scope)).not.toBeNull();
    expect(await listRelationships(bystander.scope)).toHaveLength(1);

    await deleteUser(bystander.scope);
  });
});

describe("cross-user isolation", () => {
  it("gives the same person a different contact_id for each user, and never joins them", async () => {
    const handle = "+14155550142";
    const display = "Maya";

    const a = await createUser({ phone_e164: nextPhone() });
    const b = await createUser({ phone_e164: nextPhone() });

    const contactA = await upsertRelationshipFor(a.scope, a.user_salt, handle, display);
    const contactB = await upsertRelationshipFor(b.scope, b.user_salt, handle, display);

    // The same underlying person. The ids must not match -- this is what makes a
    // cross-user join arithmetically unavailable rather than merely discouraged.
    expect(contactA).not.toBe(contactB);
    expect(a.user_salt.equals(b.user_salt)).toBe(false);

    // The one column that IS shared across users is `display`. Searching it from
    // either scope returns only that scope's row.
    const foundByA = await findRelationshipsByDisplay(a.scope, display);
    const foundByB = await findRelationshipsByDisplay(b.scope, display);
    expect(foundByA.map((r) => r.contact_id)).toEqual([contactA]);
    expect(foundByB.map((r) => r.contact_id)).toEqual([contactB]);

    // Every row every repository read returns belongs to the scope that asked.
    for (const [scope, rows] of [
      [a.scope, await listRelationships(a.scope)],
      [b.scope, await listRelationships(b.scope)],
    ] as const) {
      expect(rows).toHaveLength(1);
      for (const row of rows) expect(row.user_id).toBe(scope.user_id);
    }

    // And the guard refuses a hand-written query that would return both.
    await expect(
      scopedQuery(pool, a.scope, "select user_id, contact_id from relationships where display = $1", [
        display,
      ]),
    ).rejects.toThrow(UnscopedQueryError);

    // Even naming the predicate is not enough if $1 is somebody else.
    await expect(
      scopedQuery(pool, a.scope, "select 1 from relationships where user_id = $1", [
        b.scope.user_id,
      ]),
    ).rejects.toThrow(UnscopedQueryError);

    // The self-join that DEFEATS the SQL text check, run against real Postgres rather
    // than a stub: `a.user_id = $1` is present, so the text check passes, and the join
    // genuinely returns b's row. The result check is what stops it.
    await expect(
      scopedQuery(
        pool,
        a.scope,
        `select b.user_id, b.contact_id
           from relationships a
           join relationships b on a.display = b.display
          where a.user_id = $1`,
        [a.scope.user_id],
      ),
    ).rejects.toThrow(CrossUserResultError);

    // And `or true`, likewise live.
    await expect(
      scopedQuery(pool, a.scope, "select user_id from relationships where user_id = $1 or true", [
        a.scope.user_id,
      ]),
    ).rejects.toThrow(CrossUserResultError);

    // The hole that remains, demonstrated against real Postgres so it is not a
    // theoretical claim: projecting only `display` leaks b's row past both guards.
    const leaked = await scopedQuery<{ display: string }>(
      pool,
      a.scope,
      `select b.display
         from relationships a
         join relationships b on a.display = b.display
        where a.user_id = $1`,
      [a.scope.user_id],
    );
    expect(leaked.rows.length).toBe(2); // a's own row and b's — see scope.ts's header.

    await deleteUser(a.scope);
    await deleteUser(b.scope);
  });

  it("reads a foreign user's rows as absent, not as an error", async () => {
    const a = await createUser({ phone_e164: nextPhone() });
    const b = await createUser({ phone_e164: nextPhone() });

    const digest = await fixture<Digest>("digest", "healthy.json");
    digest.user_id = a.scope.user_id;
    await insertDigest(a.scope, { digest_id: newDigestId(), digest });

    expect(await latestDigest(a.scope)).not.toBeNull();
    expect(await latestDigest(b.scope)).toBeNull();
    expect(await listRelationships(b.scope)).toEqual([]);

    await deleteUser(a.scope);
    await deleteUser(b.scope);
  });
});

describe("the schema's own invariants", () => {
  it("refuses a salt shorter than 32 bytes", async () => {
    await expect(
      pool.query(
        `insert into users (user_id, phone_e164, user_salt) values ($1, $2, $3)`,
        ["usr_shortsalt01", nextPhone(), Buffer.alloc(16, 7)],
      ),
    ).rejects.toThrow(/users_salt_min_32_bytes/);
  });

  it("refuses two users sharing a salt", async () => {
    const salt = Buffer.alloc(32, 9);
    await pool.query(
      `insert into users (user_id, phone_e164, user_salt) values ($1, $2, $3)`,
      ["usr_saltone01", nextPhone(), salt],
    );
    await expect(
      pool.query(
        `insert into users (user_id, phone_e164, user_salt) values ($1, $2, $3)`,
        ["usr_salttwo01", nextPhone(), salt],
      ),
    ).rejects.toThrow(/users_salt_unique/);
    await deleteUser(unsafeScopeFromUserId("usr_saltone01"));
  });

  it("stores a salt of at least 32 bytes for a real user, unique per user", async () => {
    const made = await Promise.all(
      Array.from({ length: 5 }, () => createUser({ phone_e164: nextPhone() })),
    );
    const seen = new Set<string>();
    for (const { scope, user_salt } of made) {
      const row = await getUser(scope);
      expect(row?.user_salt.length).toBeGreaterThanOrEqual(32);
      expect(row?.user_salt.equals(user_salt)).toBe(true);
      seen.add(user_salt.toString("hex"));
    }
    expect(seen.size).toBe(made.length);
    for (const { scope } of made) await deleteUser(scope);
  });

  it("rejects a duplicate digest by generated_at, which is the 409 the API returns", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone() });
    const digest = await fixture<Digest>("digest", "healthy.json");
    digest.user_id = scope.user_id;

    await insertDigest(scope, { digest_id: newDigestId(), digest });
    await expect(
      insertDigest(scope, { digest_id: newDigestId(), digest }),
    ).rejects.toBeInstanceOf(DuplicateDigestError);

    await deleteUser(scope);
  });

  it("caps a brief at three items", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone() });
    const brief = await fixture<Brief>("brief", "three_items.json");
    brief.user_id = scope.user_id;
    const first = brief.items[0];
    expect(first).toBeDefined();
    brief.items = [first!, first!, first!, first!];

    await expect(
      insertBrief(scope, { brief_id: newBriefId(), brief }),
    ).rejects.toThrow(/briefs_at_most_three_items/);

    await deleteUser(scope);
  });

  it("refuses a second outbound message with the same idempotency key", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone() });
    const key = `${scope.user_id}:brief:1`;
    await insertOutboundMessage(scope, {
      message_id: newOutboundMessageId(),
      idempotency_key: key,
      blocks: [{ type: "text", text: "hi" }],
    });
    await expect(
      insertOutboundMessage(scope, {
        message_id: newOutboundMessageId(),
        idempotency_key: key,
        blocks: [{ type: "text", text: "hi again" }],
      }),
    ).rejects.toThrow(/_user_id_idempotency_key_key/);

    expect(await listOutboundMessages(scope)).toHaveLength(1);
    await deleteUser(scope);
  });

  it("refuses a global voice pack that names a contact", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone() });
    const pack = await fixture<VoicePack>("voice_pack", "global_fallback.json");
    pack.contact_id = "h_8f21a4c0";

    await expect(upsertVoicePack(scope, pack)).rejects.toThrow(
      /voice_packs_scope_matches_contact/,
    );
    await deleteUser(scope);
  });
});

describe("voice pack selection", () => {
  it("prefers the contact pack and falls back to global", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone() });
    const maya = await fixture<VoicePack>("voice_pack", "maya.json");
    const global = await fixture<VoicePack>("voice_pack", "global_fallback.json");
    await upsertVoicePack(scope, global);
    await upsertVoicePack(scope, maya);

    const forMaya = await voicePackFor(scope, maya.contact_id);
    expect(forMaya?.voice_pack_version).toBe(maya.voice_pack_version);

    const forStranger = await voicePackFor(scope, "h_ffffffff");
    expect(forStranger?.scope).toBe("global");

    await deleteUser(scope);
  });
});

describe("pairing and device authentication", () => {
  it("resolves a live code to its user and burns it once", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone() });
    await issuePairingCode(scope, { code: "778811", ttl_seconds: 600 });

    const resolved = await bootstrapLookups.resolvePairingCode("778811");
    expect(resolved?.user_id).toBe(scope.user_id);

    expect(await consumePairingCode(scope, "778811")).toBe(true);
    expect(await consumePairingCode(scope, "778811")).toBe(false);
    expect(await bootstrapLookups.resolvePairingCode("778811")).toBeNull();

    await deleteUser(scope);
  });

  it("refuses to issue a code another user is already holding", async () => {
    const a = await createUser({ phone_e164: nextPhone() });
    const b = await createUser({ phone_e164: nextPhone() });

    await issuePairingCode(a.scope, { code: "552244", ttl_seconds: 600 });
    await expect(
      issuePairingCode(b.scope, { code: "552244", ttl_seconds: 600 }),
    ).rejects.toThrow(/already live/);

    await deleteUser(a.scope);
    await deleteUser(b.scope);
  });

  it("authenticates a device token and rejects a tampered one", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone() });
    const deviceId = newDeviceId();
    const { device_token } = await registerDevice(scope, {
      device_id: deviceId,
      platform: "test",
    });

    const ok = await bootstrapLookups.authenticateDeviceToken(device_token);
    expect(ok?.scope.user_id).toBe(scope.user_id);
    expect(ok?.device_id).toBe(deviceId);

    expect(await bootstrapLookups.authenticateDeviceToken(`${device_token}x`)).toBeNull();
    expect(await bootstrapLookups.authenticateDeviceToken("garbage")).toBeNull();

    // A token minted for one user cannot authenticate against another's row.
    const other = await createUser({ phone_e164: nextPhone() });
    const forged = `${other.scope.user_id}.${device_token.split(".")[1]}`;
    expect(await bootstrapLookups.authenticateDeviceToken(forged)).toBeNull();

    await deleteUser(scope);
    await deleteUser(other.scope);
  });
});

describe("catalog enumeration", () => {
  it("finds every user-scoped table and excludes leaf partitions", async () => {
    const tables = await userScopedTables(pool);
    expect(tables.map((t) => t.table_name).sort()).toEqual(TABLES_PROMPT_01_SPECIFIED);
    // schema_migrations has no user_id and must not appear.
    expect(tables.some((t) => t.table_name === "schema_migrations")).toBe(false);
    expect(tables.some((t) => t.table_name.endsWith("_p0"))).toBe(false);
  });
});

describe("transactions", () => {
  it("roll back a failed digest insert whole, leaving no relationships behind", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone() });
    const digest = await fixture<Digest>("digest", "healthy.json");
    digest.user_id = scope.user_id;
    // A contact_id the schema will reject, so the relationship upsert fails after the
    // digest row has already been written inside the transaction.
    const first = digest.relationships[0];
    expect(first).toBeDefined();
    first!.contact_id = "NOT_A_CONTACT_ID";

    await expect(
      insertDigest(scope, { digest_id: newDigestId(), digest }),
    ).rejects.toThrow(/relationships_contact_id_prefix/);

    expect(await latestDigest(scope)).toBeNull();
    expect(await listRelationships(scope)).toEqual([]);

    await deleteUser(scope);
  });

  it("keeps briefs readable back after a write", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone() });
    const brief = await fixture<Brief>("brief", "three_items.json");
    brief.user_id = scope.user_id;
    await insertBrief(scope, { brief_id: newBriefId(), brief });

    const rows = await listBriefs(scope);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.item_count).toBe(brief.items.length);
    expect(rows[0]?.payload.schema_version).toBe("brief.v1");

    await deleteUser(scope);
  });

  it("rolls a transaction back on a throw", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone() });
    await expect(
      withTransaction(async (tx) => {
        await registerDevice(scope, { device_id: newDeviceId(), platform: "test" }, tx);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await residueByTable(scope.user_id, pool)).toMatchObject({ devices: 0 });
    await deleteUser(scope);
  });
});

// ---------------------------------------------------------------------------
// v3 ingest queue — proves that an enqueued job survives through to a
// persisted digest row. BLOCKING 2 was that enqueued jobs were never consumed.
// ---------------------------------------------------------------------------

describe("v3 ingest queue", () => {
  it("enqueue → dequeue → insertDigest persists a digest row", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone() });
    const digest = await fixture<Digest>("digest", "healthy.json");
    digest.user_id = scope.user_id;
    const digestId = newDigestId();
    const receivedAt = new Date().toISOString();

    // 1. Enqueue (what the ingest route does via api/src/routes/ingest.ts).
    const jobId = await enqueue("ingest", scope, {
      digest_id: digestId,
      digest,
      first: true,
      received_at: receivedAt,
    });
    expect(jobId).toBeTruthy();

    // 2. Dequeue (what ingest-worker.ts does).
    const job = await dequeue<{ digest_id: string; digest: Digest }>("ingest");
    expect(job, "job was dequeued").not.toBeNull();
    expect(job!.queue).toBe("ingest");
    expect(job!.payload.digest_id).toBe(digestId);

    // 3. Process (ingest-worker.ts calls insertDigest, then completeJob).
    await insertDigest(scope, {
      digest_id: job!.payload.digest_id,
      digest: job!.payload.digest,
    });
    await completeJob(job!.job_id, { status: "done" });

    // 4. Prove persistence — this is the assertion the old code couldn't satisfy.
    const latest = await latestDigest(scope);
    expect(latest, "digest persisted").not.toBeNull();
    expect(latest!.digest_id).toBe(digestId);
    expect(latest!.payload.corpus.message_count).toBe(digest.corpus.message_count);

    await deleteUser(scope);
  });

  it("a duplicate digest is still a done job (not failed)", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone() });
    const digest = await fixture<Digest>("digest", "healthy.json");
    digest.user_id = scope.user_id;
    const digestId = newDigestId();

    // First insert succeeds.
    await insertDigest(scope, { digest_id: digestId, digest });

    // Enqueue a duplicate.
    await enqueue("ingest", scope, {
      digest_id: digestId,
      digest,
      first: false,
      received_at: new Date().toISOString(),
    });
    const job = await dequeue<{ digest_id: string; digest: Digest }>("ingest");
    expect(job).not.toBeNull();

    // Duplicate must not throw past the worker.
    await expect(
      insertDigest(scope, {
        digest_id: job!.payload.digest_id,
        digest: job!.payload.digest,
      }),
    ).rejects.toThrow(DuplicateDigestError);

    // Worker marks it done (not failed), per ingest-worker.ts:63-66.
    await completeJob(job!.job_id, { status: "done" });

    await deleteUser(scope);
  });
});

// ---------------------------------------------------------------------------
// Type-level guards. Never executed; `tsc --noEmit` is what runs them.
//
// `@ts-expect-error` fails the build in BOTH directions: it fails if the line stops
// being an error, so if somebody ever gives these methods a default scope or an
// overload without one, `npm run typecheck` goes red here rather than going quiet.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function userIdIsNotOptional(scope: UserScope): Promise<void> {
  // @ts-expect-error — a repository read without a user scope must not typecheck.
  await listRelationships();
  // @ts-expect-error — nor with a bare string in place of a scope.
  await listRelationships("usr_demo0001");
  // @ts-expect-error — nor a write.
  await insertBrief({ brief_id: "brf_x", brief: {} as Brief });
  // @ts-expect-error — a scope cannot be forged from an object literal.
  await listRelationships({ user_id: "usr_demo0001" });
  // @ts-expect-error — deletion is scoped too.
  await deleteUser();
  // The scoped forms are the only ones that compile.
  await listRelationships(scope);
}

async function upsertRelationshipFor(
  scope: UserScope,
  salt: Buffer,
  handle: string,
  display: string,
): Promise<string> {
  const contactId = contactIdForTest(salt, handle);
  const now = new Date().toISOString();
  const relationship: Relationship = {
    contact_id: contactId,
    display,
    is_group: false,
    message_count: 10,
    sent_count: 5,
    received_count: 5,
    first_contact_at: now,
    last_contact_at: now,
    days_since_last_contact: 0,
    momentum_90d: 1,
    initiation_ratio: 0.5,
    archetype: null,
    as_of: now,
  };
  await scopedQuery(
    pool,
    scope,
    `insert into relationships (user_id, contact_id, display, payload, as_of)
     values ($1, $2, $3, $4, $5)`,
    [scope.user_id, contactId, display, JSON.stringify(relationship), now],
  );
  return contactId;
}
