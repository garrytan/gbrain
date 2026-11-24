/**
 * The fence census reads and writes (`src/core/fence-repair/census.ts`, `census-store.ts`) and the doctor's segmented-page
 * count: the statements the census ran through `executeRaw`, each with the same text and parameters, on the engine's own
 * `executeRaw`; only their home moved. PGLite and Postgres run these exact statements. Nothing here is composed: the page
 * column list the census spliced in is written out in each of the two page reads, and test/fence-census-sql.test.ts pins
 * each text against the original.
 *
 * The Rust engine serves every member from its store (rust/docs/store/cli-reads-doctor-fence.md). The census state is
 * `op_checkpoints` rows (`fence-candidate`, `fence-scan`) in the store's housekeeping key space; the trend rows
 * (`fence-trend`) have no store writer, so the Rust trend read answers `[]` without a call.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import type { FileFinding, PageFinding, ScanRecord } from '../fence-repair/census-store.ts';

/**
 * The members of this file. Each replaced a statement run through the deadline-bound executeRaw, so
 * src/core/statement-deadline.ts keeps that bound on them (BOUNDED_TYPED_READS).
 */
export const FENCE_CENSUS_MEMBERS: readonly string[] = [
  'listFenceCensusSources', 'readFencePassHorizon', 'listFenceCensusPagesById', 'listFenceCensusPagesUpdated',
  'listLiveFencePageIds', 'readFenceScanRecord', 'writeFenceScanRecord', 'upsertFenceCandidatePart',
  'clearFenceCandidateParts', 'readFenceTrendRecords', 'countSegmentedFencePages', 'readBudgetLedgerDay',
];

/** A source the census scans: not archived, with an incarnation. */
export interface FenceCensusSource { id: string; incarnation: string; local_path: string | null }

/** A stored page as the census judges it; the bodies only for a live markdown page that mentions a fence marker. */
export interface FenceCensusPage {
  id: number; slug: string; type: string; frontmatter: Record<string, unknown> | null; source_path: string | null; content_hash: string | null;
  updated_at: string; live: boolean; compiled_truth: string | null; timeline: string | null;
}

/** One stored trend row. */
export interface FenceTrendRecord { source_id: string; day: string; count?: number; by_class?: Record<string, number>; writers?: Record<string, number> }

const LIST_FENCE_CENSUS_SOURCES_SQL = `SELECT id, incarnation::text AS incarnation, local_path FROM sources
    WHERE archived IS NOT TRUE AND incarnation IS NOT NULL AND ($1::text[] IS NULL OR id=ANY($1::text[])) ORDER BY id COLLATE "C"`;

/** The live sources with an incarnation (only `sourceIds` when given), by id. */
export async function listFenceCensusSources(raw: EngineRawRead, sourceIds: readonly string[] | null): Promise<FenceCensusSource[]> {
  return raw<FenceCensusSource>(LIST_FENCE_CENSUS_SOURCES_SQL, [sourceIds ? [...sourceIds] : null]);
}

const READ_FENCE_PASS_HORIZON_SQL = `SELECT (LEAST(now(), COALESCE((SELECT min(xact_start) FROM pg_stat_activity
        WHERE datname=current_database() AND backend_xid IS NOT NULL AND pid<>pg_backend_pid()), now())) - ($1::int * interval '1 millisecond'))::text AS at`;
const READ_FENCE_PASS_HORIZON_FALLBACK_SQL = `SELECT (now() - ($1::int * interval '1 millisecond'))::text AS at`;

/** Where the next incremental pass starts: now, or the start of the oldest writer transaction still open, minus the grace. */
export async function readFencePassHorizon(raw: EngineRawRead, graceMs: number): Promise<string> {
  const grace = Math.max(0, Math.floor(graceMs));
  try {
    const [row] = await raw<{ at: string }>(READ_FENCE_PASS_HORIZON_SQL, [grace]);
    return row!.at;
  } catch {
    const [row] = await raw<{ at: string }>(READ_FENCE_PASS_HORIZON_FALLBACK_SQL, [grace]);
    return row!.at;
  }
}

