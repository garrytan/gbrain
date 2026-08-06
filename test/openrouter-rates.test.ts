/**
 * openrouter-rates: cache-backed router pricing (garrytan/gbrain#2504).
 *
 * The load-bearing property is that a failed fetch is a NON-EVENT — a stale
 * cache must keep serving, because refusing to spend on a network blip is the
 * exact failure class this module exists to remove.
 *
 * No network: `fetch` is stubbed per-test and GBRAIN_HOME points at a tmpdir so
 * the cache never touches a real ~/.gbrain.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readCachedRates,
  refreshOpenRouterRates,
  lookupOpenRouterChatPrice,
  lookupOpenRouterEmbeddingPrice,
  ratesAgeDays,
  ratesNeedRefresh,
  ratesCachePath,
  routerTail,
  RATES_SCHEMA_VERSION,
  _resetRatesMemo,
} from '../src/core/openrouter-rates.ts';
import { estimateMaxCostUsd } from '../src/core/anthropic-pricing.ts';
import { lookupEmbeddingPrice } from '../src/core/embedding-pricing.ts';
import { isModelPriceable, BudgetTracker } from '../src/core/budget/budget-tracker.ts';

let home: string;
const realFetch = globalThis.fetch;

function seedCache(cache: unknown): void {
  const p = ratesCachePath();
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(p, JSON.stringify(cache), 'utf8');
  _resetRatesMemo();
}

/** Stub both catalogue endpoints. `null` for either simulates a failed fetch. */
function stubFetch(chat: unknown | null, embed: unknown | null): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    const body = u.includes('/embeddings/models') ? embed : chat;
    if (body === null) throw new Error('network down');
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-rates-'));
  process.env.GBRAIN_HOME = home;
  _resetRatesMemo();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GBRAIN_HOME;
  rmSync(home, { recursive: true, force: true });
  _resetRatesMemo();
});

describe('routerTail', () => {
  test.each([
    ['openrouter:openai/gpt-5.2', 'openai/gpt-5.2'],
    ['openrouter/openai/gpt-5.2', 'openai/gpt-5.2'],   // slash form (#1540/#1698)
    ['OpenRouter:openai/gpt-5.2', 'openai/gpt-5.2'],   // case-insensitive
  ])('%s → %s', (input, expected) => {
    expect(routerTail(input)).toBe(expected);
  });

  test.each([
    ['openai:gpt-5.2'],
    ['claude-haiku-4-5'],        // bare id: provider is null, must not throw
    ['anthropic:claude-haiku-4-5'],
    ['openrouter:'],             // empty tail
  ])('%s is not a router id', (input) => {
    expect(routerTail(input)).toBeNull();
  });
});

describe('cache read', () => {
  test('missing cache reads null and never throws', () => {
    expect(readCachedRates()).toBeNull();
    expect(ratesAgeDays()).toBeNull();
    expect(ratesNeedRefresh()).toBe(true);
  });

  test('malformed JSON degrades to null rather than throwing', () => {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(ratesCachePath(), '{not json', 'utf8');
    _resetRatesMemo();
    expect(readCachedRates()).toBeNull();
  });

  test('schema mismatch is treated as no cache', () => {
    seedCache({ schema_version: RATES_SCHEMA_VERSION + 99, fetched_at: new Date().toISOString(), chat: {}, embedding: {} });
    expect(readCachedRates()).toBeNull();
  });

  test('a stale cache is still served — age never invalidates', () => {
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    seedCache({
      schema_version: RATES_SCHEMA_VERSION,
      fetched_at: old,
      chat: { 'openai/gpt-5.2': { input: 1.75, output: 14 } },
      embedding: {},
    });
    expect(lookupOpenRouterChatPrice('openrouter:openai/gpt-5.2')).toEqual({ input: 1.75, output: 14 });
    expect(ratesAgeDays()!).toBeGreaterThan(365);
    expect(ratesNeedRefresh(7)).toBe(true); // flagged as stale…
  });
});

