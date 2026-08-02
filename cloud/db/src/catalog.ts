// Catalog introspection.
//
// Both users of this module deliberately ask Postgres what exists rather than
// consulting a list in TypeScript. A hard-coded list is a list that silently stops
// matching the schema the first time somebody adds a table -- and for deletion, a
// table missed is derived user data left behind after a CCPA request, which is
// precisely the gap the FTC prosecutes.

import { getPool, type Queryable } from "./pool.js";

export type UserTable = { table_name: string; partitioned: boolean };

/**
 * Every base table in `public` that carries a `user_id` column, excluding leaf
 * partitions -- a partition's rows are visible through its parent, so counting both
 * would double-count.
 */
export async function userScopedTables(db: Queryable = getPool()): Promise<UserTable[]> {
  const res = await db.query<{ table_name: string; partitioned: boolean }>(`
    select c.relname as table_name,
           (c.relkind = 'p') as partitioned
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and not c.relispartition
       and exists (
             select 1 from pg_attribute a
              where a.attrelid = c.oid
                and a.attname = 'user_id'
                and a.attnum > 0
                and not a.attisdropped
           )
     order by c.relname
  `);
  return res.rows;
}

export type PartitionedTable = { table_name: string; strategy: string; partition_key: string };

/** Proof, straight from `pg_partitioned_table`, of what is partitioned and on what. */
export async function partitionedTables(
  db: Queryable = getPool(),
): Promise<PartitionedTable[]> {
  const res = await db.query<PartitionedTable>(`
    select c.relname as table_name,
           case p.partstrat when 'h' then 'hash' when 'r' then 'range' when 'l' then 'list'
                            else p.partstrat::text end as strategy,
           pg_get_partkeydef(c.oid) as partition_key
      from pg_partitioned_table p
      join pg_class c on c.oid = p.partrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
     order by c.relname
  `);
  return res.rows;
}

/** How many rows of `userId` survive in each user-scoped table. Used to prove delete. */
export async function residueByTable(
  userId: string,
  db: Queryable = getPool(),
): Promise<Record<string, number>> {
  const tables = await userScopedTables(db);
  const out: Record<string, number> = {};
  for (const t of tables) {
    // The identifier comes from pg_class, not from a caller, so it cannot be injected;
    // quote it anyway so an unusual name still parses.
    const res = await db.query<{ n: string }>(
      `select count(*)::text as n from "${t.table_name}" where user_id = $1`,
      [userId],
    );
    out[t.table_name] = Number(res.rows[0]?.n ?? "0");
  }
  return out;
}
