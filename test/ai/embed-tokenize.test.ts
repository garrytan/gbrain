/**
 * Exact token counts from the embedding backend's own tokenizer
 * (llama-server's /tokenize + /detokenize).
 *
 * Pins, in order:
 *   - the llama-server recipe declares the endpoints;
 *   - countTokens answers positional exact counts, joins the path onto the
 *     server ROOT (/v1/tokenize is a 404 on llama.cpp), and caches per text;
 *   - every failure (reject, 404, non-JSON, malformed body) is all-or-nothing:
 *     countTokens returns null, and embed() then plans exactly like the
 *     chars_per_token estimate — byte for byte;
 *   - measured counts drive the sub-batch split where the estimate would not;
 *   - truncateTextToTokens cuts at a token boundary and returns the
 *     detokenized prefix;
 *   - a recipe that declares no tokenizer issues no extra request at all.
 *
 * fetch is stubbed per test (no network); the gateway's embedding transport is
 * the __setEmbedTransportForTests seam.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { __setEmbedTransportForTests, configureGateway, embed, resetGateway } from '../../src/core/ai/gateway.ts';
import { __clearTokenizeCacheForTests, countTokens, truncateTextToTokens } from '../../src/core/ai/embed-tokenize.ts';
import { planEmbedRequests } from '../../src/core/ai/embed-batch-plan.ts';
import { __setTestRecipesForTests } from '../../src/core/ai/recipes/index.ts';
import { llamaServer } from '../../src/core/ai/recipes/llama-server.ts';
import type { EmbeddingTouchpoint, Recipe } from '../../src/core/ai/types.ts';

const BASE_URL = 'http://127.0.0.1:8084/v1';
const TOKENIZER = { path: '/tokenize', detokenizer: '/detokenize', add_special: false };
const DIMS = 4;
const MODEL_ID = 'synthetic-embed-1';

const TOKENIZER_RECIPE_ID = 'synthetic-tokenizer';
const ESTIMATE_RECIPE_ID = 'synthetic-estimate';

/** A local-server recipe whose only variable part is the embedding touchpoint. */
function makeRecipe(id: string, embedding: Partial<EmbeddingTouchpoint>): Recipe {
  return {
    id,
    name: `${id} (test fixture)`,
    tier: 'openai-compat',
    implementation: 'openai-compatible',
    touchpoints: {
      embedding: { models: [MODEL_ID], default_dims: DIMS, ...embedding },
    },
  };
}

// 100 budget tokens × the default 0.8 safety factor = 80 per sub-batch. Each
// text is 5 characters, so the estimate charges 2 tokens apiece (4 for the
// pair) and one batch fits; the measured counts below charge 50 each and force
// a split.
const BATCH_TOKENS = 100;
const TEXT_TO_TOKENS: Record<string, number> = { alpha: 50, beta: 50 };
const LONG_TEXT = 'long';
const LONG_TEXT_IDS = Array.from({ length: 20 }, (_, i) => i + 1);
const TRUNCATED_TEXT = 'long-prefix';

const TOKENIZER_RECIPE = makeRecipe(TOKENIZER_RECIPE_ID, {
  max_batch_tokens: BATCH_TOKENS,
  chars_per_token: 4,
  tokenizer: TOKENIZER,
});

const ESTIMATE_RECIPE = makeRecipe(ESTIMATE_RECIPE_ID, {
  max_batch_tokens: BATCH_TOKENS,
  chars_per_token: 4,
});

// --------- fetch + transport stubs ---------

interface StubbedRequest {
  url: string;
  body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;
let requests: StubbedRequest[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Answer /tokenize from TEXT_TO_TOKENS and /detokenize with TRUNCATED_TEXT. */
function stubTokenizerServer(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push({ url, body });
    if (url.endsWith('/tokenize')) {
      if (body.content === LONG_TEXT) return jsonResponse({ tokens: LONG_TEXT_IDS });
      const count = TEXT_TO_TOKENS[String(body.content)] ?? 1;
      return jsonResponse({ tokens: Array.from({ length: count }, (_, i) => i) });
    }
    if (url.endsWith('/detokenize')) return jsonResponse({ content: TRUNCATED_TEXT });
    return jsonResponse({ error: 'not found' }, 404);
  }) as unknown as typeof fetch;
}

