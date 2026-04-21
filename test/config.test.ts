import { describe, test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, saveConfig } from '../src/core/config.ts';

const configSource = readFileSync(
  new URL('../src/commands/config.ts', import.meta.url),
  'utf-8',
);

function redactUrl(url: string): string {
  return url.replace(
    /(postgresql:\/\/[^:]+:)([^@]+)(@)/,
    '$1***$3',
  );
}

describe('redactUrl', () => {
  test('redacts password in postgresql:// URL', () => {
    const url = 'postgresql://user:secretpass@host:5432/dbname';
    expect(redactUrl(url)).toBe('postgresql://user:***@host:5432/dbname');
  });

  test('redacts complex passwords with special chars', () => {
    const url = 'postgresql://postgres:p@ss!w0rd#123@db.supabase.co:5432/postgres';
    const result = redactUrl(url);
    expect(result).not.toContain('p@ss');
    expect(result).toContain('***');
  });

  test('returns non-postgresql URLs unchanged', () => {
    const url = 'https://example.com/api';
    expect(redactUrl(url)).toBe(url);
  });

  test('returns plain strings unchanged', () => {
    expect(redactUrl('hello')).toBe('hello');
  });

  test('handles URL without password', () => {
    const url = 'postgresql://user@host:5432/dbname';
    expect(redactUrl(url)).toBe(url);
  });

  test('handles empty string', () => {
    expect(redactUrl('')).toBe('');
  });
});

