/**
 * v0.41.21.0 — splitProviderModelId centralizer contract.
 *
 * Pins every shape the helper must handle so future refactors of the 5
 * downstream consumers (anthropic-pricing, budget-tracker, cost-tracker,
 * batch-projection, model-config) can't silently regress on the slash-prefix
 * bug class.
 *
 * Sibling: `src/core/ai/model-resolver.ts:parseModelId` — the gateway-side
 * resolver. Both accept the same input shapes post-v0.41.21.0; this helper
 * is defensive (returns `{provider: null, model: 'bare'}` for bare names)
 * and the gateway one throws (routing needs an explicit provider).
 */

import { describe, test, expect } from 'bun:test';
import { splitProviderModelId } from '../src/core/model-id.ts';

describe('splitProviderModelId', () => {
  describe('happy paths', () => {
    test('bare model id → no provider', () => {
      expect(splitProviderModelId('claude-sonnet-4-6')).toEqual({
        provider: null,
        model: 'claude-sonnet-4-6',
      });
    });

    test('colon-separated provider:model', () => {
      expect(splitProviderModelId('anthropic:claude-sonnet-4-6')).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      });
    });

    test('slash-separated provider/model — THE BUG CLASS FIX', () => {
      // Pre-fix: every site's inline split missed this shape, silently
      // returning the whole string as the "model" and failing pricing lookups.
      expect(splitProviderModelId('anthropic/claude-sonnet-4-6')).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      });
    });

    test('double-separator openrouter:anthropic/X — colon wins, tail as-is', () => {
      // Per D2 architecture: do NOT recursively peel. Transport=openrouter;
      // pricing-vendor-identity is intentionally deferred to TODO #2 (non-
      // Anthropic pricing). Pricing lookups will miss on the slash-bearing
      // tail and land in the caller's existing unknown-model path.
      expect(splitProviderModelId('openrouter:anthropic/claude-sonnet-4.6')).toEqual({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4.6',
      });
    });

    test('slash-separated openrouter form openai/gpt-5', () => {
      expect(splitProviderModelId('openai/gpt-5')).toEqual({
        provider: 'openai',
        model: 'gpt-5',
      });
    });
  });

  describe('defensive contract', () => {
    test('null → {provider: null, model: ""}', () => {
      expect(splitProviderModelId(null)).toEqual({ provider: null, model: '' });
    });

    test('undefined → {provider: null, model: ""}', () => {
      expect(splitProviderModelId(undefined)).toEqual({ provider: null, model: '' });
    });

    test('empty string → {provider: null, model: ""}', () => {
      expect(splitProviderModelId('')).toEqual({ provider: null, model: '' });
    });

    test('whitespace-only → {provider: null, model: ""}', () => {
      expect(splitProviderModelId('   ')).toEqual({ provider: null, model: '' });
      expect(splitProviderModelId('\t\n  ')).toEqual({ provider: null, model: '' });
    });

    test('leading/trailing whitespace is trimmed before split', () => {
      expect(splitProviderModelId('  anthropic:claude-sonnet-4-6  ')).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      });
      expect(splitProviderModelId('  anthropic/claude-sonnet-4-6  ')).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      });
    });
  });

  describe('edge inputs', () => {
    test('leading separator ":foo" → provider is empty string, not null', () => {
      // Distinguish "no separator present" (null provider) from "separator
      // with empty left side" (empty-string provider). Empty-string provider
      // is a malformed input but we preserve the distinction so downstream
      // callers can detect it without re-parsing.
      expect(splitProviderModelId(':claude-foo')).toEqual({
        provider: '',
        model: 'claude-foo',
      });
    });

    test('leading slash "/foo" → provider is empty string', () => {
      expect(splitProviderModelId('/claude-foo')).toEqual({
        provider: '',
        model: 'claude-foo',
      });
    });

    test('trailing separator "anthropic:" → model is empty string', () => {
      expect(splitProviderModelId('anthropic:')).toEqual({
        provider: 'anthropic',
        model: '',
      });
    });

    test('only ":" → empty provider AND empty model', () => {
      expect(splitProviderModelId(':')).toEqual({
        provider: '',
        model: '',
      });
    });

    test('only "/" → empty provider AND empty model', () => {
      expect(splitProviderModelId('/')).toEqual({
        provider: '',
        model: '',
      });
    });

    test('mixed-case provider is preserved (no normalization)', () => {
      // Callers that care (e.g. isAnthropicProvider) lowercase themselves.
      expect(splitProviderModelId('Anthropic:claude-foo')).toEqual({
        provider: 'Anthropic',
        model: 'claude-foo',
      });
    });
  });
});