/** Batches the embedding transport actually received, in dispatch order. */
let batches: string[][] = [];

function stubEmbedTransport(): void {
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    batches.push([...values]);
    return { values, embeddings: values.map(() => Array(DIMS).fill(0.1)), usage: { tokens: values.length }, warnings: [] };
  }) as any);
}

function configure(recipe: Recipe): void {
  __setTestRecipesForTests([recipe]);
  configureGateway({
    embedding_model: `${recipe.id}:${MODEL_ID}`,
    embedding_dimensions: DIMS,
    base_urls: { [recipe.id]: BASE_URL },
    env: {},
  });
}

beforeEach(() => {
  __clearTokenizeCacheForTests();
  requests = [];
  batches = [];
  stubEmbedTransport();
});

afterEach(() => {
  __setEmbedTransportForTests(null);
  __setTestRecipesForTests([]);
  resetGateway();
  globalThis.fetch = realFetch;
});

// --------- the recipe ---------

describe('llama-server tokenizer declaration', () => {
  test('the llama-server recipe points at the server root endpoints', () => {
    expect(llamaServer.touchpoints.embedding?.tokenizer).toEqual({
      path: '/tokenize',
      detokenizer: '/detokenize',
      add_special: false,
    });
  });

  test('the recipe declares no per-input cap, so no truncation is attempted', () => {
    expect(llamaServer.touchpoints.embedding?.max_input_tokens).toBeUndefined();
  });
});

// --------- countTokens ---------

describe('countTokens', () => {
  test('returns one exact count per text, in order', async () => {
    stubTokenizerServer();
    const counts = await countTokens(['alpha', 'beta', 'gamma'], { baseUrl: BASE_URL, tokenizer: TOKENIZER });
    expect(counts).toEqual([50, 50, 1]);
  });

  test('posts to the server root, not the /v1 mount, with add_special false', async () => {
    stubTokenizerServer();
    await countTokens(['alpha'], { baseUrl: BASE_URL, tokenizer: TOKENIZER });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('http://127.0.0.1:8084/tokenize');
    expect(requests[0]!.body).toEqual({ content: 'alpha', add_special: false });
  });

  test('a second call with the same texts issues no extra request', async () => {
    stubTokenizerServer();
    const first = await countTokens(['alpha', 'beta'], { baseUrl: BASE_URL, tokenizer: TOKENIZER });
    const afterFirst = requests.length;
    const second = await countTokens(['alpha', 'beta'], { baseUrl: BASE_URL, tokenizer: TOKENIZER });
    expect(second).toEqual(first);
    expect(requests.length).toBe(afterFirst);
  });

  test('a 404 on any text makes the whole call return null', async () => {
    stubTokenizerServer();
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      return url.endsWith('/tokenize') ? jsonResponse({ error: 'not found' }, 404) : jsonResponse({});
    }) as unknown as typeof fetch;
    expect(await countTokens(['alpha', 'beta'], { baseUrl: BASE_URL, tokenizer: TOKENIZER })).toBeNull();
  });

  test('a rejecting fetch makes the whole call return null', async () => {
    globalThis.fetch = (async () => { throw new TypeError('connection refused'); }) as unknown as typeof fetch;
    expect(await countTokens(['alpha'], { baseUrl: BASE_URL, tokenizer: TOKENIZER })).toBeNull();
  });

  test('a malformed or non-JSON body makes the whole call return null', async () => {
    globalThis.fetch = (async () => jsonResponse({ tokens: ['not-a-number'] })) as unknown as typeof fetch;
    expect(await countTokens(['alpha'], { baseUrl: BASE_URL, tokenizer: TOKENIZER })).toBeNull();
    globalThis.fetch = (async () => new Response('gateway timeout', { status: 200 })) as unknown as typeof fetch;
    expect(await countTokens(['alpha'], { baseUrl: BASE_URL, tokenizer: TOKENIZER })).toBeNull();
  });

  test('keeps at most 8 tokenize requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    globalThis.fetch = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return jsonResponse({ tokens: [1, 2, 3] });
    }) as unknown as typeof fetch;
    const texts = Array.from({ length: 20 }, (_, i) => `text-${i}`);
    expect(await countTokens(texts, { baseUrl: BASE_URL, tokenizer: TOKENIZER })).toEqual(texts.map(() => 3));
    expect(peak).toBe(8);
  });
});

