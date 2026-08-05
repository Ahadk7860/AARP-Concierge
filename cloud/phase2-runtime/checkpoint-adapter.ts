// Postgres-backed durable stream cursor. One row per paired user, upserted atomically
// after the inbound router commits a processed event.

import type { SpectrumStreamCheckpoint } from "../channel/src/spectrum-stream.js";
import type { Queryable } from "../db/src/pool.js";

export class PostgresStreamCheckpoint implements SpectrumStreamCheckpoint {
  constructor(
    private readonly db: Queryable,
    private readonly user_id: string,
  ) {}

  async load(): Promise<string | null> {
    const result = await this.db.query<{ cursor: string }>(
      "select cursor from stream_checkpoints where user_id = $1",
      [this.user_id],
    );
    return result.rows[0]?.cursor ?? null;
  }

  async save(event: { event_id: string; cursor: string }): Promise<void> {
    await this.db.query(
      `insert into stream_checkpoints (user_id, cursor, updated_at)
       values ($1, $2, now())
       on conflict (user_id) do update set cursor = $2, updated_at = now()`,
      [this.user_id, event.cursor],
    );
  }
}
