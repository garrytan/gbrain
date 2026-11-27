/**
 * #6188 durable state of the fence census: what the candidate finder found,
 * where its scans stopped, and the per-source normalization trend. All of it
 * lives in `op_checkpoints`, so it needs no schema migration.
 *
 * - `fence-candidate`: one row per (source, incarnation, page slug) whose
 *   stored page (`page`) or working-tree file (`file`) fails the coordinated
 *   fence step. Each part is bound to the bytes it judged (sha256, page id,
 *   `updated_at`, file mtime) and carries location and reason codes only.
 * - `fence-scan`: one row per (source, incarnation): the DB watermark and
 *   one-time backfill cursor, the file-walk cursor and the last census.
 * - `fence-trend`: what Tier 1 normalized, per source: one row per sync run
 *   (a managed run's total commits with the checkpoint publication that
 *   completes the run; a legacy run writes its total when it ends) and one
 *   row per normalized page write (written once per request inside its
 *   publication, so a replayed publication never counts twice). Rows carry
 *   fix classes and writers (receipt principal kind or top directory), never
 *   a path or cell value.
 *
 * Candidate and scan rows survive the 7-day `op_checkpoints` purge while
 * their source incarnation lives (`purgeStaleCheckpoints`); trend rows age
 * out with it, which is all a 7-day trend needs.
 */
import type { BrainEngine } from '../engine.ts';
import type { FenceSection, FenceKind, FenceTier } from './types.ts';

export const FENCE_CANDIDATE_OP = 'fence-candidate';
export const FENCE_SCAN_OP = 'fence-scan';
export const FENCE_TREND_OP = 'fence-trend';

/** Where a candidate's first issue sits: location only. */
export interface CandidateLocation { fence: FenceKind; section: FenceSection; rows: number[]; columns: string[]; line: number | null }

/** One judged copy of a page (stored body or working-tree file). */
export interface CandidateFinding {
  tier: FenceTier;
  /** Residual reasons, or the Tier 1 fix classes when the step normalizes it (tier deterministic). */
  reasons: string[];
  location: CandidateLocation | null;
  /** sha256 of the judged sections (pages) or file bytes (files). */
  sha256: string;
  checked_at: string;
}
export interface PageFinding extends CandidateFinding { page_id: number; updated_at: string; content_hash: string | null; source_path: string | null }
export interface FileFinding extends CandidateFinding { path: string; mtime_ms: number }

export interface CandidateRecord {
  version: 1;
  source_id: string;
  incarnation: string;
  /** The page slug the stored page or file maps to. */
  key: string;
  page?: PageFinding;
  file?: FileFinding;
}

/** The DB scan: incremental pages-updated watermark plus a one-time keyset backfill over `pages.id`. */
export interface PageScanState {
  /** Lower bound (timestamptz text) of the next incremental pass; null until the backfill starts it. */
  watermark: string | null;
  /** An unfinished incremental pass: rows with `updated_at >= lower`, after `(at, id)`; `next` becomes the watermark when it ends. */
  pass: { lower: string; next: string; after: { at: string; id: number } | null } | null;
  backfill: { after_id: number; done: boolean; started_at: string; completed_at?: string };
}

/** The working-tree walk: a full first walk, then only files changed since the last walked commit (or mtime) plus dirty files. */
export interface FileScanState {
  /** An unfinished pass: `full` lists every eligible file, `changed` only what changed since `walked`; `after` is the last path judged. */
  pass: { mode: 'full' | 'changed'; after: string | null; started_at: string; commit: string | null } | null;
  /** The last completed pass: HEAD when it started (null outside Git) and its start time (the mtime watermark). */
  walked: { commit: string | null; at: string } | null;
}

export interface ScanRecord {
  version: 1;
  source_id: string;
  incarnation: string;
  /** Fence rules version the stored findings were judged with; a newer one restarts both scans. */
  rules: string;
  pages: PageScanState;
  files: FileScanState | null;
  /** The last census: complete when the backfill is done, the incremental pass caught up and the file walk finished. */
  census: { complete: boolean; fresh_at: string | null; checked_at: string };
}

const candidateFingerprint = (sourceId: string, incarnation: string, key: string) => `${sourceId}:${incarnation}:${key}`;
const scanFingerprint = (sourceId: string, incarnation: string) => `${sourceId}:${incarnation}`;

export async function readScanRecord(engine: Pick<BrainEngine, 'readFenceScanRecord'>, sourceId: string, incarnation: string): Promise<ScanRecord | null> {
  return engine.readFenceScanRecord(FENCE_SCAN_OP, scanFingerprint(sourceId, incarnation));
}

export async function writeScanRecord(engine: Pick<BrainEngine, 'writeFenceScanRecord'>, record: ScanRecord): Promise<void> {
  await engine.writeFenceScanRecord(FENCE_SCAN_OP, scanFingerprint(record.source_id, record.incarnation), record);
}

