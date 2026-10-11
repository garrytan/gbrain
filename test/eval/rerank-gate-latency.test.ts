/**
 * W3 gate 4 latency runner (src/eval/rerank-gate-latency.ts), pure parts.
 *
 * Protects: counterbalanced arm order, warm-up calls kept out of the samples,
 * the worker bound, the A67 verdict (mean saving per skipped query >= 100 ms,
 * no p95 increase, no errored arm), the derived reranker-call reduction and
 * the read-only config overlay.
 * Fails when: one arm always runs first, warm-up or queueing time leaks into
 * a sample, the verdict uses p50 or the wrong pair set, or the overlay
 * writes to the brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  type ArmObservation,
  type ArmSample,
  type GateArm,
  type LatencyItem,
  pairedSchedule,
  percentile,
  runPaired,
  summarizeLatency,
  withSearchConfig,
} from '../../src/eval/rerank-gate-latency.ts';
import { parseItems } from '../../scripts/bench-rerank-gate-latency.ts';

const items = (n: number): LatencyItem[] => Array.from({ length: n }, (_, i) => ({ id: `q${i}`, query: { query: `question ${i}` } }));
const obs = (ms: number, o: Partial<ArmObservation> = {}): ArmObservation => ({ recall_ms: 0, query_ms: ms, eligible: 1, provider_calls: 1, skipped: 0, ...o });

function pair(id: string, offMs: number, onMs: number, skipped: boolean, kind = 'k'): ArmSample[] {
  const base = { id, kind, repeat: 0, recall_ms: 0, eligible: 1 };
  return [
    { ...base, arm: 'off', position: 0, query_ms: offMs, ms: offMs, provider_calls: 0, skipped: 0 },
    { ...base, arm: 'on', position: 1, query_ms: onMs, ms: onMs, provider_calls: skipped ? 0 : 1, skipped: skipped ? 1 : 0 },
  ];
}

describe('pairedSchedule', () => {
  test('the first arm alternates by item and flips on the next repeat', () => {
    const s = pairedSchedule(items(4), 2);
    expect(s.map((p) => p.arms[0])).toEqual(['off', 'on', 'off', 'on', 'on', 'off', 'on', 'off']);
    expect(s.filter((p) => p.arms[0] === 'off')).toHaveLength(4);
    for (const p of s) expect(new Set(p.arms)).toEqual(new Set(['off', 'on']));
  });
});

describe('runPaired', () => {
  test('warm-up calls are untimed, every pair runs both arms, and the worker bound holds', async () => {
    const calls: Array<{ arm: GateArm; id: string }> = [];
    let inFlight = 0;
    let peak = 0;
    const samples = await runPaired(items(6), async (arm, item) => {
      calls.push({ arm, id: item.id });
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return obs(10);
    }, { warmup: 2, repeats: 2, concurrency: 3 });
    expect(calls.slice(0, 4)).toEqual([{ arm: 'off', id: 'q0' }, { arm: 'on', id: 'q0' }, { arm: 'off', id: 'q1' }, { arm: 'on', id: 'q1' }]);
    expect(calls).toHaveLength(4 + 6 * 2 * 2);
    expect(samples).toHaveLength(24);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  test('a sample is the arm\'s own timed calls, never time spent waiting for a worker', async () => {
    let t = 0;
    const samples = await runPaired(items(4), async (_arm, _item, now) => {
      t += 1000;
      const start = now();
      t += 40;
      return obs(now() - start);
    }, { warmup: 0, repeats: 1, concurrency: 1, now: () => t });
    expect(samples.map((s) => s.ms)).toEqual(Array(8).fill(40));
  });

  test('an arm that throws is recorded as an error and fails the latency clause', async () => {
    const samples = await runPaired(items(2), async (arm) => {
      if (arm === 'on') throw new Error('boom');
      return obs(10);
    }, { warmup: 0, repeats: 1, concurrency: 1 });
    expect(samples.filter((s) => s.error === 'boom')).toHaveLength(2);
    expect(summarizeLatency(samples).verdict.latency_pass).toBe(false);
  });
});

describe('summarizeLatency', () => {
  test('nearest-rank percentiles', () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95)).toBe(19);
    expect(percentile([], 0.95)).toBe(0);
  });

  test('the saving is measured per skipped pair; reranked pairs and p95 are reported apart', () => {
    const samples = [
      ...pair('a', 400, 250, true, 'temporal'),
      ...pair('b', 420, 260, true, 'temporal'),
      ...pair('c', 410, 412, false, 'abstention'),
      ...pair('d', 900, 899, false, 'abstention'),
    ];
    const r = summarizeLatency(samples);
    expect(r.pairs).toBe(4);
    expect(r.skipped_pairs).toBe(2);
    expect(r.skip_rate).toBe(0.5);
    expect(r.mean_saving_per_skip_ms).toBe(155);
    expect(r.mean_saving_no_skip_ms).toBe(-0.5);
    expect(r.arms.off.p95_ms).toBe(900);
    expect(r.arms.on.p95_ms).toBe(899);
    expect(r.reranker_calls).toEqual({ off: 4, on: 2, reduction: 0.5 });
    expect(r.by_kind.temporal).toEqual({ pairs: 2, skipped: 2, mean_saving_per_skip_ms: 155 });
    expect(r.by_kind.abstention.mean_saving_per_skip_ms).toBeNull();
    expect(r.verdict).toEqual({ mean_saving_ok: true, p95_ok: true, reranker_call_reduction_ok: true, latency_pass: true });
  });

  test('a small saving or a p95 increase fails the clause', () => {
    const small = summarizeLatency([...pair('a', 300, 220, true), ...pair('b', 300, 300, false)]);
    expect(small.mean_saving_per_skip_ms).toBe(80);
    expect(small.verdict.mean_saving_ok).toBe(false);
    expect(small.verdict.latency_pass).toBe(false);
    const slowTail = summarizeLatency([...pair('a', 400, 200, true), ...pair('b', 500, 520, false)]);
    expect(slowTail.verdict.mean_saving_ok).toBe(true);
    expect(slowTail.p95_increase_ms).toBe(20);
    expect(slowTail.verdict.p95_ok).toBe(false);
    expect(slowTail.verdict.latency_pass).toBe(false);
    const none = summarizeLatency([...pair('a', 300, 300, false)]);
    expect(none.mean_saving_per_skip_ms).toBeNull();
    expect(none.verdict.latency_pass).toBe(false);
  });
});

describe('items file', () => {
  test('one JSON object per line with an id and query params', () => {
    expect(parseItems('{"id":"q1","query":{"query":"x"}}\n\n{"id":"q2","kind":"temporal","recall":{"limit":100},"query":{"query":"y","token_budget":6300}}\n'))
      .toEqual([{ id: 'q1', query: { query: 'x' } }, { id: 'q2', kind: 'temporal', recall: { limit: 100 }, query: { query: 'y', token_budget: 6300 } }]);
    expect(() => parseItems('{"id":"q1"}')).toThrow('items line 1');
  });
});

describe('withSearchConfig', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('search.reranker.gate', 'shadow');
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('the overlay answers its keys first and writes nothing', async () => {
    const on = withSearchConfig(engine, { 'search.reranker.gate': 'on' });
    expect(await on.getConfig('search.reranker.gate')).toBe('on');
    expect((await on.getAllConfig())['search.reranker.gate']).toBe('on');
    expect(await engine.getConfig('search.reranker.gate')).toBe('shadow');
    expect((await engine.getAllConfig())['search.reranker.gate']).toBe('shadow');
  });
});
