/**
 * Value pins for the 2026-08 provider-freshness pricing refresh.
 *
 * Companion to test/model-pricing.test.ts (which carries the structural
 * drift guard — derived views == canonical — plus earlier reconciliation
 * pins like Opus 4.7 and Gemini 2.0 Flash). The drift guard proves the
 * DERIVED tables agree with canonical, but nothing stops canonical ITSELF
 * regressing to a stale rate, so corrections get value-pinned here in the
 * same style.
 */
import { describe, expect, test } from 'bun:test';

import { CANONICAL_PRICING, canonicalLookup } from '../src/core/model-pricing.ts';
import { getRecipe } from '../src/core/ai/recipes/index.ts';

describe('GPT-5.6 / gpt-5.5 pricing pins', () => {
  test('gpt-5.5 reconciled to $5/$30 (not the stale pre-5.6-launch $4/$16) and matches Sol', () => {
    expect(CANONICAL_PRICING['openai:gpt-5.5']).toEqual({ input: 5.0, output: 30.0 });
    // The 5.6 launch repriced the previous flagship to match gpt-5.6-sol.
    expect(CANONICAL_PRICING['openai:gpt-5.5']).toEqual(CANONICAL_PRICING['openai:gpt-5.6-sol']);
  });

  test('GPT-5.6 family present at post-2026-07-30-cut rates', () => {
    expect(CANONICAL_PRICING['openai:gpt-5.6-sol']).toEqual({ input: 5.0, output: 30.0 });
    expect(CANONICAL_PRICING['openai:gpt-5.6-terra']).toEqual({ input: 2.0, output: 12.0 });
    expect(CANONICAL_PRICING['openai:gpt-5.6-luna']).toEqual({ input: 0.2, output: 1.2 });
  });
});

describe('Gemini 3.x Flash pricing pins', () => {
  test('Gemini 3.x Flash line present at verified rates', () => {
    expect(CANONICAL_PRICING['google:gemini-3.6-flash']).toEqual({ input: 1.5, output: 7.5 });
    expect(CANONICAL_PRICING['google:gemini-3.5-flash']).toEqual({ input: 1.5, output: 9.0 });
    expect(CANONICAL_PRICING['google:gemini-3.5-flash-lite']).toEqual({ input: 0.3, output: 2.5 });
  });
});

describe('dead models stay priced (audit rows) but stay OFF the recipe chat lists', () => {
  test('gpt-5.2 and the gemini 2.0-flash family price historically yet are not listable defaults', () => {
    expect(canonicalLookup('openai:gpt-5.2')).toBeDefined();
    expect(getRecipe('openai')!.touchpoints.chat!.models).not.toContain('gpt-5.2');
    expect(canonicalLookup('google:gemini-2.0-flash')).toBeDefined();
    const gchat = getRecipe('google')!.touchpoints.chat!.models;
    expect(gchat).not.toContain('gemini-2.0-flash');
    expect(gchat).not.toContain('gemini-2.0-flash-exp');
  });
});

describe('recipe cost anchors stay tied to canonical (refresh drift guard)', () => {
  test('openai chat baseline == canonical gpt-5.6-terra (models[0])', () => {
    const chat = getRecipe('openai')!.touchpoints.chat!;
    expect(chat.models[0]).toBe('gpt-5.6-terra');
    const c = canonicalLookup('openai:gpt-5.6-terra')!;
    expect(chat.cost_per_1m_input_usd).toBe(c.input);
    expect(chat.cost_per_1m_output_usd).toBe(c.output);
  });

  test('google chat baseline == canonical gemini-3.6-flash (models[0])', () => {
    const chat = getRecipe('google')!.touchpoints.chat!;
    expect(chat.models[0]).toBe('gemini-3.6-flash');
    const c = canonicalLookup('google:gemini-3.6-flash')!;
    expect(chat.cost_per_1m_input_usd).toBe(c.input);
    expect(chat.cost_per_1m_output_usd).toBe(c.output);
  });

  test('expansion anchors == canonical input rate of the cheap tier (models[0])', () => {
    const oaiExp = getRecipe('openai')!.touchpoints.expansion!;
    expect(oaiExp.models[0]).toBe('gpt-5.6-luna');
    expect(oaiExp.cost_per_1m_tokens_usd).toBe(canonicalLookup('openai:gpt-5.6-luna')!.input);

    const gExp = getRecipe('google')!.touchpoints.expansion!;
    expect(gExp.models[0]).toBe('gemini-3.5-flash-lite');
    expect(gExp.cost_per_1m_tokens_usd).toBe(canonicalLookup('google:gemini-3.5-flash-lite')!.input);
  });

  test('every refreshed expansion model is priced (no unpriced tiers)', () => {
    // Expansion-only models are legitimate: gpt-4o-mini stays in expansion
    // (tiny prompts, still on the live sheet) but is deliberately NOT
    // chat-listed — the chat touchpoint's touchpoint-wide max_context_tokens
    // (1M for the 5.6 family) would over-report its 128K window 8x. The
    // load-bearing invariant is pricing coverage, not chat membership.
    for (const provider of ['openai', 'google'] as const) {
      const r = getRecipe(provider)!;
      for (const m of r.touchpoints.expansion!.models) {
        expect(canonicalLookup(`${provider}:${m}`), `${provider}:${m} unpriced`).toBeDefined();
      }
    }
  });
});
