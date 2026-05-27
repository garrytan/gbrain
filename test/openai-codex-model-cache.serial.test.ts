import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { mkdtemp, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  filterSupportedModels,
  isModelCacheFresh,
  loadModelCache,
  modelCachePath,
  readModelCacheOrNull,
  writeModelCache,
  OpenAICodexModelCacheManager,
  type OpenAICodexModelCache,
} from '../src/core/ai/openai-codex/model-cache.ts';

const OLD_GBRAIN_HOME = process.env.GBRAIN_HOME;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gbrain-openai-codex-cache-'));
  process.env.GBRAIN_HOME = root;
});

afterEach(() => {
  if (OLD_GBRAIN_HOME === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = OLD_GBRAIN_HOME;
  if (root) rmSync(root, { recursive: true, force: true });
});

function cache(overrides: Partial<OpenAICodexModelCache> = {}): OpenAICodexModelCache {
  return {
    schema_version: 1,
    fetched_at: '2026-05-24T11:41:22.827Z',
    client_version: '0.133.0',
    etag: 'W/"abc"',
    raw_count: 3,
    supported_count: 2,
    models: [
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', supported_in_api: true, context_window: 272000, supported_reasoning_levels: ['low', 'medium', 'high'] },
      { slug: 'gpt-5.3-codex-spark', display_name: 'Spark', supported_in_api: false, context_window: 128000, supported_reasoning_levels: ['medium'] },
      { slug: 'gpt-5.2', display_name: 'GPT-5.2', supported_in_api: true, context_window: 272000, supported_reasoning_levels: ['medium'] },
    ],
    ...overrides,
  };
}

describe('openai-codex model cache', () => {
  test('filters out models with supported_in_api=false', () => {
    const supported = filterSupportedModels(cache().models);
    expect(supported.map(m => m.slug)).toEqual(['gpt-5.5', 'gpt-5.2']);
  });

  test('writes cache under GBRAIN_HOME with no credential material', async () => {
    await writeModelCache(cache());
    const path = modelCachePath();
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(join(root, '.gbrain'))).toBe(true);
    const fileMode = (await stat(path)).mode & 0o777;
    expect(fileMode).toBe(0o600);
    const loaded = await loadModelCache();
    expect(loaded.supported_count).toBe(2);
    expect(JSON.stringify(loaded)).not.toMatch(/access_token|refresh_token|id_token|sk-proj/i);
  });

  test('uses TTL clock control for freshness checks', () => {
    const c = cache({ fetched_at: '2026-05-24T00:00:00.000Z' });
    expect(isModelCacheFresh(c, 24 * 60 * 60 * 1000, new Date('2026-05-24T23:59:00.000Z'))).toBe(true);
    expect(isModelCacheFresh(c, 24 * 60 * 60 * 1000, new Date('2026-05-25T00:01:00.000Z'))).toBe(false);
  });

  test('returns null for missing cache but throws for malformed schema', async () => {
    expect(await readModelCacheOrNull()).toBeNull();
    mkdirSync(join(root, '.gbrain', 'cache'), { recursive: true, mode: 0o700 });
    writeFileSync(modelCachePath(), JSON.stringify({ schema_version: 999, models: [] }), { mode: 0o600 });
    await expect(loadModelCache()).rejects.toThrow(/schema/i);
  });

  test('refuses symlink cache path', async () => {
    mkdirSync(join(root, '.gbrain', 'cache'), { recursive: true, mode: 0o700 });
    const outside = join(root, 'outside-cache.json');
    writeFileSync(outside, JSON.stringify(cache()), { mode: 0o600 });
    symlinkSync(outside, modelCachePath());
    await expect(loadModelCache()).rejects.toThrow(/symlink/i);
  });

  test('refuses loose cache file permissions', async () => {
    mkdirSync(join(root, '.gbrain', 'cache'), { recursive: true, mode: 0o700 });
    writeFileSync(modelCachePath(), JSON.stringify(cache()), { mode: 0o644 });
    chmodSync(modelCachePath(), 0o644);
    await expect(loadModelCache()).rejects.toThrow(/permissions.*0600/i);
  });

  test('single-flights concurrent cache refreshes', async () => {
    let calls = 0;
    const manager = new OpenAICodexModelCacheManager({
      ttlMs: 24 * 60 * 60 * 1000,
      now: () => new Date('2026-05-25T00:00:00.000Z'),
      refresh: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return cache({ fetched_at: '2026-05-25T00:00:00.000Z' });
      },
    });
    const [a, b, c] = await Promise.all([
      manager.getFresh({ force: true }),
      manager.getFresh({ force: true }),
      manager.getFresh({ force: true }),
    ]);
    expect(calls).toBe(1);
    expect(a.cache.fetched_at).toBe('2026-05-25T00:00:00.000Z');
    expect(b.cache).toEqual(a.cache);
    expect(c.cache).toEqual(a.cache);
  });

  test('returns stale cache with redacted warning when refresh fails', async () => {
    await writeModelCache(cache({ fetched_at: '2026-05-23T00:00:00.000Z' }));
    const manager = new OpenAICodexModelCacheManager({
      ttlMs: 24 * 60 * 60 * 1000,
      now: () => new Date('2026-05-25T00:00:00.000Z'),
      refresh: async () => {
        throw new Error('refresh failed with access_token=access-token-secret-1234567890');
      },
    });
    const result = await manager.getFresh();
    expect(result.source).toBe('stale-cache');
    expect(result.warning).toContain('[REDACTED]');
    expect(result.warning).not.toContain('access-token-secret-1234567890');
    expect(result.cache.fetched_at).toBe('2026-05-23T00:00:00.000Z');
  });
});
