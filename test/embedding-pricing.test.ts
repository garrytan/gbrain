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

  test('Voyage voyage-4-large at $0.18/MTok (v0.35.1.0+)', () => {
    const r = lookupEmbeddingPrice('voyage:voyage-4-large');
    expect(r.kind).toBe('known');
    if (r.kind === 'known') expect(r.pricePerMTok).toBe(0.18);
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
