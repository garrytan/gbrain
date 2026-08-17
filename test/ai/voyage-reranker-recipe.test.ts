/**
 * v0.46.3 — Voyage reranker touchpoint + canonical-model recipe contract.
 *
 * Pins:
 *  - The voyage recipe declares a reranker touchpoint: rerank-2.5 (default) +
 *    rerank-2.5-lite, POST path '/rerank' (base_url_default already ends in
 *    /v1 — no /v1/v1 doubling), request top-N key `top_k` via `top_param`.
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
import { EMBEDDING_PRICING } from '../../src/core/embedding-pricing.ts';
import { supportsVoyageOutputDimension } from '../../src/core/ai/dims.ts';
import {
  NEW_INSTALL_DEFAULT_EMBEDDING_MODEL,
  NEW_INSTALL_DEFAULT_RERANKER_MODEL,
} from '../../src/core/ai/defaults.ts';

describe('voyage reranker touchpoint (v0.46.3)', () => {
  test('declares rerank-2.5 as the default reranker at /rerank with top_k', () => {
    const tp = voyage.touchpoints.reranker;
    expect(tp).toBeDefined();
    expect(tp!.models).toEqual(['rerank-2.5', 'rerank-2.5-lite']);
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
});
