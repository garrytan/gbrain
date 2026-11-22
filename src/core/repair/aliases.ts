/**
 * `gbrain repair aliases` (#6619): delete alias rows whose target page has no
 * row at all (purged or hard-deleted), the ones doctor `dangling_aliases`
 * reports as orphaned. A free-text alias (`page_aliases.slug`) or a slug
 * redirect (`slug_aliases.canonical_slug`) pointing at such a slug can still
 * resolve a name to a page that no longer exists. Rows whose target is
 * soft-deleted are left alone: `gbrain restore` inside the 72-hour window
 * still needs them, and a purge removes them with the page. A redirect whose
 * alias_slug is the missing slug (an old name of a page that still exists)
 * is a rename redirect and is never touched.
 *
 * One item per (source, target slug). Applying it rechecks, under the page key
 * lock, that the slug still has no page row, then deletes both alias tables'
 * rows for it; on a managed brain the delete runs as a coordinated
 * maintenance write (the alias tables carry the managed writer guard).
 * Explicit-only, bookkeeping only, no journal admission.
 */
import { maintenanceAttribution } from '../persistence/attribution.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';
import { readManagedMode } from '../persistence/managed-mode.ts';
import { afterCursor, type RepairHandler, type RepairItem } from './core.ts';

export const aliasesRepair: RepairHandler = {
  kind: 'aliases',
  publication: 'projection',
  embeds: false,
  async plan(engine, scope, after) {
    const targets = await engine.listAliasTargets(scope.source_ids);
    const items: RepairItem[] = targets.filter(row => row.page === 'missing').map((row, index) => ({ cursor: { phase: 0, id: index + 1 },
      source_id: row.source_id, slug: row.slug, chars: 0, action: 'delete_orphaned_aliases',
      change: { from: `${row.page_aliases} page alias(es), ${row.slug_redirects} slug redirect(s)`, to: 'deleted' } }));
    const soft = targets.filter(row => row.page === 'soft_deleted').reduce((sum, row) => sum + row.page_aliases + row.slug_redirects, 0);
    const residuals: Record<string, number> = soft ? { soft_deleted_target: soft } : {};
    return { items: items.filter(item => afterCursor(item.cursor, after)), residuals };
  },
  async apply(ctx, item) {
    const removed = await ctx.engine.transaction(async tx => {
      const managed = await readManagedMode(tx, { refusal: { subject: 'repair aliases' } });
      const sweep = async () => {
        await tx.lockPageKeys([{ sourceId: item.source_id, slug: item.slug }]);
        return tx.deleteOrphanedAliases(item.source_id, item.slug);
      };
      return managed ? withCoordinatedWrite(tx, [item.source_id], sweep, await maintenanceAttribution(tx)) : sweep();
    });
    return removed > 0;
  },
};
