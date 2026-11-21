/**
 * The swap readiness evaluator (docs/designs/RUST_ENGINE.md "Swap readiness", D14; D23 for criterion 8).
 *
 * Authoring gate (docs/TESTING.md): (1) protects the verdict `gbrain engine swap --to rust --plan` shows: READY only when
 * every gating criterion has passing evidence. (2) Fails when a criterion passes on missing or failing evidence, when
 * a criterion row is dropped, when speed (criterion 8) blocks the opt-in swap, or when a refusal maps to the wrong
 * reason. (3) Nothing else evaluates readiness. (4) No seam: a pure function over a status document.
 */
import { describe, expect, test } from 'bun:test';
import { evaluateReadiness, type ShadowStatus } from '../src/core/engine-swap/readiness.ts';

const NOW = new Date('2026-12-01T00:00:00Z');

function ready(): ShadowStatus {
  return {
    epoch_id: 'e1', epoch_started_at: '2026-11-10T00:00:00Z',
    follower: { state: 'following', lag_ms: 0, lag_ms_p99_24h: 900, lag_ms_p99_epoch: 1200, queue_depth: 0, applied_rows: 5000, coverage_watermark: { valid: true, through: 'x', invalidated_reason: null } },
    reconcile: { state: 'idle', consecutive_clean_full_passes: 3 },
    write_comparisons: { state: 'on', sample_rate: 1, comparable: 1500, unexplained_difference: 0, uncomparable: 2, capability_missing: 0 },
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

function edit(patch: (d: ShadowStatus) => void): ShadowStatus { const d = ready(); patch(d); return d; }
const row = (v: ReturnType<typeof evaluateReadiness>, n: number) => v.criteria.find(c => c.n === n)!;

describe('swap readiness', () => {
  test('a complete passing document is READY, with all 11 criteria listed', () => {
    const v = evaluateReadiness(ready(), NOW);
    expect(v.verdict).toBe('READY');
    expect(v.reason).toBeNull();
    expect(v.criteria.map(c => c.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(v.criteria.filter(c => c.n !== 8).every(c => c.state === 'pass')).toBe(true);
    expect(v.missing_fields).toEqual([]);
  });

  test('no shadow: NOT READY, every gating criterion missing, writer coverage unknown', () => {
    const v = evaluateReadiness(null, NOW);
    expect(v.verdict).toBe('NOT READY');
    expect(v.reason).toBe('writer_coverage_unknown');
    expect(v.criteria).toHaveLength(11);
    expect(v.criteria.filter(c => c.gating).every(c => c.state === 'missing')).toBe(true);
  });

  describe('criterion 8 (speed) is reported, never gating (D23, C1 ruling 2026-11-19)', () => {
    test('a speed loss keeps the verdict READY and is reported', () => {
      const v = evaluateReadiness(edit(d => { d.bench = { pairs: 150, rust_no_worse: false, filtered_vector_margin_met: false, losses: ['p99 get_page'] }; }), NOW);
      expect(v.verdict).toBe('READY');
      expect(row(v, 8).state).toBe('reported');
      expect(row(v, 8).gating).toBe(false);
      expect(row(v, 8).detail).toContain('losses: p99 get_page');
    });
    test('no speed evidence keeps the verdict READY and adds no missing field', () => {
      const v = evaluateReadiness(edit(d => { delete d.bench; }), NOW);
      expect(v.verdict).toBe('READY');
      expect(row(v, 8).state).toBe('reported');
      expect(v.missing_fields).toEqual([]);
    });
  });

  const fails: Array<[string, number, (d: ShadowStatus) => void]> = [
    ['fewer than 14 days', 1, d => { d.epoch_started_at = '2026-11-25T00:00:00Z'; }],
    ['lag p99 at 60 s', 1, d => { d.follower!.lag_ms_p99_epoch = 60_000; }],
    ['two clean reconciles', 1, d => { d.reconcile!.consecutive_clean_full_passes = 2; }],
    ['an unseeded gap', 1, d => { d.seed!.unseeded_gap_rows_total = 4; }],
    ['under 10,000 reads', 2, d => { d.reads!.ops = [{ op: 'search', successful: 9000, minimum: 10 }]; }],
    ['a class under its minimum', 2, d => { d.reads!.ops![1]!.successful = 10; }],
    ['capability_missing in 7 days', 2, d => { d.reads!.capability_missing_7d = 1; }],
    ['an unresolved rust_error', 3, d => { d.reads!.rust_error_unresolved_7d = 1; }],
    ['an unexplained diverged', 3, d => { d.reads!.diverged_unexplained_7d = 2; }],
    ['a trigram disagreement', 4, d => { d.search!.trigram_exact_disagreements = 1; }],
    ['recall under 0.98', 4, d => { d.search!.vector_recall_at_10 = 0.97; d.search!.primary_recall_at_10 = 0.9; }],
    ['recall under the primary', 4, d => { d.search!.primary_recall_at_10 = 0.995; }],
    ['a default ranker without E1/E2', 4, d => { d.search!.keyword_title = { ranker: 'default', e1_e2_at_least_both: false }; }],
    ['under 1,000 write comparisons', 5, d => { d.write_comparisons!.comparable = 999; }],
    ['an unexplained write difference', 5, d => { d.write_comparisons!.unexplained_difference = 1; }],
    ['a privacy_diverged event', 6, d => { d.privacy_diverged = 1; }],
    ['a fingerprint mismatch', 7, d => { d.fingerprints!.mismatches = 1; }],
    ['unverified allocators', 7, d => { d.allocators!.verified = false; }],
    ['a panic', 9, d => { d.child!.panics = 1; }],
    ['a child fault', 9, d => { d.child!.faults = 1; }],
    ['no restore drill', 10, d => { d.drills!.backup_restore_passed = false; }],
    ['no eval gates', 10, d => { d.drills!.eval_gates_e1_e3 = false; }],
    ['not a preview target', 11, d => { d.eligibility!.preview_target = false; }],
  ];
  test.each(fails)('%s fails criterion %i and the verdict', (_name, n, patch) => {
    const v = evaluateReadiness(edit(patch), NOW);
    expect(v.verdict).toBe('NOT READY');
    expect(row(v, n).state).toBe('fail');
    expect(v.criteria.filter(c => c.n !== n && c.gating).every(c => c.state === 'pass')).toBe(true);
  });

  const missing: Array<[string, number, (d: ShadowStatus) => void]> = [
    ['epoch_started_at', 1, d => { delete d.epoch_started_at; }],
    ['seed.unseeded_gap_rows_total', 1, d => { delete d.seed; }],
    ['reads.ops', 2, d => { d.reads!.ops = []; }],
    ['search.vector_recall_at_10', 4, d => { delete d.search!.vector_recall_at_10; }],
    ['write_comparisons.state', 5, d => { delete d.write_comparisons!.state; }],
    ['privacy_diverged', 6, d => { delete d.privacy_diverged; }],
    ['allocators.verified', 7, d => { delete d.allocators; }],
    ['child.faults', 9, d => { delete d.child!.faults; }],
    ['drills.backup_restore_passed', 10, d => { delete d.drills!.backup_restore_passed; }],
  ];
  test.each(missing)('a missing %s is missing evidence, never a pass', (field, n, patch) => {
    const v = evaluateReadiness(edit(patch), NOW);
    expect(v.verdict).toBe('NOT READY');
    expect(v.reason).toBe('not_ready');
    expect(row(v, n).state).toBe('missing');
    expect(v.missing_fields).toContain(field);
  });

  test('missing current follower evidence is never caught up (no lag, queue or watermark)', () => {
    const v = evaluateReadiness(edit(d => { delete d.follower!.lag_ms; delete d.follower!.queue_depth; delete d.follower!.coverage_watermark; }), NOW);
    expect(v.verdict).toBe('NOT READY');
    expect(row(v, 1).state).toBe('missing');
    expect(v.missing_fields).toEqual(expect.arrayContaining(['follower.lag_ms', 'follower.queue_depth', 'follower.coverage_watermark.valid']));
  });

  test.each([
    ['NaN lag', (d: ShadowStatus) => { d.follower!.lag_ms_p99_epoch = Number.NaN; }, 1],
    ['a string count', (d: ShadowStatus) => { (d as Record<string, unknown>).privacy_diverged = '0'; }, 6],
    ['a malformed reads row', (d: ShadowStatus) => { d.reads!.ops = [{ op: 'search', successful: Number.POSITIVE_INFINITY, minimum: 1 }]; }, 2],
    ['an unparsable epoch start', (d: ShadowStatus) => { d.epoch_started_at = 'yesterday'; }, 1],
  ] as Array<[string, (d: ShadowStatus) => void, number]>)('malformed evidence (%s) never passes', (_name, patch, n) => {
    const v = evaluateReadiness(edit(patch), NOW);
    expect(v.verdict).toBe('NOT READY');
    expect(['missing', 'fail']).toContain(row(v, n).state);
  });

  test('ts_rank keyword disagreements fail, and a default ranker with E1 and E2 passes', () => {
    expect(row(evaluateReadiness(edit(d => { d.search!.keyword_title = { ranker: 'ts_rank', exact_disagreements: 2 }; }), NOW), 4).state).toBe('fail');
    expect(evaluateReadiness(edit(d => { d.search!.keyword_title = { ranker: 'default', e1_e2_at_least_both: true }; }), NOW).verdict).toBe('READY');
    expect(row(evaluateReadiness(edit(d => { d.search!.keyword_title = { ranker: 'ts_rank' }; }), NOW), 4).state).toBe('missing');
  });

  test('write comparisons the shadow cannot make refuse (capability_missing)', () => {
    const v = evaluateReadiness(edit(d => { d.write_comparisons!.state = 'capability_missing'; }), NOW);
    expect(v.verdict).toBe('NOT READY');
    expect(row(v, 5).state).toBe('missing');
  });

  test('a fingerprint probe that was not run is missing evidence', () => {
    const v = evaluateReadiness(edit(d => { d.fingerprints!.probe!.state = 'not_run'; }), NOW);
    expect(row(v, 7).state).toBe('missing');
    expect(v.reason).toBe('not_ready');
  });

  test.each([
    ['team_brain', (d: ShadowStatus) => { d.eligibility!.team_brain = true; }],
    ['multiple_writer_hosts', (d: ShadowStatus) => { d.eligibility!.writer_hosts_7d = 2; }],
    ['writer_coverage_unknown', (d: ShadowStatus) => { d.eligibility!.unknown_writer_paths = 1; }],
    ['writer_coverage_unknown', (d: ShadowStatus) => { d.eligibility!.writer_hosts_7d = null; }],
    ['fingerprint_semantics_differ', (d: ShadowStatus) => { d.fingerprints!.probe!.state = 'fail'; }],
    ['follower_behind', (d: ShadowStatus) => { d.follower!.queue_depth = 3; }],
    ['follower_behind', (d: ShadowStatus) => { d.follower!.lag_ms = 40; }],
    ['follower_behind', (d: ShadowStatus) => { d.follower!.coverage_watermark!.valid = false; d.privacy_diverged = 1; }],
  ] as Array<[string, (d: ShadowStatus) => void]>)('maps to %s', (reason, patch) => {
    const v = evaluateReadiness(edit(patch), NOW);
    expect(v.verdict).toBe('NOT READY');
    expect(v.reason as string | null).toBe(reason);
  });

  test.each([
    ['zero observed writer hosts', (d: ShadowStatus) => { d.eligibility!.writer_hosts_7d = 0; }],
    ['a fractional host count', (d: ShadowStatus) => { d.eligibility!.writer_hosts_7d = 0.5; }],
  ] as Array<[string, (d: ShadowStatus) => void]>)('%s is no writer evidence: NOT READY, writer_coverage_unknown', (_name, patch) => {
    const v = evaluateReadiness(edit(patch), NOW);
    expect(v.verdict).toBe('NOT READY');
    expect(v.reason as string | null).toBe('writer_coverage_unknown');
    expect(row(v, 11).state).not.toBe('pass');
  });

  test('a topology reason outranks every other failure', () => {
    const v = evaluateReadiness(edit(d => { d.eligibility!.writer_hosts_7d = 3; d.fingerprints!.probe!.state = 'fail'; d.follower!.lag_ms = 50; }), NOW);
    expect(v.reason).toBe('multiple_writer_hosts');
  });
});