/** Stores one judged part (`page` or `file`) of a candidate, keeping the other part. */
export async function upsertCandidatePart(engine: Pick<BrainEngine, 'upsertFenceCandidatePart'>, ids: { sourceId: string; incarnation: string; key: string },
  part: 'page' | 'file', finding: PageFinding | FileFinding): Promise<void> {
  await engine.upsertFenceCandidatePart(FENCE_CANDIDATE_OP, candidateFingerprint(ids.sourceId, ids.incarnation, ids.key), ids, part, finding);
}

/** Drops the `part` of these candidates (they judged clean); a candidate with no part left is deleted. */
export async function clearCandidateParts(engine: Pick<BrainEngine, 'clearFenceCandidateParts'>, ids: { sourceId: string; incarnation: string }, part: 'page' | 'file', keys: readonly string[]): Promise<void> {
  if (!keys.length) return;
  await engine.clearFenceCandidateParts(FENCE_CANDIDATE_OP, keys.map(key => candidateFingerprint(ids.sourceId, ids.incarnation, key)), part);
}

/** Candidate records of live source incarnations (optionally one source). */
export async function readCandidateRecords(engine: Pick<BrainEngine, 'listFenceCandidateRecords'>, sourceIds?: readonly string[]): Promise<CandidateRecord[]> {
  return engine.listFenceCandidateRecords(FENCE_CANDIDATE_OP, sourceIds);
}

/** One trend row: files or pages Tier 1 normalized, by fix class and by writer. */
export interface TrendEntry { day: string; count: number; by_class: Record<string, number>; writers: Record<string, number> }

/**
 * One sync run's total, keyed by run id (a rewrite replaces it, so a run is
 * counted once); the row keeps the UTC day of its first write.
 */
export async function recordSyncRunTrend(engine: Pick<BrainEngine, 'upsertFenceTrendRunRecord'>, input: { sourceId: string; runId: string; day: string; count: number;
  byClass: Record<string, number>; writers: Record<string, number> }): Promise<void> {
  if (!input.count) return;
  const record = { version: 1, source_id: input.sourceId, day: input.day, count: input.count, by_class: input.byClass, writers: input.writers };
  await engine.upsertFenceTrendRunRecord(FENCE_TREND_OP, `${input.sourceId}:run:${input.runId}`, record);
}

/** One normalized page write (put_page, put_pages, remember, takes and fact writers), written once per request. */
export async function recordWriteTrend(engine: Pick<BrainEngine, 'insertOpCheckpointIfAbsent'>, input: { sourceId: string; requestKey: string; day: string; byClass: Record<string, number>; writer: string }): Promise<void> {
  const record = { version: 1, source_id: input.sourceId, day: input.day, count: 1, by_class: input.byClass, writers: { [input.writer]: 1 } };
  await engine.insertOpCheckpointIfAbsent(FENCE_TREND_OP, `${input.sourceId}:write:${input.requestKey}`, [record]);
}

/**
 * Writes the trend row of a committed page write whose outcome reports a
 * normalized fence (the page-write `fences_normalized` object). Managed sync
 * outcomes (a per-file fix list) are skipped: the sync run flushes its own
 * total once per run.
 */
export async function recordPublicationFenceTrend(tx: Pick<BrainEngine, 'insertOpCheckpointIfAbsent'>, row: { id: string; source_id: string; principal_kind: string }, outcome: Record<string, unknown>,
  now: Date = new Date()): Promise<void> {
  const report = outcome.fences_normalized as { count?: unknown; by_class?: Record<string, number> } | undefined;
  if (!report || Array.isArray(report) || typeof report !== 'object' || !Number(report.count)) return;
  await recordWriteTrend(tx, { sourceId: row.source_id, requestKey: row.id, day: now.toISOString().slice(0, 10), byClass: report.by_class ?? {}, writer: row.principal_kind });
}

/** Trend rows of these sources since `fromDay` (inclusive), summed per source and day. */
export async function readTrend(engine: Pick<BrainEngine, 'readFenceTrendRecords'>, sourceIds: readonly string[], fromDay: string): Promise<Map<string, TrendEntry[]>> {
  const out = new Map<string, TrendEntry[]>();
  if (!sourceIds.length) return out;
  for (const record of await engine.readFenceTrendRecords(FENCE_TREND_OP, sourceIds, fromDay)) {
    const days = out.get(record.source_id) ?? [];
    let day = days.find(entry => entry.day === record.day);
    if (!day) days.push(day = { day: record.day, count: 0, by_class: {}, writers: {} });
    day.count += Number(record.count ?? 0);
    for (const [cls, n] of Object.entries(record.by_class ?? {})) day.by_class[cls] = (day.by_class[cls] ?? 0) + Number(n);
    for (const [writer, n] of Object.entries(record.writers ?? {})) day.writers[writer] = (day.writers[writer] ?? 0) + Number(n);
    out.set(record.source_id, days);
  }
  for (const days of out.values()) days.sort((a, b) => a.day.localeCompare(b.day));
  return out;
}
