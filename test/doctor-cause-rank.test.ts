/**
 * #1685 GAP C — cause-ranked doctor issues. Pure unit tests.
 *
 * Covers: fail-before-warn + root-before-symptom ordering, evidence-gated
 * downstream_of (NEVER from co-occurrence alone — CODEX #9), fix-hint
 * preference, and the DECISION 4A drift guard (every cause-graph name still
 * exists in doctor-categories).
 */
import { describe, it, expect } from 'bun:test';
import {
  rankIssues,
  ROOT_CAUSE_CHECKS,
  SYMPTOM_CHECKS,
  CAUSE_GRAPH_NAMES,
  allKnownCheckNames,
  type RankableCheck,
} from '../src/core/doctor-cause-rank.ts';

const ok = (name: string): RankableCheck => ({ name, status: 'ok', message: 'fine' });
const warn = (name: string, msg = 'warned'): RankableCheck => ({ name, status: 'warn', message: msg });
const fail = (name: string, msg = 'failed'): RankableCheck => ({ name, status: 'fail', message: msg });

describe('rankIssues', () => {
  it('drops ok checks, returns [] when everything is healthy', () => {
    expect(rankIssues([ok('connection'), ok('queue_health')])).toEqual([]);
  });

  it('orders fail before warn', () => {
    const out = rankIssues([warn('stale_locks'), fail('schema_version')]);
    expect(out.map((i) => i.name)).toEqual(['schema_version', 'stale_locks']);
  });

  it('orders root before symptom within the same status', () => {
    // queue_health (symptom) + worker_oom_loop (root), both fail.
    const out = rankIssues([fail('queue_health'), fail('worker_oom_loop')]);
    expect(out.map((i) => i.name)).toEqual(['worker_oom_loop', 'queue_health']);
    expect(out[0].tier).toBe('root');
    expect(out[1].tier).toBe('symptom');
  });

  it('tags downstream_of ONLY when the named root is itself failing', () => {
    const both = rankIssues([fail('worker_oom_loop'), fail('queue_health')]);
    const q1 = both.find((i) => i.name === 'queue_health')!;
    expect(q1.downstream_of).toBe('worker_oom_loop');
  });

  it('does NOT tag downstream_of when the root is absent (no co-occurrence guess)', () => {
    const out = rankIssues([fail('queue_health')]); // worker_oom_loop not failing
    const q = out.find((i) => i.name === 'queue_health')!;
    expect(q.downstream_of).toBeUndefined();
  });

  it('does NOT tag downstream_of from a generic root×symptom cartesian', () => {
    // schema_version is a root and stale_locks is a symptom, but there is NO
    // declared causal edge between them — co-occurrence must not invent one.
    const out = rankIssues([fail('schema_version'), fail('stale_locks')]);
    const s = out.find((i) => i.name === 'stale_locks')!;
    expect(s.downstream_of).toBeUndefined();
  });

  it('uses details.fix_hint when present, else the message', () => {
    const out = rankIssues([
      { name: 'worker_oom_loop', status: 'fail', message: 'long message', details: { fix_hint: 'raise --max-rss' } },
      warn('orphan_ratio', 'too many orphans'),
    ]);
    expect(out.find((i) => i.name === 'worker_oom_loop')!.fix).toBe('raise --max-rss');
    expect(out.find((i) => i.name === 'orphan_ratio')!.fix).toBe('too many orphans');
  });

  it('is deterministic (name tiebreak) for same status+tier', () => {
    const out = rankIssues([warn('zeta_unknown'), warn('alpha_unknown')]);
    expect(out.map((i) => i.name)).toEqual(['alpha_unknown', 'zeta_unknown']);
  });
});

describe('DECISION 4A drift guard', () => {
  it('every cause-graph name exists in doctor-categories known names', () => {
    const known = allKnownCheckNames();
    const missing = [...CAUSE_GRAPH_NAMES].filter((n) => !known.has(n));
    expect(missing).toEqual([]);
  });

  it('root and symptom sets are disjoint', () => {
    const overlap = [...ROOT_CAUSE_CHECKS].filter((n) => SYMPTOM_CHECKS.has(n));
    expect(overlap).toEqual([]);
  });
});
