// The repository layer.
//
// Every method takes a `UserScope` first. There is no overload without one, no default
// parameter, and no method that accepts two user ids -- so a cross-user read is not
// something you have to remember not to write; it is something you cannot write and
// still typecheck. `scopedQuery` enforces the same rule again at runtime.
//
// The one lookup that legitimately begins without a user is pairing-code resolution,
// and it lives in `bootstrapLookups` at the bottom of this file, isolated and
// returning nothing but an id.

import type { Digest, Relationship, VoicePack, Brief, OutboundBlock } from "../../shared/src/index.js";
import { getPool, withTransaction, type Queryable } from "./pool.js";
import { residueByTable } from "./catalog.js";
import { unsafeScopeFromUserId, scopedQuery, type UserScope } from "./scope.js";
import {
  newUserId,
  newUserSalt,
  newDeviceToken,
  hashDeviceToken,
  userIdFromDeviceToken,
  deviceTokenHashEquals,
} from "./ids.js";

/** 'mismatch' means the first send came back as sms — see migration 006. */
export type HandleStatus = "unknown" | "imessage" | "mismatch" | "unreachable";

export type UserRow = {
  user_id: string;
  phone_e164: string;
  email: string | null;
  user_salt: Buffer;
  timezone: string;
  handle_status: HandleStatus;
  created_at: Date;
};

export type DeviceRow = {
  user_id: string;
  device_id: string;
  platform: string;
  last_heartbeat_at: Date | null;
  created_at: Date;
};

export type RelationshipRow = {
  user_id: string;
  contact_id: string;
  display: string;
  payload: Relationship;
  as_of: Date;
};

export type DigestRow = {
  user_id: string;
  digest_id: string;
  device_id: string;
  generated_at: Date;
  corpus_health: string;
  payload: Digest;
  as_of: Date;
  received_at: Date;
};

export type VoicePackRow = {
  user_id: string;
  voice_pack_version: string;
  scope: "contact" | "global";
  contact_id: string | null;
  n_exemplars: number | null;
  payload: VoicePack;
  as_of: Date;
  received_at: Date;
};

export type BriefRow = {
  user_id: string;
  brief_id: string;
  scheduled_for: Date;
  payload: Brief;
  digest_as_of: Date;
  hours_stale: string;
  warn: boolean;
  item_count: number;
  card_url: string | null;
  created_at: Date;
  delivered_at: Date | null;
};

export type MessageOutRow = {
  user_id: string;
  message_id: string;
  idempotency_key: string;
  brief_id: string | null;
  blocks: OutboundBlock[];
  status: "pending" | "sent" | "failed";
  provider: string | null;
  provider_message_id: string | null;
  protocol: "imessage" | "rcs" | "sms" | null;
  created_at: Date;
  sent_at: Date | null;
};

export class ResidualUserDataError extends Error {
  constructor(readonly residue: Record<string, number>) {
    super(`delete left rows behind: ${JSON.stringify(residue)}`);
    this.name = "ResidualUserDataError";
  }
}

// ---------------------------------------------------------------------------
// Account creation and deletion
// ---------------------------------------------------------------------------

export type CreatedUser = { scope: UserScope; user_salt: Buffer };

/**
 * Create an account. The salt is issued exactly once, here, and never rotated --
 * rotating it would orphan every contact_id the Mac has already computed.
 *
 * This is the one write that has no scope to take as an argument, because it is the
 * write that brings the scope into existence. It returns one.
 */
export async function createUser(
  input: { phone_e164: string; email?: string | null; timezone?: string },
  db: Queryable = getPool(),
): Promise<CreatedUser> {
  const userId = newUserId();
  const salt = newUserSalt();
  await db.query(
    `insert into users (user_id, phone_e164, email, user_salt, timezone)
     values ($1, $2, $3, $4, coalesce($5, 'America/Los_Angeles'))`,
    [userId, input.phone_e164, input.email ?? null, salt, input.timezone ?? null],
  );
  return { scope: unsafeScopeFromUserId(userId), user_salt: salt };
}

export async function getUser(
  scope: UserScope,
  db: Queryable = getPool(),
): Promise<UserRow | null> {
  const res = await scopedQuery<UserRow>(
    db,
    scope,
    `select user_id, phone_e164, email, user_salt, timezone, handle_status, created_at
       from users where user_id = $1`,
    [scope.user_id],
  );
  return res.rows[0] ?? null;
}

