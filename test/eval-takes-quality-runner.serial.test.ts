/**
 * takes-quality-eval/runner — end-to-end orchestrator test with a stubbed
 * gateway.chat. Quarantined as *.serial.test.ts because mock.module leaks
 * across files in the same shard process (R2 in scripts/check-test-isolation.sh).
 *
 * Covers:
 *   - happy path: 3 model successes → PASS receipt with all dim scores
 *   - mixed: 1 success, 2 errors → INCONCLUSIVE
 *   - budget cap fires mid-run → budgetAborted=true; receipt still produced
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

// Stub gateway.chat BEFORE importing the runner so the runner picks up
// the mocked module.
let chatHandler: ((opts: any) => Promise<any>) | null = null;
mock.module('../src/core/ai/gateway.ts', () => ({
  chat: async (opts: any) => {
    if (!chatHandler) throw new Error('chatHandler not set in test');
    return chatHandler(opts);
  },
  configureGateway: () => undefined,
}));

const { runEval } = await import('../src/core/takes-quality-eval/runner.ts');
const { RUBRIC_DIMENSIONS } = await import('../src/core/takes-quality-eval/rubric.ts');

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Seed a tiny corpus so sampling has rows to draw from.
  await engine.putPage('test/runner-fixture', {
    type: 'note', title: 't', compiled_truth: 'b', frontmatter: {},
  });
  const pageRows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = 'test/runner-fixture' LIMIT 1`,
  );
  const pageId = pageRows[0].id;
  // 5 takes — enough for sampling without being slow.
  await engine.addTakesBatch([
    { page_id: pageId, row_num: 1, claim: 'A', kind: 'take',  holder: 'world', weight: 0.5 },
    { page_id: pageId, row_num: 2, claim: 'B', kind: 'take',  holder: 'brain', weight: 0.6 },
    { page_id: pageId, row_num: 3, claim: 'C', kind: 'fact',  holder: 'world', weight: 1.0 },
    { page_id: pageId, row_num: 4, claim: 'D', kind: 'bet',   holder: 'people/garry-tan', weight: 0.7 },
    { page_id: pageId, row_num: 5, claim: 'E', kind: 'hunch', holder: 'brain', weight: 0.3 },
  ]);
});

afterAll(async () => {
  await engine.disconnect();
});

function fullScoreJson(score = 8): string {
  const scores: Record<string, { score: number; feedback?: string }> = {};
  for (const dim of RUBRIC_DIMENSIONS) {
    scores[dim] = { score, feedback: 'fine' };
  }
  return JSON.stringify({
    scores,
    overall: score,
    improvements: ['nothing pressing'],
  });
}

describe('runner — happy path (3 successes)', () => {
  test('3 PASS scores → verdict=pass, all dims present in receipt', async () => {
    chatHandler = async (_opts) => ({
      text: fullScoreJson(8),
      blocks: [{ type: 'text', text: fullScoreJson(8) }],
      stopReason: 'end',
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'openai:gpt-4o',
      providerId: 'openai',
    });

    const r = await runEval(engine, {
      limit: 5,
      cycles: 1,
      models: ['openai:gpt-4o', 'anthropic:claude-opus-4-7', 'google:gemini-1.5-pro'],
      budgetUsd: null,
    });

    expect(r.receipt.verdict).toBe('pass');
    expect(r.receipt.successes_per_cycle).toEqual([3]);
    for (const dim of RUBRIC_DIMENSIONS) {
      expect(r.receipt.scores[dim]).toBeDefined();
    }
    expect(r.receipt.overall_score).toBeGreaterThanOrEqual(7);
    expect(r.budgetAborted).toBe(false);
    // cost_usd should be > 0 since we returned non-zero usage.
    expect(r.receipt.cost_usd).toBeGreaterThan(0);
  });
});

describe('runner — INCONCLUSIVE branches', () => {
  test('all models error → INCONCLUSIVE verdict', async () => {
    chatHandler = async (_opts) => {
      throw new Error('synthetic provider error');
    };

    const r = await runEval(engine, {
      limit: 5,
      cycles: 1,
      models: ['openai:gpt-4o', 'anthropic:claude-opus-4-7', 'google:gemini-1.5-pro'],
      budgetUsd: null,
    });

    expect(r.receipt.verdict).toBe('inconclusive');
    expect(r.receipt.successes_per_cycle).toEqual([0]);
    expect(r.receipt.errors).toBeDefined();
    expect(r.receipt.errors!.length).toBeGreaterThanOrEqual(3);
  });

  test('1 success + 2 errors → INCONCLUSIVE (need >=2 contributing)', async () => {
    let callCount = 0;
    chatHandler = async (_opts) => {
      callCount++;
      if (callCount === 1) {
        return {
          text: fullScoreJson(8),
          blocks: [],
          stopReason: 'end',
          usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'openai:gpt-4o',
          providerId: 'openai',
        };
      }
      throw new Error('synthetic error for slot ' + callCount);
    };

    const r = await runEval(engine, {
      limit: 5,
      cycles: 1,
      models: ['openai:gpt-4o', 'anthropic:claude-opus-4-7', 'google:gemini-1.5-pro'],
      budgetUsd: null,
    });
    expect(r.receipt.verdict).toBe('inconclusive');
  });
});

describe('runner — FAIL branch', () => {
  test('all 3 successes but dim mean < 7 → FAIL', async () => {
    chatHandler = async (_opts) => ({
      text: fullScoreJson(5), // mean below threshold
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'openai:gpt-4o',
      providerId: 'openai',
    });

    const r = await runEval(engine, {
      limit: 5,
      cycles: 1,
      models: ['openai:gpt-4o', 'anthropic:claude-opus-4-7', 'google:gemini-1.5-pro'],
      budgetUsd: null,
    });
    expect(r.receipt.verdict).toBe('fail');
    expect(r.receipt.successes_per_cycle[0]).toBe(3);
  });
});

describe('runner — budget cap (codex review #4)', () => {
  test('budget cap fires before next cycle would exceed', async () => {
    // Estimate per-cycle cost: 3 models × ($2.5 × 5k + $10 × 2k)/1M = ~$0.1
    // With budgetUsd=0.05, the projection ($0.1) exceeds cap, so cycle 1
    // is refused before any call.
    chatHandler = async (_opts) => {
      throw new Error('chat should not be called when budget pre-flight aborts');
    };

    const r = await runEval(engine, {
      limit: 5,
      cycles: 3,
      models: ['openai:gpt-4o', 'anthropic:claude-opus-4-7', 'google:gemini-1.5-pro'],
      budgetUsd: 0.05, // tighter than projected per-cycle cost
    });
    // No cycle ever ran successfully because pre-flight aborted cycle 1.
    expect(r.budgetAborted).toBe(true);
    expect(r.receipt.cycles_run).toBe(0);
    expect(r.receipt.verdict).toBe('inconclusive');
    expect(r.receipt.verdictMessage).toContain('budget');
  });

  test('budget cap allows first cycle if projection fits', async () => {
    chatHandler = async (_opts) => ({
      text: fullScoreJson(8),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'openai:gpt-4o',
      providerId: 'openai',
    });

    const r = await runEval(engine, {
      limit: 5,
      cycles: 1,
      models: ['openai:gpt-4o'],
      budgetUsd: 100.0, // very high cap; cycle should complete
    });
    expect(r.budgetAborted).toBe(false);
    // Single-model panel with all-PASS scores → INCONCLUSIVE because <2/3
    // contributing (need >=2). That's fine for this test — we're verifying
    // the cycle ran, not the verdict.
    expect(r.receipt.cycles_run).toBe(1);
  });
});
