/**
 * Runner orchestrator tests — hermetic via stubbed judgeFn + searchFn.
 *
 * Covers the integration shape: pair generation, date pre-filter wired,
 * sampling order, cost-cap mid-run stop, pre-flight refusal, judge-error
 * counting, Wilson CI on the headline, source-tier breakdown, hot pages,
 * intra-page pairs (P1 batched fetch), and the run-row write integration.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  PreFlightBudgetError,
  runContradictionProbe,
  type JudgeFn,
} from '../src/core/eval-contradictions/runner.ts';
import type { JudgeOutput } from '../src/core/eval-contradictions/judge.ts';
import type { SearchResult } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** Seed a page; returns the id. */
async function seedPage(slug: string, title: string, body = ''): Promise<number> {
  await engine.putPage(slug, {
    title,
    type: 'concept',
    frontmatter: {},
    compiled_truth: body || `body for ${slug}`,
    timeline: '',
  });
  const page = await engine.getPage(slug);
  return page!.id;
}

/** Build a SearchResult helper for stubbed search. */
function mkResult(slug: string, page_id: number, chunk_id: number, text: string, score = 1.0): SearchResult {
  return {
    slug, page_id, chunk_id, chunk_index: 0,
    title: slug,
    type: 'concept',
    chunk_text: text,
    chunk_source: 'compiled_truth',
    score,
    stale: false,
  };
}

/** Stubbed judge that returns a fixed verdict pattern. */
function stubJudge(opts: {
  /**
   * v0.34 / Lane A2: `verdict` replaces `contradicts`. Legacy `contradicts:
   * true` maps to verdict='contradiction'; `contradicts: false` to
   * verdict='no_contradiction'. Callers can pass either field; verdict wins
   * when both are set.
   */
  verdict?: 'no_contradiction' | 'contradiction' | 'temporal_supersession' | 'temporal_regression' | 'temporal_evolution' | 'negation_artifact';
  contradicts?: boolean;
  severity?: 'info' | 'low' | 'medium' | 'high';
  confidence?: number;
  inputTokens?: number;
  outputTokens?: number;
  throwOn?: (i: number) => boolean;
}): JudgeFn {
  let calls = 0;
  return async (): Promise<JudgeOutput> => {
    const idx = calls++;
    if (opts.throwOn && opts.throwOn(idx)) {
      throw new Error('stub: simulated transient 503');
    }
    const resolvedVerdict =
      opts.verdict ?? (opts.contradicts === false ? 'no_contradiction' : 'contradiction');
    return {
      verdict: {
        verdict: resolvedVerdict,
        severity: opts.severity ?? 'medium',
        axis: 'stub axis',
        confidence: opts.confidence ?? 0.85,
        resolution_kind: 'dream_synthesize',
      },
      usage: {
        inputTokens: opts.inputTokens ?? 500,
        outputTokens: opts.outputTokens ?? 80,
      },
    };
  };
}

