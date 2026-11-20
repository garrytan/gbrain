/**
 * The page scans of the `safe-chunks` and `origin-twins` repair plans, moved here from repair/safe-chunks.ts and
 * repair/origin-twins.ts so the Rust engine can serve them as typed members. PGLite and Postgres read unscoped through
 * executeRaw, as before. The Rust engine scans its page records (rust/crates/gbrain-store/src/repair_scans.rs;
 * rust/docs/store/repair-bookkeeping.md, "Repair page scans").
 */
import type { LegacyUnscopedRead } from './brands.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../search/safe-chunks.ts';
import { CREDENTIAL_RESEAL_HELD } from '../page-state/credential-reseal-hold.ts';

/** One page `gbrain repair safe-chunks` re-seals (`rebuildable`) or reports. */
export interface SafeChunksPendingRow { id: number; source_id: string; slug: string; page_kind: string; rebuildable: boolean; chars: number }

/** Live pages of one source recording the same origin, ids ascending. */
export interface OriginTwinGroupRow { source_path: string; ids: number[]; paths: string[] }

/** A live page recording `<prefix><origin>` beside another live page recording `origin`. */
export interface LegacyOriginPair { legacy_id: number; legacy_path: string; legacy_slug: string; origin: string }

/** A live page and the origin it records. */
export interface LiveOriginPage { id: number; source_path: string }

/** The live pages of `sourceIds` below the safe chunker version, or held for a credential re-chunk and inline, by id. */
export async function listSafeChunksPending(exec: LegacyUnscopedRead, sourceIds: readonly string[]): Promise<SafeChunksPendingRow[]> {
  const rows = await exec.executeRaw<SafeChunksPendingRow>(`SELECT p.id,p.source_id,p.slug,p.page_kind,
      (p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file',p.source_path) IS NOT NULL)) AS rebuildable,
      length(p.compiled_truth)+length(COALESCE(p.timeline,'')) AS chars
    FROM pages p WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL
      AND (p.chunker_version < ${SAFE_FENCE_CHUNKER_VERSION} OR (${CREDENTIAL_RESEAL_HELD} AND p.body_storage IS DISTINCT FROM 'segmented'))
    ORDER BY p.id`, [[...sourceIds]]);
  return rows.map(row => ({ id: Number(row.id), source_id: row.source_id, slug: row.slug, page_kind: row.page_kind,
    rebuildable: row.rebuildable === true, chars: Number(row.chars) }));
}

/** The origins two or more live pages of the source record, at most `limit`, in byte order. */
export async function listOriginTwinGroups(exec: LegacyUnscopedRead, sourceId: string, limit: number): Promise<OriginTwinGroupRow[]> {
  const rows = await exec.executeRaw<OriginTwinGroupRow>(`SELECT source_path, array_agg(id ORDER BY id) AS ids, array_agg(source_path ORDER BY id) AS paths
    FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL GROUP BY source_path HAVING count(*) > 1
    ORDER BY source_path COLLATE "C" LIMIT ${Math.max(1, Math.floor(limit))}`, [sourceId]);
  return rows.map(row => ({ source_path: row.source_path, ids: row.ids.map(Number), paths: [...row.paths] }));
}

/** Each live page recording `prefix` plus another live page's origin, by the legacy page's id then the other's, at most `limit`. */
export async function listLegacyOriginPairs(exec: LegacyUnscopedRead, sourceId: string, prefix: string, limit: number): Promise<LegacyOriginPair[]> {
  const rows = await exec.executeRaw<LegacyOriginPair>(`SELECT l.id AS legacy_id, l.source_path AS legacy_path, l.slug AS legacy_slug, o.source_path AS origin
    FROM pages l JOIN pages o ON o.source_id=l.source_id AND l.source_path = $2 || o.source_path
    WHERE l.source_id=$1 AND l.deleted_at IS NULL AND o.deleted_at IS NULL AND l.id <> o.id ORDER BY l.id, o.id LIMIT ${Math.max(1, Math.floor(limit))}`, [sourceId, prefix]);
  return rows.map(row => ({ legacy_id: Number(row.legacy_id), legacy_path: row.legacy_path, legacy_slug: row.legacy_slug, origin: row.origin }));
}

/** The live pages of the source recording any of `paths`, by id. */
export async function listLiveOriginPages(exec: LegacyUnscopedRead, sourceId: string, paths: readonly string[]): Promise<LiveOriginPage[]> {
  const rows = await exec.executeRaw<LiveOriginPage>('SELECT id, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path=ANY($2::text[]) ORDER BY id',
    [sourceId, [...paths]]);
  return rows.map(row => ({ id: Number(row.id), source_path: row.source_path }));
}

/** The live pages of the source that record an origin. */
export async function countLiveFileBackedPages(exec: LegacyUnscopedRead, sourceId: string): Promise<number> {
  const [row] = await exec.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL', [sourceId]);
  return Number(row?.n ?? 0);
}
