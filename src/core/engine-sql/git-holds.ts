/**
 * The storage statements of the Git sync holds (persistence/sync-holds.ts), as engine members so the Rust engine can serve
 * them: the compare-and-set of one hold row with its source's summary counters, the read of one hold with its source's
 * read-only mark, and a retry request. PGLite and Postgres run the statements sync-holds.ts ran before. The Rust store
 * applies each one as one write (rust/crates/gbrain-store/src/persistence/git_holds.rs; rust/docs/store/repair-bookkeeping.md,
 * "Git holds").
 */
import type { BrainEngine } from '../engine.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import type { SourceHoldRecordRow } from './repair-plan-scans.ts';
import { GIT_HOLD_OP, GIT_HOLD_SUMMARY_OP } from './persistence-journal.ts';

export const GIT_HOLD_RETRY_OP = 'sync-hold-retry';

/**
 * The per-source summary counters besides `count`: `stale` the holds of files whose page exists; `images` the #5493
 * unsupported-image holds; `fences` the #6188 `invalid_fence` holds; `concurrent` the #6194 `concurrent_write` holds;
 * `stalled` the #6278 out-of-attempts holds; `dirty` the #6340 `worktree_dirty` holds; `drift` the #6712 `file_drift` holds.
 */
export const GIT_HOLD_SUMMARY_COUNTERS = ['stale', 'images', 'fences', 'concurrent', 'stalled', 'dirty', 'drift'] as const;
export type GitHoldSummaryCounter = typeof GIT_HOLD_SUMMARY_COUNTERS[number];
/** What a swap adds to the summary's `count` and each counter (each clamped at zero). */
export type GitHoldSummaryDelta = { count: number } & Record<GitHoldSummaryCounter, number>;

/**
 * One hold row's compare-and-set. `prior` is the `completed_keys` the caller read (null: no row), `next` what replaces it
 * (null: delete the row). With `summary`, the source's summary row is created or locked first, and its counters move by the
 * delta when the swap lands.
 */
export interface GitHoldSwap {
  sourceId: string; incarnation: string; path: string;
  prior: readonly unknown[] | null; next: readonly unknown[] | null;
  summary: GitHoldSummaryDelta | null;
}

export const gitHoldFingerprint = (sourceId: string, incarnation: string, path: string) => `${sourceId}:${incarnation}:${path}`;
export const summaryFingerprint = (sourceId: string, incarnation: string) => `${sourceId}:${incarnation}`;

type Exec = Pick<BrainEngine, 'executeRaw'>;

/** Validates a swap before any statement runs: a swap from no row to no row has nothing to set. */
export function checkGitHoldSwap(input: GitHoldSwap): void {
  if (input.prior === null && input.next === null) throw new Error('swapGitHold: prior and next cannot both be null');
}

/** Creates or locks the source's summary row, so hold writes of one source serialize. */
async function lockSummary(tx: Exec, sourceId: string, incarnation: string): Promise<void> {
  await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('source_id',$3::text,'incarnation',$4::text,'count',0,'stale',0)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET updated_at=now()`,
  [GIT_HOLD_SUMMARY_OP, summaryFingerprint(sourceId, incarnation), sourceId, incarnation]);
}

async function adjustSummary(tx: Exec, sourceId: string, incarnation: string, delta: GitHoldSummaryDelta): Promise<void> {
  const pairs = GIT_HOLD_SUMMARY_COUNTERS.map((name, i) => `'${name}',GREATEST(0,COALESCE((completed_keys->0->>'${name}')::int,0)+$${i + 4}::int)`).join(',');
  await tx.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_build_array((completed_keys->0)||jsonb_build_object(
      'count',GREATEST(0,COALESCE((completed_keys->0->>'count')::int,0)+$3::int),${pairs})),updated_at=now() WHERE op=$1 AND fingerprint=$2`,
  [GIT_HOLD_SUMMARY_OP, summaryFingerprint(sourceId, incarnation), delta.count, ...GIT_HOLD_SUMMARY_COUNTERS.map(name => delta[name])]);
}

/** Swaps one hold row when it still holds `prior`; true when it did. */
export async function swapGitHold(tx: Exec, input: GitHoldSwap): Promise<boolean> {
  checkGitHoldSwap(input);
  if (input.summary) await lockSummary(tx, input.sourceId, input.incarnation);
  const key = [GIT_HOLD_OP, gitHoldFingerprint(input.sourceId, input.incarnation, input.path)];
  const rows = input.prior === null
    ? await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
        ON CONFLICT(op,fingerprint) DO NOTHING RETURNING 1`, [...key, JSON.stringify(input.next)])
    : input.next === null
      ? await tx.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb RETURNING 1', [...key, JSON.stringify(input.prior)])
      : await tx.executeRaw(`UPDATE op_checkpoints SET completed_keys=$3::text::jsonb, updated_at=now()
          WHERE op=$1 AND fingerprint=$2 AND completed_keys=$4::text::jsonb RETURNING 1`, [...key, JSON.stringify(input.next), JSON.stringify(input.prior)]);
  if (!rows.length) return false;
  const delta = input.summary;
  if (delta && (delta.count !== 0 || GIT_HOLD_SUMMARY_COUNTERS.some(name => delta[name] !== 0))) {
    await adjustSummary(tx, input.sourceId, input.incarnation, delta);
  }
  return true;
}

/** One hold record (`completed_keys->0`) with its source's read-only-mirror flag; null when the path has no hold. */
export async function readGitHoldRecord(exec: LegacyUnscopedRead, sourceId: string, incarnation: string, path: string): Promise<SourceHoldRecordRow | null> {
  const [row] = await exec.executeRaw<{ record: Record<string, unknown> | null; mirror_read_only: boolean }>(`SELECT h.completed_keys->0 AS record,
      COALESCE(s.config->>'mirror_read_only','false')='true' AS mirror_read_only
    FROM op_checkpoints h LEFT JOIN sources s ON s.id=$3 WHERE h.op=$1 AND h.fingerprint=$2`,
  [GIT_HOLD_OP, gitHoldFingerprint(sourceId, incarnation, path), sourceId]);
  return row?.record ? { record: row.record, mirror_read_only: row.mirror_read_only === true } : null;
}

/**
 * `sources retry-held` on a Git source: adds `paths` to the source's retry request, without duplicates and in byte order,
 * stamped `requestedAt`.
 */
export async function requestGitHoldRetry(tx: Exec, sourceId: string, incarnation: string, paths: readonly string[], requestedAt: string): Promise<void> {
  await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('version',1,'source_id',$3::text,'incarnation',$5::text,
        'paths',(SELECT COALESCE(jsonb_agg(p ORDER BY p COLLATE "C"),'[]'::jsonb) FROM (SELECT DISTINCT jsonb_array_elements_text($4::text::jsonb) AS p) paths),
        'requested_at',$6::text)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array(jsonb_build_object('version',1,'source_id',$3::text,'incarnation',$5::text,
      'paths',(SELECT COALESCE(jsonb_agg(p ORDER BY p COLLATE "C"),'[]'::jsonb) FROM (
        SELECT jsonb_array_elements_text(COALESCE(op_checkpoints.completed_keys->0->'paths','[]'::jsonb)) AS p
        UNION SELECT jsonb_array_elements_text($4::text::jsonb)) paths),
      'requested_at',$6::text)),updated_at=now()`,
  [GIT_HOLD_RETRY_OP, summaryFingerprint(sourceId, incarnation), sourceId, JSON.stringify(paths), incarnation, requestedAt]);
}
