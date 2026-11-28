/**
 * Doctor reads: the statements `gbrain doctor` checks ran through `executeRaw`, each with the same text and parameters,
 * on the engine's own `executeRaw`; only their home moved (src/commands/doctor/**). The Rust engine answers the same
 * members from its store records (rust/crates/gbrain-store/src/cli_reads/doctor.rs, rust/docs/store/cli-reads-doctor.md).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/**
 * The members of this file. Each replaced a statement doctor ran through its deadline-bound executeRaw, so
 * src/core/statement-deadline.ts keeps that bound on them (BOUNDED_TYPED_READS).
 */
export const DOCTOR_READ_MEMBERS: readonly string[] = [
  'countPageChildOrphans', 'listSchemaPackSourceOverrides', 'countContextualCoverage', 'countAbandonedTakes', 'countAppliedTakeGrades',
];

/**
 * A page-child relation as `<table>.<column>`: every `PAGE_CHILD_FK_TARGETS` entry of src/core/repair/orphan-children.ts
 * except `content_chunks.page_id` (that one is `countOrphanChunks`).
 */
export type PageChildTarget =
  | 'page_versions.page_id' | 'tags.page_id' | 'takes.page_id' | 'raw_data.page_id' | 'timeline_entries.page_id'
  | 'links.from_page_id' | 'links.to_page_id' | 'links.origin_page_id' | 'files.page_id';

/**
 * One constant statement per target, the text doctor's child_table_orphans built from `orphanPredicate` (pinned against
 * it by test/doctor-reads-sql.test.ts), so no table or column name is spliced into SQL.
 */
const PAGE_CHILD_ORPHAN_SQL: Readonly<Record<PageChildTarget, string>> = {
  'page_versions.page_id': 'SELECT COUNT(*)::int AS n FROM page_versions WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = page_versions.page_id)',
  'tags.page_id': 'SELECT COUNT(*)::int AS n FROM tags WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = tags.page_id)',
  'takes.page_id': 'SELECT COUNT(*)::int AS n FROM takes WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = takes.page_id)',
  'raw_data.page_id': 'SELECT COUNT(*)::int AS n FROM raw_data WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = raw_data.page_id)',
  'timeline_entries.page_id': 'SELECT COUNT(*)::int AS n FROM timeline_entries WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = timeline_entries.page_id)',
  'links.from_page_id': 'SELECT COUNT(*)::int AS n FROM links WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = links.from_page_id)',
  'links.to_page_id': 'SELECT COUNT(*)::int AS n FROM links WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = links.to_page_id)',
  'links.origin_page_id': 'SELECT COUNT(*)::int AS n FROM links WHERE links.origin_page_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = links.origin_page_id)',
  'files.page_id': 'SELECT COUNT(*)::int AS n FROM files WHERE files.page_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = files.page_id)',
};

/** The statement for each target, for the test that pins it to `orphanPredicate`. */
export function pageChildOrphanSql(target: PageChildTarget): string {
  const sql = PAGE_CHILD_ORPHAN_SQL[target];
  if (!sql) throw new Error(`countPageChildOrphans: '${String(target)}' is not a page child target`);
  return sql;
}

/** Rows of a page-child relation whose page row is gone (a NULL reference of a SET NULL column is not one). */
export async function countPageChildOrphans(raw: EngineRawRead, target: PageChildTarget): Promise<number> {
  const [row] = await raw<{ n: string | number }>(pageChildOrphanSql(target));
  return Number(row?.n ?? 0);
}

/** One per-source schema-pack override: a `schema_pack.source.<id>` config key and the pack it names. */
export interface SchemaPackSourceOverrideRow { key: string; value: string }

/**
 * The two statements the schema_pack_source_drift check of src/commands/doctor/schema-pack-checks.ts ran, byte for byte:
 * the named keys for a caller confined to some sources, else every key the LIKE pattern matches (its `_` matches any one
 * character, as it always did). Neither orders its rows; the check reads only their count and distinct values.
 */
export const SCHEMA_PACK_SOURCE_OVERRIDE_SQL = {
  scoped: `SELECT key, value FROM config WHERE key = ANY($1::text[])`,
  unscoped: `SELECT key, value FROM config WHERE key LIKE 'schema_pack.source.%'`,
} as const;

/** The per-source schema-pack overrides: of `sourceIds` when named (`[]` names none), else of every source. */
export async function listSchemaPackSourceOverrides(raw: EngineRawRead, sourceIds: readonly string[] | null): Promise<SchemaPackSourceOverrideRow[]> {
  return sourceIds
    ? raw<SchemaPackSourceOverrideRow>(SCHEMA_PACK_SOURCE_OVERRIDE_SQL.scoped, [sourceIds.map((id) => `schema_pack.source.${id}`)])
    : raw<SchemaPackSourceOverrideRow>(SCHEMA_PACK_SOURCE_OVERRIDE_SQL.unscoped);
}