const LIST_FENCE_CENSUS_PAGES_BY_ID_SQL = `SELECT id, slug, type, frontmatter, source_path, content_hash, updated_at::text AS updated_at,
  (deleted_at IS NULL AND page_kind='markdown') AS live,
  CASE WHEN deleted_at IS NULL AND page_kind='markdown' AND ((strpos(compiled_truth,'gbrain:facts:')>0 OR strpos(compiled_truth,'gbrain:takes:')>0) OR (strpos(timeline,'gbrain:facts:')>0 OR strpos(timeline,'gbrain:takes:')>0)) THEN compiled_truth END AS compiled_truth,
  CASE WHEN deleted_at IS NULL AND page_kind='markdown' AND ((strpos(compiled_truth,'gbrain:facts:')>0 OR strpos(compiled_truth,'gbrain:takes:')>0) OR (strpos(timeline,'gbrain:facts:')>0 OR strpos(timeline,'gbrain:takes:')>0)) THEN timeline END AS timeline FROM pages WHERE source_id=$1 AND id>$2 ORDER BY id LIMIT $3`;

/** The source's pages after `afterId`, by id, at most `limit`. */
export async function listFenceCensusPagesById(raw: EngineRawRead, sourceId: string, afterId: number, limit: number): Promise<FenceCensusPage[]> {
  return raw<FenceCensusPage>(LIST_FENCE_CENSUS_PAGES_BY_ID_SQL, [sourceId, afterId, limit]);
}

const LIST_FENCE_CENSUS_PAGES_UPDATED_SQL = `SELECT id, slug, type, frontmatter, source_path, content_hash, updated_at::text AS updated_at,
  (deleted_at IS NULL AND page_kind='markdown') AS live,
  CASE WHEN deleted_at IS NULL AND page_kind='markdown' AND ((strpos(compiled_truth,'gbrain:facts:')>0 OR strpos(compiled_truth,'gbrain:takes:')>0) OR (strpos(timeline,'gbrain:facts:')>0 OR strpos(timeline,'gbrain:takes:')>0)) THEN compiled_truth END AS compiled_truth,
  CASE WHEN deleted_at IS NULL AND page_kind='markdown' AND ((strpos(compiled_truth,'gbrain:facts:')>0 OR strpos(compiled_truth,'gbrain:takes:')>0) OR (strpos(timeline,'gbrain:facts:')>0 OR strpos(timeline,'gbrain:takes:')>0)) THEN timeline END AS timeline FROM pages WHERE source_id=$1 AND updated_at>=$2::timestamptz
      AND ($3::timestamptz IS NULL OR (updated_at, id) > ($3::timestamptz, $4::int)) ORDER BY pages.updated_at, pages.id LIMIT $5`;

/** The source's pages updated at or after `lower`, after `(after.at, after.id)` when given, by `(updated_at, id)`, at most `limit`. */
export async function listFenceCensusPagesUpdated(raw: EngineRawRead, sourceId: string, lower: string, after: { at: string; id: number } | null,
  limit: number): Promise<FenceCensusPage[]> {
  return raw<FenceCensusPage>(LIST_FENCE_CENSUS_PAGES_UPDATED_SQL, [sourceId, lower, after?.at ?? null, after?.id ?? 0, limit]);
}

const LIST_LIVE_FENCE_PAGE_IDS_SQL = 'SELECT id FROM pages WHERE id=ANY($1::int[]) AND deleted_at IS NULL';

/** The ids among `pageIds` of pages that are not soft-deleted. */
export async function listLiveFencePageIds(raw: EngineRawRead, pageIds: readonly number[]): Promise<number[]> {
  if (!pageIds.length) return [];
  const rows = await raw<{ id: number }>(LIST_LIVE_FENCE_PAGE_IDS_SQL, [[...pageIds]]);
  return rows.map(row => Number(row.id));
}

const READ_FENCE_SCAN_RECORD_SQL = 'SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND fingerprint=$2';

/** The stored scan record of one (source, incarnation), or null. */
export async function readFenceScanRecord(raw: EngineRawRead, op: string, fingerprint: string): Promise<ScanRecord | null> {
  const [row] = await raw<{ record: ScanRecord }>(READ_FENCE_SCAN_RECORD_SQL, [op, fingerprint]);
  return row?.record ?? null;
}

const WRITE_FENCE_SCAN_RECORD_SQL = `INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,$3::text::jsonb,now())
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`;

/** Stores the scan record, replacing the one at the same (op, fingerprint). */
export async function writeFenceScanRecord(raw: EngineRawRead, op: string, fingerprint: string, record: ScanRecord): Promise<void> {
  await raw(WRITE_FENCE_SCAN_RECORD_SQL, [op, fingerprint, JSON.stringify([record])]);
}

