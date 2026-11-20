/**
 * Doctor reads, health set: the statements of the calibration, remote-report, catalog and request-index checks that ran
 * through `executeRaw` (src/commands/doctor/checks/calibration.ts, src/commands/doctor/report-remote.ts,
 * src/core/pages-upsert-arbiter.ts, src/core/timeline-dedup-repair.ts, src/commands/doctor/checks/graph-embedding.ts,
 * src/core/persistence/checkpoint-validation.ts). Each function runs the statement its caller ran, with the same
 * parameters, and returns the rows the caller read. PGLite and Postgres run the same text.
 *
 * The Rust engine answers the same members (src/core/rust-engine/store-members/doctor-health.ts,
 * rust/crates/gbrain-store/src/cli_reads/doctor_health.rs, rust/docs/store/cli-reads-doctor-health.md):
 *  - the three counts over pages, takes and timeline projections are served from the store's records;
 *  - the catalog reads answer from the store's key layout (pages and timeline dedup keys, the retrieval columns);
 *  - the applied-grade count is 0: the store keeps no `take_grade_cache` and its only writer runs raw SQL;
 *  - the request-index states refuse by name: the store has no request-table indexes to inspect.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

/**
 * The members of this file. Each replaced a statement a doctor check ran through its deadline-bound executeRaw, so
 * src/core/statement-deadline.ts keeps that bound on them (BOUNDED_TYPED_READS). A page purge's preparation reads
 * `readRequestIndexStates` too, so it is a typed preparation read (persistence/bounded-reads.ts TYPED_PREPARATION_READS):
 * on Postgres it runs through `ownRawRead` and ends at the claim's deadline and the clock's abort.
 */
export const DOCTOR_HEALTH_MEMBERS: readonly string[] = [
  'countContextualRetrievalCoverage', 'countAbandonedThreads', 'countAppliedGradeVerdicts', 'countOrphanedEventProjections',
  'readTimelineDedupIndex', 'readPagesUpsertArbiter', 'readRetrievalTrackingColumn', 'readRequestIndexStates',
];

export interface ContextualRetrievalCoverage { chunker_drift: number; unsealed: number; unsealed_code: number; mode_null: number }

// `pages.chunker_version >= 4` is safeChunksFilter('pages') (search/safe-chunks.ts, SAFE_FENCE_CHUNKER_VERSION 4).
// Each scoped statement below repeats its unscoped text whole: a composed string may not carry a literal $n
// (scripts/check-engine-sql-dynamic.ts).
const CR_COVERAGE_COLUMNS = `SELECT
         COUNT(*) FILTER (WHERE page_kind = 'markdown' AND chunker_version < $1)::int AS chunker_drift,
         COUNT(*) FILTER (WHERE NOT (pages.chunker_version >= 4))::int AS unsealed,
         COUNT(*) FILTER (WHERE page_kind = 'code' AND NOT (pages.chunker_version >= 4))::int AS unsealed_code,
         COUNT(*) FILTER (WHERE page_kind = 'markdown' AND contextual_retrieval_mode IS NULL AND type <> 'extract_receipt')::int AS mode_null
       FROM pages
       WHERE deleted_at IS NULL`;
const CR_COVERAGE_SQL = CR_COVERAGE_COLUMNS;
const CR_COVERAGE_SCOPED_SQL = `SELECT
         COUNT(*) FILTER (WHERE page_kind = 'markdown' AND chunker_version < $1)::int AS chunker_drift,
         COUNT(*) FILTER (WHERE NOT (pages.chunker_version >= 4))::int AS unsealed,
         COUNT(*) FILTER (WHERE page_kind = 'code' AND NOT (pages.chunker_version >= 4))::int AS unsealed_code,
         COUNT(*) FILTER (WHERE page_kind = 'markdown' AND contextual_retrieval_mode IS NULL AND type <> 'extract_receipt')::int AS mode_null
       FROM pages
       WHERE deleted_at IS NULL
         AND source_id = ANY($2::text[])`;

/**
 * Live pages chunked below `markdownChunkerVersion` (markdown), below the safe-chunk fence (all kinds, and code alone),
 * and markdown pages never evaluated for contextual retrieval (extract receipts aside); `sourceIds` narrows it.
 */
export async function countContextualRetrievalCoverage(raw: EngineRawRead, markdownChunkerVersion: number, sourceIds?: string[]): Promise<ContextualRetrievalCoverage> {
  const [row] = await raw<ContextualRetrievalCoverage>(sourceIds ? CR_COVERAGE_SCOPED_SQL : CR_COVERAGE_SQL,
    sourceIds ? [markdownChunkerVersion, sourceIds] : [markdownChunkerVersion]);
  return { chunker_drift: Number(row?.chunker_drift ?? 0), unsealed: Number(row?.unsealed ?? 0),
    unsealed_code: Number(row?.unsealed_code ?? 0), mode_null: Number(row?.mode_null ?? 0) };
}