// --------- truncateTextToTokens ---------

describe('truncateTextToTokens', () => {
  test('cuts an over-cap text at a token boundary and returns the detokenized prefix', async () => {
    stubTokenizerServer();
    const cut = await truncateTextToTokens(LONG_TEXT, 5, { baseUrl: BASE_URL, tokenizer: TOKENIZER });
    expect(cut).toBe(TRUNCATED_TEXT);
    const detokenize = requests.find(request => request.url.endsWith('/detokenize'));
    expect(detokenize?.body).toEqual({ tokens: [1, 2, 3, 4, 5] });
  });

  test('a text already inside the cap comes back unchanged, with no detokenize call', async () => {
    stubTokenizerServer();
    const cut = await truncateTextToTokens('alpha', 50, { baseUrl: BASE_URL, tokenizer: TOKENIZER });
    expect(cut).toBe('alpha');
    expect(requests.some(request => request.url.endsWith('/detokenize'))).toBe(false);
  });

  test('no declared detokenizer means no truncation', async () => {
    stubTokenizerServer();
    const cut = await truncateTextToTokens(LONG_TEXT, 5, { baseUrl: BASE_URL, tokenizer: { path: '/tokenize' } });
    expect(cut).toBeNull();
    expect(requests).toHaveLength(0);
  });
});

// --------- the split ---------

describe('measured counts drive the batch split', () => {
  test('the same two texts split in two under measured counts and stay one under the estimate', async () => {
    stubTokenizerServer();
    configure(TOKENIZER_RECIPE);
    await embed(['alpha', 'beta']);
    expect(batches.map(batch => batch.length)).toEqual([1, 1]);

    batches = [];
    configure(ESTIMATE_RECIPE);
    await embed(['alpha', 'beta']);
    expect(batches.map(batch => batch.length)).toEqual([2]);
  });

  test('a failing tokenizer plans exactly like the estimate path', async () => {
    globalThis.fetch = (async () => jsonResponse({ error: 'not found' }, 404)) as unknown as typeof fetch;
    configure(TOKENIZER_RECIPE);
    await embed(['alpha', 'beta']);

    const fallbackBatches = batches.map(batch => batch.length);
    batches = [];
    configure(ESTIMATE_RECIPE);
    await embed(['alpha', 'beta']);
    expect(fallbackBatches).toEqual(batches.map(batch => batch.length));
    expect(fallbackBatches).toEqual(
      planEmbedRequests(['alpha', 'beta'], ESTIMATE_RECIPE, 0.8).map(batch => batch.length),
    );
  });

  test('a recipe without a tokenizer issues no extra request and plans as today', async () => {
    stubTokenizerServer();
    configure(ESTIMATE_RECIPE);
    await embed(['alpha', 'beta']);
    expect(requests).toHaveLength(0);
    expect(batches.map(batch => batch.length)).toEqual(
      planEmbedRequests(['alpha', 'beta'], ESTIMATE_RECIPE, 0.8).map(batch => batch.length),
    );
  });

  test('an over-cap input is cut at a token boundary before the request is planned', async () => {
    stubTokenizerServer();
    const capped = makeRecipe(TOKENIZER_RECIPE_ID, {
      max_batch_tokens: BATCH_TOKENS,
      max_input_tokens: { [MODEL_ID]: 5 },
      tokenizer: TOKENIZER,
    });
    configure(capped);
    await embed([LONG_TEXT]);
    expect(batches).toEqual([[TRUNCATED_TEXT]]);
    // Counting asks /tokenize for a count (the cache holds counts, not ids), so
    // the cut re-tokenizes once to slice real ids, then detokenizes the prefix.
    expect(requests.map(request => request.url)).toEqual([
      'http://127.0.0.1:8084/tokenize',
      'http://127.0.0.1:8084/tokenize',
      'http://127.0.0.1:8084/detokenize',
    ]);
  });
});
