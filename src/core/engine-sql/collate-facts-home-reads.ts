/**
 * The facts-home scan's reads (facts/facts-home.ts) that ran through `executeRaw`, each with the statement text and
 * parameters the scan used; only their home moved. Each lists by byte order (`COLLATE "C"`) so the preview reads the same
 * on every engine whatever the database locale is (test/engine-parity/collate-facts-home.test.ts). The text of each is
 * pinned in test/engine-sql-caller-raw-sql-pins.test.ts.
 *
 * The four names and signatures are the ones the facts-cycle lane gave them (dcd46a25d6, src/core/engine-sql/facts-cycle.ts),
 * with the byte order this wave pins. The two holding-slug tests in `listHeldFactRows` are `holdingSlugSql` (facts-fence.ts)
 * written out; the pin test checks they match it.
 */
import type { UnfencedFactRow } from '../facts/unfenced-facts.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

/** An unfenced fact the scan found, with its ontology dimension and whether its entity page is soft-deleted. */
export type UnfencedScanRow = UnfencedFactRow & { dimension: string | null; page_deleted: boolean };
/** A fenced fact waiting on a holding page: when it started waiting and whether that is older than the cutoff. */
export type HeldFactRow = UnfencedFactRow & { held_since: string; old: boolean; from_slug: string };
/** The recorded file origin (`source_path`, `source_uri`) of a live page. */
export interface PageFileOrigin { source_path: string | null; source_uri: string | null }

/** The source's unexpired facts with no fence row, by entity slug in byte order (null first) then id, with page-existence flags. */
export async function scanUnfencedFactRows(raw: EngineRawRead, sourceId: string): Promise<UnfencedScanRow[]> {
  return raw<UnfencedScanRow>(`SELECT f.id, f.source_id, f.entity_slug, f.fact, f.kind, f.visibility, f.notability, f.context, f.valid_from, f.valid_until, f.source,
  f.confidence, f.claim_metric, f.claim_value, f.claim_unit, f.claim_period, f.attributed_to, f.dimension, EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.entity_slug AND p.deleted_at IS NULL) AS page_exists,
    EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.entity_slug AND p.deleted_at IS NOT NULL) AS page_deleted FROM facts f
    WHERE f.source_id=$1 AND f.row_num IS NULL AND f.expired_at IS NULL ORDER BY f.entity_slug COLLATE "C" NULLS FIRST, f.id`, [sourceId]);
}

/**
 * The source's unexpired fence rows on a holding page (`memory/unattributed`, at any folder depth) that name another entity,
 * by entity slug in byte order then id. `days` is the age cutoff as text; the statement marks a row `old` when it is older.
 */
export async function listHeldFactRows(raw: EngineRawRead, sourceId: string, days: string): Promise<HeldFactRow[]> {
  return raw<HeldFactRow>(`SELECT f.id, f.source_id, f.entity_slug, f.fact, f.kind, f.visibility, f.notability, f.context, f.valid_from, f.valid_until, f.source,
  f.confidence, f.claim_metric, f.claim_value, f.claim_unit, f.claim_period, f.attributed_to, EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.entity_slug AND p.deleted_at IS NULL) AS page_exists, f.source_markdown_slug AS from_slug,
      to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS held_since, f.created_at < now() - ($2 || ' days')::interval AS old
     FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug IN (SELECT hp.slug FROM pages hp WHERE hp.source_id = $1 AND (hp.slug = 'memory/unattributed' OR hp.slug LIKE '%/memory/unattributed')) AND f.row_num IS NOT NULL AND f.expired_at IS NULL AND f.dimension IS NULL
      AND f.entity_slug IS NOT NULL AND NOT (f.entity_slug = 'memory/unattributed' OR f.entity_slug LIKE '%/memory/unattributed') ORDER BY f.entity_slug COLLATE "C", f.id`, [sourceId, days]);
}

/** The source's fenced, unexpired facts whose page is missing or soft-deleted, by id, with the page slug they sit on. */
export async function listFencedFactsOfMissingPages(raw: EngineRawRead, sourceId: string): Promise<Array<{ id: number; slug: string }>> {
  return raw<{ id: number; slug: string }>(`SELECT f.id, f.source_markdown_slug AS slug FROM facts f WHERE f.source_id=$1 AND f.row_num IS NOT NULL
      AND f.expired_at IS NULL AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.source_markdown_slug AND p.deleted_at IS NULL) ORDER BY f.id`, [sourceId]);
}

/** The recorded file origin of a live page, or null for no live page. */
export async function readPageFileOrigin(raw: EngineRawRead, sourceId: string, slug: string): Promise<PageFileOrigin | null> {
  const [page] = await raw<PageFileOrigin>('SELECT source_path, source_uri FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]);
  return page ?? null;
}
