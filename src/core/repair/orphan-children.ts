/**
 * `gbrain repair orphan-children` (#5216, #4738): remove child rows whose
 * page no longer exists, and find page rows whose stored body cannot be read
 * (a torn TOAST value). Both show up on brains with storage damage: doctor's
 * `child_table_orphans` used to print cleanup SQL no gbrain command could run,
 * and a torn body fails every operation that reads it with SQLSTATE XX000.
 *
 * Each item is one (table, column) pair. Applying it deletes the orphans, or
 * clears the reference for the two ON DELETE SET NULL columns, in one
 * statement that rechecks the orphan predicate. The torn-TOAST probe reads
 * every page body, one batch at a time and then row by row inside a failing
 * batch, and reports the torn pages as a residual with their ids; it never
 * changes them. Brain-wide, bookkeeping only, no journal admission.
 */
import type { BrainEngine } from '../engine.ts';
import type { RepairHandler, RepairItem } from './core.ts';

/** FK children of pages. `allowNull`: the FK is ON DELETE SET NULL, so NULL is valid and an orphan is cleared, not deleted. */
export const PAGE_CHILD_FK_TARGETS: ReadonlyArray<{ table: string; col: string; allowNull: boolean }> = [
  { table: 'content_chunks', col: 'page_id', allowNull: false },
  { table: 'page_versions', col: 'page_id', allowNull: false },
  { table: 'tags', col: 'page_id', allowNull: false },
  { table: 'takes', col: 'page_id', allowNull: false },
  { table: 'raw_data', col: 'page_id', allowNull: false },
  { table: 'timeline_entries', col: 'page_id', allowNull: false },
  { table: 'links', col: 'from_page_id', allowNull: false },
  { table: 'links', col: 'to_page_id', allowNull: false },
  { table: 'links', col: 'origin_page_id', allowNull: true },
  { table: 'files', col: 'page_id', allowNull: true },
];

// NOT EXISTS (not `NOT IN (SELECT id FROM pages)`) so the planner can use a
// hash anti-join: once the page-id list outgrows work_mem, NOT IN degrades to a
// per-row rescan of pages. pages.id is the primary key (never NULL), so the
// semantics match NOT IN exactly. The column is table-qualified because the
// predicate also runs inside the repair's UPDATE and DELETE statements.
export function orphanPredicate(target: { table: string; col: string; allowNull: boolean }): string {
  const col = `${target.table}.${target.col}`;
  return `${target.allowNull ? `${col} IS NOT NULL AND ` : ''}NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = ${col})`;
}

const PROBE_BATCH = 500;
const PROBE_SQL = `SELECT id, length(compiled_truth) + length(COALESCE(timeline, '')) + length(COALESCE(frontmatter::text, '')) AS n
  FROM pages WHERE id = ANY($1::bigint[])`;

/** Page ids whose body, timeline or frontmatter cannot be read back. */
export async function probeTornPages(engine: Pick<BrainEngine, 'executeRaw'>): Promise<number[]> {
  const torn: number[] = [];
  let cursor = 0;
  for (;;) {
    const ids = (await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE id > $1 ORDER BY id LIMIT $2', [cursor, PROBE_BATCH])).map(r => Number(r.id));
    if (ids.length === 0) return torn;
    try { await engine.executeRaw(PROBE_SQL, [ids]); }
    catch {
      for (const id of ids) {
        try { await engine.executeRaw(PROBE_SQL, [[id]]); } catch { torn.push(id); }
      }
    }
    cursor = ids[ids.length - 1]!;
  }
}

export const orphanChildrenRepair: RepairHandler = {
  kind: 'orphan-children',
  publication: 'projection',
  embeds: false,
  async plan(engine) {
    const items: RepairItem[] = [];
    for (const [index, target] of PAGE_CHILD_FK_TARGETS.entries()) {
      const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${target.table} WHERE ${orphanPredicate(target)}`);
      const n = Number(row?.n ?? 0);
      if (n > 0) items.push({ cursor: { phase: 0, id: index + 1 }, source_id: 'brain', slug: `${target.table}.${target.col}`, chars: 0,
        action: target.allowNull ? `clear_${n}_orphan_reference(s)` : `delete_${n}_orphan_row(s)`, change: { from: String(n), to: target.allowNull ? 'null' : 'deleted' } });
    }
    const torn = await probeTornPages(engine);
    const warnings: string[] = [];
    if (torn.length > 0) {
      const named = await engine.executeRaw<{ id: number; source_id: string; slug: string }>(
        'SELECT id, source_id, slug FROM pages WHERE id = ANY($1::bigint[]) ORDER BY id LIMIT 20', [torn]);
      warnings.push(`${torn.length} page row(s) have a stored body that cannot be read (torn TOAST, SQLSTATE XX000): `
        + `${named.map(p => `#${p.id} ${p.source_id}:${p.slug}`).join(', ')}${torn.length > 20 ? ', …' : ''}. `
        + 'This repair does not change them. Restore the brain from a backup, or re-create it and sync from its source files; see docs/guides/repair.md#orphan-children.');
    }
    const residuals: Record<string, number> = torn.length ? { torn_pages: torn.length } : {};
    return { items, residuals, ...(warnings.length ? { warnings } : {}) };
  },
  async apply(ctx, item) {
    const target = PAGE_CHILD_FK_TARGETS[item.cursor.id - 1];
    if (!target || item.slug !== `${target.table}.${target.col}`) return false;
    const rows = await ctx.engine.executeRaw<{ n: number }>(target.allowNull
      ? `WITH cleared AS (UPDATE ${target.table} SET ${target.col} = NULL WHERE ${orphanPredicate(target)} RETURNING 1) SELECT count(*)::int AS n FROM cleared`
      : `WITH removed AS (DELETE FROM ${target.table} WHERE ${orphanPredicate(target)} RETURNING 1) SELECT count(*)::int AS n FROM removed`);
    return Number(rows[0]?.n ?? 0) > 0;
  },
};
