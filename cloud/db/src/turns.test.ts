import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresPhase2PrivateRepository } from "./encrypted.js";
import { createUser } from "./repository.js";
import { getPool, closePool } from "./pool.js";
import { migrate } from "./migrate.js";
import { acquireSuiteLock, releaseSuiteLock } from "./test-lock.js";

const pool = getPool();
const repository = new PostgresPhase2PrivateRepository(pool);
let phoneCounter = 0;

beforeAll(async () => {
  await acquireSuiteLock();
  await migrate(pool);
  await pool.query("set timezone to 'UTC'");
}, 120_000);

afterAll(async () => {
  await closePool();
  await releaseSuiteLock();
});

function phone(): string {
  phoneCounter += 1;
  return `+1666${String(1_000_000 + phoneCounter).slice(-7)}`;
}

function turn(id: string, occurredAt: Date) {
  return {
    turn_id: id,
    direction: "inbound" as const,
    ciphertext: Buffer.from(`cipher-${id}`),
    key_envelope: Buffer.from(`envelope-${id}`),
    occurred_at: occurredAt,
    expires_at: new Date(occurredAt.getTime() + 90 * 24 * 60 * 60 * 1_000),
  };
}

describe("PostgresPhase2PrivateRepository", () => {
  it("stores only encrypted handle fields and scopes reads by user", async () => {
    const a = await createUser({ phone_e164: phone() }, pool);
    const b = await createUser({ phone_e164: phone() }, pool);
    const encrypted = {
      contact_id: "h_8f21a4c0",
      ciphertext: Buffer.from("ciphertext-not-a-handle"),
      key_envelope: Buffer.from("envelope-metadata"),
      algorithm: "aes-256-gcm" as const,
    };
    await repository.putEncryptedContactHandle(a.scope, encrypted);
    await expect(repository.encryptedContactHandleFor(a.scope, encrypted.contact_id)).resolves.toEqual(encrypted);
    await expect(repository.encryptedContactHandleFor(b.scope, encrypted.contact_id)).resolves.toBeNull();
    await pool.query("delete from users where user_id = any($1::text[])", [[a.scope.user_id, b.scope.user_id]]);
  });

  it("claims an encrypted exchange atomically and idempotently", async () => {
    const user = await createUser({ phone_e164: phone() }, pool);
    const occurred = new Date("2026-08-05T12:00:00.000Z");
    const inbound = turn("turn_in_atomic", occurred);
    const outbound = { ...turn("turn_out_atomic", occurred), direction: "outbound" as const };
    await expect(repository.appendEncryptedExchangeOnce(user.scope, inbound, outbound)).resolves.toBe(true);
    await expect(repository.appendEncryptedExchangeOnce(user.scope, inbound, outbound)).resolves.toBe(false);
    await expect(repository.appendEncryptedExchangeOnce(
      user.scope,
      turn("turn_in_without_reply", occurred),
      null,
    )).resolves.toBe(true);
    const rows = await pool.query<{ direction: string; n: string }>(
      "select direction, count(*)::text as n from turns where user_id = $1 group by direction order by direction",
      [user.scope.user_id],
    );
    expect(rows.rows).toEqual([{ direction: "inbound", n: "2" }, { direction: "outbound", n: "1" }]);
    await pool.query("delete from users where user_id = $1", [user.scope.user_id]);
  });

  it("purges rows at the 90-day boundary and is idempotent", async () => {
    const user = await createUser({ phone_e164: phone() }, pool);
    const boundary = new Date("2026-11-03T12:00:00.000Z");
    await repository.appendEncryptedTurn(user.scope, turn("turn_expired", new Date("2026-08-05T12:00:00.000Z")));
    await repository.appendEncryptedTurn(user.scope, turn("turn_future", new Date("2026-08-05T12:00:00.001Z")));
    await expect(repository.purgeExpiredTurns(boundary)).resolves.toBe(1);
    await expect(repository.purgeExpiredTurns(boundary)).resolves.toBe(0);
    const remaining = await pool.query<{ turn_id: string }>(
      "select turn_id from turns where user_id = $1",
      [user.scope.user_id],
    );
    expect(remaining.rows).toEqual([{ turn_id: "turn_future" }]);
    await pool.query("delete from users where user_id = $1", [user.scope.user_id]);
  });

  it("deletes private rows by user-first cascade with no second cleanup pass", async () => {
    const user = await createUser({ phone_e164: phone() }, pool);
    await repository.putEncryptedContactHandle(user.scope, {
      contact_id: "h_8f21a4c0",
      ciphertext: Buffer.from("ciphertext"),
      key_envelope: Buffer.from("envelope"),
      algorithm: "aes-256-gcm",
    });
    await repository.appendEncryptedTurn(user.scope, turn("turn_cascade", new Date("2026-08-05T12:00:00.000Z")));

    const deleted = await pool.query("delete from users where user_id = $1", [user.scope.user_id]);
    expect(deleted.rowCount).toBe(1);
    const residue = await pool.query<{ handles: string; turns: string }>(`
      select
        (select count(*)::text from contact_handles where user_id = $1) as handles,
        (select count(*)::text from turns where user_id = $1) as turns
    `, [user.scope.user_id]);
    expect(residue.rows[0]).toEqual({ handles: "0", turns: "0" });
  });
});
