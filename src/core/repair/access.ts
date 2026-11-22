/**
 * `gbrain repair access` (GBRA-218): derive `pages.page_readers` for pages
 * written before the member-access migration whose frontmatter already names
 * readers. Until then such a page reads as nobody for every remote caller
 * (fail closed), so the backfill only restores reads for listed members; it
 * never widens anything. A trigger keeps the column current on every later
 * write, so this runs once per upgraded brain. Updates only rows whose value
 * changes (IS DISTINCT FROM), bumps no revision, content hash, generation or
 * embedding state; no journal admission.
 */
import type { RepairHandler, RepairItem } from './core.ts';

export const accessRepair: RepairHandler = {
  kind: 'access',
  publication: 'projection',
  embeds: false,
  async plan(engine, scope, after) {
    const rows = await engine.listAccessReaderDrift(scope.source_ids, after?.phase === 0 ? after.id : 0);
    const items: RepairItem[] = rows.map(row => ({ cursor: { phase: 0, id: row.id }, source_id: row.source_id, slug: row.slug, chars: 0, action: 'derive_page_readers' }));
    return { items, residuals: {} };
  },
  async apply(ctx, item) {
    return ctx.engine.deriveAccessReaders(item.cursor.id);
  },
};
