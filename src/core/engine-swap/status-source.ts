/**
 * The shadow status document the swap plan reads (readiness.ts `ShadowStatus`), built from what the shadow writes
 * today (S3: the seed record, the follower file, the reconcile passes and the shadow state). Fields the shadow does
 * not produce yet (read comparisons, search arms, bench, drills, writer observations) are left out, so the evaluator
 * reports them `missing` and the verdict stays NOT READY until they exist. Nothing here is guessed.
 */
import { buildFollowStatus } from '../../shadow/follow-status.ts';
import { readSeedRecord } from '../../shadow/seed.ts';
import { readShadowState } from '../../shadow/state.ts';
import type { ShadowStatus } from './readiness.ts';

/** Null when this brain has no seeded shadow. */
export function shadowStatusFromDir(dir: string, now: Date = new Date()): ShadowStatus | null {
  if (!readSeedRecord(dir)) return null;
  const s = buildFollowStatus(dir, readShadowState(dir), now);
  const f = s.follower;
  return {
    ...(s.epoch_id ? { epoch_id: s.epoch_id } : {}),
    ...(s.epoch_started_at ? { epoch_started_at: s.epoch_started_at } : {}),
    follower: {
      state: f.state,
      ...(f.lag_ms !== null ? { lag_ms: f.lag_ms } : {}),
      ...(f.lag_ms_p99_24h !== null ? { lag_ms_p99_24h: f.lag_ms_p99_24h } : {}),
      ...(f.lag_ms_p99_epoch !== null ? { lag_ms_p99_epoch: f.lag_ms_p99_epoch } : {}),
      queue_depth: f.queue_depth,
      applied_rows: f.applied_rows,
      coverage_watermark: f.coverage_watermark,
    },
    reconcile: { state: s.reconcile.state, consecutive_clean_full_passes: s.reconcile.consecutive_clean_full_passes, next_full_pass_due: s.reconcile.next_full_pass_due },
    write_comparisons: { ...s.write_comparisons, sample_rate: s.write_comparisons.sample_rate ?? undefined },
    fingerprints: {
      checked_rows: s.fingerprints.checked_rows, mismatches: s.fingerprints.mismatches,
      probe: { state: s.fingerprints.probe.state, ...(s.fingerprints.probe.checked_at ? { checked_at: s.fingerprints.probe.checked_at } : {}), mismatches: s.fingerprints.probe.mismatches },
    },
    allocators: { verified: s.allocators.verified, ...(s.allocators.checked_at ? { checked_at: s.allocators.checked_at } : {}) },
    seed: { ...(s.seed.seed_id ? { seed_id: s.seed.seed_id } : {}), finished_at: s.seed.finished_at, ...(s.seed.unseeded_gap_rows_total !== null ? { unseeded_gap_rows_total: s.seed.unseeded_gap_rows_total } : {}) },
  };
}
