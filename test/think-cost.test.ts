import { describe, expect, test } from 'bun:test';
import { computeThinkCostUsd } from '../src/commands/think.ts';

// think's own cost was previously unsurfaced anywhere: not in this CLI's own
// --json output, not in budget_ledger, and invisible to a wrapping caller's
// own token accounting (the LLM call think makes is its own, separate API
// call). computeThinkCostUsd is the small, pure function that turns
// {input_tokens, output_tokens} + a resolved modelUsed into a USD figure via
// the existing canonical pricing table.
describe('computeThinkCostUsd', () => {
  test('computes cost from real usage against a known model', () => {
    const cost = computeThinkCostUsd(
      { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      'anthropic:claude-sonnet-5',
    );
    // sonnet-5 pricing: input $3.00/MTok, output $15.00/MTok.
    expect(cost).toBe(18);
  });

  test('undefined usage (no-client/stub path) → undefined, never a fabricated cost', () => {
    expect(computeThinkCostUsd(undefined, 'anthropic:claude-sonnet-5')).toBeUndefined();
  });

  test('unknown model id → undefined, not zero (no pricing to compute from)', () => {
    expect(computeThinkCostUsd(
      { input_tokens: 100, output_tokens: 100 },
      'some-unlisted-provider:some-model',
    )).toBeUndefined();
  });

  test('zero-token usage → zero cost, not undefined (a real call that happened to be free)', () => {
    expect(computeThinkCostUsd(
      { input_tokens: 0, output_tokens: 0 },
      'anthropic:claude-sonnet-5',
    )).toBe(0);
  });
});
