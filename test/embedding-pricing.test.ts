/**
 * Pricing table contract — Voyage + ZeroEntropy coverage gate.
 *
 * The post-upgrade reembed cost prompt in `gbrain upgrade` falls back to
 * "estimate unavailable" on unknown providers, which is fine for safety
 * but bad UX if the provider IS in the recipe registry. These tests pin
 * the providers that v0.35.x officially supports as first-class.
 */
import { describe, test, expect } from 'bun:test';
import {
  EMBEDDING_PRICING,
  lookupEmbeddingPrice,
  estimateCostFromChars,
} from '../src/core/embedding-pricing.ts';

describe('lookupEmbeddingPrice — first-class providers', () => {
  test('OpenAI text-embedding-3-large at $0.13/MTok', () => {
    const r = lookupEmbeddingPrice('openai:text-embedding-3-large');
    expect(r.kind).toBe('known');
    if (r.kind === 'known') expect(r.pricePerMTok).toBe(0.13);
  });

  test('Voyage voyage-3-large at $0.18/MTok', () => {
    const r = lookupEmbeddingPrice('voyage:voyage-3-large');
    expect(r.kind).toBe('known');
    if (r.kind === 'known') expect(r.pricePerMTok).toBe(0.18);
  });

  // Voyage v4 family, verified against docs.voyageai.com/docs/pricing 2026-07-28.
  test.each([
    ['voyage:voyage-4-large', 0.12],
    ['voyage:voyage-4', 0.06],
    ['voyage:voyage-4-lite', 0.02],
  ])('Voyage %s at $%d/MTok', (model, expected) => {
    const r = lookupEmbeddingPrice(model);
    expect(r.kind).toBe('known');
    if (r.kind === 'known') expect(r.pricePerMTok).toBe(expected);
  });

  // voyage-4-nano is the open-weight variant with no hosted rate published;
  // it must stay unpriced so callers say "estimate unavailable" (see table comment).
  test('voyage-4-nano is deliberately unpriced', () => {
    expect(lookupEmbeddingPrice('voyage:voyage-4-nano').kind).toBe('unknown');
  });

  test('ZeroEntropy zembed-1 at $0.05/MTok (v0.35.1.0+)', () => {
    const r = lookupEmbeddingPrice('zeroentropyai:zembed-1');
    expect(r.kind).toBe('known');
    if (r.kind === 'known') expect(r.pricePerMTok).toBe(0.05);
  });
});

describe('lookupEmbeddingPrice — fall-through behavior', () => {
  test('returns unknown for bogus provider', () => {
    const r = lookupEmbeddingPrice('madeup:model-9000');
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') {
      expect(r.provider).toBe('madeup');
      expect(r.model).toBe('model-9000');
    }
  });

  test('bare model strings default to openai', () => {
    const r = lookupEmbeddingPrice('text-embedding-3-small');
    expect(r.kind).toBe('known');
    if (r.kind === 'known') expect(r.key).toBe('openai:text-embedding-3-small');
  });

  test('provider name is case-insensitive', () => {
    const r = lookupEmbeddingPrice('ZeroEntropyAI:zembed-1');
    expect(r.kind).toBe('known');
    if (r.kind === 'known') expect(r.pricePerMTok).toBe(0.05);
  });
});

describe('lookupEmbeddingPrice — azure-openai alias (#4032)', () => {
  // Azure deployments bill the same per-token rates as OpenAI-hosted models.
  // The alias (not duplicated rows) means new openai:* entries can never drift
  // from their Azure twins.
  test.each([
    ['azure-openai:text-embedding-3-large', 0.13],
    ['azure-openai:text-embedding-3-small', 0.02],
    ['azure-openai:text-embedding-ada-002', 0.10],
  ])('%s resolves via the openai row at $%d/MTok', (model, expected) => {
    const r = lookupEmbeddingPrice(model);
    expect(r.kind).toBe('known');
    if (r.kind === 'known') {
      expect(r.pricePerMTok).toBe(expected);
      expect(r.key).toBe((model as string).replace('azure-openai', 'openai'));
    }
  });

  test('alias provider is case-insensitive too', () => {
    const r = lookupEmbeddingPrice('Azure-OpenAI:text-embedding-3-small');
    expect(r.kind).toBe('known');
    if (r.kind === 'known') expect(r.pricePerMTok).toBe(0.02);
  });

  test('azure-openai model with no openai twin stays unknown', () => {
    const r = lookupEmbeddingPrice('azure-openai:custom-embed-9000');
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') {
      expect(r.provider).toBe('azure-openai');
      expect(r.model).toBe('custom-embed-9000');
    }
  });
});

