/**
 * v0.46.3 — Voyage reranker touchpoint + canonical-model recipe contract.
 *
 * Pins:
 *  - The voyage recipe declares a reranker touchpoint: the rerank-2.5 pair
 *    (rerank-2.5 default) + the preview rerank-3 pair, POST path '/rerank'
 *    (base_url_default already ends in /v1 — no /v1/v1 doubling), request
 *    top-N key `top_k` via `top_param`.
 *  - #4938: rerank-3 / rerank-3-lite are in the allowlist (both the gateway's
 *    runtime check and `gbrain models doctor`'s reranker_config probe read
 *    this same array) while default_model stays rerank-2.5 — adding a model
 *    must not move existing installs onto it.
 *  - `default_model: 'voyage-4'` on the embedding touchpoint — array order is
 *    quality-sorted (voyage-4-large first) and must NOT drive selection.
 *  - voyage-code-4 is in the embedding models AND in the flexible-dims set.
 *  - The zeroentropyai recipe carries `sunset` metadata with per-touchpoint
 *    replacements pointing at the voyage models.
 *  - Pricing rows exist for the voyage rerankers (budget-tracker's rerank
 *    metering falls back to the embedding pricing table).
 */

import { describe, test, expect } from 'bun:test';
import { voyage } from '../../src/core/ai/recipes/voyage.ts';
import { zeroentropyai } from '../../src/core/ai/recipes/zeroentropyai.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { EMBEDDING_PRICING, lookupEmbeddingPrice } from '../../src/core/embedding-pricing.ts';
import { supportsVoyageOutputDimension } from '../../src/core/ai/dims.ts';
import {
  NEW_INSTALL_DEFAULT_EMBEDDING_MODEL,
  NEW_INSTALL_DEFAULT_RERANKER_MODEL,
} from '../../src/core/ai/defaults.ts';

describe('voyage reranker touchpoint (v0.46.3)', () => {
  test('declares rerank-2.5 as the default reranker at /rerank with top_k', () => {
    const tp = voyage.touchpoints.reranker;
    expect(tp).toBeDefined();
    expect(tp!.models).toEqual(['rerank-2.5', 'rerank-2.5-lite', 'rerank-3', 'rerank-3-lite']);
    expect(tp!.default_model).toBe('rerank-2.5');
    expect(tp!.path).toBe('/rerank');
    expect(tp!.top_param).toBe('top_k');
    expect(tp!.max_payload_bytes).toBeGreaterThan(0);
  });

  test('base URL + path compose without /v1/v1 doubling', () => {
    const url = `${voyage.base_url_default!.replace(/\/$/, '')}${voyage.touchpoints.reranker!.path}`;
    expect(url).toBe('https://api.voyageai.com/v1/rerank');
  });

  test('registry resolves the same recipe object', () => {
    expect(getRecipe('voyage')?.touchpoints.reranker?.default_model).toBe('rerank-2.5');
  });
});

describe('voyage rerank-3 allowlist (#4938)', () => {
  // Both enforcement points — gateway.rerank()'s `tp.models.includes(...)`
  // guard and `gbrain models doctor`'s reranker_config probe — read this one
  // array, so listing the model here is what unblocks
  // `gbrain config set search.reranker.model voyage:rerank-3`.
  test('rerank-3 and rerank-3-lite are in the reranker allowlist', () => {
    const models = voyage.touchpoints.reranker!.models;
    expect(models).toContain('rerank-3');
    expect(models).toContain('rerank-3-lite');
  });

  test('the registry copy carries them too (the object doctor + gateway resolve)', () => {
    const models = getRecipe('voyage')!.touchpoints.reranker!.models;
    expect(models).toContain('rerank-3');
    expect(models).toContain('rerank-3-lite');
  });

  test('adding rerank-3 does NOT move the default off rerank-2.5', () => {
    // Flipping default_model would silently migrate every install that
    // resolves the recipe default instead of an explicit config row.
    expect(voyage.touchpoints.reranker!.default_model).toBe('rerank-2.5');
    expect(NEW_INSTALL_DEFAULT_RERANKER_MODEL).toBe('voyage:rerank-2.5');
  });

  test('the 2.5 pair is retained, not replaced', () => {
    const models = voyage.touchpoints.reranker!.models;
    expect(models).toContain('rerank-2.5');
    expect(models).toContain('rerank-2.5-lite');
  });

  test('wire shape is unchanged — rerank-3 rides the same path + top_param', () => {
    const tp = voyage.touchpoints.reranker!;
    expect(tp.path).toBe('/rerank');
    expect(tp.top_param).toBe('top_k');
  });
});