describe('refresh', () => {
  test('populates the cache from both catalogues, normalizing per-token → per-MTok', async () => {
    stubFetch(
      { data: [{ id: 'openai/gpt-5.2', pricing: { prompt: '0.00000175', completion: '0.000014' } }] },
      { data: [{ id: 'openai/text-embedding-3-small', pricing: { prompt: '0.00000002', completion: '0' } }] },
    );
    const r = await refreshOpenRouterRates({ timeoutMs: 500 });
    expect(r.ok).toBe(true);
    expect(r.chatCount).toBe(1);
    expect(r.embeddingCount).toBe(1);

    expect(lookupOpenRouterChatPrice('openrouter:openai/gpt-5.2')).toEqual({ input: 1.75, output: 14 });
    expect(lookupOpenRouterEmbeddingPrice('openrouter:openai/text-embedding-3-small')).toBeCloseTo(0.02, 10);
  });

  test('total fetch failure leaves an existing cache untouched', async () => {
    seedCache({
      schema_version: RATES_SCHEMA_VERSION,
      fetched_at: new Date().toISOString(),
      chat: { 'openai/gpt-5.2': { input: 1.75, output: 14 } },
      embedding: { 'openai/text-embedding-3-small': 0.02 },
    });
    stubFetch(null, null);

    const r = await refreshOpenRouterRates({ timeoutMs: 500 });
    expect(r.ok).toBe(false);

    _resetRatesMemo();
    expect(lookupOpenRouterChatPrice('openrouter:openai/gpt-5.2')).toEqual({ input: 1.75, output: 14 });
    expect(lookupOpenRouterEmbeddingPrice('openrouter:openai/text-embedding-3-small')).toBe(0.02);
  });

  test('half failure keeps the other half from the previous cache', async () => {
    seedCache({
      schema_version: RATES_SCHEMA_VERSION,
      fetched_at: new Date().toISOString(),
      chat: { 'openai/gpt-5.2': { input: 1.75, output: 14 } },
      embedding: { 'openai/text-embedding-3-small': 0.02 },
    });
    // chat OK, embeddings down — embedding rates must survive, or capped
    // enrich runs re-break on the very id this was built for.
    stubFetch({ data: [{ id: 'openai/gpt-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } }] }, null);

    const r = await refreshOpenRouterRates({ timeoutMs: 500 });
    expect(r.ok).toBe(true);
    expect(lookupOpenRouterChatPrice('openrouter:openai/gpt-4o')).toEqual({ input: 2.5, output: 10 });
    expect(lookupOpenRouterEmbeddingPrice('openrouter:openai/text-embedding-3-small')).toBe(0.02);
  });

  test('an empty-but-200 catalogue does not clobber a good cache', async () => {
    seedCache({
      schema_version: RATES_SCHEMA_VERSION,
      fetched_at: new Date().toISOString(),
      chat: { 'openai/gpt-5.2': { input: 1.75, output: 14 } },
      embedding: {},
    });
    stubFetch({ data: [] }, { data: [] });

    const r = await refreshOpenRouterRates({ timeoutMs: 500 });
    expect(r.ok).toBe(false);
    _resetRatesMemo();
    expect(lookupOpenRouterChatPrice('openrouter:openai/gpt-5.2')).toEqual({ input: 1.75, output: 14 });
  });

  test('free models (rate 0) are kept, not skipped as falsy', async () => {
    stubFetch(
      { data: [{ id: 'nvidia/nemotron:free', pricing: { prompt: '0', completion: '0' } }] },
      { data: [] },
    );
    await refreshOpenRouterRates({ timeoutMs: 500 });
    expect(lookupOpenRouterChatPrice('openrouter:nvidia/nemotron:free')).toEqual({ input: 0, output: 0 });
  });

  test('cache file is written with the declared schema version', async () => {
    stubFetch(
      { data: [{ id: 'openai/gpt-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } }] },
      { data: [] },
    );
    await refreshOpenRouterRates({ timeoutMs: 500 });
    expect(existsSync(ratesCachePath())).toBe(true);
    const onDisk = JSON.parse(readFileSync(ratesCachePath(), 'utf8'));
    expect(onDisk.schema_version).toBe(RATES_SCHEMA_VERSION);
    expect(typeof onDisk.fetched_at).toBe('string');
  });
});

describe('integration with the pricing lookups', () => {
  test('router chat id prices from cache, and is NOT aliased to the vendor rate', () => {
    // Cached router rate is deliberately different from Anthropic's direct rate
    // so an alias bug would be visible rather than coincidentally correct.
    seedCache({
      schema_version: RATES_SCHEMA_VERSION,
      fetched_at: new Date().toISOString(),
      chat: { 'anthropic/claude-sonnet-4-6': { input: 9, output: 45 } },
      embedding: {},
    });
    // 1M input at $9/MTok = $9.00 (direct Anthropic rate would give $3.00).
    expect(estimateMaxCostUsd('openrouter:anthropic/claude-sonnet-4-6', 1_000_000, 0)).toBeCloseTo(9, 6);
  });

  test('uncached router id stays null — TX2 refusal preserved', () => {
    expect(estimateMaxCostUsd('openrouter:anthropic/claude-sonnet-4-6', 1_000, 1_000)).toBeNull();
    expect(estimateMaxCostUsd('openrouter:openai/gpt-5.2', 1_000, 1_000)).toBeNull();
  });

  test('direct (non-router) ids are unaffected by the cache', () => {
    seedCache({
      schema_version: RATES_SCHEMA_VERSION,
      fetched_at: new Date().toISOString(),
      chat: { 'anthropic/claude-sonnet-4-6': { input: 9, output: 45 } },
      embedding: {},
    });
    // Sonnet 4.6 direct = $3/MTok input; the router entry must not leak here.
    expect(estimateMaxCostUsd('claude-sonnet-4-6', 1_000_000, 0)).toBeCloseTo(3, 6);
  });

  test('router embedding id prices from cache, overriding the bundled constant', () => {
    seedCache({
      schema_version: RATES_SCHEMA_VERSION,
      fetched_at: new Date().toISOString(),
      chat: {},
      embedding: { 'openai/text-embedding-3-small': 0.05 }, // deliberately ≠ bundled 0.02
    });
    const r = lookupEmbeddingPrice('openrouter:openai/text-embedding-3-small');
    expect(r.kind).toBe('known');
    if (r.kind === 'known') expect(r.pricePerMTok).toBe(0.05);
  });

  test('bundled embedding constants still resolve with no cache present', () => {
    const r = lookupEmbeddingPrice('openai:text-embedding-3-small');
    expect(r.kind).toBe('known');
    if (r.kind === 'known') expect(r.pricePerMTok).toBe(0.02);
  });
});

/**
 * BudgetTracker resolves chat pricing through its OWN `lookupPricing`, not
 * through `estimateMaxCostUsd`. Wiring only the latter left capped runs still
 * failing on router ids — the embedding half worked purely because
 * `lookupPricing` delegates to `lookupEmbeddingPrice`. These pin the gate
 * itself so the two paths can't drift apart again.
 */
describe('budget gate (isModelPriceable) — the path that actually gates spend', () => {
  test('router chat id is priceable once cached', () => {
    seedCache({
      schema_version: RATES_SCHEMA_VERSION,
      fetched_at: new Date().toISOString(),
      chat: { 'deepseek/deepseek-v4-flash-0731': { input: 0.09, output: 0.18 } },
      embedding: {},
    });
    expect(isModelPriceable('openrouter:deepseek/deepseek-v4-flash-0731', 'chat')).toBe(true);
  });

  test('uncached router chat id is NOT priceable — TX2 refusal preserved', () => {
    expect(isModelPriceable('openrouter:deepseek/deepseek-v4-flash-0731', 'chat')).toBe(false);
  });

  test('a cached router id never resolves to the vendor rate', () => {
    seedCache({
      schema_version: RATES_SCHEMA_VERSION,
      fetched_at: new Date().toISOString(),
      chat: { 'anthropic/claude-sonnet-4-6': { input: 9, output: 45 } },
      embedding: {},
    });
    // Direct Sonnet is $3/MTok; the router entry is $9. Anything but 9 means
    // the id leaked into a vendor-priced path.
    const tracker = new BudgetTracker({ maxCostUsd: 100, label: 'test' });
    tracker.reserve({
      modelId: 'openrouter:anthropic/claude-sonnet-4-6',
      estimatedInputTokens: 1_000_000,
      maxOutputTokens: 0,
      kind: 'chat',
    });
    tracker.record({
      modelId: 'openrouter:anthropic/claude-sonnet-4-6',
      inputTokens: 1_000_000,
      outputTokens: 0,
    }, 'chat');
    expect(tracker.totalSpent).toBeCloseTo(9, 6);
  });

  test('non-Anthropic canonical ids were already priceable (regression guard)', () => {
    // These resolve via canonicalLookup inside lookupPricing and must keep
    // working with no cache present.
    for (const id of ['openai:gpt-5.2', 'deepseek:deepseek-chat', 'google:gemini-2.0-flash']) {
      expect(isModelPriceable(id, 'chat')).toBe(true);
    }
  });
});
