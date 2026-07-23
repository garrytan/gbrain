/**
 * #1610 — Voyage/ZeroEntropy compat shims must read the response body ONCE
 * via text() instead of `resp.clone().json()`.
 *
 * On bun < 1.1.27, Response.clone() truncates large bodies (oven-sh/bun#6348):
 * the clone().json() parse threw, the shim's catch fell back to the ORIGINAL
 * response — whose wire shape (ZE `{results: ...}`, Voyage base64 embeddings)
 * the AI SDK's openai-compatible Zod schema rejects — and multi-chunk pages
 * failed with "Invalid JSON response".
 *
 * These tests simulate the truncating clone() and assert the shims still
 * return the fully rewritten body. They also pin that the rewritten Response
 * does NOT carry the original (now stale) Content-Length header, which lied
 * about the rewritten body's size (gateway.ts previously copied
 * `headers: resp.headers` verbatim).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  __voyageCompatFetchForTests,
  __zeroEntropyCompatFetchForTests,
} from '../../src/core/ai/gateway.ts';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

/** Build a Response whose clone() truncates the body (bun < 1.1.27 behavior). */
function truncatingCloneResponse(body: string): Response {
  const headers = {
    'content-type': 'application/json',
    // Deliberately stale after any rewrite: the original wire body's length.
    'content-length': String(Buffer.byteLength(body)),
  };
  const resp = new Response(body, { status: 200, headers });
  (resp as any).clone = () =>
    new Response(body.slice(0, 32), { status: 200, headers });
  return resp;
}

describe('voyageCompatFetch — single body read (#1610)', () => {
  test('rewrites base64 embeddings even when clone() truncates the body', async () => {
    const floats = new Float32Array([0.5, 0.25, -1]);
    const b64 = Buffer.from(floats.buffer).toString('base64');
    const wireBody = JSON.stringify({
      object: 'list',
      data: [{ object: 'embedding', embedding: b64, index: 0 }],
      model: 'voyage-3',
      usage: { total_tokens: 7 },
    });
    globalThis.fetch = (async () => truncatingCloneResponse(wireBody)) as unknown as typeof fetch;

    const out = await __voyageCompatFetchForTests('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify({ input: ['hello'], model: 'voyage-3' }),
      headers: { 'content-type': 'application/json' },
    });

    const json: any = await out.json();
    expect(Array.from(json.data[0].embedding)).toEqual([0.5, 0.25, -1]);
    expect(json.usage.prompt_tokens).toBe(7);
    // Stale Content-Length from the wire body must not survive the rewrite.
    expect(out.headers.get('content-length')).toBeNull();
    expect(out.headers.get('content-encoding')).toBeNull();
  });
});

describe('zeroEntropyCompatFetch — single body read (#1610)', () => {
  test('rewrites {results} → {data} even when clone() truncates the body', async () => {
    const wireBody = JSON.stringify({
      results: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
      usage: { total_bytes: 42, total_tokens: 9 },
    });
    let fetchedUrl = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      fetchedUrl = String(url);
      return truncatingCloneResponse(wireBody);
    }) as unknown as typeof fetch;

    const out = await __zeroEntropyCompatFetchForTests('https://api.zeroentropy.dev/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify({ input: ['hello'], model: 'zembed-1' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(fetchedUrl.endsWith('/v1/models/embed')).toBe(true);
    const json: any = await out.json();
    // The AI SDK schema requires {data: [{embedding, index}]} — the raw ZE
    // {results} fallback is exactly the pre-fix "Invalid JSON response".
    expect(json.results).toBeUndefined();
    expect(json.data).toHaveLength(2);
    expect(json.data[0]).toEqual({ object: 'embedding', embedding: [0.1, 0.2], index: 0 });
    expect(json.data[1].index).toBe(1);
    expect(json.usage.prompt_tokens).toBe(9);
    expect(out.headers.get('content-length')).toBeNull();
  });

  test('non-JSON body falls back to the original bytes (rebuilt, still readable)', async () => {
    const wireBody = 'plain text, not json';
    globalThis.fetch = (async () =>
      new Response(wireBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const out = await __zeroEntropyCompatFetchForTests('https://api.zeroentropy.dev/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify({ input: ['hello'] }),
    });
    // Body was consumed by the shim's single read; the fallback must
    // rebuild a readable Response rather than return the drained original.
    expect(await out.text()).toBe(wireBody);
  });
});
