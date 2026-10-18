/**
 * GOOGLE_GENERATIVE_AI_BASE_URL: native-google chat and embedding requests go
 * to the configured base URL (an eval metering proxy, a regional gateway)
 * with the real path and key header, and nothing changes when it is unset.
 * A local HTTP server stands in for the Gemini API, so the real AI SDK
 * request is exercised (no transport stub, no network).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chat, configureGateway, embed, resetGateway, resolveNativeBaseUrl } from '../../src/core/ai/gateway.ts';
import type { AIGatewayConfig } from '../../src/core/ai/types.ts';

const seen: Array<{ path: string; key: string | null }> = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, key: req.headers.get('x-goog-api-key') });
      if (url.pathname.endsWith(':generateContent')) {
        return Response.json({
          candidates: [{ content: { role: 'model', parts: [{ text: 'proxied' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
        });
      }
      if (url.pathname.endsWith(':embedContent')) return Response.json({ embedding: { values: [0.6, 0.8, 0] } });
      if (url.pathname.endsWith(':batchEmbedContents')) {
        const body = await req.json() as { requests: unknown[] };
        return Response.json({ embeddings: body.requests.map(() => ({ values: [0.6, 0.8, 0] })) });
      }
      return new Response('not found', { status: 404 });
    },
  });
});

afterAll(() => { server.stop(true); });
afterEach(() => { seen.length = 0; resetGateway(); });

const cfgWith = (env: Record<string, string | undefined>) => ({ env }) as unknown as AIGatewayConfig;

describe('resolveNativeBaseUrl google', () => {
  test('a bare host gets /v1beta; a versioned URL is kept; trailing slashes are trimmed', () => {
    expect(resolveNativeBaseUrl('google', cfgWith({ GOOGLE_GENERATIVE_AI_BASE_URL: 'http://127.0.0.1:8787' }))).toBe('http://127.0.0.1:8787/v1beta');
    expect(resolveNativeBaseUrl('google', cfgWith({ GOOGLE_GENERATIVE_AI_BASE_URL: 'https://proxy.example/google/' }))).toBe('https://proxy.example/google/v1beta');
    expect(resolveNativeBaseUrl('google', cfgWith({ GOOGLE_GENERATIVE_AI_BASE_URL: 'https://proxy.example/v1beta/' }))).toBe('https://proxy.example/v1beta');
    expect(resolveNativeBaseUrl('google', cfgWith({ GOOGLE_GENERATIVE_AI_BASE_URL: 'https://proxy.example/v1' }))).toBe('https://proxy.example/v1');
  });

  test('unset or blank leaves the SDK default; providers read only their own variable', () => {
    expect(resolveNativeBaseUrl('google', cfgWith({}))).toBeUndefined();
    expect(resolveNativeBaseUrl('google', cfgWith({ GOOGLE_GENERATIVE_AI_BASE_URL: '  ' }))).toBeUndefined();
    expect(resolveNativeBaseUrl('google', cfgWith({ OPENAI_BASE_URL: 'https://x' }))).toBeUndefined();
    expect(resolveNativeBaseUrl('openai', cfgWith({ GOOGLE_GENERATIVE_AI_BASE_URL: 'https://x' }))).toBeUndefined();
  });
});

describe('native-google requests honor the override', () => {
  test('chat posts generateContent under the configured base URL with the key header', async () => {
    configureGateway({
      chat_model: 'google:gemini-2.5-flash',
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'test-google-key', GOOGLE_GENERATIVE_AI_BASE_URL: `http://127.0.0.1:${server.port}` },
    });
    const result = await chat({ model: 'google:gemini-2.5-flash', messages: [{ role: 'user', content: 'ping' }], maxTokens: 16 });
    expect(result.text).toBe('proxied');
    expect(seen).toEqual([{ path: '/v1beta/models/gemini-2.5-flash:generateContent', key: 'test-google-key' }]);
  });

  test('embedding posts under the configured base URL', async () => {
    configureGateway({
      embedding_model: 'google:gemini-embedding-001',
      embedding_dimensions: 3,
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'test-google-key', GOOGLE_GENERATIVE_AI_BASE_URL: `http://127.0.0.1:${server.port}/v1beta` },
    });
    const [one] = await embed(['hello'], { inputType: 'document' });
    const two = await embed(['hello', 'world'], { inputType: 'document' });
    for (const v of [one, ...two]) expect(Array.from(v).map(x => Math.round(x * 10) / 10)).toEqual([0.6, 0.8, 0]);
    expect(seen).toEqual([
      { path: '/v1beta/models/gemini-embedding-001:embedContent', key: 'test-google-key' },
      { path: '/v1beta/models/gemini-embedding-001:batchEmbedContents', key: 'test-google-key' },
    ]);
  });
});
