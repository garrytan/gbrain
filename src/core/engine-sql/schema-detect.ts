/**
 * The three page-shape reads of `gbrain schema detect` (src/core/schema-pack/detect.ts): page totals of a source, the
 * slug-prefix distribution with the page types under each prefix, and the page-type distribution. One implementation
 * for both engines; the Rust engine serves the same members from rust/crates/gbrain-store/src/schema_detect.rs.
 *
 * Order: counts sort largest first; a tie sorts by the prefix or type in byte order (`COLLATE "C"`), and the types
 * under a prefix are in byte order too, so PGLite, Postgres in any database locale and the Rust store agree.
 * `pages.type` is NOT NULL: an untyped page has the empty type.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead };

/** Live pages of one source: all of them, the ones with a type and the ones without. */
export interface PageTypeTotals { total: number; typed: number; untyped: number }

/** One slug prefix (`people/`) with at least the minimum pages: its live page count and its page types, in byte order. */
export interface PagePrefixSample { prefix: string; cnt: number; sample_types: string[] }

/** One page type with its live page count. */
export interface PageTypeCount { type: string; cnt: number }

export const PAGE_TYPE_TOTALS_SQL = `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE type IS NULL OR type = '')::text AS untyped,
       COUNT(*) FILTER (WHERE type IS NOT NULL AND type != '')::text AS typed
     FROM pages
     WHERE source_id = $1 AND deleted_at IS NULL`;

export const PAGE_PREFIX_SAMPLES_SQL = `SELECT
       substring(slug from '^[^/]+/') AS prefix,
       COUNT(*)::text AS cnt,
       array_agg(DISTINCT type COLLATE "C" ORDER BY type COLLATE "C") FILTER (WHERE type IS NOT NULL AND type != '') AS sample_types
     FROM pages
     WHERE source_id = $1
       AND deleted_at IS NULL
       AND slug LIKE '%/%'
     GROUP BY substring(slug from '^[^/]+/')
     HAVING COUNT(*) >= $2
     ORDER BY COUNT(*) DESC, substring(slug from '^[^/]+/') COLLATE "C"
     LIMIT $3`;

export const PAGE_TYPE_COUNTS_SQL = `SELECT type, COUNT(*)::text AS cnt
     FROM pages
     WHERE source_id = $1 AND deleted_at IS NULL AND type IS NOT NULL AND type != ''
     GROUP BY type
     ORDER BY COUNT(*) DESC, type COLLATE "C"
     LIMIT $2`;

/** Live page totals of `sourceId`. */
export async function pageTypeTotals(raw: EngineRawRead, sourceId: string): Promise<PageTypeTotals> {
  const rows = await raw<{ total: string | number; untyped: string | number; typed: string | number }>(PAGE_TYPE_TOTALS_SQL, [sourceId]);
  return { total: Number(rows[0]?.total ?? 0), typed: Number(rows[0]?.typed ?? 0), untyped: Number(rows[0]?.untyped ?? 0) };
}

/** The slug prefixes of `sourceId`'s live pages with at least `minPages` pages, at most `limit`. */
export async function pagePrefixSamples(raw: EngineRawRead, sourceId: string, minPages: number, limit: number): Promise<PagePrefixSample[]> {
  const rows = await raw<{ prefix: string; cnt: string | number; sample_types: string[] | null }>(PAGE_PREFIX_SAMPLES_SQL, [sourceId, minPages, limit]);
  return rows.map(r => ({ prefix: r.prefix, cnt: Number(r.cnt), sample_types: Array.isArray(r.sample_types) ? r.sample_types : [] }));
}

/**
 * The schema-pack probes over `source_path` (lint-rules.ts extractable_empty_corpus, sync.ts probePrefix): a path
 * prefix matches `LIKE '<prefix>%'`, with `\\` escaping, `%` and `_` wildcards in the prefix as the callers always sent it.
 */
export const PATH_PREFIX_PAGE_COUNT_SQL = `SELECT COUNT(*)::text AS cnt FROM pages WHERE deleted_at IS NULL AND source_path LIKE $1`;
const UNTYPED_PREFIX_COUNT_SQL = `SELECT COUNT(*)::text AS cnt FROM pages WHERE deleted_at IS NULL AND (type IS NULL OR type = '') AND source_path LIKE $1`;
const UNTYPED_PREFIX_COUNT_IN_SOURCE_SQL = `SELECT COUNT(*)::text AS cnt FROM pages WHERE deleted_at IS NULL AND (type IS NULL OR type = '') AND source_path LIKE $1 AND source_id = $2`;
const UNTYPED_PREFIX_SAMPLE_SQL = `SELECT slug FROM pages WHERE deleted_at IS NULL AND (type IS NULL OR type = '') AND source_path LIKE $1 ORDER BY slug COLLATE "C" LIMIT 10`;
const UNTYPED_PREFIX_SAMPLE_IN_SOURCE_SQL = `SELECT slug FROM pages WHERE deleted_at IS NULL AND (type IS NULL OR type = '') AND source_path LIKE $1 AND source_id = $2 ORDER BY slug COLLATE "C" LIMIT 10`;

/** Live pages of any source whose source path starts with `prefix` (LIKE semantics). */
export async function countLivePagesAtPathPrefix(raw: EngineRawRead, prefix: string): Promise<number> {
  const rows = await raw<{ cnt?: string }>(PATH_PREFIX_PAGE_COUNT_SQL, [`${prefix}%`]);
  return rows[0]?.cnt ? parseInt(rows[0].cnt, 10) : 0;
}

/** The untyped live pages under a path prefix (in `sourceId` when given): their count and the first ten slugs by byte. */
export async function probeUntypedPathPrefix(raw: EngineRawRead, prefix: string, sourceId?: string): Promise<{ count: number; sample: string[] }> {
  const params: unknown[] = sourceId ? [`${prefix}%`, sourceId] : [`${prefix}%`];
  const cntRows = await raw<{ cnt: string }>(sourceId ? UNTYPED_PREFIX_COUNT_IN_SOURCE_SQL : UNTYPED_PREFIX_COUNT_SQL, params);
  const count = parseInt(cntRows[0]?.cnt ?? '0', 10) || 0;
  if (count === 0) return { count: 0, sample: [] };
  const sampleRows = await raw<{ slug: string }>(sourceId ? UNTYPED_PREFIX_SAMPLE_IN_SOURCE_SQL : UNTYPED_PREFIX_SAMPLE_SQL, params);
  return { count, sample: sampleRows.map((r) => r.slug) };
}

/** The page types of `sourceId`'s live typed pages, at most `limit`. */
export async function countPagesByTypeForSource(raw: EngineRawRead, sourceId: string, limit: number): Promise<PageTypeCount[]> {
  const rows = await raw<{ type: string; cnt: string | number }>(PAGE_TYPE_COUNTS_SQL, [sourceId, limit]);
  return rows.map(r => ({ type: r.type, cnt: Number(r.cnt) }));
}