const UPSERT_FENCE_CANDIDATE_PART_SQL = `INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('version',1,'source_id',$3::text,'incarnation',$4::text,'key',$5::text,$6::text,$7::text::jsonb)),now())
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array((op_checkpoints.completed_keys->0)||jsonb_build_object($6::text,$7::text::jsonb)),updated_at=now()`;

/** Stores one judged part (`page` or `file`) of a candidate, keeping the other part. */
export async function upsertFenceCandidatePart(raw: EngineRawRead, op: string, fingerprint: string, ids: { sourceId: string; incarnation: string; key: string },
  part: 'page' | 'file', finding: PageFinding | FileFinding): Promise<void> {
  await raw(UPSERT_FENCE_CANDIDATE_PART_SQL, [op, fingerprint, ids.sourceId, ids.incarnation, ids.key, part, JSON.stringify(finding)]);
}

const DELETE_FENCE_CANDIDATES_WITHOUT_PART_SQL = 'DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[]) AND (completed_keys->0->$3::text) IS NULL';
const DROP_FENCE_CANDIDATE_PART_SQL = `UPDATE op_checkpoints SET completed_keys=jsonb_build_array((completed_keys->0)-$3::text),updated_at=now()
    WHERE op=$1 AND fingerprint=ANY($2::text[]) AND (completed_keys->0->$3::text) IS NOT NULL`;

/** Drops the `part` of these candidates; a candidate with no other part left is deleted (`other` is the part to keep). */
export async function clearFenceCandidateParts(raw: EngineRawRead, op: string, fingerprints: readonly string[], part: 'page' | 'file'): Promise<void> {
  if (!fingerprints.length) return;
  const other = part === 'page' ? 'file' : 'page';
  await raw(DELETE_FENCE_CANDIDATES_WITHOUT_PART_SQL, [op, [...fingerprints], other]);
  await raw(DROP_FENCE_CANDIDATE_PART_SQL, [op, [...fingerprints], part]);
}

const READ_FENCE_TREND_RECORDS_SQL = `SELECT completed_keys->0 AS record FROM op_checkpoints
    WHERE op=$1 AND completed_keys->0->>'source_id'=ANY($2::text[]) AND completed_keys->0->>'day'>=$3`;

/** The trend rows of these sources from `fromDay` (inclusive). */
export async function readFenceTrendRecords(raw: EngineRawRead, op: string, sourceIds: readonly string[], fromDay: string): Promise<FenceTrendRecord[]> {
  const rows = await raw<{ record: FenceTrendRecord }>(READ_FENCE_TREND_RECORDS_SQL, [op, [...sourceIds], fromDay]);
  return rows.map(row => row.record);
}

const COUNT_SEGMENTED_FENCE_PAGES_SQL = `SELECT COUNT(*)::int AS n FROM pages
    WHERE deleted_at IS NULL AND page_kind = 'markdown' AND body_storage = 'segmented' AND source_id = ANY($1::text[])
      AND (source_path IS NULL OR NOT (source_id = ANY($2::text[])))`;

/** Live markdown pages of `sourceIds` stored in segments with no walked file: no path, or a source whose checkout was not walked. */
export async function countSegmentedFencePages(raw: EngineRawRead, sourceIds: readonly string[], walkedSourceIds: readonly string[]): Promise<number> {
  const [row] = await raw<{ n: number }>(COUNT_SEGMENTED_FENCE_PAGES_SQL, [[...sourceIds], [...walkedSourceIds]]);
  return Number(row?.n ?? 0);
}

/** One `budget_ledger` day row as text (`numeric::text`). */
export interface BudgetLedgerDayRow { reserved: string; committed: string; cap: string | null }

const READ_BUDGET_LEDGER_DAY_SQL = 'SELECT reserved_usd::text AS reserved, committed_usd::text AS committed, cap_usd::text AS cap FROM budget_ledger WHERE scope = $1 AND resolver_id = $2 AND local_date = $3::date';

/** The daily budget ledger row of (scope, resolver, day), or null when none exists (the fence repair's spend for the day, read by the doctor). */
export async function readBudgetLedgerDay(raw: EngineRawRead, scope: string, resolver: string, day: string): Promise<BudgetLedgerDayRow | null> {
  const [row] = await raw<BudgetLedgerDayRow>(READ_BUDGET_LEDGER_DAY_SQL, [scope, resolver, day]);
  return row ?? null;
}