describe('runContradictionProbe', () => {
  test('empty queries returns a report with zero counts', async () => {
    const out = await runContradictionProbe({
      engine,
      queries: [],
      judgeFn: stubJudge({}),
      searchFn: async () => [],
      budgetUsd: 5,
    });
    expect(out.report.queries_evaluated).toBe(0);
    expect(out.report.total_contradictions_flagged).toBe(0);
  });

  test('cross-slug pair detection with stubbed search + judge', async () => {
    const idA = await seedPage('companies/acme', 'Acme');
    const idB = await seedPage('openclaw/chat/x', 'Chat');
    const out = await runContradictionProbe({
      engine,
      queries: ['what is acme MRR'],
      judgeFn: stubJudge({ contradicts: true, severity: 'medium' }),
      searchFn: async () => [
        mkResult('companies/acme', idA, 1, 'Acme MRR is $2M', 1.5),
        mkResult('openclaw/chat/x', idB, 2, 'Acme MRR is $50K', 0.5),
      ],
      budgetUsd: 5,
    });
    expect(out.report.total_contradictions_flagged).toBe(1);
    expect(out.report.queries_with_contradiction).toBe(1);
    expect(out.report.per_query[0].pairs_judged).toBe(1);
  });

  test('intra-page chunk-vs-take detection (P1 batched fetch)', async () => {
    const id1 = await seedPage('people/alice', 'Alice');
    await engine.addTakesBatch([
      {
        page_id: id1, row_num: 1, claim: 'Alice is the CTO', kind: 'fact',
        holder: 'garry', weight: 1, active: true, superseded_by: null,
      },
    ]);
    const out = await runContradictionProbe({
      engine,
      queries: ['what is alice role'],
      judgeFn: stubJudge({ contradicts: true, severity: 'high' }),
      searchFn: async () => [
        mkResult('people/alice', id1, 1, 'Alice is the CFO of acme'),
      ],
      budgetUsd: 5,
    });
    expect(out.report.total_contradictions_flagged).toBe(1);
    const finding = out.report.per_query[0].contradictions[0];
    expect(finding.kind).toBe('intra_page_chunk_take');
    expect(finding.b.take_id).not.toBeNull();
    expect(finding.b.holder).toBe('garry');
  });

  test('same-slug pairs are NOT generated (cross_slug skip rule)', async () => {
    const idA = await seedPage('a/page', 'A');
    const out = await runContradictionProbe({
      engine,
      queries: ['q'],
      judgeFn: stubJudge({}),
      searchFn: async () => [
        // Both results from the same page — pair should NOT form.
        mkResult('a/page', idA, 1, 'chunk one'),
        mkResult('a/page', idA, 2, 'chunk two'),
      ],
      budgetUsd: 5,
    });
    expect(out.report.per_query[0].pairs_judged).toBe(0);
  });

  test('date pre-filter rejects quarterly-shape pairs', async () => {
    const idA = await seedPage('companies/acme', 'Acme');
    const idB = await seedPage('openclaw/chat/2024', 'Chat');
    const out = await runContradictionProbe({
      engine,
      queries: ['q'],
      judgeFn: stubJudge({}),
      searchFn: async () => [
        mkResult('companies/acme', idA, 1, 'Acme MRR was $50K (2024-08-01)'),
        mkResult('openclaw/chat/2024', idB, 2, 'Acme MRR is $2M (2026-03-15)'),
      ],
      budgetUsd: 5,
    });
    expect(out.report.per_query[0].pairs_skipped_by_date).toBe(1);
    expect(out.report.per_query[0].pairs_judged).toBe(0);
  });

  test('judge throw counts as judge_errors, does not crash run', async () => {
    const idA = await seedPage('a/1', 'A');
    const idB = await seedPage('b/1', 'B');
    const out = await runContradictionProbe({
      engine,
      queries: ['q'],
      // Throw on the first (and only) call.
      judgeFn: stubJudge({ throwOn: (i) => i === 0 }),
      searchFn: async () => [
        mkResult('a/1', idA, 1, 'chunk a'),
        mkResult('b/1', idB, 2, 'chunk b'),
      ],
      budgetUsd: 5,
    });
    expect(out.report.judge_errors.total).toBe(1);
    expect(out.report.total_contradictions_flagged).toBe(0);
    expect(out.judgeErrorRows.length).toBe(1);
  });

  test('cost cap mid-run stop with partial report', async () => {
    const idA = await seedPage('a/1', 'A');
    const idB = await seedPage('b/1', 'B');
    const idC = await seedPage('c/1', 'C');
    const out = await runContradictionProbe({
      engine,
      queries: ['q1', 'q2', 'q3'],
      // Huge tokens per call so cap blows fast.
      judgeFn: stubJudge({ inputTokens: 1_000_000, outputTokens: 200_000 }),
      searchFn: async () => [
        mkResult('a/1', idA, 1, 'a'),
        mkResult('b/1', idB, 2, 'b'),
        mkResult('c/1', idC, 3, 'c'),
      ],
      budgetUsd: 0.001,
      yesOverride: true,  // bypass pre-flight refusal
    });
    expect(out.capHitMidRun).toBe(true);
    expect(out.report.queries_evaluated).toBe(3);
    // The first query gets some judging; the rest are zero-judged.
    expect(out.report.per_query.length).toBe(3);
  });

  test('pre-flight refuses when estimate > budget AND --yes not set', async () => {
    await expect(
      runContradictionProbe({
        engine,
        queries: Array(1000).fill('q'),
        judgeFn: stubJudge({}),
        searchFn: async () => [],
        budgetUsd: 0.0000001,
      })
    ).rejects.toBeInstanceOf(PreFlightBudgetError);
  });

  test('pre-flight passes when --yes is set', async () => {
    const out = await runContradictionProbe({
      engine,
      queries: ['q'],
      judgeFn: stubJudge({}),
      searchFn: async () => [],
      budgetUsd: 0.0000001,
      yesOverride: true,
    });
    expect(out.report).toBeTruthy();
  });

  test('Wilson CI populated on the headline percentage', async () => {
    const idA = await seedPage('a/1', 'A');
    const idB = await seedPage('b/1', 'B');
    const out = await runContradictionProbe({
      engine,
      queries: ['q'],
      judgeFn: stubJudge({ contradicts: true, severity: 'medium' }),
      searchFn: async () => [
        mkResult('a/1', idA, 1, 'a'),
        mkResult('b/1', idB, 2, 'b'),
      ],
      budgetUsd: 5,
    });
    expect(out.report.calibration.wilson_ci_95.point).toBe(1);  // 1/1 query
    expect(out.report.calibration.small_sample_note).toBeTruthy();
  });

  test('source_tier_breakdown computed from observed pairs', async () => {
    const idA = await seedPage('companies/acme', 'Acme');
    const idB = await seedPage('openclaw/chat/x', 'Chat');
    const out = await runContradictionProbe({
      engine,
      queries: ['q'],
      judgeFn: stubJudge({}),
      searchFn: async () => [
        mkResult('companies/acme', idA, 1, 'a'),
        mkResult('openclaw/chat/x', idB, 2, 'b'),
      ],
      budgetUsd: 5,
    });
    // One pair: curated vs bulk
    expect(out.report.source_tier_breakdown.curated_vs_bulk).toBe(1);
    expect(out.report.source_tier_breakdown.curated_vs_curated).toBe(0);
  });

  test('hot pages roll up across findings', async () => {
    const id1 = await seedPage('people/alice', 'A');
    const id2 = await seedPage('companies/acme', 'C');
    const id3 = await seedPage('openclaw/chat/x', 'X');
    const out = await runContradictionProbe({
      engine,
      queries: ['q1', 'q2'],
      judgeFn: stubJudge({ contradicts: true, severity: 'high' }),
      searchFn: async (_engine, q) => {
        // Both queries feature alice; one features acme.
        if (q === 'q1') {
          return [
            mkResult('people/alice', id1, 1, 'a1'),
            mkResult('companies/acme', id2, 2, 'c'),
          ];
        }
        return [
          mkResult('people/alice', id1, 3, 'a2'),
          mkResult('openclaw/chat/x', id3, 4, 'x'),
        ];
      },
      budgetUsd: 5,
    });
    const alice = out.report.hot_pages.find((p) => p.slug === 'people/alice');
    expect(alice?.appearances).toBe(2);
  });

  test('cache hit on second probe with same input (cache layer reaches engine)', async () => {
    const idA = await seedPage('a/1', 'A');
    const idB = await seedPage('b/1', 'B');
    const queries = ['q'];
    const stubSearch = async () => [
      mkResult('a/1', idA, 1, 'aaa'),
      mkResult('b/1', idB, 2, 'bbb'),
    ];
    const first = await runContradictionProbe({
      engine,
      queries,
      judgeFn: stubJudge({}),
      searchFn: stubSearch,
      budgetUsd: 5,
    });
    expect(first.report.cache.hits).toBe(0);
    expect(first.report.cache.misses).toBe(1);

    const second = await runContradictionProbe({
      engine,
      queries,
      judgeFn: stubJudge({}),
      searchFn: stubSearch,
      budgetUsd: 5,
    });
    expect(second.report.cache.hits).toBe(1);
  });

  test('--no-cache forces every pair to the judge', async () => {
    const idA = await seedPage('a/1', 'A');
    const idB = await seedPage('b/1', 'B');
    await runContradictionProbe({
      engine,
      queries: ['q'],
      judgeFn: stubJudge({}),
      searchFn: async () => [
        mkResult('a/1', idA, 1, 'aaa'),
        mkResult('b/1', idB, 2, 'bbb'),
      ],
      budgetUsd: 5,
    });
    const second = await runContradictionProbe({
      engine,
      queries: ['q'],
      judgeFn: stubJudge({}),
      searchFn: async () => [
        mkResult('a/1', idA, 1, 'aaa'),
        mkResult('b/1', idB, 2, 'bbb'),
      ],
      budgetUsd: 5,
      noCache: true,
    });
    expect(second.report.cache.hits).toBe(0);
  });

  test('abort signal aborts mid-run', async () => {
    const idA = await seedPage('a/1', 'A');
    const idB = await seedPage('b/1', 'B');
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 0);
    const out = await runContradictionProbe({
      engine,
      queries: ['q1', 'q2', 'q3', 'q4'],
      judgeFn: async () => {
        // Yield to let the abort fire.
        await new Promise((r) => setTimeout(r, 1));
        return {
          verdict: { verdict: 'no_contradiction', severity: 'info', axis: '', confidence: 0.3, resolution_kind: null },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      searchFn: async () => [
        mkResult('a/1', idA, 1, 'a'),
        mkResult('b/1', idB, 2, 'b'),
      ],
      budgetUsd: 5,
      abortSignal: ctrl.signal,
    });
    expect(out.report.queries_evaluated).toBe(4);
    // Some queries are emitted; aborted ones have zero counts.
  });

  test('report shape matches schema_version: 1 contract', async () => {
    const out = await runContradictionProbe({
      engine,
      queries: ['q'],
      judgeFn: stubJudge({}),
      searchFn: async () => [],
      budgetUsd: 5,
    });
    expect(out.report.schema_version).toBe(1);
    expect(out.report.prompt_version).toBeTruthy();
    expect(out.report.truncation_policy).toBeTruthy();
    expect(out.report.judge_errors.note).toContain('counted');
    expect(out.report.cost_usd.estimate_note).toContain('soft ceiling');
  });

  test('deterministic sampling produces stable pair order across runs', async () => {
    const idA = await seedPage('a/1', 'A');
    const idB = await seedPage('b/1', 'B');
    const idC = await seedPage('c/1', 'C');
    const search = async () => [
      mkResult('a/1', idA, 1, 'aaa', 1.0),
      mkResult('b/1', idB, 2, 'bbb', 0.9),
      mkResult('c/1', idC, 3, 'ccc', 0.8),
    ];
    let order1: string[] = [];
    let order2: string[] = [];
    const recordOrder = (out: string[]): JudgeFn => async (input) => {
      out.push(`${input.a.slug}|${input.b.slug}`);
      return {
        verdict: { verdict: 'no_contradiction', severity: 'info', axis: '', confidence: 0.4, resolution_kind: null },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    await runContradictionProbe({
      engine, queries: ['q'], judgeFn: recordOrder(order1), searchFn: search,
      budgetUsd: 5, noCache: true,
    });
    await runContradictionProbe({
      engine, queries: ['q'], judgeFn: recordOrder(order2), searchFn: search,
      budgetUsd: 5, noCache: true,
    });
    expect(order1).toEqual(order2);
  });

  // ---- Lane D: R4 regression — runner emits findings for every non-no_contradiction verdict ----
  // Without the runner.ts:307-ish emit-rule change from Lane A2, the new
  // verdicts (temporal_supersession, temporal_regression, temporal_evolution,
  // negation_artifact) would silently vanish from the report. This test
  // pins the broadened emit predicate one verdict at a time.

  for (const verdict of [
    'contradiction',
    'temporal_supersession',
    'temporal_regression',
    'temporal_evolution',
    'negation_artifact',
  ] as const) {
    test(`R4 regression: verdict='${verdict}' surfaces as a finding`, async () => {
      const idA = await seedPage(`a/${verdict}`, 'A');
      const idB = await seedPage(`b/${verdict}`, 'B');
      const out = await runContradictionProbe({
        engine,
        queries: [`q-${verdict}`],
        judgeFn: stubJudge({ verdict, severity: 'medium', confidence: 0.85 }),
        searchFn: async () => [
          mkResult(`a/${verdict}`, idA, 1, `text-a-${verdict}`, 1.0),
          mkResult(`b/${verdict}`, idB, 2, `text-b-${verdict}`, 0.5),
        ],
        budgetUsd: 5,
        noCache: true,
      });
      expect(out.report.total_contradictions_flagged).toBe(1);
      expect(out.report.per_query[0].contradictions.length).toBe(1);
      expect(out.report.per_query[0].contradictions[0].verdict).toBe(verdict);
      // Only verdict='contradiction' counts toward the strict
      // queries_with_contradiction metric (Wilson-CI denominator).
      if (verdict === 'contradiction') {
        expect(out.report.queries_with_contradiction).toBe(1);
      } else {
        expect(out.report.queries_with_contradiction).toBe(0);
      }
      // Every non-no_contradiction verdict counts toward queries_with_any_finding.
      expect(out.report.queries_with_any_finding).toBe(1);
      // Per-verdict breakdown tallies correctly.
      expect(out.report.verdict_breakdown[verdict]).toBe(1);
    });
  }

  test(`R4 regression: verdict='no_contradiction' produces ZERO findings`, async () => {
    const idA = await seedPage('a/noc', 'A');
    const idB = await seedPage('b/noc', 'B');
    const out = await runContradictionProbe({
      engine,
      queries: ['q-noc'],
      judgeFn: stubJudge({ verdict: 'no_contradiction', severity: 'info', confidence: 0.85 }),
      searchFn: async () => [
        mkResult('a/noc', idA, 1, 'no contradiction here', 1.0),
        mkResult('b/noc', idB, 2, 'also no contradiction', 0.5),
      ],
      budgetUsd: 5,
      noCache: true,
    });
    expect(out.report.total_contradictions_flagged).toBe(0);
    expect(out.report.per_query[0].contradictions.length).toBe(0);
    expect(out.report.queries_with_contradiction).toBe(0);
    expect(out.report.queries_with_any_finding).toBe(0);
    expect(out.report.verdict_breakdown.no_contradiction).toBe(1);
  });

  // ---- Lane D: R5 regression — cache key tuple shape stays 5 fields ----
  // Lane A1 bumped PROMPT_VERSION 1→2 (invalidates cache) but kept the key
  // shape unchanged. Adding a 6th field would silently break every operator's
  // brain (no migration path).

  test('R5 regression: cache key tuple shape is exactly 5 fields', async () => {
    const { buildCacheKey } = await import('../src/core/eval-contradictions/cache.ts');
    const key = buildCacheKey({ textA: 'a', textB: 'b', modelId: 'haiku' });
    const keys = Object.keys(key).sort();
    expect(keys).toEqual([
      'chunk_a_hash',
      'chunk_b_hash',
      'model_id',
      'prompt_version',
      'truncation_policy',
    ]);
  });
});
