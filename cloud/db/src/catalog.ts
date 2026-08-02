// Catalog introspection — how the delete proves it left nothing behind.
//
// Everything here asks Postgres what exists rather than consulting a list in
// TypeScript. A hard-coded list stops matching the schema the first time somebody adds
// a table, and for deletion a missed table is derived user data surviving a CCPA
// request — the gap the FTC prosecutes.
//
// There are TWO enumerations, and they must agree:
//
//   `userScopedTables`        every table with a column named `user_id`
//   `deletionReachableTables` every table reachable from `users` by foreign key
//
// The column-name query alone is a naming-convention checker wearing a catalog's
// clothes: CONTRACTS.md § 3 warns that prompts 04-05 add `brief_items`-shaped tables
// keyed on a parent id with no `user_id` of their own, and such a table is invisible to
// it. The foreign-key walk sees those. `residueByTable` therefore enumerates by the
// walk and REFUSES to run if it finds a reachable table it cannot count, rather than
// quietly reporting zero for a table it never looked at.

import { getPool, type Queryable } from "./pool.js";

export type UserTable = { table_name: string; partitioned: boolean };

export class UncountableTableError extends Error {
  constructor(readonly tables: string[]) {
    super(
      `these tables are reachable from users by foreign key but have no user_id ` +
        `column, so the delete verification cannot count their rows: ` +
        `${tables.join(", ")}. Give each one a user_id, or extend residueByTable to ` +
        `count them through their parent key. Do not remove them from the walk.`,
    );
    this.name = "UncountableTableError";
  }
}

/**
 * Every base table in `public` carrying a `user_id` column, excluding leaf partitions
 * (their rows are visible through the parent, so counting both double-counts).
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

export type ReachableTable = {
  table_name: string;
  depth: number;
  has_user_id: boolean;
  /** 'c' = cascade. Anything else means a delete would fail or orphan rows. */
  on_delete: string | null;
};

/**
 * Every table reachable from `users` by following foreign keys, transitively.
 *
 * This is what makes the delete verification independent of a column naming
 * convention. Leaf partitions are excluded: a partitioned child's foreign key is
 * recorded once on the parent and again on every partition, and only the parent
 * should be counted.
 */
export async function deletionReachableTables(
  db: Queryable = getPool(),
): Promise<ReachableTable[]> {
  const res = await db.query<ReachableTable>(`
    with recursive reachable as (
      select c.oid, 0 as depth, null::"char" as on_delete
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'users'
      union
      select con.conrelid, r.depth + 1, con.confdeltype
        from pg_constraint con
        join reachable r on con.confrelid = r.oid
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
       where con.contype = 'f'
         and n.nspname = 'public'
         and not c.relispartition
         and con.conrelid <> con.confrelid
    )
    select c.relname as table_name,
           min(r.depth) as depth,
           bool_or(a.attname is not null) as has_user_id,
           min(r.on_delete::text) as on_delete
      from reachable r
      join pg_class c on c.oid = r.oid
      left join pg_attribute a
        on a.attrelid = c.oid and a.attname = 'user_id'
       and a.attnum > 0 and not a.attisdropped
     group by c.relname
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

/**
 * How many rows of `userId` survive in each table reachable from `users`.
 *
 * Throws `UncountableTableError` rather than skipping a reachable table it cannot
 * count. Silently omitting such a table is the exact failure this function exists to
 * prevent, and it would present as a clean zero-row report.
 */
export async function residueByTable(
  userId: string,
  db: Queryable = getPool(),
): Promise<Record<string, number>> {
  const reachable = await deletionReachableTables(db);

  const uncountable = reachable.filter((t) => !t.has_user_id).map((t) => t.table_name);
  if (uncountable.length > 0) throw new UncountableTableError(uncountable);

  const out: Record<string, number> = {};
  for (const t of reachable) {
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
