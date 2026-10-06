/**
 * takes-quality-eval/runner — end-to-end orchestrator test with a stubbed
 * gateway.chat. Quarantined as *.serial.test.ts because mock.module leaks
 * across files in the same shard process (R2 in scripts/check-test-isolation.sh).
 *
 * Covers:
 *   - happy path: 3 model successes → PASS receipt with all dim scores
 *   - mixed: 1 success, 2 errors → INCONCLUSIVE
 *   - budget cap fires mid-run → budgetAborted=true; receipt still produced
 *   - pricing gate: canonically priced models pass under a cap; an unpriced
 *     model refuses under a cap (no_pricing, fix registers the rate), runs
 *     with a warning without one, and passes once its rate is registered
 */
import { describe, test, expect, beforeAll, afterAll, mock, spyOn } from 'bun:test';
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
      models: ['openai:gpt-4o', 'anthropic:claude-opus-4-7', 'google:gemini-2.5-flash'],
      budgetUsd: 0.05, // tighter than projected per-cycle cost (~$0.109)
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

describe('runner — pricing gate (new models must run)', () => {
  const scored = async () => ({
    text: fullScoreJson(8),
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'stub',
    providerId: 'stub',
  });

  test('canonically priced models outside the old allowlist pass the gate under a cap', async () => {
    chatHandler = scored;
    const r = await runEval(engine, {
      limit: 5, cycles: 1, models: ['anthropic:claude-fable-5', 'openai:gpt-5.6-sol'], budgetUsd: 100,
    });
    expect(r.receipt.cycles_run).toBe(1);
    expect(r.receipt.cost_usd).toBeGreaterThan(0);
  });

  test('an unpriced model under a user cap refuses with no_pricing before any call', async () => {
    chatHandler = async () => { throw new Error('chat must not run when the cap cannot be enforced'); };
    let err: unknown;
    try {
      await runEval(engine, { limit: 5, cycles: 1, models: ['openai:gpt-4o', 'vendor:brand-new-model'], budgetUsd: 1 });
    } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'no_pricing' });
    const fix = (err as { fix: { argv: string[]; actor: string } }).fix;
    expect(fix.argv.slice(0, 4)).toEqual(['gbrain', 'pricing', 'set', 'vendor:brand-new-model']);
    expect(fix.argv).toContain('--input');
    expect(fix.argv).toContain('--output');
    expect(fix.actor).toBe('agent');
    expect((err as Error).message).toContain('$1.00 cost cap');
  });

  test('an unpriced model without a cap warns and runs; its spend is not counted', async () => {
    chatHandler = scored;
    const lines: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { lines.push(String(c)); return true; });
    let r;
    try {
      r = await runEval(engine, { limit: 5, cycles: 1, models: ['vendor:brand-new-model'], budgetUsd: null });
    } finally {
      spy.mockRestore();
    }
    expect(r.receipt.cycles_run).toBe(1);
    expect(r.receipt.cost_usd).toBe(0);
    expect(lines.join('')).toContain('gbrain pricing set vendor:brand-new-model');
  });

  test('a rate registered in pricing.overrides prices the model under a cap', async () => {
    chatHandler = scored;
    await engine.setConfig('pricing.overrides', JSON.stringify({ 'vendor:brand-new-model': { input: 1, output: 2 } }));
    try {
      const r = await runEval(engine, { limit: 5, cycles: 1, models: ['vendor:brand-new-model'], budgetUsd: 100 });
      expect(r.receipt.cycles_run).toBe(1);
      expect(r.receipt.cost_usd).toBeCloseTo((100 * 1 + 50 * 2) / 1_000_000, 10);
    } finally {
      await engine.setConfig('pricing.overrides', '');
    }
  });
});

