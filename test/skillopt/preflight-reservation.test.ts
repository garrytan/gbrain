/**
 * #5585 — preflight's impossible-reservation check: each role's largest
 * single call priced exactly as BudgetTracker.reserve() prices it (shared
 * reservationCostUsd, effective output caps, same overrides, input 0), so a
 * call that can never fit the cap is refused before any spend, naming the role
 * and the control that fixes it. Expected cost stays a separate heuristic.
 */
import { describe, test, expect } from 'bun:test';
import { BudgetExhausted, BudgetTracker } from '../../src/core/budget/budget-tracker.ts';
import { preflight, formatPreflightReport, singleCallReservations, type PreflightOpts } from '../../src/core/skillopt/preflight.ts';

const OPUS5 = 'anthropic:claude-opus-5';
const FABLE = 'anthropic:claude-fable-5-1';
const HAIKU = 'anthropic:claude-haiku-4-5-20251001';

const base: PreflightOpts = {
  epochs: 1, batchSize: 4, trainSize: 8, selSize: 5, testSize: 5,
  optimizerModel: HAIKU, targetModel: HAIKU, judgeModel: HAIKU, maxCostUsd: 100,
};

describe('impossible single-call reservation', () => {
  test('thinking optimizer at the default reflect cap cannot fit a $0.50 cap: aborts naming role + control', () => {
    const r = preflight({ ...base, optimizerModel: OPUS5, maxCostUsd: 0.5 });
    expect(r.proceed).toBe(false);
    expect(r.abort_code).toBe('reservation_exceeds_cap');
    expect(r.abort_reason).toStartWith('reservation_exceeds_cap: a single optimizer call reserves $0.80 (anthropic:claude-opus-5, 32000 output tokens)');
    expect(r.abort_reason).toContain('--reflect-max-tokens / skillopt.reflect_max_tokens');
  });

  test('a lowered reflect cap admits the same run', () => {
    const r = preflight({ ...base, optimizerModel: OPUS5, reflectMaxTokens: 4096, maxCostUsd: 0.5 });
    expect(r.abort_code).not.toBe('reservation_exceeds_cap');
  });

  test('a task judge override is checked with the thinking judge floor and named as the judge role', () => {
    const r = preflight({ ...base, judgeModels: [HAIKU, FABLE], maxCostUsd: 0.3 });
    expect(r.abort_code).toBe('reservation_exceeds_cap');
    expect(r.abort_reason).toContain('a single judge call reserves $0.41 (anthropic:claude-fable-5-1, 8192 output tokens)');
    expect(r.abort_reason).toContain('--judge-model');
  });

  test('rule-only benchmark (no judge models): the judge is neither reserved nor priced', () => {
    const r = preflight({ ...base, judgeModels: [] });
    expect(r.estimate.judge_calls).toBe(0);
    expect(singleCallReservations({ ...base, judgeModels: [] }).map((c) => c.role)).toEqual(['optimizer', 'target']);
  });

  test('free local models and uncapped runs never trip; unpriced models are left to the run-time no_pricing contract', () => {
    expect(preflight({ ...base, optimizerModel: 'ollama:llama3', targetModel: 'ollama:llama3', judgeModel: 'ollama:llama3', maxCostUsd: 0.0001 }).abort_code)
      .not.toBe('reservation_exceeds_cap');
    expect(preflight({ ...base, optimizerModel: OPUS5, maxCostUsd: 0 }).proceed).toBe(true);
    const unpriced = singleCallReservations({ ...base, optimizerModel: 'litellm:mystery' });
    expect(unpriced[0]!.reservation_usd).toBeNull();
  });

  test('pricing overrides are honored', () => {
    const r = preflight({ ...base, optimizerModel: OPUS5, maxCostUsd: 0.5, pricingOverrides: { [OPUS5]: { input: 1, output: 1 } } });
    expect(r.abort_code).not.toBe('reservation_exceeds_cap');
  });

  test('the report shows expected cost and the per-call reservation requirement separately', () => {
    const est = preflight({ ...base, optimizerModel: OPUS5 }).estimate;
    const text = formatPreflightReport(est, { ...base, optimizerModel: OPUS5 });
    expect(text).toContain('Est. cost:');
    expect(text).toContain('Per call:   largest single call reserves $0.80 (optimizer anthropic:claude-opus-5, 32000 output tokens)');
  });
});

describe('parity with BudgetTracker.reserve()', () => {
  const cases: Array<[string, number, number]> = [
    [OPUS5, 32000, 0.5], [OPUS5, 32000, 0.9], [FABLE, 8192, 0.4], [FABLE, 8192, 0.42], [HAIKU, 4096, 0.01], ['ollama:llama3', 32000, 0.0001],
  ];
  for (const [model, maxOut, cap] of cases) {
    test(`${model} ${maxOut} tokens vs $${cap}`, () => {
      const reservation = singleCallReservations({ ...base, optimizerModel: model, reflectMaxTokens: maxOut })[0]!;
      const impossible = reservation.reservation_usd !== null && reservation.reservation_usd > cap;
      const tracker = new BudgetTracker({ maxCostUsd: cap, label: 'parity' });
      let threw = false;
      try {
        tracker.reserve({ modelId: model, estimatedInputTokens: 0, maxOutputTokens: maxOut, kind: 'chat' });
      } catch (err) {
        expect(err).toBeInstanceOf(BudgetExhausted);
        threw = true;
      }
      expect(threw).toBe(impossible);
    });
  }
});
