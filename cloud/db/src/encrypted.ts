import pg from "pg";

import { getPool, withTransaction, type Queryable } from "./pool.js";
import { scopedQuery, type UserScope } from "./scope.js";
import type {
  EncryptedContactHandle,
  EncryptedTurn,
  Phase2PrivateRepository,
} from "./repository.js";

type ContactHandleRow = EncryptedContactHandle & { user_id: string };

export type EncryptedOutboxState = {
  event_key: string;
  delivery_key: string;
  delivery_status: "pending" | "sent" | "no_reply";
  inbound_turn_id: string;
  outbound: EncryptedTurn | null;
};

type OutboxRow = {
  user_id: string;
  event_key: string;
  delivery_key: string;
  delivery_status: EncryptedOutboxState["delivery_status"];
  inbound_turn_id: string;
  outbound_turn_id: string | null;
  direction: EncryptedTurn["direction"] | null;
  ciphertext: Buffer | null;
  key_envelope: Buffer | null;
  occurred_at: Date | null;
  expires_at: Date | null;
};

/** PostgreSQL implementation of the frozen ciphertext-only Phase 2 storage seam. */
export class PostgresPhase2PrivateRepository implements Phase2PrivateRepository {
  constructor(private readonly db: pg.Pool = getPool()) {}

  async putEncryptedContactHandle(scope: UserScope, handle: EncryptedContactHandle): Promise<void> {
    assertEncryptedHandle(handle);
    await scopedQuery(this.db, scope, `
      insert into contact_handles
        (user_id, contact_id, ciphertext, key_envelope, algorithm)
      values ($1, $2, $3, $4, $5)
      on conflict (user_id, contact_id) do update
        set ciphertext = excluded.ciphertext,
            key_envelope = excluded.key_envelope,
            algorithm = excluded.algorithm,
            updated_at = now()
    `, [scope.user_id, handle.contact_id, handle.ciphertext, handle.key_envelope, handle.algorithm]);
  }

  async encryptedContactHandleFor(
    scope: UserScope,
    contactId: string,
  ): Promise<EncryptedContactHandle | null> {
    const result = await scopedQuery<ContactHandleRow>(this.db, scope, `
      select user_id, contact_id, ciphertext, key_envelope, algorithm
        from contact_handles
       where user_id = $1 and contact_id = $2
    `, [scope.user_id, contactId]);
    const row = result.rows[0];
    if (row === undefined) return null;
    const handle: EncryptedContactHandle = {
      contact_id: row.contact_id,
      ciphertext: row.ciphertext,
      key_envelope: row.key_envelope,
      algorithm: row.algorithm,
    };
    assertEncryptedHandle(handle);
    return handle;
  }

  async appendEncryptedTurn(scope: UserScope, turn: EncryptedTurn): Promise<void> {
    assertEncryptedTurn(turn);
    await scopedQuery(this.db, scope, `
      insert into turns
        (user_id, turn_id, direction, ciphertext, key_envelope, occurred_at, expires_at)
      values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (user_id, turn_id) do nothing
    `, turnParams(scope, turn));
  }

  async encryptedOutcomeFor(scope: UserScope, eventKey: string): Promise<EncryptedOutboxState | null> {
    assertOpaqueKey(eventKey);
    return readOutcome(this.db, scope, eventKey);
  }

  /**
   * Serializes claims on the user's durable row, then writes inbound turn, canonical
   * outbound turn, and outbox state in one transaction. A concurrent loser reads the
   * winner's encrypted canonical output and can never substitute its recomputation.
   */
  async claimEncryptedOutcome(
    scope: UserScope,
    input: { event_key: string; delivery_key: string; inbound: EncryptedTurn; outbound: EncryptedTurn | null },
  ): Promise<{ claimed: boolean; state: EncryptedOutboxState }> {
    assertOpaqueKey(input.event_key);
    assertOpaqueKey(input.delivery_key);
    assertEncryptedTurn(input.inbound);
    if (input.inbound.direction !== "inbound") throw new Error("private_turn_direction_invalid");
    if (input.outbound !== null) {
      assertEncryptedTurn(input.outbound);
      if (input.outbound.direction !== "outbound") throw new Error("private_turn_direction_invalid");
    }

    return withTransaction(async (tx) => {
      // A stable per-user row makes the read-then-insert safe across processes and avoids
      // the READ COMMITTED visibility hole in `on conflict do nothing` CTE tricks.
      await scopedQuery(tx, scope, "select user_id from users where user_id = $1 for update", [scope.user_id]);
      const existing = await readOutcome(tx, scope, input.event_key);
      if (existing !== null) return { claimed: false, state: existing };

      await insertTurn(tx, scope, input.inbound);
      if (input.outbound !== null) await insertTurn(tx, scope, input.outbound);
      await scopedQuery(tx, scope, `
        insert into inbound_outbox
          (user_id, event_key, inbound_turn_id, outbound_turn_id, delivery_key, delivery_status)
        values ($1, $2, $3, $4, $5, $6)
      `, [
        scope.user_id,
        input.event_key,
        input.inbound.turn_id,
        input.outbound?.turn_id ?? null,
        input.delivery_key,
        input.outbound === null ? "no_reply" : "pending",
      ]);
      const state = await readOutcome(tx, scope, input.event_key);
      if (state === null) throw new Error("encrypted_outbox_claim_failed");
      return { claimed: true, state };
    }, this.db);
  }