describe('runner — malformed-slot correction pass (#5325, protocol 2)', () => {
  const PANEL = ['openai:gpt-5.2', 'anthropic:claude-opus-4-7'];
  const reply = (text: string, outputTokens = 50) => ({
    text, blocks: [], stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: outputTokens, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'stub', providerId: 'stub',
  });
  function missingAccuracy(): string {
    const parsed = JSON.parse(fullScoreJson(8));
    delete parsed.scores[RUBRIC_DIMENSIONS[0]];
    return JSON.stringify(parsed);
  }

  test('a slot missing a dimension is re-asked once with the validator error and the run reaches a verdict', async () => {
    const calls: Array<{ model: string; prompt: string; thinking?: string }> = [];
    chatHandler = async (opts) => {
      calls.push({ model: opts.model, prompt: opts.messages[0].content, thinking: opts.thinking });
      const second = opts.model === PANEL[1];
      const isCorrection = String(opts.messages[0].content).includes('failed validation');
      return reply(second && !isCorrection ? missingAccuracy() : fullScoreJson(8));
    };

    const r = await runEval(engine, { limit: 5, cycles: 1, models: PANEL, budgetUsd: null });

    expect(calls).toHaveLength(3);
    expect(calls[2]!.model).toBe(PANEL[1]);
    expect(calls[2]!.prompt).toContain(`incomplete_scores: missing dim(s) [${RUBRIC_DIMENSIONS[0]}]`);
    expect(calls.every(c => c.thinking === 'off')).toBe(true);
    expect(r.receipt.verdict).toBe('pass');
    expect(r.receipt.successes_per_cycle).toEqual([2]);
    expect(r.receipt.protocol_version).toBe(2);
    expect(r.receipt.correction_selection_rule).toBe('corrected_if_valid');
    expect(r.receipt.corrections).toEqual([{
      cycle: 0, modelId: PANEL[1], first_error: `incomplete_scores: missing dim(s) [${RUBRIC_DIMENSIONS[0]}]`, corrected: 'valid',
    }]);
  });

  test('an empty reply (the output cap spent on reasoning) is a format failure and gets the correction', async () => {
    let n = 0;
    chatHandler = async (opts) => {
      n++;
      if (opts.model === PANEL[0] && n === 1) return { ...reply('', 2000), stopReason: 'length' };
      return reply(fullScoreJson(8));
    };

    const r = await runEval(engine, { limit: 5, cycles: 1, models: PANEL, budgetUsd: null });

    expect(r.receipt.corrections?.[0]).toMatchObject({ modelId: PANEL[0], corrected: 'valid' });
    expect(r.receipt.corrections?.[0]!.first_error).toStartWith('parse_failed:');
    expect(r.receipt.verdict).toBe('pass');
  });

  test('a correction that is still malformed keeps the first failure and records both', async () => {
    chatHandler = async (opts) => reply(opts.model === PANEL[1] ? 'no json here' : fullScoreJson(8));

    const r = await runEval(engine, { limit: 5, cycles: 1, models: PANEL, budgetUsd: null });

    expect(r.receipt.verdict).toBe('inconclusive');
    expect(r.receipt.corrections).toHaveLength(1);
    expect(r.receipt.corrections![0]).toMatchObject({ corrected: 'invalid' });
    expect(r.receipt.corrections![0]!.corrected_error).toStartWith('parse_failed:');
    expect(r.receipt.errors?.[0]?.error).toBe(r.receipt.corrections![0]!.first_error);
  });

  test('valid low scores and provider errors are never re-asked', async () => {
    const calls: string[] = [];
    chatHandler = async (opts) => {
      calls.push(opts.model);
      if (opts.model === PANEL[1]) throw new Error('synthetic provider error');
      return reply(fullScoreJson(3));
    };

    const r = await runEval(engine, { limit: 5, cycles: 1, models: PANEL, budgetUsd: null });

    expect(calls).toEqual(PANEL);
    expect(r.receipt.corrections).toBeUndefined();
  });

  test('a correction the budget cap cannot cover is not sent and is recorded with corrected: null', async () => {
    const calls: string[] = [];
    chatHandler = async (opts) => {
      calls.push(opts.model);
      return reply(opts.model === PANEL[1] ? missingAccuracy() : fullScoreJson(8), 60_000);
    };

    const r = await runEval(engine, { limit: 5, cycles: 1, models: PANEL, budgetUsd: 0.5 });

    expect(calls).toEqual(PANEL);
    expect(r.receipt.corrections).toEqual([{
      cycle: 0, modelId: PANEL[1], first_error: `incomplete_scores: missing dim(s) [${RUBRIC_DIMENSIONS[0]}]`, corrected: null, skipped_reason: 'budget',
    }]);
  });
});
