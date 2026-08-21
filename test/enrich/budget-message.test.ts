/**
 * #4032 — the budget-exhausted CLI message must branch on the abort reason.
 * A no_pricing TX2 hard-fail is NOT a cost overrun: "raise --max-usd" sends the
 * operator after the wrong knob (the cap was never the problem). Pure (no
 * engine) — runs in the fast parallel loop.
 */
import { describe, test, expect } from 'bun:test';
import { budgetExhaustedMessage } from '../../src/commands/enrich.ts';

describe('budgetExhaustedMessage (#4032)', () => {
  test('cost → raise-the-cap advice', () => {
    expect(budgetExhaustedMessage('cost')).toContain('--max-usd');
    expect(budgetExhaustedMessage('cost')).toContain('Budget cap reached');
  });

  test('undefined reason (legacy result) keeps the cost message', () => {
    expect(budgetExhaustedMessage(undefined)).toContain('Budget cap reached');
  });

  test('no_pricing → pricing-entry-or-uncapped advice, names the model', () => {
    const msg = budgetExhaustedMessage('no_pricing', 'azure-openai:text-embedding-3-large');
    expect(msg).toContain('azure-openai:text-embedding-3-large');
    expect(msg).toContain('cost cap cannot be enforced');
    expect(msg).toContain('--max-usd off');
    expect(msg).not.toContain('higher --max-usd');
  });

  test('no_pricing without a modelId still explains itself', () => {
    const msg = budgetExhaustedMessage('no_pricing');
    expect(msg).toContain('No pricing');
    expect(msg).toContain('cost cap cannot be enforced');
  });
});
