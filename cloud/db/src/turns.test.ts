import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomInt } from "node:crypto";

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
  return `+1666${String(randomInt(0, 9_000_000) + phoneCounter).padStart(7, "0").slice(-7)}`;
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

  it("claims encrypted reply and no-reply exchanges atomically and idempotently", async () => {
    const user = await createUser({ phone_e164: phone() }, pool);
    const occurred = new Date("2026-08-05T12:00:00.000Z");
    const inbound = turn("turn_in_atomic", occurred);
    const outbound = { ...turn("turn_out_atomic", occurred), direction: "outbound" as const };
    const reply = { event_key: "8".repeat(32), delivery_key: "9".repeat(32), inbound, outbound };
    await expect(repository.claimEncryptedOutcome(user.scope, reply)).resolves.toMatchObject({ claimed: true });
    await expect(repository.claimEncryptedOutcome(user.scope, reply)).resolves.toMatchObject({ claimed: false });
    await expect(repository.claimEncryptedOutcome(user.scope, {
      event_key: "0".repeat(32),
      delivery_key: "f".repeat(32),
      inbound: turn("turn_in_without_reply", occurred),
      outbound: null,
    })).resolves.toMatchObject({ claimed: true, state: { delivery_status: "no_reply" } });
    const rows = await pool.query<{ direction: string; n: string }>(
      "select direction, count(*)::text as n from turns where user_id = $1 group by direction order by direction",
      [user.scope.user_id],
    );
    expect(rows.rows).toEqual([{ direction: "inbound", n: "2" }, { direction: "outbound", n: "1" }]);
    await pool.query("delete from users where user_id = $1", [user.scope.user_id]);
  });

  it("keeps the first encrypted outbound canonical across changed and concurrent claims", async () => {
    const user = await createUser({ phone_e164: phone() }, pool);
    const occurred = new Date("2026-08-05T12:00:00.000Z");
    const canonical = { ...turn("turn_out_canonical", occurred), direction: "outbound" as const };
    const changed = { ...canonical, ciphertext: Buffer.from("changed-model-output") };
    const first = await repository.claimEncryptedOutcome(user.scope, {
      event_key: "a".repeat(32),
      delivery_key: "b".repeat(32),
      inbound: turn("turn_in_canonical", occurred),
      outbound: canonical,
    });
    const retry = await repository.claimEncryptedOutcome(user.scope, {
      event_key: "a".repeat(32),
      delivery_key: "c".repeat(32),
      inbound: turn("turn_in_canonical", occurred),
      outbound: changed,
    });
    expect(first.claimed).toBe(true);
    expect(retry.claimed).toBe(false);
    expect(retry.state.delivery_key).toBe("b".repeat(32));
    expect(retry.state.outbound?.ciphertext).toEqual(canonical.ciphertext);

    const raceInputs = ["race-one", "race-two"].map((ciphertext) => ({
      event_key: "d".repeat(32),
      delivery_key: "e".repeat(32),
      inbound: turn("turn_in_race", occurred),
      outbound: { ...turn("turn_out_race", occurred), direction: "outbound" as const, ciphertext: Buffer.from(ciphertext) },
    }));
    const raced = await Promise.all(raceInputs.map((input) => repository.claimEncryptedOutcome(user.scope, input)));
    expect(raced.filter((result) => result.claimed)).toHaveLength(1);
    expect(raced[0]!.state.outbound?.ciphertext).toEqual(raced[1]!.state.outbound?.ciphertext);

    await repository.markEncryptedOutcomeDelivered(user.scope, "a".repeat(32), "b".repeat(32));
    await repository.markEncryptedOutcomeDelivered(user.scope, "a".repeat(32), "b".repeat(32));
    await expect(repository.encryptedOutcomeFor(user.scope, "a".repeat(32))).resolves
      .toMatchObject({ delivery_status: "sent", delivery_key: "b".repeat(32) });
    await pool.query("delete from users where user_id = $1", [user.scope.user_id]);
  });

  it("persists a canonical no-reply state that a later text cannot widen", async () => {
    const user = await createUser({ phone_e164: phone() }, pool);
    const occurred = new Date("2026-08-05T12:00:00.000Z");
    const first = await repository.claimEncryptedOutcome(user.scope, {
      event_key: "1".repeat(32),
      delivery_key: "2".repeat(32),
      inbound: turn("turn_in_silent", occurred),
      outbound: null,
    });
    const retry = await repository.claimEncryptedOutcome(user.scope, {
      event_key: "1".repeat(32),
      delivery_key: "3".repeat(32),
      inbound: turn("turn_in_silent", occurred),
      outbound: { ...turn("turn_out_late", occurred), direction: "outbound" as const },
    });
    expect(first.state).toMatchObject({ delivery_status: "no_reply", outbound: null });
    expect(retry).toMatchObject({ claimed: false, state: { delivery_status: "no_reply", outbound: null } });
    await pool.query("delete from users where user_id = $1", [user.scope.user_id]);
  });

  it("purges rows at the 90-day boundary and is idempotent", async () => {
    const user = await createUser({ phone_e164: phone() }, pool);
    const boundary = new Date("2026-11-03T12:00:00.000Z");
    await repository.claimEncryptedOutcome(user.scope, {
      event_key: "4".repeat(32),
      delivery_key: "5".repeat(32),
      inbound: turn("turn_expired", new Date("2026-08-05T12:00:00.000Z")),
      outbound: null,
    });
    await repository.appendEncryptedTurn(user.scope, turn("turn_future", new Date("2026-08-05T12:00:00.001Z")));
    await expect(repository.purgeExpiredTurns(boundary)).resolves.toBe(1);
    await expect(repository.purgeExpiredTurns(boundary)).resolves.toBe(0);
    const remaining = await pool.query<{ turn_id: string }>(
      "select turn_id from turns where user_id = $1",
      [user.scope.user_id],
    );
    expect(remaining.rows).toEqual([{ turn_id: "turn_future" }]);
    const outbox = await pool.query("select 1 from inbound_outbox where user_id = $1", [user.scope.user_id]);
    expect(outbox.rowCount).toBe(0);
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
    await repository.claimEncryptedOutcome(user.scope, {
      event_key: "6".repeat(32),
      delivery_key: "7".repeat(32),
      inbound: turn("turn_cascade", new Date("2026-08-05T12:00:00.000Z")),
      outbound: null,
    });

    const deleted = await pool.query("delete from users where user_id = $1", [user.scope.user_id]);
    expect(deleted.rowCount).toBe(1);
    const residue = await pool.query<{ handles: string; turns: string; outbox: string }>(`
      select
        (select count(*)::text from contact_handles where user_id = $1) as handles,
        (select count(*)::text from turns where user_id = $1) as turns,
        (select count(*)::text from inbound_outbox where user_id = $1) as outbox
    `, [user.scope.user_id]);
    expect(residue.rows[0]).toEqual({ handles: "0", turns: "0", outbox: "0" });
  });
});
