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

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  EMBEDDING_COST_PER_1K_TOKENS,
  estimateEmbeddingCostUsd,
  willEmbedSynchronously,
  shouldBlockSync,
} from '../src/core/embedding.ts';
import { lookupEmbeddingPrice } from '../src/core/embedding-pricing.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { estimateTokens } from '../src/core/chunkers/code.ts';
import {
  parseUsdLimit,
  formatUsdLimit,
  usdLimitToCap,
  normalizeSpendPosture,
  isValidSpendPosture,
} from '../src/core/spend-posture.ts';

describe('Layer 8 D1 — embedding cost model', () => {
  // The estimateEmbeddingCostUsd tests assert the gateway-UNCONFIGURED OpenAI
  // fallback ($0.13/Mtok). That fallback only fires when no gateway is
  // configured — so guarantee that precondition rather than depending on
  // ambient state. Without this, a sibling test file in the same shard that
  // configured (and didn't reset) a cheaper model leaks its rate in here and
  // these assertions flip (the legacy-embedding preload only restores when the
  // gateway slot is EMPTY, so a non-empty foreign config survives).
  beforeEach(() => resetGateway());


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

describe('v0.41.31 — willEmbedSynchronously (embed-mode resolver)', () => {
  // Mirrors sync.ts:2346 effectiveNoEmbed = v2 && !serial && !noEmbed ? true : noEmbed.
  // Embed runs INLINE iff that resolves to false.
  test('v2 off → inline (legacy synchronous embed)', () => {
    expect(willEmbedSynchronously({ v2Enabled: false, serialFlag: false, noEmbed: false })).toBe('inline');
  });
  test('v2 on + parallel → deferred (backfill jobs)', () => {
    expect(willEmbedSynchronously({ v2Enabled: true, serialFlag: false, noEmbed: false })).toBe('deferred');
  });
  test('v2 on + --serial → inline', () => {
    expect(willEmbedSynchronously({ v2Enabled: true, serialFlag: true, noEmbed: false })).toBe('inline');
  });
  test('--no-embed forces deferred regardless of v2/serial', () => {
    expect(willEmbedSynchronously({ v2Enabled: false, serialFlag: false, noEmbed: true })).toBe('deferred');
    expect(willEmbedSynchronously({ v2Enabled: true, serialFlag: true, noEmbed: true })).toBe('deferred');
  });
});

describe('v0.41.31 — shouldBlockSync (cost-gate decision)', () => {
  // R-1: deferred NEVER blocks, even at absurd cost (the headline fix — a
  // nightly cron over a synced corpus must not exit 2).
  test('R-1: deferred never blocks, even at $999', () => {
    expect(shouldBlockSync(999, 0.5, 'deferred')).toBe(false);
    expect(shouldBlockSync(0, 0.5, 'deferred')).toBe(false);
  });
  // R-2: inline still blocks above the floor (protection preserved where
  // sync actually spends synchronously).
  test('R-2: inline blocks above floor', () => {
    expect(shouldBlockSync(0.51, 0.5, 'inline')).toBe(true);
    expect(shouldBlockSync(130, 0.5, 'inline')).toBe(true);
  });
  test('inline at exactly the floor does NOT block (boundary)', () => {
    expect(shouldBlockSync(0.5, 0.5, 'inline')).toBe(false);
  });
  test('inline below floor does not block (kills cents-level cron noise)', () => {
    expect(shouldBlockSync(0.03, 0.5, 'inline')).toBe(false);
    expect(shouldBlockSync(0, 0.5, 'inline')).toBe(false);
  });
  test('floor of 0 makes inline block on any nonzero cost', () => {
    expect(shouldBlockSync(0.0001, 0, 'inline')).toBe(true);
    expect(shouldBlockSync(0, 0, 'inline')).toBe(false);
  });

  // v0.42.42.0 (#2139): posture + Infinity-floor behavior.
  test('spend.posture=tokenmax never blocks, even above floor', () => {
    expect(shouldBlockSync(999, 0.5, 'inline', 'tokenmax')).toBe(false);
    expect(shouldBlockSync(999, 0, 'inline', 'tokenmax')).toBe(false);
  });
  test('default posture (gated) preserves the legacy decision', () => {
    expect(shouldBlockSync(0.51, 0.5, 'inline', 'gated')).toBe(true);
    expect(shouldBlockSync(0.03, 0.5, 'inline', 'gated')).toBe(false);
  });
  test('off/unlimited floor (Infinity) is never exceeded → never blocks', () => {
    expect(shouldBlockSync(999, Infinity, 'inline')).toBe(false);
    expect(shouldBlockSync(1e9, Infinity, 'inline', 'gated')).toBe(false);
  });
});

describe('v0.42.42.0 (#2139) — spend-posture USD-limit parsing', () => {
  test('off / unlimited / none (case-insensitive) → Infinity', () => {
    for (const v of ['off', 'OFF', 'unlimited', 'Unlimited', 'none', 'NONE', '  off  ']) {
      expect(parseUsdLimit(v, 25)).toBe(Infinity);
    }
  });
  test('finite positive numbers pass through', () => {
    expect(parseUsdLimit('5', 25)).toBe(5);
    expect(parseUsdLimit(0.5, 25)).toBe(0.5);
    expect(parseUsdLimit('100000', 25)).toBe(100000);
  });
  test('0 falls back to default unless allowZero', () => {
    expect(parseUsdLimit('0', 25)).toBe(25); // backfill cap: off ≠ 0
    expect(parseUsdLimit('0', 0.5, { allowZero: true })).toBe(0); // floor: 0 = block-on-any
  });
  test('garbage / negative / empty / null → default', () => {
    expect(parseUsdLimit('abc', 25)).toBe(25);
    expect(parseUsdLimit('-3', 25)).toBe(25);
    expect(parseUsdLimit('', 25)).toBe(25);
    expect(parseUsdLimit(null, 25)).toBe(25);
    expect(parseUsdLimit(undefined, 0.5)).toBe(0.5);
  });
  test('formatUsdLimit: Infinity → "unlimited" (never the JSON.stringify=null trap), finite passthrough', () => {
    expect(formatUsdLimit(Infinity)).toBe('unlimited');
    expect(formatUsdLimit(5)).toBe(5);
    expect(formatUsdLimit(0)).toBe(0);
    // The trap this guards: raw Infinity serializes to null.
    expect(JSON.stringify({ cap: Infinity })).toBe('{"cap":null}');
    expect(JSON.stringify({ cap: formatUsdLimit(Infinity) })).toBe('{"cap":"unlimited"}');
  });
  test('usdLimitToCap: Infinity → undefined (no cap), finite passthrough', () => {
    expect(usdLimitToCap(Infinity)).toBeUndefined();
    expect(usdLimitToCap(10)).toBe(10);
  });
  test('normalizeSpendPosture: only tokenmax is tokenmax; everything else gated', () => {
    expect(normalizeSpendPosture('tokenmax')).toBe('tokenmax');
    expect(normalizeSpendPosture('TokenMax')).toBe('tokenmax');
    expect(normalizeSpendPosture('gated')).toBe('gated');
    expect(normalizeSpendPosture('max')).toBe('gated');
    expect(normalizeSpendPosture('')).toBe('gated');
    expect(normalizeSpendPosture(null)).toBe('gated');
    expect(normalizeSpendPosture(42)).toBe('gated');
  });
  test('isValidSpendPosture accepts gated/tokenmax (case-insensitive), rejects the rest', () => {
    expect(isValidSpendPosture('gated')).toBe(true);
    expect(isValidSpendPosture('tokenmax')).toBe(true);
    expect(isValidSpendPosture('TokenMax')).toBe(true); // normalized lowercase
    expect(isValidSpendPosture('max')).toBe(false);
    expect(isValidSpendPosture('')).toBe(false);
    expect(isValidSpendPosture(7)).toBe(false);
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
