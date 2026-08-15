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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitProviderModelId, normalizeModelId } from '../src/core/model-id.ts';

const REPO_ROOT = join(import.meta.dir, '..');
const readSrc = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

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

describe('normalizeModelId (#1698)', () => {
  test('slash form → colon — THE REPORTED BUG', () => {
    // Pre-fix: the colon-only inline check left this as the malformed
    // `anthropic:anthropic/claude-sonnet-4-6` and silently degraded to no-LLM.
    expect(normalizeModelId('anthropic/claude-sonnet-4-6')).toBe('anthropic:claude-sonnet-4-6');
  });

  test('bare → anthropic: default', () => {
    expect(normalizeModelId('claude-sonnet-4-6')).toBe('anthropic:claude-sonnet-4-6');
  });

  test('colon identity (already provider:model)', () => {
    expect(normalizeModelId('anthropic:claude-sonnet-4-6')).toBe('anthropic:claude-sonnet-4-6');
  });

  test('openrouter nested form preserved (inner slash kept)', () => {
    expect(normalizeModelId('openrouter:anthropic/claude-sonnet-4.6')).toBe('openrouter:anthropic/claude-sonnet-4.6');
  });

  test('non-anthropic bare with custom default provider', () => {
    expect(normalizeModelId('gpt-5', 'openai')).toBe('openai:gpt-5');
  });

  test('empty / whitespace returns input as-is (downstream throws loudly)', () => {
    expect(normalizeModelId('')).toBe('');
    expect(normalizeModelId('   ')).toBe('   ');
  });

  // #1698 (codex #2): a malformed leading separator yields an EMPTY-STRING provider from
  // splitProviderModelId. It must be returned unchanged (so resolveRecipe throws loudly),
  // NOT silently coerced to the default provider — otherwise `:claude-sonnet-4-6` would run
  // as `anthropic:claude-sonnet-4-6`, masking a typo as a valid Anthropic model.
  test('leading-colon malformed id returns input as-is (NOT coerced to anthropic)', () => {
    expect(normalizeModelId(':claude-sonnet-4-6')).toBe(':claude-sonnet-4-6');
  });
  test('leading-slash malformed id returns input as-is (NOT coerced to anthropic)', () => {
    expect(normalizeModelId('/claude-sonnet-4-6')).toBe('/claude-sonnet-4-6');
  });
  test('leading separator is not coerced even with a custom default provider', () => {
    expect(normalizeModelId(':gpt-5', 'openai')).toBe(':gpt-5');
  });
});

describe('normalize-everywhere structural guards (#1698)', () => {
  // Positive: every chat-adapter site references the shared normalizer.
  const SITES = [
    'src/core/think/index.ts',
    'src/core/cycle/synthesize.ts',
    'src/core/conversation-parser/llm-base.ts',
    'src/core/facts/extract.ts',
  ];
  // The exact colon-only inline that #1698 fixed: `X.includes(':') ? X : `anthropic:`.
  const COLON_ONLY_INLINE = /\.includes\(['"]:['"]\)\s*\?\s*[\w.]+\s*:\s*`anthropic:/;

  for (const site of SITES) {
    test(`${site} uses normalizeModelId and not the colon-only inline`, () => {
      const src = readSrc(site);
      expect(src).toContain('normalizeModelId');
      expect(COLON_ONLY_INLINE.test(src)).toBe(false);
    });
  }

  test('hasAnthropicKey is defined exactly once (the shared helper), not re-copied', () => {
    const FORMER_COPIES = [
      'src/core/think/index.ts',
      'src/core/cycle/synthesize.ts',
      'src/core/conversation-parser/llm-base.ts',
    ];
    for (const f of FORMER_COPIES) {
      expect(readSrc(f)).not.toMatch(/function hasAnthropicKey\s*\(/);
    }
    // The one canonical definition lives here.
    expect(readSrc('src/core/ai/anthropic-key.ts')).toMatch(/export function hasAnthropicKey\s*\(/);
  });
});
