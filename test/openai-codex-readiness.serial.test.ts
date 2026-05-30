import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'fs/promises';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { InMemoryTokenStore, type OpenAICodexTokenRecord } from '../src/core/ai/openai-codex/token-store.ts';
import { writeModelCache, type OpenAICodexModelCache } from '../src/core/ai/openai-codex/model-cache.ts';
import { getOpenAICodexReadiness } from '../src/core/ai/openai-codex/readiness.ts';

const OLD_GBRAIN_HOME = process.env.GBRAIN_HOME;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gbrain-openai-codex-ready-'));
  process.env.GBRAIN_HOME = root;
});

afterEach(() => {
  if (OLD_GBRAIN_HOME === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = OLD_GBRAIN_HOME;
  if (root) rmSync(root, { recursive: true, force: true });
});

function token(overrides: Partial<OpenAICodexTokenRecord> = {}): OpenAICodexTokenRecord {
  return {
    access_token: 'access-token-secret-1234567890',
    refresh_token: 'refresh-token-secret-1234567890',
    expires_at: '2030-01-01T00:00:00.000Z',
    token_type: 'Bearer',
    ...overrides,
  };
}

function cache(overrides: Partial<OpenAICodexModelCache> = {}): OpenAICodexModelCache {
  return {
    schema_version: 1,
    fetched_at: '2026-05-24T00:00:00.000Z',
    raw_count: 1,
    supported_count: 1,
    models: [{ slug: 'gpt-5.5', supported_in_api: true }],
    ...overrides,
  };
}

describe('openai-codex OAuth readiness', () => {
  test('reports not_logged_in when token store is empty', async () => {
    const result = await getOpenAICodexReadiness({
      tokenStore: new InMemoryTokenStore(),
      now: () => new Date('2026-05-24T12:00:00.000Z'),
    });
    expect(result.status).toBe('not_logged_in');
    expect(result.ready).toBe(false);
    expect(result.hint).toMatch(/login openai-codex/i);
  });

  test('reports cache_missing when token exists but model cache is absent', async () => {
    const store = new InMemoryTokenStore();
    await store.set(token());
    const result = await getOpenAICodexReadiness({
      tokenStore: store,
      now: () => new Date('2026-05-24T12:00:00.000Z'),
    });
    expect(result.status).toBe('cache_missing');
    expect(result.ready).toBe(false);
    expect(result.hint).toMatch(/refresh openai-codex/i);
  });

  test('reports token_present when token is valid and model cache is stale', async () => {
    const store = new InMemoryTokenStore();
    await store.set(token());
    await writeModelCache(cache({ fetched_at: '2026-05-22T00:00:00.000Z' }));
    const result = await getOpenAICodexReadiness({
      tokenStore: store,
      now: () => new Date('2026-05-24T12:00:00.000Z'),
      ttlMs: 24 * 60 * 60 * 1000,
    });
    expect(result.status).toBe('token_present');
    expect(result.ready).toBe(false);
    expect(result.hint).toMatch(/refresh/i);
  });

  test('reports needs_refresh when token is expired even if cache is fresh', async () => {
    const store = new InMemoryTokenStore();
    await store.set(token({ expires_at: '2026-05-24T11:59:00.000Z' }));
    await writeModelCache(cache({ fetched_at: '2026-05-24T11:00:00.000Z' }));
    const result = await getOpenAICodexReadiness({
      tokenStore: store,
      now: () => new Date('2026-05-24T12:00:00.000Z'),
    });
    expect(result.status).toBe('needs_refresh');
    expect(result.ready).toBe(false);
  });

  test('reports ready when token and supported model cache are current', async () => {
    const store = new InMemoryTokenStore();
    await store.set(token());
    await writeModelCache(cache({ fetched_at: '2026-05-24T11:00:00.000Z' }));
    const result = await getOpenAICodexReadiness({
      tokenStore: store,
      now: () => new Date('2026-05-24T12:00:00.000Z'),
    });
    expect(result.status).toBe('ready');
    expect(result.ready).toBe(true);
    expect(result.models_supported).toBe(1);
  });

  test('redacts token material from readiness errors', async () => {
    const result = await getOpenAICodexReadiness({
      tokenStore: {
        get: async () => { throw new Error('boom access_token=access-token-secret-1234567890'); },
        set: async () => {},
        delete: async () => {},
      },
      now: () => new Date('2026-05-24T12:00:00.000Z'),
    });
    expect(result.status).toBe('not_logged_in');
    expect(result.ready).toBe(false);
    expect(result.hint).toContain('[REDACTED]');
    expect(result.hint).not.toContain('access-token-secret-1234567890');
  });
});