describe('voyage canonical embedding model (v0.46.3)', () => {
  test('default_model is voyage-4, NOT models[0] (voyage-4-large)', () => {
    const tp = voyage.touchpoints.embedding!;
    expect(tp.default_model).toBe('voyage-4');
    expect(tp.models[0]).toBe('voyage-4-large');
    expect(tp.models).toContain('voyage-4');
  });

  test('voyage-code-4 is listed and in the flexible-dims set', () => {
    expect(voyage.touchpoints.embedding!.models).toContain('voyage-code-4');
    expect(supportsVoyageOutputDimension('voyage-code-4')).toBe(true);
    // The open-weight nano stays excluded (existing contract).
    expect(supportsVoyageOutputDimension('voyage-4-nano')).toBe(false);
  });

  test('new-install default constants point at voyage', () => {
    expect(NEW_INSTALL_DEFAULT_EMBEDDING_MODEL).toBe('voyage:voyage-4');
    expect(NEW_INSTALL_DEFAULT_RERANKER_MODEL).toBe('voyage:rerank-2.5');
  });
});

describe('zeroentropyai sunset metadata (v0.46.3)', () => {
  test('recipe carries sunset date + per-touchpoint replacements', () => {
    expect(zeroentropyai.sunset).toBeDefined();
    expect(zeroentropyai.sunset!.date).toBe('2026-09-04');
    expect(zeroentropyai.sunset!.replacement?.embedding).toBe('voyage:voyage-4');
    expect(zeroentropyai.sunset!.replacement?.reranker).toBe('voyage:rerank-2.5');
  });

  test('voyage carries NO sunset (it is the replacement, not the deprecated)', () => {
    expect(voyage.sunset).toBeUndefined();
  });
});

describe('voyage reranker pricing rows (v0.46.3)', () => {
  test('rerank-2.5 + rerank-2.5-lite are priced (budget-tracker fallback)', () => {
    expect(EMBEDDING_PRICING['voyage:rerank-2.5']?.pricePerMTok).toBe(0.05);
    expect(EMBEDDING_PRICING['voyage:rerank-2.5-lite']?.pricePerMTok).toBe(0.02);
    expect(EMBEDDING_PRICING['voyage:voyage-code-4']?.pricePerMTok).toBe(0.12);
  });

  test('#4938: every allowlisted reranker resolves a price (no TX2 no_pricing)', () => {
    // lookupPricing(kind: 'rerank') falls through to the embedding table; a
    // miss returns null and `--max-cost` callers hard-fail with no_pricing.
    // An allowlisted-but-unpriced model would make the fix a new footgun.
    for (const m of voyage.touchpoints.reranker!.models) {
      const hit = lookupEmbeddingPrice(`voyage:${m}`);
      expect(hit.kind).toBe('known');
    }
  });

  test('#4938: rerank-3 pair carries the post-free-tier list rate', () => {
    // Priced at the list rate, NOT 0: the 200M complimentary grant is
    // per-account and unknowable from here, so over-reporting inside the
    // grant beats under-reporting past it.
    expect(EMBEDDING_PRICING['voyage:rerank-3']?.pricePerMTok).toBe(0.05);
    expect(EMBEDDING_PRICING['voyage:rerank-3-lite']?.pricePerMTok).toBe(0.02);
  });
});