/** The doctor `contextual_retrieval_coverage` counts over live pages (of the caller's sources when scoped). */
export interface ContextualCoverageCounts { chunker_drift: number; unsealed: number; unsealed_code: number; mode_null: number }

/**
 * The three counts of src/commands/doctor/checks/calibration.ts, each the text it ran at 3852ea1505 (pinned by
 * test/doctor-reads-sql.test.ts), the scoped form adding the caller's source filter.
 */
/**
 * `safeChunksFilter('pages')` (src/core/search/safe-chunks.ts) as rendered: importing it here would close an import cycle
 * through src/core/statement-deadline.ts, which reads DOCTOR_READ_MEMBERS at load. test/doctor-reads-sql.test.ts fails
 * when the two drift.
 */
export const PAGES_SAFE_CHUNKS_FILTER = 'pages.chunker_version >= 4';

export function contextualCoverageSql(scoped: boolean): string {
  return `SELECT
         COUNT(*) FILTER (WHERE page_kind = 'markdown' AND chunker_version < $1)::int AS chunker_drift,
         -- #5004/#5247: pages of every kind the safe-chunk fence withholds from
         -- every remote read. Counted separately from drift: the chunker version
         -- may move past the fence floor, and only the fence has this consequence.
         COUNT(*) FILTER (WHERE NOT (${PAGES_SAFE_CHUNKS_FILTER}))::int AS unsealed,
         COUNT(*) FILTER (WHERE page_kind = 'code' AND NOT (${PAGES_SAFE_CHUNKS_FILTER}))::int AS unsealed_code,
         -- #4009 belt+braces: extract receipts are audit artifacts stamped
         -- mode 'none' at write time, but a reindex DB fallback can clear
         -- the stamp — never count them as "never evaluated".
         COUNT(*) FILTER (WHERE page_kind = 'markdown' AND contextual_retrieval_mode IS NULL AND type <> 'extract_receipt')::int AS mode_null
       FROM pages
       WHERE deleted_at IS NULL
         ${scoped ? 'AND source_id = ANY($2::text[])' : ''}`;
}

/**
 * since_date is TEXT and may be month-precision ('YYYY-MM'); 'YYYY-MM'::date throws "invalid input syntax for type
 * date", so the statement normalizes to the 1st before casting, the same guarded cast as listAbandonedTakes (the
 * `gbrain calibration` abandoned-threads listing), which must stay in lockstep so the doctor count matches it.
 */
export function abandonedTakesCountSql(scoped: boolean): string {
  return `SELECT COUNT(*)::int AS count FROM takes
         WHERE active = true
           AND resolved_at IS NULL
           AND superseded_by IS NULL
           AND weight >= 0.7
           AND since_date IS NOT NULL
           AND (since_date || CASE WHEN length(since_date) = 7 THEN '-01' ELSE '' END)::date
               < (now() - INTERVAL '12 months')` +
        (scoped ? `\n           AND page_id IN (SELECT id FROM pages WHERE source_id = ANY($1::text[]))` : '');
}

export function appliedTakeGradesCountSql(scoped: boolean): string {
  return `SELECT COUNT(*)::int AS applied_count FROM take_grade_cache WHERE applied = true` +
        (scoped
          ? ' AND take_id IN (SELECT t.id FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.source_id = ANY($1::text[]))'
          : '');
}

/** Live markdown pages chunked below `chunkerVersion`, pages below the safe-chunk fence (and the code ones), and markdown pages with no contextual mode. */
export async function countContextualCoverage(raw: EngineRawRead, chunkerVersion: number, sourceIds: readonly string[] | null): Promise<ContextualCoverageCounts> {
  const [row] = await raw<ContextualCoverageCounts>(contextualCoverageSql(!!sourceIds), sourceIds ? [chunkerVersion, sourceIds] : [chunkerVersion]);
  return { chunker_drift: row?.chunker_drift ?? 0, unsealed: row?.unsealed ?? 0, unsealed_code: row?.unsealed_code ?? 0, mode_null: row?.mode_null ?? 0 };
}

/** Active, unresolved, unsuperseded takes of weight 0.7 or more whose since_date is over 12 months ago, on the named sources' pages when given. */
export async function countAbandonedTakes(raw: EngineRawRead, sourceIds: readonly string[] | null): Promise<number> {
  const [row] = await raw<{ count: number }>(abandonedTakesCountSql(!!sourceIds), sourceIds ? [sourceIds] : undefined);
  return row?.count ?? 0;
}

/** Cached take verdicts with applied = true, on takes of the named sources' pages when given. */
export async function countAppliedTakeGrades(raw: EngineRawRead, sourceIds: readonly string[] | null): Promise<number> {
  const [row] = await raw<{ applied_count: number }>(appliedTakeGradesCountSql(!!sourceIds), sourceIds ? [sourceIds] : undefined);
  return row?.applied_count ?? 0;
}
