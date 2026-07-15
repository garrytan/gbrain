// The chat budget pricer (lookupPricing) previously searched only the
// Anthropic-specific ANTHROPIC_PRICING view, so a non-Anthropic chat model that
// is in CANONICAL_PRICING (e.g. openai:gpt-5.5 = $4/$16) returned null pricing →
// BudgetExhausted(no_pricing) when a cap was set → facts extraction silently
// produced 0 facts. The canonical fallback fixes it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetTracker, BudgetExhausted } from '../src/core/budget/budget-tracker.ts';

let tmp: string;
let auditPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-budget-canonical-pricing-test-'));
  auditPath = join(tmp, 'budget.jsonl');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('BudgetTracker canonical pricing fallback', () => {
  test('prices openai:gpt-5.5 (chat) via CANONICAL_PRICING — no no_pricing throw under a cap', () => {
    const t = new BudgetTracker({ label: 'canonical-pricing-test', maxCostUsd: 1.0, auditPath });
    expect(() =>
      t.reserve({ modelId: 'openai:gpt-5.5', estimatedInputTokens: 1000, maxOutputTokens: 500, kind: 'chat' }),
    ).not.toThrow();
  });

  test('still throws no_pricing for a genuinely-unknown model under a cap', () => {
    const t = new BudgetTracker({ label: 'canonical-pricing-test', maxCostUsd: 1.0, auditPath });
    try {
      t.reserve({ modelId: 'openai:does-not-exist-9.9', estimatedInputTokens: 1000, maxOutputTokens: 500, kind: 'chat' });
      throw new Error('expected BudgetExhausted');
    } catch (e) {
      expect(e instanceof BudgetExhausted).toBe(true);
    }
  });
});