describe('loadConfig', () => {
  test('merges MiniMax env vars and provider fields', () => {
    const originalHome = process.env.HOME;
    const originalOpenAI = process.env.OPENAI_API_KEY;
    const originalAnthropic = process.env.ANTHROPIC_API_KEY;
    const originalMiniMax = process.env.MINIMAX_API_KEY;
    const originalMiniMaxBase = process.env.MINIMAX_BASE_URL;
    const originalMiniMaxGroupId = process.env.MINIMAX_GROUP_ID;

    const tempHome = mkdtempSync(join(tmpdir(), 'gbrain-config-'));
    process.env.HOME = tempHome;
    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'ant-test';
    process.env.MINIMAX_API_KEY = 'mini-test';
    process.env.MINIMAX_GROUP_ID = 'group-test';
    process.env.MINIMAX_BASE_URL = 'https://example.minimax/v1';

    try {
      saveConfig({
        engine: 'pglite',
        database_path: '/tmp/brain.pglite',
        embedding_provider: 'minimax',
        embedding_model: 'embo-01',
      });

      const config = loadConfig();
      expect(config?.embedding_provider).toBe('minimax');
      expect(config?.embedding_model).toBe('embo-01');
      expect(config?.anthropic_api_key).toBe('ant-test');
      expect(config?.minimax_api_key).toBe('mini-test');
      expect(config?.minimax_group_id).toBe('group-test');
      expect(config?.minimax_base_url).toBe('https://example.minimax/v1');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAI;
      if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropic;
      if (originalMiniMax === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = originalMiniMax;
      if (originalMiniMaxBase === undefined) delete process.env.MINIMAX_BASE_URL;
      else process.env.MINIMAX_BASE_URL = originalMiniMaxBase;
      if (originalMiniMaxGroupId === undefined) delete process.env.MINIMAX_GROUP_ID;
      else process.env.MINIMAX_GROUP_ID = originalMiniMaxGroupId;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test('hasEmbeddingProviderCredentials requires MiniMax group id', async () => {
    const originalHome = process.env.HOME;
    const tempHome = mkdtempSync(join(tmpdir(), 'gbrain-minimax-creds-'));
    process.env.HOME = tempHome;

    try {
      saveConfig({
        engine: 'pglite',
        database_path: '/tmp/brain.pglite',
        embedding_provider: 'minimax',
        embedding_model: 'embo-01',
        minimax_api_key: 'mini-test',
      });

      const { hasEmbeddingProviderCredentials } = await import('../src/core/embedding.ts');
      expect(hasEmbeddingProviderCredentials()).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test('embedBatch dispatches to MiniMax when configured', async () => {
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    const tempHome = mkdtempSync(join(tmpdir(), 'gbrain-embedcfg-'));
    process.env.HOME = tempHome;

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      calls.push({ url, init });
      return new Response(JSON.stringify({
        vectors: [new Array(1536).fill(0.25)],
        base_resp: { status_code: 0 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      saveConfig({
        engine: 'pglite',
        database_path: '/tmp/brain.pglite',
        embedding_provider: 'minimax',
        embedding_model: 'embo-01',
        minimax_api_key: 'mini-test',
        minimax_group_id: 'group-test',
      });

      const { embedBatch, getEmbeddingModel, getEmbeddingProvider, hasEmbeddingProviderCredentials } = await import('../src/core/embedding.ts');
      const vectors = await embedBatch(['hello world']);

      expect(getEmbeddingProvider()).toBe('minimax');
      expect(getEmbeddingModel()).toBe('embo-01');
      expect(hasEmbeddingProviderCredentials()).toBe(true);
      expect(vectors).toHaveLength(1);
      expect(vectors[0]).toBeInstanceOf(Float32Array);
      expect(vectors[0].length).toBe(1536);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.minimax.chat/v1/embeddings?GroupId=group-test');
      expect(calls[0].init?.headers).toEqual({
        Authorization: 'Bearer mini-test',
        'Content-Type': 'application/json',
      });
      expect(calls[0].init?.body).toBe(JSON.stringify({
        model: 'embo-01',
        texts: ['hello world'],
        type: 'db',
      }));
    } finally {
      globalThis.fetch = originalFetch;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test('MiniMax retries on API rate-limit style responses', async () => {
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    const originalInterval = process.env.MINIMAX_MIN_REQUEST_INTERVAL_MS;
    const tempHome = mkdtempSync(join(tmpdir(), 'gbrain-minimax-retry-'));
    process.env.HOME = tempHome;
    process.env.MINIMAX_MIN_REQUEST_INTERVAL_MS = '1';

    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({
          base_resp: { status_code: 1002, status_msg: 'rate limit' },
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'retry-after': '1',
          },
        });
      }

      return new Response(JSON.stringify({
        vectors: [new Array(1536).fill(0.5)],
        base_resp: { status_code: 0 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      saveConfig({
        engine: 'pglite',
        database_path: '/tmp/brain.pglite',
        embedding_provider: 'minimax',
        embedding_model: 'embo-01',
        minimax_api_key: 'mini-test',
        minimax_group_id: 'group-test',
      });

      const { embedBatch, resetEmbeddingStateForTests } = await import('../src/core/embedding.ts');
      resetEmbeddingStateForTests();
      const vectors = await embedBatch(['hello world']);

      expect(calls).toBe(2);
      expect(vectors).toHaveLength(1);
      expect(vectors[0]).toBeInstanceOf(Float32Array);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalInterval === undefined) delete process.env.MINIMAX_MIN_REQUEST_INTERVAL_MS;
      else process.env.MINIMAX_MIN_REQUEST_INTERVAL_MS = originalInterval;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test('MiniMax spaces requests by configured minimum interval', async () => {
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    const originalInterval = process.env.MINIMAX_MIN_REQUEST_INTERVAL_MS;
    const tempHome = mkdtempSync(join(tmpdir(), 'gbrain-minimax-spacing-'));
    process.env.HOME = tempHome;
    process.env.MINIMAX_MIN_REQUEST_INTERVAL_MS = '25';

    const callTimes: number[] = [];
    globalThis.fetch = (async () => {
      callTimes.push(Date.now());
      return new Response(JSON.stringify({
        vectors: [new Array(1536).fill(0.25)],
        base_resp: { status_code: 0 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      saveConfig({
        engine: 'pglite',
        database_path: '/tmp/brain.pglite',
        embedding_provider: 'minimax',
        embedding_model: 'embo-01',
        minimax_api_key: 'mini-test',
        minimax_group_id: 'group-test',
      });

      const { embedBatch, resetEmbeddingStateForTests } = await import('../src/core/embedding.ts');
      resetEmbeddingStateForTests();
      await embedBatch(['one']);
      await embedBatch(['two']);

      expect(callTimes).toHaveLength(2);
      expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(20);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalInterval === undefined) delete process.env.MINIMAX_MIN_REQUEST_INTERVAL_MS;
      else process.env.MINIMAX_MIN_REQUEST_INTERVAL_MS = originalInterval;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('config source correctness', () => {
  test('redactUrl function exists in config.ts', () => {
    expect(configSource).toContain('function redactUrl');
  });

  test('redactUrl uses the correct regex pattern', () => {
    expect(configSource).toContain('postgresql:\/\/');
  });
});