describe('lookupEmbeddingPrice — nested gateway ids (#2504)', () => {
  // Router providers (openrouter, generic gateways) wrap the upstream vendor
  // in the model segment. The router bills the vendor's per-token rate, so
  // the vendor row is the honest estimate on a miss.
  test.each([
    ['openrouter:openai/text-embedding-3-large', 0.13, 'openai:text-embedding-3-large'],
    ['openrouter:voyage/voyage-4', 0.06, 'voyage:voyage-4'],
    ['openrouter:mistral/mistral-embed', 0.10, 'mistral:mistral-embed'],
  ])('%s falls back to the nested vendor row', (model, expected, key) => {
    const r = lookupEmbeddingPrice(model as string);
    expect(r.kind).toBe('known');
    if (r.kind === 'known') {
      expect(r.pricePerMTok).toBe(expected as number);
      expect(r.key).toBe(key as string);
    }
  });

  test('nested provider aliases still apply (router → azure-openai → openai)', () => {
    const r = lookupEmbeddingPrice('openrouter:azure-openai/text-embedding-3-small');
    expect(r.kind).toBe('known');
    if (r.kind === 'known') expect(r.key).toBe('openai:text-embedding-3-small');
  });

  test('bare slash form assumes openai wrapper then unnests', () => {
    const r = lookupEmbeddingPrice('openai/text-embedding-3-small');
    expect(r.kind).toBe('known');
    if (r.kind === 'known') expect(r.key).toBe('openai:text-embedding-3-small');
  });

  test('nested unknown vendor stays unknown (fail closed, never fabricate)', () => {
    const r = lookupEmbeddingPrice('openrouter:madeup/model-9000');
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') {
      expect(r.provider).toBe('openrouter');
      expect(r.model).toBe('madeup/model-9000');
    }
  });

  test('trailing/leading slash does not recurse into an empty key', () => {
    expect(lookupEmbeddingPrice('openrouter:model-9000/').kind).toBe('unknown');
    expect(lookupEmbeddingPrice('openrouter:/model-9000').kind).toBe('unknown');
  });
});

describe('EMBEDDING_PRICING — table integrity', () => {
  test('all entries have pricePerMTok as a non-negative finite number', () => {
    for (const [key, val] of Object.entries(EMBEDDING_PRICING)) {
      expect(Number.isFinite(val.pricePerMTok)).toBe(true);
      expect(val.pricePerMTok).toBeGreaterThanOrEqual(0);
      expect(key).toContain(':');
    }
  });

  test('keys use lowercase provider names', () => {
    for (const key of Object.keys(EMBEDDING_PRICING)) {
      const provider = key.split(':')[0];
      expect(provider).toBe(provider.toLowerCase());
    }
  });
});

describe('estimateCostFromChars', () => {
  test('returns 0 for 0 chars', () => {
    expect(estimateCostFromChars(0, 0.13)).toBe(0);
  });

  test('100M chars @ $0.13/MTok ≈ $3.71 (100M / 3.5 ≈ 28.57M tokens × 0.13)', () => {
    const c = estimateCostFromChars(100_000_000, 0.13);
    expect(c).toBeGreaterThan(3.7);
    expect(c).toBeLessThan(3.8);
  });
});

// #4344 — hosted-recipe coverage gate: every embedding model the voyage
// recipe offers as HOSTED must have a pricing row, so `gbrain upgrade`'s
// cost estimate never says "unavailable" for a model we ship in the picker.
// voyage-4-nano is the documented exception (open-weight, no hosted rate —
// a fabricated 0 would under-estimate hosted-API users).
describe('#4344 — every hosted voyage recipe model has a pricing entry', () => {
  test('recipe models ⊆ pricing table (minus the open-weight exception)', async () => {
    const { voyage } = await import('../src/core/ai/recipes/voyage.ts');
    const OPEN_WEIGHT_EXCEPTIONS = new Set(['voyage-4-nano']);
    const models: string[] = (voyage as any).touchpoints.embedding.models;
    expect(models.length).toBeGreaterThan(0);
    const missing = models
      .filter((m) => !OPEN_WEIGHT_EXCEPTIONS.has(m))
      .filter((m) => lookupEmbeddingPrice(`voyage:${m}`).kind !== 'known');
    expect(missing).toEqual([]);
  });

  test.each([
    ['voyage:voyage-3.5', 0.06],
    ['voyage:voyage-3.5-lite', 0.02],
    ['voyage:voyage-3-lite', 0.02],
    ['voyage:voyage-code-3', 0.18],
    ['voyage:voyage-finance-2', 0.12],
    ['voyage:voyage-law-2', 0.12],
    ['voyage:voyage-multimodal-3', 0.12],
  ])('%s at $%d/MTok (docs.voyageai.com/docs/pricing, verified 2026-08-21)', (model, expected) => {
    const r = lookupEmbeddingPrice(model);
    expect(r.kind).toBe('known');
    if (r.kind === 'known') expect(r.pricePerMTok).toBe(expected);
  });
});
