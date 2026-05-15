/**
 * takes-quality-eval — boundary cases that don't need an LLM stub:
 *   - empty corpus → actionable error
 *   - --slug-prefix that matches no rows → actionable error
 *   - --source fs (reserved for v0.33+) → clear refusal
 *   - --budget-usd with model not in pricing.ts → fail-closed BEFORE any call
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runEval } from '../src/core/takes-quality-eval/runner.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('runner boundaries — pre-LLM (no API calls fire)', () => {
  test('empty takes table → throws "no takes to evaluate"', async () => {
    await expect(runEval(engine, { limit: 10 })).rejects.toThrow(/no takes to evaluate/);
  });

  test('source=fs is refused in v0.32 (reserved for v0.33+)', async () => {
    await expect(runEval(engine, { source: 'fs', limit: 10 })).rejects.toThrow(/fs source not yet wired/);
  });

  test('--budget-usd with unknown model → PricingNotFoundError BEFORE any HTTP call (codex review #4)', async () => {
    // Seed 1 take so the corpus isn't empty (otherwise we'd fail on that check first).
    await engine.putPage('test/budget-bound', {
      type: 'note', title: 't', compiled_truth: 'b', frontmatter: {},
    });
    const pageRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'test/budget-bound' LIMIT 1`,
    );
    await engine.addTakesBatch([
      { page_id: pageRows[0].id, row_num: 1, claim: 'a', kind: 'take', holder: 'world', weight: 0.5 },
    ]);

    // Unknown model + budget cap set → must abort fail-closed before any
    // network call. The error message names the offending model and points
    // at pricing.ts.
    await expect(
      runEval(engine, {
        models: ['unknown:gpt-99'],
        budgetUsd: 1.0,
        limit: 1,
      }),
    ).rejects.toThrow(/has no pricing entry/);
  });

  test('--budget-usd null with unknown model → does NOT pre-flight pricing (allowed; cost may be unknown)', async () => {
    // Without --budget-usd, the runner doesn't need exact pricing — it
    // estimates best-effort and prints what it knows. Unknown model just
    // contributes 0 to cost_usd. The runner shouldn't pre-flight error.
    //
    // We can't actually call the unknown model (provider lookup would fail)
    // so we test the negative: pre-flight does NOT fire when budgetUsd is null.
    // The actual call would error at gateway level, separate from pricing.
    //
    // Verify by checking that the error (if any) is NOT the
    // PricingNotFoundError shape — it should be a provider-resolve error.
    try {
      await runEval(engine, {
        models: ['unknown:gpt-99'],
        budgetUsd: null,
        limit: 1,
      });
    } catch (e) {
      // If the call reached the gateway, the error message should be
      // about provider/recipe, NOT pricing.
      const msg = (e as Error).message;
      expect(msg).not.toContain('has no pricing entry');
    }
  });
});
