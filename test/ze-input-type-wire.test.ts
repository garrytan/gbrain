/**
 * Wire-level contract for asymmetric input_type threading to ZeroEntropy.
 *
 * Why this exists when asymmetric-encoding-contract.test.ts already pins
 * input_type: that test captures `providerOptions` at the
 * `__setEmbedTransportForTests` seam — UPSTREAM of the AI-SDK adapter.
 * The adapter silently drops `providerOptions.openaiCompatible.input_type`
 * (unrecognized field; `dimensions` survives because it's a known param),
 * so the providerOptions contract held green while the actual wire body
 * said `input_type: 'document'` for every request — queries included —
 * and the entire vector arm did asymmetric retrieval with symmetric
 * (document-typed) query vectors.
 *
 * This test drives embed()/embedQuery() through the REAL adapter and
 * asserts the body the ZE endpoint receives, via the
 * `__setZeFetchForTests` terminal-fetch seam. It fails if input_type is
 * ever again threaded only through providerOptions.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  embed,
  embedQuery,
  __setZeFetchForTests,
} from '../src/core/ai/gateway.ts';

function configureZE() {
  configureGateway({
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: 1280,
    env: { ZEROENTROPY_API_KEY: 'sk-fake' },
  });
}

function fakeZeResponse(count: number, dims: number): Response {
  // ZE's native response shape — exercises the shim's inbound rewrite
  // ({results} → {data}, total_tokens → prompt_tokens) on the way back.
  return new Response(
    JSON.stringify({
      results: Array.from({ length: count }, () => ({
        embedding: Array.from({ length: dims }, () => 0.1),
      })),
      usage: { total_bytes: 4, total_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

interface CapturedWire {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
}

function captureWire(captured: CapturedWire[]): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')),
      headers: new Headers(init?.headers ?? {}),
    });
    return fakeZeResponse(
      Array.isArray((JSON.parse(String(init?.body ?? '{}')) as { input?: unknown[] }).input)
        ? ((JSON.parse(String(init?.body ?? '{}')) as { input: unknown[] }).input.length)
        : 1,
      1280,
    );
  }) as typeof fetch;
}

afterEach(() => {
  __setZeFetchForTests(null);
  resetGateway();
});

describe('ZE wire body carries asymmetric input_type (adapter drops providerOptions)', () => {
  test('embedQuery → wire body has input_type=query; threading header stripped', async () => {
    configureZE();
    const captured: CapturedWire[] = [];
    __setZeFetchForTests(captureWire(captured));

    await embedQuery('what does foo bar do?');

    expect(captured.length).toBe(1);
    expect(captured[0].body.input_type).toBe('query');
    // The internal threading header must not leak to the provider.
    expect(captured[0].headers.get('x-gbrain-input-type')).toBeNull();
    // Sanity: the shim's URL rewrite ran (we're on the real outbound path).
    expect(captured[0].url).toContain('/models/embed');
  });

  test('embed (index path) → wire body has input_type=document', async () => {
    configureZE();
    const captured: CapturedWire[] = [];
    __setZeFetchForTests(captureWire(captured));

    await embed(['this is a document being indexed']);

    expect(captured.length).toBe(1);
    expect(captured[0].body.input_type).toBe('document');
    expect(captured[0].headers.get('x-gbrain-input-type')).toBeNull();
  });
});
