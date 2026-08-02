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
import type { Digest, VoicePack, Brief, Relationship } from "@boi/shared";
import { getPool, closePool, withTransaction } from "./pool.js";
import { migrate, rollbackAll, loadMigrations, MIGRATIONS_DIR } from "./migrate.js";
import { partitionedTables, userScopedTables, residueByTable } from "./catalog.js";
import { openUserScope, scopedQuery, UnscopedQueryError, type UserScope } from "./scope.js";
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

const FIXTURES = join(process.cwd(), "contracts", "fixtures");

async function fixture<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(join(FIXTURES, ...parts), "utf8")) as T;
}

/** The tables this schema is supposed to have. Asserted, never used as the source. */
const EXPECTED_USER_TABLES = [
  "briefs",
  "devices",
  "digests",
  "messages_out",
  "pairing_codes",
  "relationships",
  "users",
  "voice_packs",
];

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+1555${String(1_000_000 + phoneCounter).slice(-7)}`;
}

const pool = getPool();

beforeAll(async () => {
  // Prove "runs clean from empty" by actually starting from empty.
  await rollbackAll(pool);
  await migrate(pool);
}, 60_000);

afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------

describe("migrations", () => {
  it("run clean from empty and are idempotent on re-run", async () => {
    await rollbackAll(pool);

    const first = await migrate(pool);
    expect(first.applied).toEqual(["001_identity", "002_ingest", "003_pairing_and_delivery"]);
    expect(first.skipped).toEqual([]);

    const second = await migrate(pool);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["001_identity", "002_ingest", "003_pairing_and_delivery"]);

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
  it("hash-partitions every user-data table on user_id", async () => {
    const partitioned = await partitionedTables(pool);
    const byName = new Map(partitioned.map((p) => [p.table_name, p]));

    // `users` is the identity root and is deliberately not partitioned: CONTRACTS.md
    // section 3 declares `phone_e164 not null unique`, and a UNIQUE constraint on a
    // partitioned table must include the partition key. Everything holding derived
    // user data below it is partitioned, and cascades from it.
    const mustBePartitioned = EXPECTED_USER_TABLES.filter((t) => t !== "users");

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
    expect(res.rows.length).toBe(EXPECTED_USER_TABLES.length - 1);
    for (const row of res.rows) {
      expect(Number(row.n), `${row.parent} partition count`).toBe(8);
    }
  });
});

describe("the delete", () => {
  it("is one operation and leaves zero rows in every user-scoped table", async () => {
    const { scope, user_salt } = await createUser({ phone_e164: nextPhone() });

    // Seed EVERY user-scoped table, so a delete that misses one is visible.
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

    await issuePairingCode(scope, { code: "410100", ttl_seconds: 600 });

    // Every table must be NON-EMPTY first. Without this, "zero rows everywhere"
    // passes vacuously against a schema that was never seeded.
    const before = await residueByTable(scope.user_id, pool);
    expect(Object.keys(before).sort()).toEqual(EXPECTED_USER_TABLES);
    for (const [table, n] of Object.entries(before)) {
      expect(n, `${table} should be seeded before the delete`).toBeGreaterThan(0);
    }

    const result = await deleteUser(scope);
    expect(result.deleted).toBe(true);

    // Enumerated from pg_class, not from a list in this file: a table added later
    // cannot be silently missed.
    const after = await residueByTable(scope.user_id, pool);
    expect(Object.keys(after).sort()).toEqual(EXPECTED_USER_TABLES);
    for (const [table, n] of Object.entries(after)) {
      expect(n, `${table} still holds rows for the deleted user`).toBe(0);
    }
    expect(result.verified_tables).toEqual(EXPECTED_USER_TABLES);
  }, 60_000);

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
        ["usr_shortsalt", nextPhone(), Buffer.alloc(16, 7)],
      ),
    ).rejects.toThrow(/users_salt_min_32_bytes/);
  });

  it("refuses two users sharing a salt", async () => {
    const salt = Buffer.alloc(32, 9);
    await pool.query(
      `insert into users (user_id, phone_e164, user_salt) values ($1, $2, $3)`,
      ["usr_saltone", nextPhone(), salt],
    );
    await expect(
      pool.query(
        `insert into users (user_id, phone_e164, user_salt) values ($1, $2, $3)`,
        ["usr_salttwo", nextPhone(), salt],
      ),
    ).rejects.toThrow(/users_salt_unique/);
    await deleteUser(openUserScope("usr_saltone"));
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
    expect(tables.map((t) => t.table_name).sort()).toEqual(EXPECTED_USER_TABLES);
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
