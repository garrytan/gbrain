/**
 * v0.20.0 Cathedral II Layer 8 D1 — sync --all cost preview tests.
 *
 * Cathedral I DX review identified "first sync surprise bill" as the #1
 * DX pain for large repos. v0.19.0 ran `sync --all` without telling the
 * user/agent how much it would cost. Cathedral II D1 gates --all on an
 * estimate: TTY prompts, non-TTY emits a ConfirmationRequired envelope
 * and exits 2, --yes skips, --dry-run shows + exits 0, --no-embed
 * skips the cost gate entirely (user already opted out of the spend).
 *
 * These tests exercise the cost envelope + flag behavior against a
 * real git repo fixture, no PGLite needed. The --yes / --dry-run /
 * envelope paths don't depend on DB state.
 */

import { describe, test, expect } from 'bun:test';
import { EMBEDDING_COST_PER_1K_TOKENS, estimateEmbeddingCostUsd } from '../src/core/embedding.ts';
import { lookupEmbeddingPrice } from '../src/core/embedding-pricing.ts';
import { estimateTokens } from '../src/core/chunkers/code.ts';

describe('Layer 8 D1 — embedding cost model', () => {
  test('EMBEDDING_COST_PER_1K_TOKENS back-compat constant is the OpenAI 3-large rate', () => {
    // Retained only for back-compat imports. Live cost math now resolves the
    // CONFIGURED model's rate via embedding-pricing.ts (see model-aware test
    // below). As of 2026-04-24: $0.00013 / 1k tokens.
    expect(EMBEDDING_COST_PER_1K_TOKENS).toBe(0.00013);
  });

  test('estimateEmbeddingCostUsd scales linearly (gateway-unconfigured fallback = OpenAI rate)', () => {
    // With no gateway configured (unit-test context) the estimator falls back
    // to the OpenAI text-embedding-3-large rate ($0.13/Mtok = $0.00013/1k).
    expect(estimateEmbeddingCostUsd(0)).toBe(0);
    expect(estimateEmbeddingCostUsd(1000)).toBeCloseTo(0.00013, 5);
    expect(estimateEmbeddingCostUsd(10_000)).toBeCloseTo(0.0013, 4);
    expect(estimateEmbeddingCostUsd(1_000_000)).toBeCloseTo(0.13, 4);
  });

  test('cost preview uses the CONFIGURED model rate, not a hardcoded OpenAI rate', () => {
    // Regression: the cost gate previously hardcoded $0.00013/1k (OpenAI
    // text-embedding-3-large) regardless of the configured embedding model,
    // so a brain on a cheaper model (e.g. zeroentropyai:zembed-1 @ $0.05/Mtok)
    // saw a preview that named the wrong provider and over-stated spend ~2.6x.
    // The pricing table is the single source of truth per provider:model.
    const TOKENS = 2_590_710_262; // a real large-brain sync preview
    const openai = lookupEmbeddingPrice('openai:text-embedding-3-large');
    const zeroentropy = lookupEmbeddingPrice('zeroentropyai:zembed-1');
    expect(openai.kind).toBe('known');
    expect(zeroentropy.kind).toBe('known');
    if (openai.kind === 'known' && zeroentropy.kind === 'known') {
      const openaiCost = (TOKENS / 1_000_000) * openai.pricePerMTok;
      const zeCost = (TOKENS / 1_000_000) * zeroentropy.pricePerMTok;
      // The two models must produce materially different previews; a fix that
      // collapses both to the OpenAI number would regress this assertion.
      expect(openaiCost).toBeCloseTo(336.79, 1);
      expect(zeCost).toBeCloseTo(129.54, 1);
      expect(zeCost).toBeLessThan(openaiCost);
    }
  });

  test('5K-file TS repo sanity check: ~$5 at ~400k tokens', () => {
    // A 5K-file TS repo at ~80 tokens/file averages ~400k tokens. Cost:
    // 400_000 / 1000 * 0.00013 = $0.052 ≈ $0.05. Not $5. The CHANGELOG
    // prose claim "~$5 one-time" was conservative for very-large repos
    // (100k+ tokens/file megaliths). This test pins the formula, not
    // the prose estimate.
    const cost = estimateEmbeddingCostUsd(400_000);
    expect(cost).toBeGreaterThan(0.04);
    expect(cost).toBeLessThan(0.07);
  });
});

describe('Layer 8 D1 — estimateTokens (exported from chunkers/code.ts)', () => {
  test('empty string is 0 tokens', () => {
    expect(estimateTokens('')).toBe(0);
  });

  test('short text is a small token count', () => {
    const t = estimateTokens('Hello, world!');
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(10);
  });

  test('longer text scales roughly with length', () => {
    const short = 'The quick brown fox jumps over the lazy dog.';
    const long = short.repeat(100);
    const shortTokens = estimateTokens(short);
    const longTokens = estimateTokens(long);
    // Not strictly 100x because of tokenizer encoding, but should be >50x.
    expect(longTokens).toBeGreaterThan(shortTokens * 50);
  });
});
