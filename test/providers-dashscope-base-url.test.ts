import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import { runProviders } from '../src/commands/providers.ts';
import { saveConfig } from '../src/core/config.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

function fakeEmbeddingResponse(dims = 1024): Response {
  return new Response(JSON.stringify({
    object: 'list',
    data: [
      {
        object: 'embedding',
        index: 0,
        embedding: new Array(dims).fill(0.01),
      },
    ],
    model: 'text-embedding-v4',
    usage: { prompt_tokens: 3, total_tokens: 3 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('gbrain providers test — DashScope base URL override', () => {
  test('honors provider_base_urls.dashscope when --model overrides the configured model', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-providers-dashscope-'));
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> | undefined;

    try {
      await withEnv(
        {
          GBRAIN_HOME: home,
          DATABASE_URL: undefined,
          GBRAIN_DATABASE_URL: undefined,
          DASHSCOPE_API_KEY: 'sk-dashscope-fake',
        },
        async () => {
          saveConfig({
            engine: 'pglite',
            database_path: join(home, '.gbrain', 'brain.pglite'),
            provider_base_urls: {
              dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            },
          });

          globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            capturedUrl = typeof input === 'string'
              ? input
              : input instanceof URL
              ? input.toString()
              : input.url;
            capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
            return fakeEmbeddingResponse();
          }) as unknown as typeof fetch;
          console.log = () => {};

          await runProviders('test', ['--model', 'dashscope:text-embedding-v4']);
        },
      );

      expect(capturedUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');
      expect(capturedBody?.model).toBe('text-embedding-v4');
      expect(capturedBody?.dimensions).toBe(1024);
      expect(capturedBody?.encoding_format).toBe('float');
    } finally {
      console.log = originalLog;
      globalThis.fetch = originalFetch;
      resetGateway();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