// since_date is TEXT and may be month-precision ('YYYY-MM'); the guarded cast normalizes it to the 1st, as the
// `gbrain calibration` abandoned-threads listing does (serve-http.ts), so the count matches that listing.
const ABANDONED_SQL = `SELECT COUNT(*)::int AS count FROM takes
         WHERE active = true
           AND resolved_at IS NULL
           AND superseded_by IS NULL
           AND weight >= 0.7
           AND since_date IS NOT NULL
           AND (since_date || CASE WHEN length(since_date) = 7 THEN '-01' ELSE '' END)::date
               < (now() - INTERVAL '12 months')`;
const ABANDONED_SCOPED_SQL = `SELECT COUNT(*)::int AS count FROM takes
         WHERE active = true
           AND resolved_at IS NULL
           AND superseded_by IS NULL
           AND weight >= 0.7
           AND since_date IS NOT NULL
           AND (since_date || CASE WHEN length(since_date) = 7 THEN '-01' ELSE '' END)::date
               < (now() - INTERVAL '12 months')
           AND page_id IN (SELECT id FROM pages WHERE source_id = ANY($1::text[]))`;

/** Active, unresolved, unsuperseded takes of weight >= 0.7 stated more than 12 months ago; `sourceIds` narrows it by page source. */
export async function countAbandonedThreads(raw: EngineRawRead, sourceIds?: string[]): Promise<number> {
  const [row] = await raw<{ count: number }>(sourceIds ? ABANDONED_SCOPED_SQL : ABANDONED_SQL, sourceIds ? [sourceIds] : []);
  return Number(row?.count ?? 0);
}

const APPLIED_GRADES_SQL = `SELECT COUNT(*)::int AS applied_count FROM take_grade_cache WHERE applied = true`;
const APPLIED_GRADES_SCOPED_SQL = `SELECT COUNT(*)::int AS applied_count FROM take_grade_cache WHERE applied = true AND take_id IN (SELECT t.id FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.source_id = ANY($1::text[]))`;

/** Grade verdicts the judge applied; `sourceIds` narrows it to takes on those sources' pages. */
export async function countAppliedGradeVerdicts(raw: EngineRawRead, sourceIds?: string[]): Promise<number> {
  const [row] = await raw<{ applied_count: number }>(sourceIds ? APPLIED_GRADES_SCOPED_SQL : APPLIED_GRADES_SQL, sourceIds ? [sourceIds] : []);
  return Number(row?.applied_count ?? 0);
}

const ORPHAN_PROJECTIONS_SQL = `SELECT count(*)::int AS n FROM timeline_entries te
       JOIN pages ep ON ep.id = te.event_page_id
       WHERE te.event_page_id IS NOT NULL AND ep.deleted_at IS NOT NULL`;
const ORPHAN_PROJECTIONS_SCOPED_SQL = `SELECT count(*)::int AS n FROM timeline_entries te
       JOIN pages ep ON ep.id = te.event_page_id
       WHERE te.event_page_id IS NOT NULL AND ep.deleted_at IS NOT NULL
         AND ep.source_id = ANY($1::text[])`;

/** Timeline projections whose event page is soft-deleted; `sourceIds` narrows it by the event page's source. */
export async function countOrphanedEventProjections(raw: EngineRawRead, sourceIds?: string[]): Promise<number> {
  const [row] = await raw<{ n: number }>(sourceIds ? ORPHAN_PROJECTIONS_SCOPED_SQL : ORPHAN_PROJECTIONS_SQL, sourceIds ? [sourceIds] : []);
  return Number(row?.n ?? 0);
}

/** The timeline dedup index (migration v138); `timeline-dedup-repair.ts` parses its columns. */
export const TIMELINE_DEDUP_INDEX = 'idx_timeline_dedup';
export interface TimelineDedupIndex { tablePresent: boolean; indexdef: string | null }
const TIMELINE_DEDUP_SQL = `SELECT to_regclass('timeline_entries')::text AS reg,
    (SELECT indexdef FROM pg_indexes WHERE indexname = $1 ORDER BY schemaname COLLATE "C" LIMIT 1) AS indexdef`;

/** Whether `timeline_entries` exists, and the definition of its dedup index (null when it is absent). */
export async function readTimelineDedupIndex(raw: EngineRawRead): Promise<TimelineDedupIndex> {
  const [row] = await raw<{ reg: string | null; indexdef: string | null }>(TIMELINE_DEDUP_SQL, [TIMELINE_DEDUP_INDEX]);
  const tablePresent = !!row?.reg;
  return { tablePresent, indexdef: tablePresent ? row?.indexdef ?? null : null };
}

