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
    const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string }>(
      `SELECT id, source_id, slug FROM pages
        WHERE source_id = ANY($1::text[]) AND id > $2
          AND (frontmatter ? 'readable_by' OR page_readers IS NOT NULL)
          AND page_readers IS DISTINCT FROM gbrain_access_readers(frontmatter)
        ORDER BY id`,
      [scope.source_ids, after?.phase === 0 ? after.id : 0]);
    const items: RepairItem[] = rows.map(row => ({ cursor: { phase: 0, id: Number(row.id) }, source_id: row.source_id, slug: row.slug, chars: 0, action: 'derive_page_readers' }));
    return { items, residuals: {} };
  },
  async apply(ctx, item) {
    const rows = await ctx.engine.executeRaw<{ id: number }>(
      `UPDATE pages SET page_readers = gbrain_access_readers(frontmatter)
        WHERE id = $1 AND page_readers IS DISTINCT FROM gbrain_access_readers(frontmatter) RETURNING id`, [item.cursor.id]);
    return rows.length > 0;
  },
};
