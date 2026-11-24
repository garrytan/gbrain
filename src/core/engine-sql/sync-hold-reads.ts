/**
 * The git sync hold reads persistence/sync-holds.ts readGitSourceHolds, readGitHoldRetryPaths and buildHoldReport ran through
 * `executeRaw` (Rust engine lane 11).
 * The statement text is the caller's, byte for byte (test/engine-sql-caller-raw-sql-pins.test.ts), so PGLite and
 * Postgres answer exactly as before. A Rust brain keeps no hold rows: its git sync path, the only hold writer, refuses
 * (src/core/rust-engine/store-members/persistence.ts).
 */
import { GIT_HOLD_OP, GIT_HOLD_SUMMARY_OP } from './persistence-journal.ts';

/** The op_checkpoints op of a `gbrain sources retry-held` request: the held paths the next sync re-screens. */
export const GIT_HOLD_RETRY_OP = 'sync-hold-retry';

/** The engine's own executeRaw, so a statement fault a test injects on the engine reaches the hold read. */
export interface HoldRead {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

/** Which holds `readGitHoldRecords` returns: every source's, or only `sourceIds`; every run's, or only `runId`'s. */
export interface GitHoldRecordsQuery { sourceIds?: string[]; runId?: string }

/** $1 the hold op, $2 the source ids or null, $3 the run id or null; a read-only mirror's record says so. */
export const GIT_HOLD_RECORDS_SQL = `SELECT CASE WHEN COALESCE(s.config->>'mirror_read_only','false')='true' THEN jsonb_set(h.completed_keys->0,'{read_only_checkout}','true'::jsonb) ELSE h.completed_keys->0 END AS record FROM op_checkpoints h
    JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
    WHERE h.op=$1 AND ($2::text[] IS NULL OR s.id=ANY($2::text[])) AND ($3::text IS NULL OR h.completed_keys->0->>'run_id'=$3)
    ORDER BY s.id COLLATE "C",h.fingerprint COLLATE "C"`;

/** The hold records of each source's current incarnation, by source id then fingerprint. */
export function readGitHoldRecords<R = Record<string, unknown>>(exec: HoldRead, opts: GitHoldRecordsQuery = {}): Promise<Array<{ record: R }>> {
  return exec.executeRaw<{ record: R }>(GIT_HOLD_RECORDS_SQL, [GIT_HOLD_OP, opts.sourceIds ?? null, opts.runId ?? null]);
}

/** $1 the retry op, $2 the source incarnation's fingerprint. */
export const GIT_HOLD_RETRY_SQL = 'SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2';

/** The retry request's keys for one source incarnation (`fingerprint`), or null when none is pending. */
export async function readGitHoldRetryRequest(exec: HoldRead, fingerprint: string): Promise<Array<{ paths?: unknown }> | null> {
  const [row] = await exec.executeRaw<{ completed_keys: Array<{ paths?: unknown }> }>(GIT_HOLD_RETRY_SQL, [GIT_HOLD_RETRY_OP, fingerprint]);
  return row ? row.completed_keys : null;
}

/** One source incarnation's hold summary counters (zero when a counter is absent). */
export interface GitHoldSummaryRow {
  count: number | string; images: number | string; fences: number | string; stalled: number | string;
  concurrent: number | string; dirty: number | string; drift: number | string;
}

/** $1 the summary op, $2 the source incarnation's fingerprint. */
export const GIT_HOLD_SUMMARY_SQL = `SELECT COALESCE((completed_keys->0->>'count')::int,0) AS count,
      COALESCE((completed_keys->0->>'drift')::int,0) AS drift,
      COALESCE((completed_keys->0->>'images')::int,0) AS images, COALESCE((completed_keys->0->>'fences')::int,0) AS fences, COALESCE((completed_keys->0->>'stalled')::int,0) AS stalled,
      COALESCE((completed_keys->0->>'concurrent')::int,0) AS concurrent, COALESCE((completed_keys->0->>'dirty')::int,0) AS dirty
    FROM op_checkpoints WHERE op=$1 AND fingerprint=$2`;

/** $1 the source id: the text of its `mirror_read_only` config key. */
export const SOURCE_MIRROR_READ_ONLY_SQL = "SELECT config->>'mirror_read_only' AS mirror FROM sources WHERE id=$1";

/** What a sync hold report reads besides the holds: the summary counters (null when the incarnation has none) and the source's mirror flag text (null when unset or the source is absent). */
export interface GitHoldReportInputs { summary: GitHoldSummaryRow | null; mirror: string | null }

/** The hold report's summary and mirror flag for one source and its incarnation's fingerprint, read in parallel. */
export async function readGitHoldReportInputs(exec: HoldRead, sourceId: string, fingerprint: string): Promise<GitHoldReportInputs> {
  const [[summary], [source]] = await Promise.all([
    exec.executeRaw<GitHoldSummaryRow>(GIT_HOLD_SUMMARY_SQL, [GIT_HOLD_SUMMARY_OP, fingerprint]),
    exec.executeRaw<{ mirror: string | null }>(SOURCE_MIRROR_READ_ONLY_SQL, [sourceId]),
  ]);
  return { summary: summary ?? null, mirror: source?.mirror ?? null };
}
