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
  ANTHROPIC_CACHE_READ_MULT,
  ANTHROPIC_CACHE_WRITE_5M_MULT,
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

  test('Opus 5 present at $5/$25 (same tier as Opus 4.8)', () => {
    expect(CANONICAL_PRICING['anthropic:claude-opus-5']).toMatchObject({ input: 5.0, output: 25.0 });
  });

  test('Opus 4.8 present at $5/$25 (closes gbrain#1819)', () => {
    expect(CANONICAL_PRICING['anthropic:claude-opus-4-8']).toMatchObject({ input: 5.0, output: 25.0 });
  });

  test('Opus 4.7 at $5/$25 (not the stale $15/$75)', () => {
    expect(CANONICAL_PRICING['anthropic:claude-opus-4-7']).toMatchObject({ input: 5.0, output: 25.0 });
  });

  test('Sonnet 5 present at $3/$15 (standard rate, intro discount not modeled)', () => {
    expect(CANONICAL_PRICING['anthropic:claude-sonnet-5']).toMatchObject({ input: 3.0, output: 15.0 });
  });

  test('Fable 5 present at $10/$50', () => {
    expect(CANONICAL_PRICING['anthropic:claude-fable-5']).toMatchObject({ input: 10.0, output: 50.0 });
  });

  test('Gemini 2.0 Flash reconciled to $0.10/$0.40; legacy alias agrees', () => {
    expect(CANONICAL_PRICING['google:gemini-2.0-flash']).toEqual({ input: 0.1, output: 0.4 });
    expect(CANONICAL_PRICING['google:gemini-2-flash']).toEqual(
      CANONICAL_PRICING['google:gemini-2.0-flash'],
    );
  });

  // Retired ids stay priced so historical usage/audit rows still resolve;
  // the live successors have to be priced for anything new to be estimated.
  test('the live Gemini ids are priced alongside the retired ones', () => {
    expect(CANONICAL_PRICING['google:gemini-2.5-flash']).toEqual({ input: 0.3, output: 2.5 });
    expect(CANONICAL_PRICING['google:gemini-2.5-flash-lite']).toEqual({ input: 0.1, output: 0.4 });
  });

  // #4218 drift guard extension: cache_read/cache_write are DERIVED from the
  // input rate via the exported multipliers — a hand-edited cache number that
  // drifts from input*mult fails here.
  test('every anthropic: row carries cache_read = 0.1x input and cache_write = 1.25x input', () => {
    for (const [key, p] of Object.entries(CANONICAL_PRICING)) {
      if (!key.startsWith('anthropic:')) continue;
      expect(p.cache_read).toBeCloseTo(p.input * ANTHROPIC_CACHE_READ_MULT, 10);
      expect(p.cache_write).toBeCloseTo(p.input * ANTHROPIC_CACHE_WRITE_5M_MULT, 10);
    }
  });

  test('cache fields, when present, are finite positive with read < input < write', () => {
    for (const [key, p] of Object.entries(CANONICAL_PRICING)) {
      if (p.cache_read !== undefined) {
        expect(Number.isFinite(p.cache_read)).toBe(true);
        expect(p.cache_read).toBeGreaterThan(0);
        expect(p.cache_read).toBeLessThan(p.input);
      }
      if (p.cache_write !== undefined) {
        expect(Number.isFinite(p.cache_write)).toBe(true);
        expect(p.cache_write).toBeGreaterThan(p.input);
      }
      // Non-Anthropic rows deliberately carry NO cache fields until their
      // provider's cache pricing is verified — consumers fall back to the
      // input rate (documented in ModelPricing).
      if (!key.startsWith('anthropic:')) {
        expect(p.cache_read).toBeUndefined();
        expect(p.cache_write).toBeUndefined();
      }
    }
  });
});

describe('canonicalLookup — id normalization', () => {
  test('bare anthropic id → hit (defaults to anthropic provider)', () => {
    expect(canonicalLookup('claude-opus-4-8')).toMatchObject({ input: 5.0, output: 25.0 });
  });

  test('colon form → hit', () => {
    expect(canonicalLookup('anthropic:claude-opus-4-8')).toMatchObject({ input: 5.0, output: 25.0 });
  });

  test('slash form → hit', () => {
    expect(canonicalLookup('anthropic/claude-opus-4-8')).toMatchObject({ input: 5.0, output: 25.0 });
  });

  test('non-anthropic bare id → miss (preserves prior null contract)', () => {
    expect(canonicalLookup('gpt-5')).toBeUndefined();
  });

  test('nested OpenRouter id with NO declared entry → MISS (markup ≠ native pricing)', () => {
    expect(canonicalLookup('openrouter:anthropic/claude-sonnet-4-6')).toBeUndefined();
  });

  test('OpenRouter id WITH a declared static entry → hit on its own rate, not the vendor alias', () => {
    // deepseek/deepseek-v4-flash-0731 happens to match deepseek:deepseek-v4-flash
    // to the cent, but this must resolve via its OWN canonical key, not by
    // falling through to the bare vendor tail — that fallthrough is exactly
    // what canonicalLookup's nested-id miss (case above) exists to prevent.
    expect(canonicalLookup('openrouter:deepseek/deepseek-v4-flash-0731')).toEqual({
      input: 0.14,
      output: 0.28,
    });
    expect(canonicalLookup('openrouter:qwen/qwen3.7-flash')).toEqual({
      input: 0.03,
      output: 0.13,
    });
    expect(canonicalLookup('openrouter:qwen/qwen3.6-plus')).toEqual({
      input: 0.325,
      output: 1.95,
    });
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

  test('openai recipe expansion cost equals canonical gpt-5.6-luna input price', async () => {
    // The recipe's expansion touchpoint hardcodes a per-1M cost with a
    // "gpt-5.6-luna baseline" comment; the canonical table is the single
    // home for that number. Keyed pin (luna is the declared baseline) so a
    // price refresh that touches only one of the two homes fails here.
    const { openai } = await import('../src/core/ai/recipes/openai.ts');
    const canonical = CANONICAL_PRICING['openai:gpt-5.6-luna'];
    expect(canonical).toBeDefined();
    expect(openai.touchpoints?.expansion?.models?.[0]).toBe('gpt-5.6-luna');
    expect(openai.touchpoints?.expansion?.cost_per_1m_tokens_usd).toBe(canonical.input);
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

describe('canonicalLookup — case-insensitive fallback (#4123 / TODOS case-sensitivity)', () => {
  test('cased provider prefix resolves', () => {
    expect(canonicalLookup('ANTHROPIC:claude-opus-4-8')).toMatchObject({ input: 5.0, output: 25.0 });
  });

  test('cased model tail resolves', () => {
    expect(canonicalLookup('anthropic:CLAUDE-OPUS-4-8')).toMatchObject({ input: 5.0, output: 25.0 });
  });

  test('nested OpenRouter ids still intentionally MISS (markup never repriced as native)', () => {
    expect(canonicalLookup('OPENROUTER:anthropic/claude-opus-4-8')).toBeUndefined();
  });

  test('no two canonical keys collide case-insensitively (folded-view safety pin)', () => {
    const folded = new Map<string, string>();
    for (const key of Object.keys(CANONICAL_PRICING)) {
      const lower = key.toLowerCase();
      const prior = folded.get(lower);
      expect(prior === undefined || prior === key).toBe(true);
      folded.set(lower, key);
    }
  });
});
