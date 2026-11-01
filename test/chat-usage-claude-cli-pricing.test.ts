/**
 * The usage ledger prices a `claude-cli:<model>` call like its Anthropic
 * sibling, the same resolution the budget meter (`priceFor`) already applies,
 * instead of writing `cost_usd = NULL`. A model nobody can price stays null.
 */
import { describe, expect, test } from 'bun:test';
import { estimateChatCostUsd } from '../src/core/ai/chat-usage.ts';

const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 500_000, cache_write_tokens: 250_000 };

describe('estimateChatCostUsd for subscription-billed labels', () => {
  test('claude-cli:<model> is priced, and equals the anthropic:<model> price', () => {
    const sibling = estimateChatCostUsd('anthropic:claude-sonnet-5', usage);
    expect(sibling).not.toBeNull();
    expect(estimateChatCostUsd('claude-cli:claude-sonnet-5', usage)).toBe(sibling);
  });

  test('the sibling price is positive and scales with output tokens', () => {
    const small = estimateChatCostUsd('claude-cli:claude-sonnet-5', { input_tokens: 0, output_tokens: 1_000 });
    const large = estimateChatCostUsd('claude-cli:claude-sonnet-5', { input_tokens: 0, output_tokens: 2_000 });
    expect(small).toBeGreaterThan(0);
    expect(large).toBeCloseTo((small as number) * 2, 10);
  });

  test('an alias label is priced as the dated model it maps to', () => {
    expect(estimateChatCostUsd('claude-cli:sonnet', usage)).not.toBeNull();
  });

  test('a model with no price anywhere stays null', () => {
    expect(estimateChatCostUsd('claude-cli:not-a-real-model-xyz', usage)).toBeNull();
    expect(estimateChatCostUsd('nope:not-a-real-model-xyz', usage)).toBeNull();
    expect(estimateChatCostUsd('ollama:llama3', usage)).toBeNull();
  });
});
