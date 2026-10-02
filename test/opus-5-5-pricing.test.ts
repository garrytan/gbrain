/**
 * #5359 / #5494: Claude Opus 5.5 (`claude-opus-5-5`) was missing from the
 * recipes and the price table, so `--max-cost` runs on it hard-failed with
 * no_pricing before the first call. Rates are Anthropic's published Opus 5.5
 * list: $4 in / $20 out, cache reads 0.05x ($0.20), 5-minute writes 1.25x.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { BudgetTracker } from '../src/core/budget/budget-tracker.ts';
import { CANONICAL_PRICING } from '../src/core/model-pricing.ts';
import { anthropic } from '../src/core/ai/recipes/anthropic.ts';
import { claudeCli } from '../src/core/ai/recipes/claude-cli.ts';

describe('#5359 / #5494 Claude Opus 5.5', () => {
  test('priced at the published rates, with the 0.05x cache-read rate', () => {
    expect(CANONICAL_PRICING['anthropic:claude-opus-5-5']).toEqual({ input: 4, output: 20, cache_read: 0.2, cache_write: 5 });
  });

  test('listed by the anthropic and claude-cli recipes', () => {
    expect(anthropic.touchpoints.chat?.models).toContain('claude-opus-5-5');
    expect(anthropic.touchpoints.chat?.model_context_tokens?.['claude-opus-5-5']).toBe(1_000_000);
    expect(claudeCli.touchpoints.chat?.models).toContain('claude-opus-5-5');
    expect(claudeCli.touchpoints.expansion?.models).toContain('claude-opus-5-5');
  });

  test('a --max-cost reservation is estimated instead of refused with no_pricing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-opus55-'));
    try {
      const tracker = new BudgetTracker({ label: 'opus55-test', maxCostUsd: 1, auditPath: join(dir, 'audit.jsonl') });
      // 100k in + 10k out = $0.40 + $0.20 = $0.60, inside the $1 cap.
      expect(() => tracker.reserve({ modelId: 'anthropic:claude-opus-5-5', kind: 'chat', estimatedInputTokens: 100_000, maxOutputTokens: 10_000, label: 'x' })).not.toThrow();
      // A second identical reservation would reach $1.20 and is refused on cost.
      let reason: string | undefined;
      try {
        tracker.reserve({ modelId: 'anthropic:claude-opus-5-5', kind: 'chat', estimatedInputTokens: 100_000, maxOutputTokens: 10_000, label: 'y' });
      } catch (e) {
        reason = (e as { reason?: string }).reason;
      }
      expect(reason).toBe('cost');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
