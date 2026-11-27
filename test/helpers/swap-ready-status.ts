/** A shadow status document that passes every swap readiness criterion (test/engine-swap-*.test.ts). */
import type { ShadowStatus } from '../../src/core/engine-swap/readiness.ts';

export function readinessReadyFor(): ShadowStatus {
  return {
    epoch_id: 'e1', epoch_started_at: '2026-11-10T00:00:00Z',
    follower: { state: 'following', lag_ms: 0, lag_ms_p99_24h: 900, lag_ms_p99_epoch: 1200, queue_depth: 0, applied_rows: 5000, coverage_watermark: { valid: true, through: 'x', invalidated_reason: null } },
    reconcile: { state: 'idle', consecutive_clean_full_passes: 3 },
    // 100 qualifying writes a day for 20 days before 2026-12-01: criterion 5's bar is the 1,000 cap (shadow/write-bar.ts).
    write_comparisons: { state: 'on', sample_rate: 1, comparable: 1500, unexplained_difference: 0, uncomparable: 2, capability_missing: 0,
      qualifying_writes: { by_day: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [new Date(Date.parse('2026-12-01T00:00:00Z') - i * 86_400_000).toISOString().slice(0, 10), 100])), first_seen: '2026-11-10T00:00:00Z' } },
    fingerprints: { checked_rows: 900, mismatches: 0, probe: { state: 'pass', checked_at: '2026-11-30T00:00:00Z', server_version: '16', collation: 'C' } },
    allocators: { verified: true, checked_at: '2026-11-30T00:00:00Z' },
    seed: { seed_id: 's', finished_at: '2026-11-10T01:00:00Z', unseeded_gap_rows_total: 0 },
    reads: { ops: [{ op: 'search', successful: 8000, minimum: 1000 }, { op: 'get_page', successful: 4000, minimum: 1000 }], capability_missing_7d: 0, rust_error_unresolved_7d: 0, diverged_unexplained_7d: 0 },
    search: { trigram_exact_disagreements: 0, keyword_title: { ranker: 'ts_rank', exact_disagreements: 0 }, vector_recall_at_10: 0.99, primary_recall_at_10: 0.985 },
    privacy_diverged: 0,
    bench: { pairs: 150, rust_no_worse: true, filtered_vector_margin_met: true, losses: [] },
    child: { panics: 0, faults: 0 },
    drills: { backup_restore_passed: true, eval_gates_e1_e3: true },
    eligibility: { writer_hosts_7d: 1, unknown_writer_paths: 0, team_brain: false, preview_target: true },
  };
}
