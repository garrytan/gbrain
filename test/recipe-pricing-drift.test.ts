/**
 * #2689 — recipe allowlist ↔ canonical pricing drift guard.
 *
 * The Anthropic chat allowlist once predated the canonical pricing table
 * (pricing knew claude-sonnet-5; the recipe rejected it), so a config-set
 * model the whole system "knew" still failed the chat-client probe. This
 * guard pins the invariant the other way around: every model id the
 * anthropic recipe accepts (chat + expansion) MUST resolve in
 * CANONICAL_PRICING, so an allowlist addition can never outrun pricing and
 * a pricing-known Anthropic model missing from the allowlist shows up in
 * review as an explicit divergence, not silent rot.
 */
import { describe, test, expect } from 'bun:test';
import { anthropic } from '../src/core/ai/recipes/anthropic.ts';
import { canonicalLookup } from '../src/core/model-pricing.ts';

describe('anthropic recipe ↔ canonical pricing (#2689 drift guard)', () => {
  const recipeIds = new Set<string>([
    ...(anthropic.touchpoints.chat?.models ?? []),
    ...(anthropic.touchpoints.expansion?.models ?? []),
    // Alias targets must be priced too — they're what actually hits the wire.
    ...Object.values(anthropic.aliases ?? {}),
  ]);

  test('recipe declares at least one chat model', () => {
    expect(recipeIds.size).toBeGreaterThan(0);
  });

  for (const id of recipeIds) {
    test(`recipe model "${id}" is priced in CANONICAL_PRICING`, () => {
      expect(canonicalLookup(`anthropic:${id}`)).toBeTruthy();
    });
  }
});
