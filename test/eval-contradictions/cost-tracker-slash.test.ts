/**
 * v0.41.20.0 — pin slash-prefix model id routing through
 * `eval-contradictions/cost-tracker.ts:pricingFor`.
 *
 * The cost-tracker carries its own duplicate ANTHROPIC_PRICING table
 * (consolidation deferred to TODOS.md #3 from the v0.41.20.0 plan).
 * Pre-fix, `pricingFor` did exact-key match only, so every non-bare
 * lookup silently fell back to Haiku — including colon-form Sonnet/Opus
 * that the table DOES carry as explicit `anthropic:claude-*` keys. After
 * fix, parseModelId handles bare/colon/slash uniformly; the silent-Haiku
 * fallback is preserved only for genuinely-unknown models (legacy behavior
 * pinned here per D9).
 */

import { describe, test, expect } from 'bun:test';
import { CostTracker } from '../../src/core/eval-contradictions/cost-tracker.ts';

describe('eval-contradictions/cost-tracker pricingFor (via recordJudgeCall)', () => {
  function spendCheck(modelId: string, inputTokens: number, outputTokens: number): number {
    const t = new CostTracker({ capUsd: 999 });
    t.recordJudgeCall(modelId, { inputTokens, outputTokens });
    return t.judge();
  }

  test('bare claude-sonnet-4-6 → Sonnet pricing (1M in = $3)', () => {
    expect(spendCheck('claude-sonnet-4-6', 1_000_000, 0)).toBeCloseTo(3.0, 5);
  });

  test('colon-form anthropic:claude-sonnet-4-6 → Sonnet pricing', () => {
    // Table has this key explicitly; pre-fix path also worked.
    expect(spendCheck('anthropic:claude-sonnet-4-6', 1_000_000, 0)).toBeCloseTo(3.0, 5);
  });

  test('slash-form anthropic/claude-sonnet-4-6 → Sonnet pricing (THE FIX)', () => {
    // Pre-v0.41.20.0: silently billed as Haiku ($1/MTok instead of $3/MTok).
    expect(spendCheck('anthropic/claude-sonnet-4-6', 1_000_000, 0)).toBeCloseTo(3.0, 5);
  });

  test('slash-form anthropic/claude-opus-4-7 → Opus pricing ($5/MTok in)', () => {
    expect(spendCheck('anthropic/claude-opus-4-7', 1_000_000, 0)).toBeCloseTo(5.0, 5);
  });

  test('LEGACY BEHAVIOR PIN: unknown model silently falls back to Haiku pricing', () => {
    // D9 from the v0.41.20.0 plan: we deliberately preserve the silent-Haiku
    // fallback in this duplicate pricing table. The right fix is unifying
    // the two pricing systems (TODOS.md #3) — tightening cost-tracker in
    // isolation would surprise existing eval-contradictions callers who
    // depend on the soft-ceiling --budget-usd contract.
    expect(spendCheck('mistral/medium', 1_000_000, 0)).toBeCloseTo(1.0, 5);
    expect(spendCheck('gpt-5', 1_000_000, 0)).toBeCloseTo(1.0, 5);
  });

  test('OpenRouter nested form falls back to Haiku (legacy behavior preserved)', () => {
    // Per D2: parseModelId returns {provider:'openrouter', model:'anthropic/...'};
    // the tail 'anthropic/claude-sonnet-4-6' is not a pricing key in this
    // duplicate table (which doesn't carry slash-form keys), so the silent
    // Haiku fallback fires. Matches the deliberate OpenRouter-pricing-deferred
    // posture from TODOS.md #2.
    expect(spendCheck('openrouter:anthropic/claude-sonnet-4-6', 1_000_000, 0)).toBeCloseTo(1.0, 5);
  });
});
