/**
 * GBRA-283 B3a (N2, gate d3a/d9a): an embedded engine's query-embedding cache entries are tagged per engine object by
 * default (cold for every new engine, dropped at close). A host that reopens a brain per call may pass
 * settings.cache_namespace, an opaque string it owns for one tenant database: the tag is then that namespace plus the
 * provider-configuration generation (provider set, base URLs and a key fingerprint, never the key), so a reopened
 * brain hits, another namespace never does even on a cloned database, and a replaced key starts cold.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { __setEmbedTransportForTests, embedQuery, resetGateway } from '../src/core/ai/gateway.ts';
import { __queryEmbedCacheKeysForTests } from '../src/core/ai/query-embed-cache.ts';
import { embeddedSettings, openEngine, withEngineScope, type EngineSettings } from '../src/core/engine-open.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const EMBEDDING = { model: 'openai:text-embedding-3-small', dimensions: 1536 };
const key = () => `sk-ns-${randomBytes(12).toString('hex')}`;
const calls: string[] = [];
afterEach(() => {
  calls.length = 0;
  __setEmbedTransportForTests(null);
  resetGateway();
});
function stubEmbeds(): void {
  __setEmbedTransportForTests((async ({ model, values }: any) => {
    const headers = await model.config.headers();
    calls.push(headers.authorization ?? '');
    return { embeddings: values.map(() => Array.from({ length: EMBEDDING.dimensions }, (_, i) => (i % 7) + 1)), usage: { tokens: 1 } };
  }) as any);
}
const settingsFor = (path: string | undefined, apiKey: string, cache_namespace?: string): EngineSettings => ({
  embedded_core: true, engine: 'pglite', database: path ? { path } : {}, host: { id: randomUUID() }, embedding: EMBEDDING,
  ai: { providers: { openai: { apiKey } } }, ...(cache_namespace !== undefined ? { cache_namespace } : {}),
});
/** Opens, embeds one query in the engine's scope, closes; returns how many provider calls it made. */
async function askOnce(settings: EngineSettings, query = 'what did brain-a plan'): Promise<number> {
  const before = calls.length;
  const engine: BrainEngine = await openEngine(settings);
  try { await withEngineScope(engine, () => embedQuery(query)); } finally { await engine.disconnect(); }
  return calls.length - before;
}

describe('settings.cache_namespace', () => {
  test('two copies of one database under different namespaces miss on their own; the same namespace reopened hits; a replaced key misses', async () => {
    stubEmbeds();
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-cache-ns-'));
    const original = join(dir, 'brain-a.pglite');
    const seed = await openEngine(settingsFor(original, key()));
    await seed.initSchema();
    await seed.disconnect();
    const copy = join(dir, 'brain-a-copy.pglite');
    cpSync(original, copy, { recursive: true });
    const apiKey = key();
    expect(await askOnce(settingsFor(original, apiKey, 'tenant-a-incarnation-1'))).toBe(1);
    expect(await askOnce(settingsFor(copy, apiKey, 'tenant-b-incarnation-1'))).toBe(1);
    expect(await askOnce(settingsFor(original, apiKey, 'tenant-a-incarnation-1'))).toBe(0);
    expect(await askOnce(settingsFor(copy, apiKey, 'tenant-b-incarnation-1'))).toBe(0);
    expect(await askOnce(settingsFor(original, key(), 'tenant-a-incarnation-1'))).toBe(1);
  }, 120_000);

  test('without a namespace every new engine starts cold', async () => {
    stubEmbeds();
    const apiKey = key();
    expect(await askOnce(settingsFor(undefined, apiKey))).toBe(1);
    expect(await askOnce(settingsFor(undefined, apiKey))).toBe(1);
  }, 60_000);

  test('a query embed still in flight when its engine closes leaves no entry behind for it', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    __setEmbedTransportForTests((async ({ values }: any) => {
      calls.push('in-flight');
      await gate;
      return { embeddings: values.map(() => Array.from({ length: EMBEDDING.dimensions }, (_, i) => (i % 7) + 1)), usage: { tokens: 1 } };
    }) as any);
    const engine = await openEngine(settingsFor(undefined, key()));
    const pending = withEngineScope(engine, () => embedQuery('asked by brain-a just before it closed')).catch(() => null);
    for (let i = 0; i < 200 && calls.length === 0; i++) await Bun.sleep(5);
    expect(calls).toEqual(['in-flight']);
    await engine.disconnect();
    release();
    await pending;
    expect(__queryEmbedCacheKeysForTests().filter(k => k.includes('asked by brain-a just before it closed'))).toEqual([]);
  }, 60_000);

  test('the namespace is an opaque non-empty string, read back as given, and no tag carries the key', async () => {
    for (const bad of ['', 42, { id: 'x' }, 'x'.repeat(257)]) {
      const error = await openEngine({ ...settingsFor(undefined, key()), cache_namespace: bad as never }).then(e => e.disconnect().then(() => null), e => e);
      expect(error?.code).toBe('engine_settings_invalid');
      expect(error?.message).toContain('cache_namespace');
    }
    stubEmbeds();
    const apiKey = key();
    const engine = await openEngine(settingsFor(undefined, apiKey, 'tenant-a'));
    try {
      expect(embeddedSettings(engine)?.cache_namespace).toBe('tenant-a');
      await withEngineScope(engine, () => embedQuery('a question for brain-a'));
      const tagged = __queryEmbedCacheKeysForTests().filter(k => k.includes('a question for brain-a'));
      expect(tagged).toHaveLength(1);
      expect(tagged[0]).not.toContain(apiKey);
      expect(tagged[0]).not.toContain('tenant-a');
    } finally {
      await engine.disconnect();
    }
  }, 60_000);
});
