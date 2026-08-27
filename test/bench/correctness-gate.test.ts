import { describe, test, expect } from 'bun:test';
import { runCorrectnessGate } from '../../src/core/bench/correctness-gate.ts';
import type { QrelsFile } from '../../src/core/bench/qrels-file.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

// The correctness gate's only engine touchpoint is `searchFn`, which is
// injectable. Tests pass a fake engine + a deterministic search stub.
const fakeEngine = {} as unknown as BrainEngine;

function makeQrels(queries: QrelsFile['queries']): QrelsFile {
  return { schema_version: 1, queries };
}

describe('correctness-gate: per-query iteration + aggregate math', () => {
  test('perfect retrieval → mean_recall=1, first_relevant=1, expected_top1=1', async () => {
    const qrels = makeQrels([
      {
        query_id: 'q1',
        query: 'x',
        relevant: [{ source_id: 'default', slug: 'a' }, { source_id: 'default', slug: 'b' }],
        expected_top1: { source_id: 'default', slug: 'a' },
      },
    ]);
    const result = await runCorrectnessGate(fakeEngine, qrels, {
      k: 10,
      searchFn: async () => [
        { source_id: 'default', slug: 'a' },
        { source_id: 'default', slug: 'b' },
      ],
    });
    expect(result.summary.mean_recall_at_k).toBe(1);
    expect(result.summary.first_relevant_hit_rate).toBe(1);
    expect(result.summary.expected_top1_hit_rate).toBe(1);
    expect(result.summary.queries_errored).toBe(0);
  });

  test('duplicate chunks count once in page-level recall and retrieved_count', async () => {
    const qrels = makeQrels([
      {
        query_id: 'q-duplicate',
        query: 'x',
        relevant: [{ source_id: 'default', slug: 'a' }],
      },
    ]);
    const result = await runCorrectnessGate(fakeEngine, qrels, {
      k: 2,
      searchFn: async () => [
        { source_id: 'default', slug: 'a' },
        { source_id: 'default', slug: 'a' },
      ],
    });
    expect(result.per_query[0].recall_at_k).toBe(1);
    expect(result.per_query[0].retrieved_count).toBe(1);
  });

  test('per-query throw → errored=true; query NOT counted in aggregates; gate flagged', async () => {
    // Finding 2D: a query throw flips verdict to fail. The orchestrator records
    // the throw as a per-query failure; the caller (eval-gate.ts) treats
    // any queries_errored > 0 as a gate failure.
    const qrels = makeQrels([
      {
        query_id: 'q-throws',
        query: 'x',
        relevant: [{ source_id: 'default', slug: 'a' }],
      },
      {
        query_id: 'q-works',
        query: 'y',
        relevant: [{ source_id: 'default', slug: 'b' }],
      },
    ]);
    let called = 0;
    const result = await runCorrectnessGate(fakeEngine, qrels, {
      k: 10,
      searchFn: async () => {
        called++;
        if (called === 1) throw new Error('simulated brain timeout');
        return [{ source_id: 'default', slug: 'b' }];
      },
    });
    expect(result.summary.queries_total).toBe(2);
    expect(result.summary.queries_run).toBe(1);
    expect(result.summary.queries_errored).toBe(1);
    // Aggregate computed on non-errored only.
    expect(result.summary.mean_recall_at_k).toBe(1);
    // Errored query surfaced in per_query list with error_message.
    const errored = result.per_query.find(p => p.errored);
    expect(errored?.error_message).toMatch(/timeout/);
  });

  test('missing brain page (slug not in retrieved) counted as miss', async () => {
    const qrels = makeQrels([
      {
        query_id: 'q1',
        query: 'x',
        relevant: [{ source_id: 'default', slug: 'a' }, { source_id: 'default', slug: 'b' }],
      },
    ]);
    const result = await runCorrectnessGate(fakeEngine, qrels, {
      searchFn: async () => [{ source_id: 'default', slug: 'a' }], // only 'a' retrieved
    });
    expect(result.summary.mean_recall_at_k).toBe(0.5); // 1 of 2 relevant
    expect(result.summary.first_relevant_hit_rate).toBe(1); // top-1 was 'a' which is relevant
  });

  test('duplicate chunk-level hits from relevant pages cannot inflate recall above 1', async () => {
    const qrels = makeQrels([
      {
        query_id: 'q-duplicate-chunks',
        query: 'x',
        relevant: [
          { source_id: 'default', slug: 'a' },
          { source_id: 'default', slug: 'b' },
          { source_id: 'default', slug: 'c' },
          { source_id: 'default', slug: 'd' },
        ],
      },
    ]);
    const result = await runCorrectnessGate(fakeEngine, qrels, {
      k: 10,
      // Seven relevant chunk hits used to score 7 / 4 = 1.75 even though
      // they represent only two distinct pages.
      searchFn: async () => [
        { source_id: 'default', slug: 'a' },
        { source_id: 'default', slug: 'a' },
        { source_id: 'default', slug: 'a' },
        { source_id: 'default', slug: 'a' },
        { source_id: 'default', slug: 'b' },
        { source_id: 'default', slug: 'b' },
        { source_id: 'default', slug: 'b' },
      ],
    });

    expect(result.per_query[0]?.recall_at_k).toBe(0.5);
    expect(result.per_query[0]?.recall_at_k).toBeLessThanOrEqual(1);
    expect(result.per_query[0]?.retrieved_count).toBe(2);
    expect(result.summary.mean_recall_at_k).toBe(0.5);
  });

  test('distinct relevant pages retain correct recall, including the same slug in different sources', async () => {
    const qrels = makeQrels([
      {
        query_id: 'q-distinct-pages',
        query: 'x',
        relevant: [
          { source_id: 'source-a', slug: 'shared' },
          { source_id: 'source-b', slug: 'shared' },
          { source_id: 'source-a', slug: 'unique-a' },
          { source_id: 'source-b', slug: 'unique-b' },
        ],
      },
    ]);
    const result = await runCorrectnessGate(fakeEngine, qrels, {
      k: 10,
      searchFn: async () => [
        { source_id: 'source-a', slug: 'shared' },
        { source_id: 'source-b', slug: 'shared' },
        { source_id: 'source-a', slug: 'unique-a' },
      ],
    });

    expect(result.per_query[0]?.recall_at_k).toBe(0.75);
    expect(result.per_query[0]?.retrieved_count).toBe(3);
    expect(result.summary.mean_recall_at_k).toBe(0.75);
  });

  test('empty retrieved list → recall=0 / first_relevant=0 / expected_top1=0', async () => {
    const qrels = makeQrels([
      {
        query_id: 'q1',
        query: 'x',
        relevant: [{ source_id: 'default', slug: 'a' }],
        expected_top1: { source_id: 'default', slug: 'a' },
      },
    ]);
    const result = await runCorrectnessGate(fakeEngine, qrels, {
      searchFn: async () => [],
    });
    expect(result.summary.mean_recall_at_k).toBe(0);
    expect(result.summary.first_relevant_hit_rate).toBe(0);
    expect(result.summary.expected_top1_hit_rate).toBe(0);
    expect(result.summary.queries_errored).toBe(0); // empty result != error
  });

  test('multi-source: wrong-source hit does NOT count as relevant (eng-D5 regression)', async () => {
    // Same slug "people/alice" in two sources; qrels says we want host's
    // version specifically. Retrieval returns team-a's version. That's NOT
    // a hit — the eng-D5 fix is structurally enforced via source_id::slug
    // compare keys.
    const qrels = makeQrels([
      {
        query_id: 'q1',
        query: 'x',
        relevant: [{ source_id: 'host', slug: 'people/alice' }],
        expected_top1: { source_id: 'host', slug: 'people/alice' },
      },
    ]);
    const result = await runCorrectnessGate(fakeEngine, qrels, {
      searchFn: async () => [{ source_id: 'team-a', slug: 'people/alice' }],
    });
    expect(result.summary.mean_recall_at_k).toBe(0);
    expect(result.summary.first_relevant_hit_rate).toBe(0);
    expect(result.summary.expected_top1_hit_rate).toBe(0);
  });

  test('expected_top1_hit_rate denominator = queries WITH expected_top1 only', async () => {
    const qrels = makeQrels([
      {
        query_id: 'q1',
        query: 'a',
        relevant: [{ source_id: 'default', slug: 'a' }],
        expected_top1: { source_id: 'default', slug: 'a' },
      },
      {
        query_id: 'q2',
        query: 'b',
        relevant: [{ source_id: 'default', slug: 'b' }],
        // no expected_top1 set
      },
    ]);
    const result = await runCorrectnessGate(fakeEngine, qrels, {
      searchFn: async (_e, q) => [{ source_id: 'default', slug: q }],
    });
    // 1 of 1 query with expected_top1 matched (q1).
    expect(result.summary.expected_top1_denominator).toBe(1);
    expect(result.summary.expected_top1_hit_rate).toBe(1);
  });
});
