/**
 * MiniMax recipe smoke (Commit 5 of the v0.32 wave).
 *
 * Coverage:
 *  - Recipe registered with expected shape
 *  - default auth: MINIMAX_API_KEY → "Bearer <key>"; missing → AIConfigError
 *  - dimsProviderOptions threads `type: 'db'` for embo-01 (the asymmetric
 *    retrieval field default) — pins the v1 indexing-only behavior
 *  - #1977: chat touchpoint declared; minimaxCompatFetch rewrites the
 *    embedding wire shape both directions, passes chat through with the
 *    response body UNREAD (the consumed-body regression), fail-open.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { minimaxCompatFetch } from '../../src/core/ai/recipes/minimax.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('recipe: minimax', () => {
  test('registered with expected shape', () => {
    const r = getRecipe('minimax');
    expect(r).toBeDefined();
    expect(r!.id).toBe('minimax');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('https://api.minimaxi.com/v1');
    expect(r!.auth_env?.required).toEqual(['MINIMAX_API_KEY']);
    expect(r!.auth_env?.optional).toContain('MINIMAX_GROUP_ID');
  });

  test('embedding touchpoint declares embo-01 + 1536 dims', () => {
    const r = getRecipe('minimax')!;
    expect(r.touchpoints.embedding).toBeDefined();
    expect(r.touchpoints.embedding!.models).toEqual(['embo-01']);
    expect(r.touchpoints.embedding!.default_dims).toBe(1536);
    expect(r.touchpoints.embedding!.user_provided_models ?? false).toBe(false);
    expect(r.touchpoints.embedding!.max_batch_tokens).toBe(4096);
  });

  test('default auth: MINIMAX_API_KEY set → "Bearer <key>"', () => {
    const r = getRecipe('minimax')!;
    const auth = defaultResolveAuth(r, { MINIMAX_API_KEY: 'fake-mm-key' }, 'embedding');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer fake-mm-key');
  });

  test('default auth: missing MINIMAX_API_KEY → AIConfigError', () => {
    const r = getRecipe('minimax')!;
    expect(() => defaultResolveAuth(r, {}, 'embedding')).toThrow(AIConfigError);
  });

  test('dimsProviderOptions threads type:db for embo-01', () => {
    const opts = dimsProviderOptions('openai-compatible', 'embo-01', 1536);
    expect(opts).toEqual({ openaiCompatible: { type: 'db' } });
  });

  test('dimsProviderOptions returns undefined for non-MiniMax openai-compat models', () => {
    expect(dimsProviderOptions('openai-compatible', 'voyage-3-lite', 512)).toBeUndefined();
    expect(dimsProviderOptions('openai-compatible', 'nomic-embed-text', 768)).toBeUndefined();
  });

  test('chat touchpoint declared (#1977) so assertTouchpoint permits gbrain think', () => {
    const r = getRecipe('minimax')!;
    expect(r.touchpoints.chat).toBeDefined();
    expect(r.touchpoints.chat!.models).toContain('MiniMax-M3');
    expect(r.touchpoints.chat!.supports_tools).toBe(false);
    expect(r.touchpoints.chat!.supports_subagent_loop).toBe(false);
  });

  test('recipe ships minimaxCompatFetch via compat.fetch (no env-templated base URL)', () => {
    const r = getRecipe('minimax')!;
    expect(r.compat?.fetch).toBe(minimaxCompatFetch);
    // base_urls config override must keep working: no resolveOpenAICompatConfig.
    expect(r.resolveOpenAICompatConfig).toBeUndefined();
  });
});

describe('minimaxCompatFetch (#1977)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function stubFetch(body: unknown, init?: { status?: number; contentType?: string }) {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input: any, i?: RequestInit) => {
      calls.push({ url: String(input), init: i });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': init?.contentType ?? 'application/json' },
      });
    }) as unknown as typeof fetch;
    return calls;
  }

  const EMBED_URL = 'https://api.minimaxi.com/v1/embeddings';
  const CHAT_URL = 'https://api.minimaxi.com/v1/chat/completions';

  test('embedding request: input → texts, type:db injected, encoding_format dropped', async () => {
    const calls = stubFetch({ vectors: [[0.1, 0.2]] });
    await minimaxCompatFetch(EMBED_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '99' },
      body: JSON.stringify({ model: 'embo-01', input: ['hello', 'world'], encoding_format: 'float' }),
    });
    const wire = JSON.parse(calls[0]!.init!.body as string);
    expect(wire.texts).toEqual(['hello', 'world']);
    expect(wire.input).toBeUndefined();
    expect(wire.encoding_format).toBeUndefined();
    expect(wire.type).toBe('db');
    expect(new Headers(calls[0]!.init!.headers).get('content-length')).toBeNull();
  });

  test('embedding response: {vectors} rewritten to OpenAI {data:[{embedding}]}', async () => {
    stubFetch({ vectors: [[0.1, 0.2], [0.3, 0.4]], total_tokens: 7 });
    const res = await minimaxCompatFetch(EMBED_URL, {
      method: 'POST',
      body: JSON.stringify({ model: 'embo-01', input: ['a', 'b'] }),
    });
    const json = await res.json();
    expect(json.data).toEqual([
      { object: 'embedding', embedding: [0.1, 0.2], index: 0 },
      { object: 'embedding', embedding: [0.3, 0.4], index: 1 },
    ]);
    expect(json.usage).toEqual({ prompt_tokens: 7, total_tokens: 7 });
  });

  test('chat completion passes through with body UNREAD (consumed-body regression)', async () => {
    stubFetch({ choices: [{ message: { role: 'assistant', content: 'hi' } }] });
    const res = await minimaxCompatFetch(CHAT_URL, {
      method: 'POST',
      body: JSON.stringify({ model: 'MiniMax-M3', messages: [{ role: 'user', content: 'say hi' }] }),
    });
    expect(res.bodyUsed).toBe(false); // the broken PR #2882 wrapper consumed this
    const json = await res.json(); // must NOT throw "Body already used"
    expect(json.choices[0].message.content).toBe('hi');
  });

  test('chat request body is never rewritten (messages untouched, no type injected)', async () => {
    const calls = stubFetch({ choices: [] });
    const body = JSON.stringify({ model: 'MiniMax-M3', messages: [{ role: 'user', content: 'x' }] });
    await minimaxCompatFetch(CHAT_URL, { method: 'POST', body });
    expect(calls[0]!.init!.body).toBe(body);
  });

  test('embedding error response ({vectors:null, base_resp}) passes through re-readable', async () => {
    stubFetch({ vectors: null, base_resp: { status_code: 2013, status_msg: 'invalid params' } });
    const res = await minimaxCompatFetch(EMBED_URL, {
      method: 'POST',
      body: JSON.stringify({ model: 'embo-01', input: ['a'] }),
    });
    expect(res.bodyUsed).toBe(false);
    const json = await res.json();
    expect(json.base_resp.status_code).toBe(2013);
  });

  test('fail-open: non-JSON response body passes through untouched', async () => {
    stubFetch('not json', { contentType: 'application/json' });
    const res = await minimaxCompatFetch(EMBED_URL, {
      method: 'POST',
      body: JSON.stringify({ model: 'embo-01', input: ['a'] }),
    });
    expect(await res.text()).toBe('not json');
  });
});
