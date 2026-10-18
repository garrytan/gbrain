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

const MISSING = (alias: string, column: string) => `NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=${alias}.source_id AND p.slug=${alias}.${column})`;
const SOFT_DELETED = (alias: string, column: string) =>
  `EXISTS (SELECT 1 FROM pages p WHERE p.source_id=${alias}.source_id AND p.slug=${alias}.${column} AND p.deleted_at IS NOT NULL)`;

/** Alias rows (both tables) whose target page row is absent, per source; and those whose target is soft-deleted. */
export const ORPHANED_ALIAS_COUNTS_SQL = `SELECT source_id,sum(slug_redirects)::int AS slug_redirects,sum(page_aliases)::int AS page_aliases FROM (
    SELECT sa.source_id,1 AS slug_redirects,0 AS page_aliases FROM slug_aliases sa WHERE ${MISSING('sa', 'canonical_slug')}
    UNION ALL SELECT pa.source_id,0,1 FROM page_aliases pa WHERE ${MISSING('pa', 'slug')}) o GROUP BY source_id ORDER BY source_id`;
export const SOFT_DELETED_ALIAS_COUNT_SQL = `SELECT
    (SELECT count(*)::int FROM slug_aliases sa WHERE ${SOFT_DELETED('sa', 'canonical_slug')}) AS slug_redirects,
    (SELECT count(*)::int FROM page_aliases pa WHERE ${SOFT_DELETED('pa', 'slug')}) AS page_aliases`;

export const aliasesRepair: RepairHandler = {
  kind: 'aliases',
  publication: 'projection',
  embeds: false,
  async plan(engine, scope, after) {
    const rows = await engine.executeRaw<{ source_id: string; slug: string; page_aliases: number; slug_redirects: number }>(
      `SELECT source_id,slug,sum(page_aliases)::int AS page_aliases,sum(slug_redirects)::int AS slug_redirects FROM (
         SELECT pa.source_id,pa.slug,1 AS page_aliases,0 AS slug_redirects FROM page_aliases pa WHERE pa.source_id=ANY($1::text[]) AND ${MISSING('pa', 'slug')}
         UNION ALL SELECT sa.source_id,sa.canonical_slug,0,1 FROM slug_aliases sa WHERE sa.source_id=ANY($1::text[]) AND ${MISSING('sa', 'canonical_slug')}
       ) o GROUP BY source_id,slug ORDER BY source_id,slug`, [scope.source_ids]);
    const items: RepairItem[] = rows.map((row, index) => ({ cursor: { phase: 0, id: index + 1 }, source_id: row.source_id, slug: row.slug, chars: 0,
      action: 'delete_orphaned_aliases', change: { from: `${row.page_aliases} page alias(es), ${row.slug_redirects} slug redirect(s)`, to: 'deleted' } }));
    const [soft] = await engine.executeRaw<{ n: number }>(`SELECT
        (SELECT count(*)::int FROM page_aliases pa WHERE pa.source_id=ANY($1::text[]) AND ${SOFT_DELETED('pa', 'slug')})
      + (SELECT count(*)::int FROM slug_aliases sa WHERE sa.source_id=ANY($1::text[]) AND ${SOFT_DELETED('sa', 'canonical_slug')}) AS n`, [scope.source_ids]);
    const residuals: Record<string, number> = soft?.n ? { soft_deleted_target: soft.n } : {};
    return { items: items.filter(item => afterCursor(item.cursor, after)), residuals };
  },
  async apply(ctx, item) {
    const removed = await ctx.engine.transaction(async tx => {
      const managed = await readManagedMode(tx, { refusal: { subject: 'repair aliases' } });
      const sweep = async () => {
        await tx.lockPageKeys([{ sourceId: item.source_id, slug: item.slug }]);
        const [row] = await tx.executeRaw<{ n: number }>(`WITH target AS (SELECT $1::text AS source_id,$2::text AS slug WHERE NOT EXISTS
            (SELECT 1 FROM pages p WHERE p.source_id=$1 AND p.slug=$2)),
          pa AS (DELETE FROM page_aliases a USING target t WHERE a.source_id=t.source_id AND a.slug=t.slug RETURNING 1),
          sa AS (DELETE FROM slug_aliases a USING target t WHERE a.source_id=t.source_id AND a.canonical_slug=t.slug RETURNING 1)
          SELECT (SELECT count(*) FROM pa)::int+(SELECT count(*) FROM sa)::int AS n`, [item.source_id, item.slug]);
        return Number(row?.n ?? 0);
      };
      return managed ? withCoordinatedWrite(tx, [item.source_id], sweep, await maintenanceAttribution(tx)) : sweep();
    });
    return removed > 0;
  },
};