export interface PagesUpsertArbiter {
  /** The pages table exists (nothing to check if not). */
  tablePresent: boolean;
  /** Some non-partial, valid, immediate unique index on exactly (source_id, slug) exists, under any name. */
  arbiterPresent: boolean;
  /** Duplicate (source_id, slug) groups; counted only when the arbiter is missing (0 otherwise). */
  duplicateGroups: number;
}

const PAGES_REGCLASS_SQL = `SELECT to_regclass('pages')::text AS reg`;
// Catalog-anchored candidate set (#550): the same to_regclass('pages') plus the catalog validity flags exclude an
// INVALID index, a DEFERRABLE unique and a same-named table in another schema; indpred IS NULL excludes partial indexes.
const PAGES_UNIQUE_INDEXES_SQL = `SELECT pg_get_indexdef(x.indexrelid) AS indexdef
       FROM pg_index x
      WHERE x.indrelid = to_regclass('pages')
        AND x.indisunique
        AND x.indisvalid
        AND x.indisready
        AND x.indimmediate
        AND x.indpred IS NULL`;
const PAGES_DUPLICATE_GROUPS_SQL = `SELECT COUNT(*)::text AS n FROM (
         SELECT 1 FROM pages GROUP BY source_id, slug HAVING COUNT(*) > 1
       ) d`;

/** Parse the column list out of a `pg_get_indexdef` string. */
function indexColumns(indexdef: string): string[] {
  const open = indexdef.indexOf('(');
  const close = indexdef.indexOf(')', open);
  if (open < 0 || close < 0) return [];
  return indexdef.slice(open + 1, close).split(',').map(c => c.trim().split(/\s+/)[0]!).filter(Boolean);
}

/** True when the indexdef is a non-partial unique index on exactly {source_id, slug}. */
export function isPagesArbiterShape(indexdef: string): boolean {
  if (!/^CREATE UNIQUE INDEX/i.test(indexdef)) return false;
  if (/\)\s+WHERE\s+/i.test(indexdef)) return false;
  const cols = indexColumns(indexdef).sort();
  return cols.length === 2 && cols[0] === 'slug' && cols[1] === 'source_id';
}

/** The pages(source_id, slug) upsert arbiter every putPage needs, and the duplicate groups that block restoring it. */
export async function readPagesUpsertArbiter(raw: EngineRawRead): Promise<PagesUpsertArbiter> {
  const [table] = await raw<{ reg: string | null }>(PAGES_REGCLASS_SQL);
  if (!table?.reg) return { tablePresent: false, arbiterPresent: false, duplicateGroups: 0 };
  const indexes = await raw<{ indexdef: string }>(PAGES_UNIQUE_INDEXES_SQL);
  const arbiterPresent = indexes.some(index => isPagesArbiterShape(index.indexdef));
  if (arbiterPresent) return { tablePresent: true, arbiterPresent: true, duplicateGroups: 0 };
  const [dup] = await raw<{ n: string }>(PAGES_DUPLICATE_GROUPS_SQL);
  return { tablePresent: true, arbiterPresent: false, duplicateGroups: parseInt(dup?.n ?? '0', 10) };
}

const RETRIEVAL_COLUMN_SQL = `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'pages' AND column_name = 'last_retrieved_at'
       ) AS exists`;

/** Whether pages has the `last_retrieved_at` column brainstorm and LSD's stale-page signal read (migration v79). */
export async function readRetrievalTrackingColumn(raw: EngineRawRead): Promise<boolean> {
  const [row] = await raw<{ exists: boolean }>(RETRIEVAL_COLUMN_SQL, []);
  return row?.exists === true;
}

export interface RequestIndexRow { name: string; valid: boolean | null; phase: string | null; blocks_done: string | null; blocks_total: string | null }
// One statement on both engines: PGLite has pg_index and an always-empty pg_stat_progress_create_index.
const REQUEST_INDEX_SQL = `SELECT n.name, i.indisvalid AS valid, p.phase, p.blocks_done::text, p.blocks_total::text
       FROM unnest($1::text[]) WITH ORDINALITY AS n(name, position)
       LEFT JOIN pg_index i ON i.indexrelid = to_regclass(n.name)
       LEFT JOIN LATERAL (SELECT phase, blocks_done, blocks_total FROM pg_stat_progress_create_index p
         WHERE p.relid = i.indrelid AND p.index_relid IN (i.indexrelid, 0) LIMIT 1) p ON true
      ORDER BY n.position`;

/** One row per named index, in the given order: `valid` is null when the index is missing; `phase` is set while it is built. */
export async function readRequestIndexStates(raw: EngineRawRead, names: readonly string[]): Promise<RequestIndexRow[]> {
  return raw<RequestIndexRow>(REQUEST_INDEX_SQL, [names]);
}
