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
import type { RepairHandler, RepairItem } from './core.ts';
import { PAGE_CHILD_FK_TARGETS } from '../engine-sql/repair-page-reads.ts';

// The target list, the orphan predicate and the statements live in engine-sql/repair-page-reads.ts (engine members).
export { PAGE_CHILD_FK_TARGETS, orphanPredicate } from '../engine-sql/repair-page-reads.ts';

export const orphanChildrenRepair: RepairHandler = {
  kind: 'orphan-children',
  publication: 'projection',
  embeds: false,
  async plan(engine) {
    const items: RepairItem[] = [];
    for (const [index, target] of PAGE_CHILD_FK_TARGETS.entries()) {
      const n = await engine.countPageChildOrphans(target);
      if (n > 0) items.push({ cursor: { phase: 0, id: index + 1 }, source_id: 'brain', slug: `${target.table}.${target.col}`, chars: 0,
        action: target.allowNull ? `clear_${n}_orphan_reference(s)` : `delete_${n}_orphan_row(s)`, change: { from: String(n), to: target.allowNull ? 'null' : 'deleted' } });
    }
    const torn = await engine.probeTornPages();
    const warnings: string[] = [];
    if (torn.count > 0) {
      warnings.push(`${torn.count} page row(s) have a stored body that cannot be read (torn TOAST, SQLSTATE XX000): `
        + `${torn.named.map(p => `#${p.id} ${p.source_id}:${p.slug}`).join(', ')}${torn.count > 20 ? ', …' : ''}. `
        + 'This repair does not change them. Restore the brain from a backup, or re-create it and sync from its source files; see docs/guides/repair.md#orphan-children.');
    }
    const residuals: Record<string, number> = torn.count ? { torn_pages: torn.count } : {};
    return { items, residuals, ...(warnings.length ? { warnings } : {}) };
  },
  async apply(ctx, item) {
    const target = PAGE_CHILD_FK_TARGETS[item.cursor.id - 1];
    if (!target || item.slug !== `${target.table}.${target.col}`) return false;
    return await ctx.engine.clearPageChildOrphans(target) > 0;
  },
};
