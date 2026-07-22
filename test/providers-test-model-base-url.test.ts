/**
 * #2863 regression — `gbrain providers test --model` must resolve
 * `provider_base_urls` the same way the production embed/chat path does.
 *
 * Before the fix, the `--model` override branch in `runTest`
 * (src/commands/providers.ts) forwarded only `embedding_model`/`chat_model`
 * + `env` into `configureGateway`, dropping `config.provider_base_urls`
 * entirely. A brain configured with a custom (e.g. China-region DashScope)
 * endpoint would pass `gbrain providers test --touchpoint embedding` (no
 * `--model`, uses configureFromEnv() which DOES forward base_urls) but fail
 * `gbrain providers test --touchpoint embedding --model
 * dashscope:text-embedding-v3` with a misleading "Incorrect API key" error
 * — the probe silently fell back to the recipe's hardcoded default endpoint
 * (dashscope-intl.aliyuncs.com) instead of the configured one.
 *
 * This test drives the real `runProviders('test', ...)` CLI path end to end
 * (loadConfig -> configureGateway -> gateway -> AI SDK -> fetch) and asserts
 * on the actual HTTP request URL, so it fails on the pre-fix code and only
 * passes once the --model override reuses buildGatewayConfig (the same
 * resolver src/cli.ts#connectEngine and init-embed-check.ts use for the
 * production path).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProviders } from '../src/commands/providers.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

const CUSTOM_BASE_URL = 'https://llm-custom.cn-beijing.maas.example.test/compatible-mode/v1';

type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler | null = null;
const origFetch = globalThis.fetch;
let tmpHome: string;

function okEmbeddingResponse(dims: number): Response {
  const vec = Array(dims).fill(0).map((_, i) => 0.001 * i);
  return new Response(
    JSON.stringify({ data: [{ embedding: vec }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

beforeEach(() => {
  fetchHandler = null;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!fetchHandler) throw new Error('fetch called but no handler installed');
    return fetchHandler(typeof url === 'string' ? url : url.toString(), init ?? {});
  }) as typeof fetch;

  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-providers-test-base-url-'));
  mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
  writeFileSync(
    join(tmpHome, '.gbrain', 'config.json'),
    JSON.stringify({
      embedding_model: 'dashscope:text-embedding-v3',
      embedding_dimensions: 1024,
      provider_base_urls: { dashscope: CUSTOM_BASE_URL },
    }),
  );
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetGateway();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('providers test --model — provider_base_urls (#2863)', () => {
  test('embedding touchpoint probe hits the configured custom base URL, not the recipe default', async () => {
    let capturedUrl = '';
    fetchHandler = async (url) => {
      capturedUrl = url;
      return okEmbeddingResponse(1024);
    };

    await withEnv(
      { GBRAIN_HOME: tmpHome, DASHSCOPE_API_KEY: 'test-dashscope-key' },
      async () => {
        await runProviders('test', ['--touchpoint', 'embedding', '--model', 'dashscope:text-embedding-v3']);
      },
    );

    expect(capturedUrl.startsWith(CUSTOM_BASE_URL)).toBe(true);
    expect(capturedUrl).not.toContain('dashscope-intl.aliyuncs.com');
  });

  test('bare `providers test` (no --model) already used the custom base URL (control)', async () => {
    let capturedUrl = '';
    fetchHandler = async (url) => {
      capturedUrl = url;
      return okEmbeddingResponse(1024);
    };

    await withEnv(
      { GBRAIN_HOME: tmpHome, DASHSCOPE_API_KEY: 'test-dashscope-key' },
      async () => {
        await runProviders('test', ['--touchpoint', 'embedding']);
      },
    );

    expect(capturedUrl.startsWith(CUSTOM_BASE_URL)).toBe(true);
  });
});