/**
 * Delete everything, derived data included.
 *
 * ONE statement. Every user-data table has an FK to `users` with `on delete cascade`,
 * so the cascade reaches derived rows in the same operation -- there is no second pass
 * to forget and no table to add to a list. Cascade is the mechanism; partitioning
 * never was (CONTRACTS.md section 3, corrected 2 Aug).
 *
 * The residue assertion is not test scaffolding: it walks foreign keys from `users` on
 * every real delete, so a table added next month that somehow escapes the cascade
 * fails the request loudly instead of leaving user data behind quietly. One-click
 * delete that leaves derived rows behind is the gap the FTC prosecutes.
 *
 * STILL OPEN: section 3 also counts derived data outside Postgres. A rendered card at
 * `briefs.card_url` is derived data and nothing here reaches it. Prompt 04 owns that.
 */
export async function deleteUser(
  scope: UserScope,
  pool = getPool(),
): Promise<{ deleted: boolean; verified_tables: string[] }> {
  return withTransaction(async (tx) => {
    const res = await scopedQuery(tx, scope, "delete from users where user_id = $1", [
      scope.user_id,
    ]);

    const residue = await residueByTable(scope.user_id, tx);
    const leftover = Object.fromEntries(
      Object.entries(residue).filter(([, n]) => n > 0),
    );
    if (Object.keys(leftover).length > 0) {
      throw new ResidualUserDataError(leftover);
    }

    return { deleted: (res.rowCount ?? 0) > 0, verified_tables: Object.keys(residue).sort() };
  }, pool);
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export async function setHandleStatus(
  scope: UserScope,
  status: HandleStatus,
  db: Queryable = getPool(),
): Promise<void> {
  await scopedQuery(db, scope, "update users set handle_status = $2 where user_id = $1", [
    scope.user_id,
    status,
  ]);
}

/** Signup needs to know whether this phone already has an account. Phone is the join key. */
export async function findUserIdByPhone(
  phoneE164: string,
  db: Queryable = getPool(),
): Promise<UserScope | null> {
  // Unscoped by necessity and by nature: it resolves the ACCOUNT HOLDER's own handle,
  // which is the one handle CONTRACTS.md section 3 says the server does see. Returns an
  // id and nothing else, like the two lookups in `bootstrapLookups`.
  const res = await db.query<{ user_id: string }>(
    "select user_id from users where phone_e164 = $1",
    [phoneE164],
  );
  const row = res.rows[0];
  return row === undefined ? null : unsafeScopeFromUserId(row.user_id);
}

export async function registerDevice(
  scope: UserScope,
  input: { device_id: string; platform?: string },
  db: Queryable = getPool(),
): Promise<{ device_token: string }> {
  const { token, hash } = newDeviceToken(scope.user_id);
  await scopedQuery(
    db,
    scope,
    `insert into devices (user_id, device_id, device_token_hash, platform)
     values ($1, $2, $3, coalesce($4, 'macos'))
     on conflict (user_id, device_id)
     do update set device_token_hash = excluded.device_token_hash`,
    [scope.user_id, input.device_id, hash, input.platform ?? null],
  );
  return { device_token: token };
}

export type HeartbeatFields = {
  app_version?: string | null;
  /** What the DEVICE last computed — not what the server holds. See migration 005. */
  digest_as_of?: string | null;
  macos_version?: string | null;
  fda_granted?: boolean | null;
};

export async function recordHeartbeat(
  scope: UserScope,
  deviceId: string,
  at: Date,
  fields: HeartbeatFields = {},
  db: Queryable = getPool(),
): Promise<boolean> {
  const res = await scopedQuery(
    db,
    scope,
    `update devices
        set last_heartbeat_at = $3,
            app_version   = coalesce($4, app_version),
            digest_as_of  = coalesce($5, digest_as_of),
            macos_version = coalesce($6, macos_version),
            fda_granted   = coalesce($7, fda_granted)
      where user_id = $1 and device_id = $2`,
    [
      scope.user_id,
      deviceId,
      at.toISOString(),
      fields.app_version ?? null,
      fields.digest_as_of ?? null,
      fields.macos_version ?? null,
      fields.fda_granted ?? null,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

export type DeviceStateRow = {
  device_id: string;
  last_heartbeat_at: Date | null;
  app_version: string | null;
  digest_as_of: Date | null;
  macos_version: string | null;
  fda_granted: boolean | null;
};

export async function getDeviceState(
  scope: UserScope,
  deviceId: string,
  db: Queryable = getPool(),
): Promise<DeviceStateRow | null> {
  const res = await scopedQuery<DeviceStateRow>(
    db,
    scope,
    `select device_id, last_heartbeat_at, app_version, digest_as_of, macos_version, fda_granted
       from devices where user_id = $1 and device_id = $2`,
    [scope.user_id, deviceId],
  );
  return res.rows[0] ?? null;
}

/** Does this device belong to this user? The ingest routes will not trust a body's claim. */
export async function deviceBelongsToUser(
  scope: UserScope,
  deviceId: string,
  db: Queryable = getPool(),
): Promise<boolean> {
  const res = await scopedQuery(
    db,
    scope,
    "select 1 from devices where user_id = $1 and device_id = $2",
    [scope.user_id, deviceId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function listDevices(
  scope: UserScope,
  db: Queryable = getPool(),
): Promise<DeviceRow[]> {
  const res = await scopedQuery<DeviceRow>(
    db,
    scope,
    `select user_id, device_id, platform, last_heartbeat_at, created_at
       from devices where user_id = $1 order by created_at`,
    [scope.user_id],
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

/** Upsert the relationships from one digest. `contact_id` arrives from the Mac. */
export async function upsertRelationships(
  scope: UserScope,
  rows: readonly Relationship[],
  db: Queryable = getPool(),
): Promise<number> {
  let n = 0;
  for (const r of rows) {
    const res = await scopedQuery(
      db,
      scope,
      `insert into relationships (user_id, contact_id, display, payload, as_of)
       values ($1, $2, $3, $4, $5)
       on conflict (user_id, contact_id) do update
         set display = excluded.display,
             payload = excluded.payload,
             as_of   = excluded.as_of
       where relationships.as_of <= excluded.as_of`,
      [scope.user_id, r.contact_id, r.display, JSON.stringify(r), r.as_of],
    );
    n += res.rowCount ?? 0;
  }
  return n;
}

export async function listRelationships(
  scope: UserScope,
  db: Queryable = getPool(),
): Promise<RelationshipRow[]> {
  const res = await scopedQuery<RelationshipRow>(
    db,
    scope,
    `select user_id, contact_id, display, payload, as_of
       from relationships where user_id = $1 order by contact_id`,
    [scope.user_id],
  );
  return res.rows;
}

/**
 * Look a relationship up by the name shown to the user.
 *
 * `display` is the one field in this table that is NOT per-user salted -- two users
 * who both know a "Maya" store the same string. That is exactly the column a
 * cross-user query would reach for, so it is scoped like everything else and there is
 * no variant of this method that omits the scope.
 */
export async function findRelationshipsByDisplay(
  scope: UserScope,
  display: string,
  db: Queryable = getPool(),
): Promise<RelationshipRow[]> {
  const res = await scopedQuery<RelationshipRow>(
    db,
    scope,
    `select user_id, contact_id, display, payload, as_of
       from relationships where user_id = $1 and display = $2 order by contact_id`,
    [scope.user_id, display],
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

export class DuplicateDigestError extends Error {
  constructor(readonly generated_at: string) {
    super(`digest already stored for generated_at ${generated_at}`);
    this.name = "DuplicateDigestError";
  }
}

/**
 * Store a digest and its relationships in one transaction.
 *
 * A repeated `generated_at` raises `DuplicateDigestError`, which is what the HTTP
 * layer turns into `409 {"error":"duplicate"}` in prompt 02.
 */
export async function insertDigest(
  scope: UserScope,
  input: { digest_id: string; digest: Digest },
  pool = getPool(),
): Promise<{ digest_id: string; relationships: number }> {
  const d = input.digest;
  return withTransaction(async (tx) => {
    try {
      await scopedQuery(
        tx,
        scope,
        `insert into digests
           (user_id, digest_id, device_id, generated_at, corpus_health, payload, as_of)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          scope.user_id,
          input.digest_id,
          d.device_id,
          d.generated_at,
          d.corpus.health,
          JSON.stringify(d),
          d.corpus.as_of,
        ],
      );
    } catch (err) {
      if (isUniqueViolation(err, /_user_id_generated_at_key$/)) {
        throw new DuplicateDigestError(d.generated_at);
      }
      throw err;
    }
    const relationships = await upsertRelationships(scope, d.relationships, tx);
    return { digest_id: input.digest_id, relationships };
  }, pool);
}

export async function latestDigest(
  scope: UserScope,
  db: Queryable = getPool(),
): Promise<DigestRow | null> {
  const res = await scopedQuery<DigestRow>(
    db,
    scope,
    `select user_id, digest_id, device_id, generated_at, corpus_health, payload, as_of, received_at
       from digests where user_id = $1 order by generated_at desc limit 1`,
    [scope.user_id],
  );
  return res.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Voice packs
// ---------------------------------------------------------------------------

/**
 * Store a voice pack.
 *
 * CONTRACTS.md section 7: the `is_from_me = 1` guard is asserted at the upload
 * boundary and a pack that fails it is rejected with `422 redaction_failed` and
 * stored NOWHERE. That validation belongs to the HTTP layer in prompt 02; this
 * function is only reached after it passes, so there is no partial-write path here.
 */
export async function upsertVoicePack(
  scope: UserScope,
  pack: VoicePack,
  db: Queryable = getPool(),
): Promise<void> {
  await scopedQuery(
    db,
    scope,
    `insert into voice_packs
       (user_id, voice_pack_version, scope, contact_id, n_exemplars, payload, as_of)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (user_id, voice_pack_version) do update
       set payload = excluded.payload, as_of = excluded.as_of`,
    [
      scope.user_id,
      pack.voice_pack_version,
      pack.scope,
      pack.contact_id,
      pack.n_exemplars ?? null,
      JSON.stringify(pack),
      pack.as_of,
    ],
  );
}

/**
 * The contact-scoped pack if there is one, else the global fallback, else null.
 *
 * The ordering uses `is not distinct from` rather than `=` because the global pack's
 * contact_id is NULL: `NULL = $2` evaluates to NULL, and `order by ... desc` sorts
 * NULLs FIRST, which would rank the global fallback above the contact pack it is only
 * supposed to back up.
 */
export async function voicePackFor(
  scope: UserScope,
  contactId: string | null,
  db: Queryable = getPool(),
): Promise<VoicePackRow | null> {
  const res = await scopedQuery<VoicePackRow>(
    db,
    scope,
    `select user_id, voice_pack_version, scope, contact_id, n_exemplars, payload, as_of, received_at
       from voice_packs
      where user_id = $1 and (contact_id = $2 or scope = 'global')
      order by (contact_id is not distinct from $2) desc, as_of desc
      limit 1`,
    [scope.user_id, contactId],
  );
  return res.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Briefs and outbound messages
// ---------------------------------------------------------------------------

export async function insertBrief(
  scope: UserScope,
  input: { brief_id: string; brief: Brief },
  db: Queryable = getPool(),
): Promise<void> {
  const b = input.brief;
  await scopedQuery(
    db,
    scope,
    `insert into briefs
       (user_id, brief_id, scheduled_for, payload, digest_as_of, hours_stale, warn, item_count, card_url)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (user_id, brief_id) do update
       set payload = excluded.payload, item_count = excluded.item_count`,
    [
      scope.user_id,
      input.brief_id,
      b.scheduled_for,
      JSON.stringify(b),
      b.staleness.digest_as_of,
      b.staleness.hours_stale,
      b.staleness.warn,
      b.items.length,
      b.card_url ?? null,
    ],
  );
}

export async function listBriefs(
  scope: UserScope,
  db: Queryable = getPool(),
): Promise<BriefRow[]> {
  const res = await scopedQuery<BriefRow>(
    db,
    scope,
    `select user_id, brief_id, scheduled_for, payload, digest_as_of, hours_stale, warn,
            item_count, card_url, created_at, delivered_at
       from briefs where user_id = $1 order by scheduled_for desc`,
    [scope.user_id],
  );
  return res.rows;
}

export async function insertOutboundMessage(
  scope: UserScope,
  input: {
    message_id: string;
    idempotency_key: string;
    brief_id?: string | null;
    /** Which brief item this message rendered. Null for the lead and for non-brief sends. */
    item_index?: number | null;
    blocks: readonly OutboundBlock[];
  },
  db: Queryable = getPool(),
): Promise<void> {
  await scopedQuery(
    db,
    scope,
    `insert into messages_out (user_id, message_id, idempotency_key, brief_id, item_index, blocks)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      scope.user_id,
      input.message_id,
      input.idempotency_key,
      input.brief_id ?? null,
      input.item_index ?? null,
      JSON.stringify(input.blocks),
    ],
  );
}

export type OutboundAttribution = {
  message_id: string;
  brief_id: string | null;
  item_index: number | null;
  provider_message_id: string | null;
};

/**
 * Resolve a provider's message id back to the brief item it rendered.
 *
 * THE MAPPING. `inbound.v1.reply_to_message_id` is the PROVIDER's id, and this is the
 * only way back to ours. Scoped: the resolver establishes the user first — from
 * `inbound.v1.user_id`, or from the account holder's own handle — so this stays a
 * single-partition read and does not become a third unscoped lookup.
 *
 * Matched, never parsed. `lmsg_`, `omsg_stub_3` and anything else a transport invents
 * all work, because nothing here looks at the prefix.
 */
export async function findOutboundByProviderMessageId(
  scope: UserScope,
  providerMessageId: string,
  db: Queryable = getPool(),
): Promise<OutboundAttribution | null> {
  const res = await scopedQuery<OutboundAttribution>(
    db,
    scope,
    `select message_id, brief_id, item_index, provider_message_id
       from messages_out
      where user_id = $1 and provider_message_id = $2
      order by created_at desc
      limit 1`,
    [scope.user_id, providerMessageId],
  );
  return res.rows[0] ?? null;
}

/** The most recent brief for a user. The fallback when threading is unavailable. */
export async function latestBrief(
  scope: UserScope,
  db: Queryable = getPool(),
): Promise<BriefRow | null> {
  const res = await scopedQuery<BriefRow>(
    db,
    scope,
    `select user_id, brief_id, scheduled_for, payload, digest_as_of, hours_stale, warn,
            item_count, card_url, created_at, delivered_at
       from briefs where user_id = $1 order by scheduled_for desc limit 1`,
    [scope.user_id],
  );
  return res.rows[0] ?? null;
}

/** Has a brief already been composed for this slot? One brief per user per day. */
export async function briefForSlot(
  scope: UserScope,
  scheduledFor: Date,
  db: Queryable = getPool(),
): Promise<BriefRow | null> {
  const res = await scopedQuery<BriefRow>(
    db,
    scope,
    `select user_id, brief_id, scheduled_for, payload, digest_as_of, hours_stale, warn,
            item_count, card_url, created_at, delivered_at
       from briefs where user_id = $1 and scheduled_for = $2`,
    [scope.user_id, scheduledFor.toISOString()],
  );
  return res.rows[0] ?? null;
}

/** Every user the scheduler must consider. Ids and timezones only — no content. */
export async function allUserSchedules(
  db: Queryable = getPool(),
): Promise<Array<{ user_id: string; timezone: string }>> {
  const res = await db.query<{ user_id: string; timezone: string }>(
    "select user_id, timezone from users order by user_id",
  );
  return res.rows;
}

/** Record what the Channel came back with. The composer never learns the protocol; this is the audit row. */
export async function markOutboundSent(
  scope: UserScope,
  idempotencyKey: string,
  result: { protocol: string; provider: string; provider_message_id?: string | null; line_id?: string | null },
  db: Queryable = getPool(),
): Promise<void> {
  await scopedQuery(
    db,
    scope,
    `update messages_out
        set status = 'sent', sent_at = now(),
            protocol = $3, provider = $4,
            provider_message_id = $5, line_id = $6
      where user_id = $1 and idempotency_key = $2`,
    [
      scope.user_id,
      idempotencyKey,
      result.protocol,
      result.provider,
      result.provider_message_id ?? null,
      result.line_id ?? null,
    ],
  );
}

export async function listOutboundMessages(
  scope: UserScope,
  db: Queryable = getPool(),
): Promise<MessageOutRow[]> {
  const res = await scopedQuery<MessageOutRow>(
    db,
    scope,
    `select user_id, message_id, idempotency_key, brief_id, blocks, status, provider,
            provider_message_id, protocol, created_at, sent_at
       from messages_out where user_id = $1 order by created_at`,
    [scope.user_id],
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export type PairingCodeRow = { code: string; expires_at: Date; consumed_at: Date | null };

/**
 * Issue a pairing code, guaranteed unique among LIVE codes across all users.
 *
 * A unique constraint cannot do this: on a hash-partitioned table it would have to
 * include `user_id`, and including `user_id` guarantees nothing about a code typed by
 * a stranger. The transactional advisory lock is real mutual exclusion on the code
 * string, so the probe-then-insert below cannot race another issuer.
 */
export async function issuePairingCode(
  scope: UserScope,
  input: { code: string; ttl_seconds: number; now?: Date },
  pool = getPool(),
): Promise<PairingCodeRow> {
  // The clock is a parameter, not `now()` in SQL. Expiry is a documented behaviour --
  // ten minutes, CONTRACTS.md's `/v1/pair` -- and a behaviour tested by sleeping is a
  // behaviour tested for eleven minutes or not at all. Every read below compares
  // against the SAME injected instant, so a test can issue at T and resolve at T+11m.
  const at = input.now ?? new Date();
  return withTransaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", [
      `pairing_code:${input.code}`,
    ]);

    // Deliberately unscoped, and it must be: the question is whether ANY user holds
    // this code. It selects the literal 1 -- no user id, no content -- so it reveals
    // only that the code is taken, which is what the caller already knows it asked.
    const live = await tx.query(
      `select 1 from pairing_codes
        where code = $1 and consumed_at is null and expires_at > $2 limit 1`,
      [input.code, at.toISOString()],
    );
    if ((live.rowCount ?? 0) > 0) {
      throw new Error(`pairing code ${input.code} is already live`);
    }

    const res = await scopedQuery<PairingCodeRow>(
      tx,
      scope,
      `insert into pairing_codes (user_id, code, created_at, expires_at)
       values ($1, $2, $3, $3::timestamptz + make_interval(secs => $4::double precision))
       on conflict (user_id, code) do update
         set expires_at = excluded.expires_at, consumed_at = null, created_at = excluded.created_at
       returning code, expires_at, consumed_at`,
      [scope.user_id, input.code, at.toISOString(), input.ttl_seconds],
    );
    const row = res.rows[0];
    if (row === undefined) throw new Error("pairing code insert returned no row");
    return row;
  }, pool);
}

/** Burn the code. Returns false if it was already consumed or has expired. */
export async function consumePairingCode(
  scope: UserScope,
  code: string,
  now: Date = new Date(),
  db: Queryable = getPool(),
): Promise<boolean> {
  const at = now.toISOString();
  const res = await scopedQuery(
    db,
    scope,
    `update pairing_codes set consumed_at = $3
      where user_id = $1 and code = $2 and consumed_at is null and expires_at > $3`,
    [scope.user_id, code, at],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * The two lookups that begin without a user, and the complete list of them.
 *
 * Both return an identifier and nothing else -- never a display name, never a
 * payload, never anything about a relationship. Anything that reads user CONTENT goes
 * through `UserScope`, with no exceptions. Keeping these here, named as what they
 * are, is what stops "just this once" from spreading into the repository proper.
 */
export const bootstrapLookups = {
  /**
   * Six digits typed by a human cannot carry a user id, so this is a scan. Uniqueness
   * among live codes is guaranteed by `issuePairingCode`, so at most one row matches.
   */
  async resolvePairingCode(
    code: string,
    now: Date = new Date(),
    db: Queryable = getPool(),
  ): Promise<UserScope | null> {
    const res = await db.query<{ user_id: string }>(
      `select user_id from pairing_codes
        where code = $1 and consumed_at is null and expires_at > $2 limit 1`,
      [code, now.toISOString()],
    );
    const row = res.rows[0];
    return row === undefined ? null : unsafeScopeFromUserId(row.user_id);
  },

  /**
   * A device token DOES carry its user id (`<user_id>.<secret>`), so this reads a
   * single partition. The id half is untrusted routing information; the random half
   * is what authenticates, compared in constant time against the stored SHA-256.
   */
  async authenticateDeviceToken(
    cleartext: string,
    db: Queryable = getPool(),
  ): Promise<{ scope: UserScope; device_id: string } | null> {
    const userId = userIdFromDeviceToken(cleartext);
    if (userId === null) return null;

    const scope = unsafeScopeFromUserId(userId);
    const presented = hashDeviceToken(cleartext);
    const res = await scopedQuery<{ device_id: string; device_token_hash: Buffer }>(
      db,
      scope,
      "select device_id, device_token_hash from devices where user_id = $1",
      [scope.user_id],
    );
    for (const row of res.rows) {
      if (deviceTokenHashEquals(row.device_token_hash, presented)) {
        return { scope, device_id: row.device_id };
      }
    }
    return null;
  },
} as const;

// ---------------------------------------------------------------------------

/**
 * A UNIQUE violation on a partitioned table names the offending PARTITION's index --
 * `digests_p3_user_id_generated_at_key`, not a constraint name declared on the parent.
 * Matching the column-derived suffix is therefore the stable test, and it stays
 * correct however many partitions exist.
 */
function isUniqueViolation(err: unknown, constraint: RegExp): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === "23505" && e.constraint !== undefined && constraint.test(e.constraint);
}
