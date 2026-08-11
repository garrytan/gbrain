// Regression: loadConfigWithEngine() read every DB-plane key one at a time.
//
// SYMPTOM. On a Supabase-hosted brain, `gbrain stats` took 7.7s wall clock.
// pg_stat_statements showed 54 queries totalling 2.3ms of server time — 44 of
// them `SELECT value FROM config WHERE key = $1`. The database did no work;
// the CLI paid one ~70ms round trip per config key. The same command against a
// local PGLite brain took 0.26s, which is why the pattern survived so long: on
// an embedded database each read costs microseconds and is invisible.
//
// The config table is a handful of rows, so it is now read once via
// getAllConfig() and every key is answered from that snapshot. These tests pin
// the round-trip count, not the wall clock: a timing assertion would be flaky
// in CI, while a call counter is deterministic.
//
// Against the pre-fix code the first two cases report 18+ per-key reads.

import { describe, expect, test } from 'bun:test';
import { loadConfigWithEngine, type GBrainConfig } from '../src/core/config.ts';

/** Engine double that counts how many times each config read is issued. */
function makeCountingEngine(values: Record<string, string> = {}) {
  const stats = { getConfig: 0, getAllConfig: 0, listConfigKeys: 0 };

  return {
    stats,
    async getConfig(key: string): Promise<string | null> {
      stats.getConfig++;
      return key in values ? values[key] : null;
    },
    async getAllConfig(): Promise<Record<string, string>> {
      stats.getAllConfig++;
      return { ...values };
    },
    async listConfigKeys(prefix: string): Promise<string[]> {
      stats.listConfigKeys++;
      return Object.keys(values).filter((k) => k.startsWith(prefix));
    },
  };
}

/** Engine without the bulk read — an older or third-party implementation. */
function makeLegacyEngine(values: Record<string, string> = {}) {
  const stats = { getConfig: 0 };
  return {
    stats,
    async getConfig(key: string): Promise<string | null> {
      stats.getConfig++;
      return key in values ? values[key] : null;
    },
    async listConfigKeys(prefix: string): Promise<string[]> {
      return Object.keys(values).filter((k) => k.startsWith(prefix));
    },
  };
}

const BASE: GBrainConfig = { engine: 'postgres' } as GBrainConfig;

describe('loadConfigWithEngine DB-plane round trips', () => {
  test('reads the config table once, not once per key', async () => {
    const engine = makeCountingEngine();

    await loadConfigWithEngine(engine, BASE);

    expect(engine.stats.getAllConfig).toBe(1);
    expect(engine.stats.getConfig).toBe(0);
    expect(engine.stats.listConfigKeys).toBe(0);
  });

  test('resolves a key prefix map from the same snapshot', async () => {
    // dbPrefixMap used to list keys, then read one value per matched key, so
    // its cost scaled with how many keys the prefix matched.
    const engine = makeCountingEngine({
      'provider_base_urls.openai': 'https://a.example',
      'provider_base_urls.anthropic': 'https://b.example',
      'provider_base_urls.voyage': 'https://c.example',
    });

    const merged = await loadConfigWithEngine(engine, BASE);

    expect(merged?.provider_base_urls).toEqual({
      openai: 'https://a.example',
      anthropic: 'https://b.example',
      voyage: 'https://c.example',
    });
    expect(engine.stats.getAllConfig).toBe(1);
    expect(engine.stats.getConfig).toBe(0);
  });

  test('the snapshot does not change which values win', async () => {
    const engine = makeCountingEngine({
      embedding_multimodal: 'true',
      embedding_multimodal_model: 'voyage:voyage-multimodal-3',
      'content_sanity.bytes_warn': '1024',
      'dream.synthesize.verdict_model': 'anthropic:claude-haiku-4-5',
    });

    const merged = await loadConfigWithEngine(engine, BASE);

    expect(merged?.embedding_multimodal).toBe(true);
    expect(merged?.embedding_multimodal_model).toBe('voyage:voyage-multimodal-3');
    expect(merged?.content_sanity?.bytes_warn).toBe(1024);
    expect(merged?.dream?.synthesize?.verdict_model).toBe('anthropic:claude-haiku-4-5');
  });

  test('file/env config still beats the DB plane', async () => {
    // Precedence is the reason each key is resolved separately in the first
    // place; the snapshot must not disturb it.
    const engine = makeCountingEngine({ embedding_multimodal_model: 'db:model' });
    const base = { ...BASE, embedding_multimodal_model: 'file:model' } as GBrainConfig;

    const merged = await loadConfigWithEngine(engine, base);

    expect(merged?.embedding_multimodal_model).toBe('file:model');
  });

  test('an engine without getAllConfig still resolves every key', async () => {
    // Fallback path: a pre-v43 or third-party engine keeps the per-key reads.
    const engine = makeLegacyEngine({
      embedding_multimodal: 'true',
      'provider_base_urls.openai': 'https://a.example',
    });

    const merged = await loadConfigWithEngine(engine, BASE);

    expect(merged?.embedding_multimodal).toBe(true);
    expect(merged?.provider_base_urls).toEqual({ openai: 'https://a.example' });
    expect(engine.stats.getConfig).toBeGreaterThan(10);
  });

  test('a failing bulk read degrades to per-key reads', async () => {
    // A brain mid-migration has no config table. getAllConfig throwing must
    // not abort the load, and must not skip the DB plane on a brain where the
    // per-key path would have worked.
    const stats = { getConfig: 0 };
    const engine = {
      async getAllConfig(): Promise<Record<string, string>> {
        throw new Error('relation "config" does not exist');
      },
      async getConfig(key: string): Promise<string | null> {
        stats.getConfig++;
        return key === 'embedding_multimodal' ? 'true' : null;
      },
      async listConfigKeys(): Promise<string[]> {
        return [];
      },
    };

    const merged = await loadConfigWithEngine(engine, BASE);

    expect(merged?.embedding_multimodal).toBe(true);
    expect(stats.getConfig).toBeGreaterThan(10);
  });

  test('a brain with no config table at all still loads', async () => {
    const engine = {
      async getAllConfig(): Promise<Record<string, string>> {
        throw new Error('relation "config" does not exist');
      },
      async getConfig(): Promise<string | null> {
        throw new Error('relation "config" does not exist');
      },
      async listConfigKeys(): Promise<string[]> {
        throw new Error('relation "config" does not exist');
      },
    };

    const merged = await loadConfigWithEngine(engine, BASE);

    expect(merged).toBeTruthy();
    expect(merged?.embedding_multimodal).toBeUndefined();
  });
});
