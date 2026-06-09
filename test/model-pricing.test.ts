/**
 * model-pricing — canonical table + canonicalLookup + the drift guard.
 *
 * Because the other pricing tables are DERIVED from CANONICAL_PRICING (not
 * hand-copied), cross-table price drift — the kind that left Opus 4.7 at
 * $15/$75 in takes-quality-eval while anthropic-pricing.ts had $5/$25
 * (gbrain#1819) — is structurally impossible. The "drift guard" below is a
 * regression trip-wire: it asserts each derived view still equals canonical, so
 * if anyone later re-hardcodes a view back into a duplicate, CI catches it. The
 * cross-modal panel check is genuinely load-bearing — it asserts canonical
 * actually carries every model the runner prices.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_PRICING,
  canonicalLookup,
} from '../src/core/model-pricing.ts';
import { ANTHROPIC_PRICING } from '../src/core/anthropic-pricing.ts';
import { MODEL_PRICING } from '../src/core/takes-quality-eval/pricing.ts';
import { estimateAnthropicCost } from '../src/core/brain-score-recommendations.ts';

describe('CANONICAL_PRICING — table integrity', () => {
  test('every entry has finite positive rates and a provider-prefixed key', () => {
    for (const [key, p] of Object.entries(CANONICAL_PRICING)) {
      expect(Number.isFinite(p.input)).toBe(true);
      expect(Number.isFinite(p.output)).toBe(true);
      expect(p.input).toBeGreaterThan(0);
      expect(p.output).toBeGreaterThan(0);
      // Provider-prefixed key (sanity guard against a bare key sneaking in).
      // NOTE: deliberately NO output>=input invariant — symmetric pricing is
      // legitimate (e.g. together:...Llama-3.3 is 0.88/0.88).
      expect(key).toContain(':');
    }
  });

  test('Opus 4.8 present at $5/$25 (closes gbrain#1819)', () => {
    expect(CANONICAL_PRICING['anthropic:claude-opus-4-8']).toEqual({ input: 5.0, output: 25.0 });
  });

  test('Opus 4.7 at $5/$25 (not the stale $15/$75)', () => {
    expect(CANONICAL_PRICING['anthropic:claude-opus-4-7']).toEqual({ input: 5.0, output: 25.0 });
  });

  test('Gemini 2.0 Flash reconciled to $0.10/$0.40; legacy alias agrees', () => {
    expect(CANONICAL_PRICING['google:gemini-2.0-flash']).toEqual({ input: 0.1, output: 0.4 });
    expect(CANONICAL_PRICING['google:gemini-2-flash']).toEqual(
      CANONICAL_PRICING['google:gemini-2.0-flash'],
    );
  });
});

describe('canonicalLookup — id normalization', () => {
  test('bare anthropic id → hit (defaults to anthropic provider)', () => {
    expect(canonicalLookup('claude-opus-4-8')).toEqual({ input: 5.0, output: 25.0 });
  });

  test('colon form → hit', () => {
    expect(canonicalLookup('anthropic:claude-opus-4-8')).toEqual({ input: 5.0, output: 25.0 });
  });

  test('slash form → hit', () => {
    expect(canonicalLookup('anthropic/claude-opus-4-8')).toEqual({ input: 5.0, output: 25.0 });
  });

  test('non-anthropic bare id → miss (preserves prior null contract)', () => {
    expect(canonicalLookup('gpt-5')).toBeUndefined();
  });

  test('nested OpenRouter id → MISS (markup ≠ native pricing)', () => {
    expect(canonicalLookup('openrouter:anthropic/claude-sonnet-4-6')).toBeUndefined();
  });

  test('slash-bearing model tail kept as exact key (together Llama)', () => {
    expect(canonicalLookup('together:meta-llama/Llama-3.3-70B-Instruct-Turbo')).toEqual({
      input: 0.88,
      output: 0.88,
    });
  });

  test('null / empty → undefined (no throw)', () => {
    expect(canonicalLookup(null)).toBeUndefined();
    expect(canonicalLookup(undefined)).toBeUndefined();
    expect(canonicalLookup('')).toBeUndefined();
  });
});

describe('DRIFT GUARD — derived views stay equal to canonical (re-hardcode trip-wire)', () => {
  test('ANTHROPIC_PRICING (bare) equals canonical anthropic: entries', () => {
    for (const [key, p] of Object.entries(CANONICAL_PRICING)) {
      if (!key.startsWith('anthropic:')) continue;
      const bare = key.slice('anthropic:'.length);
      expect(ANTHROPIC_PRICING[bare]).toEqual(p);
    }
  });

  test('takes-quality MODEL_PRICING equals canonical for every allowlisted key', () => {
    for (const [key, p] of Object.entries(MODEL_PRICING)) {
      const c = canonicalLookup(key);
      expect(c).toBeDefined();
      expect(p.input_per_1m).toBe(c!.input);
      expect(p.output_per_1m).toBe(c!.output);
    }
  });

  test('cross-modal panel models are all priced from canonical', () => {
    // The runner now calls canonicalLookup(slot.model) directly, so presence
    // here = the runner prices these. Mirrors the panel it used to inline.
    for (const id of [
      'openai:gpt-4o',
      'openai:gpt-4o-mini',
      'anthropic:claude-opus-4-7',
      'anthropic:claude-sonnet-4-6',
      'google:gemini-1.5-pro',
      'google:gemini-2.0-flash',
      'together:meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'deepseek:deepseek-chat',
    ]) {
      expect(canonicalLookup(id)).toBeDefined();
    }
  });
});

describe('S1A — raw-index consumers price provider-prefixed ids', () => {
  test('estimateAnthropicCost prices anthropic:claude-opus-4-8 (was zero pre-fix)', () => {
    // 1 call, 1M in, 1M out → 1*5 + 1*25 = $30. Pre-fix the bare-key index
    // missed on the provider-prefixed id and returned 0.
    const cost = estimateAnthropicCost('anthropic:claude-opus-4-8', 1, 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(30.0, 2);
  });
});

describe('no heavy import (cycle guard)', () => {
  test('model-pricing.ts imports only model-id.ts (relative)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/core/model-pricing.ts', import.meta.url)),
      'utf8',
    );
    const relImports = [...src.matchAll(/^\s*import\s.*from\s+['"](\.[^'"]+)['"]/gm)].map(
      (m) => m[1],
    );
    expect(relImports).toEqual(['./model-id.ts']);
  });
});
