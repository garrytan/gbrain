/**
 * Google retires gemini-2.5-flash on 2026-12-01 and routes its requests to
 * gemini-3.5-flash-lite (#9776). Every gbrain default that named 2.5-flash
 * names its replacement, the replacement is priced, and the retired id stays
 * priced (old usage rows) but leaves the recipe lists, so the default-slot
 * guards catch anything that still points at it. gemini-2.5-flash-lite is not
 * deprecated and stays offered.
 */
import { describe, expect, test } from 'bun:test';

import { DEFAULT_ALIASES } from '../src/core/model-config.ts';
import { getRecipe } from '../src/core/ai/recipes/index.ts';
import { DEFAULT_MODEL_PANEL } from '../src/core/takes-quality-eval/runner.ts';
import { CANONICAL_PRICING, canonicalLookup } from '../src/core/model-pricing.ts';

describe('Gemini defaults after gemini-2.5-flash retires (#9776)', () => {
  const google = getRecipe('google')!;

  test('the gemini alias resolves to gemini-3.5-flash-lite', () => {
    expect(DEFAULT_ALIASES.gemini).toBe('google:gemini-3.5-flash-lite');
  });

  test('the google recipe defaults chat and expansion to gemini-3.5-flash-lite', () => {
    expect(google.touchpoints.chat!.models[0]).toBe('gemini-3.5-flash-lite');
    expect(google.touchpoints.expansion!.models[0]).toBe('gemini-3.5-flash-lite');
  });

  test('the retired gemini-2.5-flash is no longer offered; gemini-2.5-flash-lite still is', () => {
    for (const tp of [google.touchpoints.chat!, google.touchpoints.expansion!]) {
      expect(tp.models).not.toContain('gemini-2.5-flash');
      expect(tp.models).toContain('gemini-2.5-flash-lite');
    }
  });

  test('the takes judge panel uses gemini-3.5-flash-lite', () => {
    expect(DEFAULT_MODEL_PANEL).toContain('google:gemini-3.5-flash-lite');
    expect(DEFAULT_MODEL_PANEL).not.toContain('google:gemini-2.5-flash');
  });

  test('gemini-3.5-flash-lite is priced at Google\'s rates; the retired id still prices old rows', () => {
    expect(canonicalLookup('google:gemini-3.5-flash-lite')).toEqual({ input: 0.3, output: 2.5 });
    expect(CANONICAL_PRICING['google:gemini-2.5-flash']).toEqual({ input: 0.3, output: 2.5 });
  });
});
