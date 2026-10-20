/**
 * #6448 item 1 (fix wave 15 P6.1b) — long-prompt pricing tier.
 *
 * Haiku 5.5 bills every rate 5x once a prompt exceeds 100,000 input tokens.
 * The canonical row carries that tier; `priceAtPromptSize` selects it per
 * request; `usageCostUsd` / `reservationCostUsd` (and so the budget tracker's
 * reserve and record) and `estimateChatCostUsd` (the durable chat ledger)
 * price the WHOLE prompt at the upper tier past the threshold. The pre-flight
 * estimate counts tool definitions and tool-result output, so a tool-heavy
 * prompt that crosses the threshold is reserved at the tier it will bill at.
 * No live call anywhere here.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reservationCostUsd, usageCostUsd } from '../src/core/budget/reservation-cost.ts';
import { BudgetExhausted, BudgetTracker } from '../src/core/budget/budget-tracker.ts';
import { estimateChatCostUsd, recordChatUsage, withChatCallMeter, type ChatCallMeter } from '../src/core/ai/chat-usage.ts';

// Behaviour only through the pre-existing cost APIs, so this file runs (and
// fails for the wrong dollar amounts, never an import) against master.
// The tier row and `priceAtPromptSize` / `estimateChatInputTokens` helpers are
// pinned in test/model-pricing-tier-helpers.test.ts.
const HAIKU = 'anthropic:claude-haiku-5-5';
const T = 100_000;
const auditPath = () => join(mkdtempSync(join(tmpdir(), 'budget-tier-')), 'audit.jsonl');

describe('usageCostUsd / reservationCostUsd apply the tier to the whole prompt', () => {
  test('threshold: 99,999 in + 1,000 out bills base; 100,001 bills the 5x tier', () => {
    expect(usageCostUsd(HAIKU, T - 1, 1_000, 'chat')).toBeCloseTo((99_999 * 0.10 + 1_000 * 0.50) / 1e6, 12);
    expect(usageCostUsd(HAIKU, T, 1_000, 'chat')).toBeCloseTo((100_000 * 0.10 + 1_000 * 0.50) / 1e6, 12);
    // Astra's probe: $0.0105 before the fix; the declared tariff gives $0.0525005.
    expect(usageCostUsd(HAIKU, T + 1, 1_000, 'chat')).toBeCloseTo(0.0525005, 10);
    expect(reservationCostUsd(HAIKU, 'chat', T + 1, 1_000)).toBeCloseTo(0.0525005, 10);
  });

  test('bare and dated forms of the id price the same tier', () => {
    expect(usageCostUsd('claude-haiku-5-5', T + 1, 0, 'chat')).toBeCloseTo((T + 1) * 0.50 / 1e6, 12);
    expect(usageCostUsd('anthropic/claude-haiku-5-5', T + 1, 0, 'chat')).toBeCloseTo((T + 1) * 0.50 / 1e6, 12);
  });

  test('models without a tier are unchanged at any size', () => {
    expect(usageCostUsd('anthropic:claude-sonnet-5-5', 400_000, 1_000, 'chat')).toBeCloseTo((400_000 * 2 + 1_000 * 10) / 1e6, 12);
  });
});

describe('budget tracker: the cap admits long prompts at their real tariff', () => {
  test('a 100,001-token Haiku call is refused under a $0.03 cap (it was admitted at $0.0105)', () => {
    const tracker = new BudgetTracker({ maxCostUsd: 0.03, label: 'tier-test', auditPath: auditPath() });
    let thrown: unknown;
    try {
      tracker.reserve({ modelId: HAIKU, estimatedInputTokens: T + 1, maxOutputTokens: 1_000, kind: 'chat' });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BudgetExhausted);
    expect((thrown as BudgetExhausted).reason).toBe('cost');
    // The same prompt one token under the threshold is admitted.
    expect(tracker.reserve({ modelId: HAIKU, estimatedInputTokens: T - 1, maxOutputTokens: 1_000, kind: 'chat' })).toBeDefined();
  });

  test('concurrent reservations: tiers are per request, and the second long prompt is refused by the held projection', () => {
    const tracker = new BudgetTracker({ maxCostUsd: 0.06, label: 'tier-test', auditPath: auditPath() });
    // Two 60K prompts: each below the threshold, both admitted at base even
    // though their SUM crosses 100K — the tier is a property of one request.
    const a = tracker.reserve({ modelId: HAIKU, estimatedInputTokens: 60_000, maxOutputTokens: 0, kind: 'chat' });
    const b = tracker.reserve({ modelId: HAIKU, estimatedInputTokens: 60_000, maxOutputTokens: 0, kind: 'chat' });
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    tracker.release(a);
    tracker.release(b);
    // Two 100,001-token prompts at $0.0525 each: the first is held, the
    // second must not fit under the remaining $0.0075.
    const first = tracker.reserve({ modelId: HAIKU, estimatedInputTokens: T + 1, maxOutputTokens: 1_000, kind: 'chat' });
    expect(first).toBeDefined();
    expect(() => tracker.reserve({ modelId: HAIKU, estimatedInputTokens: T + 1, maxOutputTokens: 1_000, kind: 'chat' }))
      .toThrow(BudgetExhausted);
  });

  test('record() prices the provider-reported total (cache included) at the tier', () => {
    const tracker = new BudgetTracker({ maxCostUsd: 1, label: 'tier-test', auditPath: auditPath() });
    const r = tracker.reserve({ modelId: HAIKU, estimatedInputTokens: 1_000, maxOutputTokens: 100, kind: 'chat' });
    // The SDK's inputTokens is input + cache_creation + cache_read: a prompt
    // served mostly from cache is still a long prompt for tier selection.
    tracker.record({ modelId: HAIKU, reservation: r, inputTokens: T + 1, outputTokens: 1_000 });
    expect(tracker.snapshot().cumulativeCostUsd).toBeCloseTo(0.0525005, 10);
  });
});

describe('durable chat ledger: estimateChatCostUsd', () => {
  test('cache buckets count toward the prompt size and bill at the tier cache rates', () => {
    // 10,001 uncached + 90,000 cache reads = 100,001 prompt tokens → tier.
    const usd = estimateChatCostUsd(HAIKU, { input_tokens: 10_001, output_tokens: 1_000, cache_read_tokens: 90_000 });
    expect(usd).toBeCloseTo((10_001 * 0.50 + 90_000 * 0.05 + 1_000 * 2.50) / 1e6, 12);
    // One token less in cache: base tier on every bucket.
    const base = estimateChatCostUsd(HAIKU, { input_tokens: 10_001, output_tokens: 1_000, cache_read_tokens: 89_999 });
    expect(base).toBeCloseTo((10_001 * 0.10 + 89_999 * 0.01 + 1_000 * 0.50) / 1e6, 12);
  });

  test('cache writes count toward the prompt size too', () => {
    const usd = estimateChatCostUsd(HAIKU, { input_tokens: 1, output_tokens: 0, cache_write_tokens: T });
    expect(usd).toBeCloseTo((1 * 0.50 + T * 0.625) / 1e6, 12);
  });
});

describe('phase cost meter: claude-cli Haiku 5.5 bills the tier like the anthropic id', () => {
  test('a 100,001-token prompt (90,000 from cache) meters at the tier rates on both routes', () => {
    const usage = { input_tokens: T + 1, output_tokens: 1_000, cache_read_tokens: 90_000 };
    const tier = (10_001 * 0.50 + 90_000 * 0.05 + 1_000 * 2.50) / 1e6;
    for (const model of [HAIKU, 'claude-cli:claude-haiku-5-5']) {
      const meter: ChatCallMeter = { calls: 0, cost_usd: 0, unpriced_calls: 0 };
      withChatCallMeter(meter, () => recordChatUsage({ model, usage }));
      expect(meter.cost_usd).toBeCloseTo(tier, 12);
    }
  });
});
