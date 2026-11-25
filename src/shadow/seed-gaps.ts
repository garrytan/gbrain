/**
 * The shadow seed's gap count: the rows of every primary table that the seed neither copies,
 * carries inside a copied relation, nor leaves behind on purpose (rust/docs/store/seed.md, "Every
 * other primary table"). The Rust store's `seedPlan()` names the copied relations, the carried
 * tables and the not-copied list; anything else in the primary's catalog is a gap. A not-copied
 * table can still hold rows that are brain state (`gap_rows`): those rows are counted as a gap
 * of their own, and so can a column of a copied relation the store cannot keep yet (`gap_columns`,
 * counted only when the primary has the column). A swap to the seeded store is refused while any gap count is above zero.
 *
 * The count runs inside the seed's read-only snapshot through `query`, so it sees exactly the
 * rows the copy saw.
 */
import type { SeedPlan } from '../core/rust-engine/store.ts';

/** Runs one read in the seed's snapshot. */
export type SeedQuery = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** A table name or column name taken from the plan or the catalog, safe to quote. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function quoted(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`shadow seed: unexpected table or column name ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/** The base tables of the primary's schema, sorted. */
export async function primaryTables(query: SeedQuery): Promise<string[]> {
  const rows = await query(
    `SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      ORDER BY 1`,
  );
  return rows.map(r => String(r.name));
}

/**
 * The gap counts, keyed by gap name and sorted: one entry per primary table the plan does not
 * cover (named by the table), and one per `gap_rows` filter of a not-copied table. Zero counts are
 * included, so the report names every gap.
 */
export async function countSeedGaps(plan: SeedPlan, query: SeedQuery): Promise<Record<string, number>> {
  const covered = new Set<string>([
    ...plan.relations.map(r => r.relation),
    ...plan.carried.map(([table]) => table),
    ...plan.not_copied.map(n => n.table),
  ]);
  const tables = await primaryTables(query);
  const present = new Set(tables);
  const counts: Record<string, number> = {};
  for (const table of tables) {
    if (covered.has(table)) continue;
    const [row] = await query(`SELECT count(*)::bigint::text AS n FROM ${quoted(table)}`);
    counts[table] = Number(row?.n ?? 0);
  }
  for (const n of plan.not_copied) {
    if (!n.gap_rows || !present.has(n.table)) continue;
    const [row] = await query(
      `SELECT count(*)::bigint::text AS n FROM ${quoted(n.table)} WHERE ${quoted(n.gap_rows.column)}::text = $1`,
      [n.gap_rows.equals],
    );
    counts[n.gap_rows.gap] = Number(row?.n ?? 0);
  }
  for (const g of plan.gap_columns) {
    if (!present.has(g.table)) continue;
    const [col] = await query(
      `SELECT 1 AS present FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
      [g.table, g.column],
    );
    if (!col) continue;
    const [row] = await query(
      `SELECT count(*)::bigint::text AS n FROM ${quoted(g.table)} WHERE ${quoted(g.column)} IS NOT NULL`,
    );
    counts[g.gap] = Number(row?.n ?? 0);
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