  async markEncryptedOutcomeDelivered(scope: UserScope, eventKey: string, deliveryKey: string): Promise<void> {
    assertOpaqueKey(eventKey);
    assertOpaqueKey(deliveryKey);
    const result = await scopedQuery<{ user_id: string }>(this.db, scope, `
      update inbound_outbox
         set delivery_status = 'sent', delivered_at = coalesce(delivered_at, now())
       where user_id = $1 and event_key = $2 and delivery_key = $3
         and delivery_status in ('pending', 'sent')
      returning user_id
    `, [scope.user_id, eventKey, deliveryKey]);
    if (result.rowCount !== 1) throw new Error("encrypted_outbox_delivery_state_invalid");
  }

  async purgeExpiredTurns(now: Date): Promise<number> {
    assertDate(now);
    return withTransaction(async (tx) => {
      // Remove delivery metadata first so it can never point at a purged canonical turn.
      await tx.query(`
        delete from inbound_outbox o
         using turns t
         where t.user_id = o.user_id and t.turn_id = o.inbound_turn_id
           and t.expires_at <= $1
      `, [now]);
      const result = await tx.query("delete from turns where expires_at <= $1", [now]);
      return result.rowCount ?? 0;
    }, this.db);
  }
}

async function insertTurn(db: Queryable, scope: UserScope, turn: EncryptedTurn): Promise<void> {
  await scopedQuery(db, scope, `
    insert into turns
      (user_id, turn_id, direction, ciphertext, key_envelope, occurred_at, expires_at)
    values ($1, $2, $3, $4, $5, $6, $7)
  `, turnParams(scope, turn));
}

async function readOutcome(db: Queryable, scope: UserScope, eventKey: string): Promise<EncryptedOutboxState | null> {
  const result = await scopedQuery<OutboxRow>(db, scope, `
    select o.user_id, o.event_key, o.delivery_key, o.delivery_status, o.inbound_turn_id,
           o.outbound_turn_id, t.direction, t.ciphertext, t.key_envelope,
           t.occurred_at, t.expires_at
      from inbound_outbox o
      left join turns t
        on t.user_id = o.user_id and t.turn_id = o.outbound_turn_id
     where o.user_id = $1 and o.event_key = $2
  `, [scope.user_id, eventKey]);
  const row = result.rows[0];
  if (row === undefined) return null;
  const outbound = row.outbound_turn_id === null ? null : encryptedTurnFromRow(row);
  if ((row.delivery_status === "no_reply") !== (outbound === null)) throw new Error("encrypted_outbox_corrupt");
  return {
    event_key: row.event_key,
    delivery_key: row.delivery_key,
    delivery_status: row.delivery_status,
    inbound_turn_id: row.inbound_turn_id,
    outbound,
  };
}

function encryptedTurnFromRow(row: OutboxRow): EncryptedTurn {
  if (row.outbound_turn_id === null || row.direction !== "outbound" || row.ciphertext === null ||
      row.key_envelope === null || row.occurred_at === null || row.expires_at === null) {
    throw new Error("encrypted_outbox_corrupt");
  }
  const turn: EncryptedTurn = {
    turn_id: row.outbound_turn_id,
    direction: row.direction,
    ciphertext: row.ciphertext,
    key_envelope: row.key_envelope,
    occurred_at: row.occurred_at,
    expires_at: row.expires_at,
  };
  assertEncryptedTurn(turn);
  return turn;
}

function turnParams(scope: UserScope, turn: EncryptedTurn): readonly unknown[] {
  return [
    scope.user_id,
    turn.turn_id,
    turn.direction,
    turn.ciphertext,
    turn.key_envelope,
    turn.occurred_at,
    turn.expires_at,
  ];
}

function assertEncryptedHandle(handle: EncryptedContactHandle): void {
  if (!/^h_[0-9a-f]{8,32}$/u.test(handle.contact_id) || handle.algorithm !== "aes-256-gcm" ||
      handle.ciphertext.length === 0 || handle.key_envelope.length === 0) {
    throw new Error("encrypted_contact_handle_invalid");
  }
}

function assertEncryptedTurn(turn: EncryptedTurn): void {
  assertDate(turn.occurred_at);
  assertDate(turn.expires_at);
  if (turn.turn_id.length === 0 || turn.turn_id.length > 128 || turn.ciphertext.length === 0 ||
      turn.key_envelope.length === 0 ||
      turn.expires_at.getTime() !== turn.occurred_at.getTime() + 90 * 24 * 60 * 60 * 1_000) {
    throw new Error("encrypted_turn_invalid");
  }
}

function assertDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) throw new Error("private_turn_date_invalid");
}

function assertOpaqueKey(value: string): void {
  if (!/^[0-9a-f]{32}$/u.test(value)) throw new Error("encrypted_outbox_key_invalid");
}
