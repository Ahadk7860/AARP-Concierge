import { getPool, type Queryable } from "./pool.js";
import { scopedQuery, type UserScope } from "./scope.js";
import type {
  EncryptedContactHandle,
  EncryptedTurn,
  Phase2PrivateRepository,
} from "./repository.js";

type ContactHandleRow = EncryptedContactHandle & { user_id: string };

/** PostgreSQL implementation of the frozen ciphertext-only Phase 2 storage seam. */
export class PostgresPhase2PrivateRepository implements Phase2PrivateRepository {
  constructor(private readonly db: Queryable = getPool()) {}

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

  /**
   * Atomically claims an inbound turn and, when present, stores its reply.
   * `false` means this provider event was already committed, so callers must not deliver
   * its reply twice after stream redelivery.
   */
  async appendEncryptedExchangeOnce(
    scope: UserScope,
    inbound: EncryptedTurn,
    outbound: EncryptedTurn | null,
  ): Promise<boolean> {
    assertEncryptedTurn(inbound);
    if (inbound.direction !== "inbound") throw new Error("private_turn_direction_invalid");
    if (outbound !== null) {
      assertEncryptedTurn(outbound);
      if (outbound.direction !== "outbound") throw new Error("private_turn_direction_invalid");
    }

    const result = await scopedQuery<{ user_id: string; inserted: boolean }>(this.db, scope, `
      with inbound_insert as (
        insert into turns
          (user_id, turn_id, direction, ciphertext, key_envelope, occurred_at, expires_at)
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (user_id, turn_id) do nothing
        returning user_id
      ), outbound_insert as (
        insert into turns
          (user_id, turn_id, direction, ciphertext, key_envelope, occurred_at, expires_at)
        select $1, $8, $9, $10, $11, $12, $13
         where $8::text is not null and exists (select 1 from inbound_insert)
        on conflict (user_id, turn_id) do nothing
      )
      select $1::text as user_id, exists (select 1 from inbound_insert) as inserted
    `, [
      ...turnParams(scope, inbound),
      outbound?.turn_id ?? null,
      outbound?.direction ?? null,
      outbound?.ciphertext ?? null,
      outbound?.key_envelope ?? null,
      outbound?.occurred_at ?? null,
      outbound?.expires_at ?? null,
    ]);
    return result.rows[0]?.inserted === true;
  }

  async purgeExpiredTurns(now: Date): Promise<number> {
    assertDate(now);
    const result = await this.db.query("delete from turns where expires_at <= $1", [now]);
    return result.rowCount ?? 0;
  }
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
