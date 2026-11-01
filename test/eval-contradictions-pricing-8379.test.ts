import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { JudgeOutput } from '../src/core/eval-contradictions/judge.ts';
import { runContradictionProbe } from '../src/core/eval-contradictions/runner.ts';
import type { SearchResult } from '../src/core/types.ts';

function engineWithPricing(overrides: string | null): BrainEngine {
  return {
    getConfig: async () => overrides,
    listActiveTakesForPages: async () => new Map(),
  } as unknown as BrainEngine;
}

function result(slug: string, page_id: number): SearchResult {
  return {
    slug,
    page_id,
    chunk_id: page_id,
    chunk_index: 0,
    title: slug,
    type: 'concept',
    chunk_text: `Claim from ${slug}`,
    chunk_source: 'compiled_truth',
    score: 1,
    stale: false,
  };
}

const judge = async (): Promise<JudgeOutput> => ({
  verdict: {
    verdict: 'no_contradiction',
    severity: 'info',
    axis: 'pricing test',
    confidence: 1,
    resolution_kind: 'dream_synthesize',
  },
  usage: { inputTokens: 1_000, outputTokens: 100 },
});

async function run(opts: {
  engine: BrainEngine;
  judgeModel: string;
  budgetUsd: number;
  topK: number;
  yesOverride?: boolean;
}) {
  return runContradictionProbe({
    engine: opts.engine,
    queries: ['claims'],
    judgeModel: opts.judgeModel,
    budgetUsd: opts.budgetUsd,
    topK: opts.topK,
    yesOverride: opts.yesOverride,
    judgeFn: judge,
    searchFn: async (_engine, _query, { limit }) =>
      [result('a', 1), result('b', 2), result('c', 3)].slice(0, limit),
    noCache: true,
  });
}

describe('suspected contradictions judge pricing', () => {
  test('free local judges do not accrue fictional Haiku spend', async () => {
    const out = await run({
      engine: engineWithPricing(null),
      judgeModel: 'ollama:local-model',
      budgetUsd: 0.0001,
      topK: 3,
      yesOverride: true,
    });

    expect(out.report.cost_usd.judge).toBe(0);
    expect(out.capHitMidRun).toBe(false);
    expect(out.report.per_query[0].pairs_judged).toBe(3);
  });

  test('configured operator rates are used by preflight and actual accounting', async () => {
    let outcome: { kind: 'ok'; cost: number } | { kind: 'error'; error: unknown };
    try {
      const out = await run({
        engine: engineWithPricing(JSON.stringify({ 'ollama:local-model': { input: 0.2, output: 0.5 } })),
        judgeModel: 'ollama:local-model',
        budgetUsd: 0.0008,
        topK: 2,
      });
      outcome = { kind: 'ok', cost: out.report.cost_usd.judge };
    } catch (error) {
      outcome = { kind: 'error', error };
    }

    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.cost).toBeCloseTo(0.00025, 10);
  });
});
