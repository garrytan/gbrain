/**
 * #7838: prefix inventories are lazy runtime data, not startup configuration.
 * A large persisted inventory must not ride on every config snapshot, but must
 * remain available to brainstorm inside that snapshot. Federated, unscoped and
 * literal-default inventories must not poison one another. Real storage on both
 * backends; no model calls and no timing assertions.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { fetchFar } from '../src/core/brainstorm/domain-bank.ts';
import { preparationReads } from '../src/core/persistence/group-publish.ts';
import { loadConfigSnapshot, snapshotConfigReader, withRequestConfigSnapshot } from '../src/core/config-snapshot.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const legacyKey = 'brainstorm.domain_bank.prefixes:default';
const large = JSON.stringify({ prefixes: Array.from({ length: 6000 }, (_, i) => `synthetic/domain-${i}`), cached_at: Date.now() });
for (const kind of testBackends()) describe(`lazy prefix inventory (${kind})`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close: closePostgres } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    for (const sourceId of ['cache-a', 'cache-b']) {
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
      await engine.putPage(`prefix/${sourceId}/note`, { type: 'note', title: sourceId, compiled_truth: 'Synthetic inventory fixture.', timeline: '', frontmatter: {} }, { sourceId });
    }
    await engine.setConfig('brainstorm.max_cost', '0.25');
    await engine.setConfig('brainstorm.domainXbank.prefixes:keep', 'ordinary-setting');
    await engine.setConfig(legacyKey, large);
  }, 120_000);
  afterAll(async () => { if (kind === 'pglite') await engine?.disconnect(); await closePostgres?.(); });

  test('bulk resolution omits large cache values at storage, preserving real settings and lazy point reads', async () => {
    const snapshot = await loadConfigSnapshot(engine);
    expect(snapshot?.[legacyKey]).toBeUndefined();
    expect(snapshot?.['brainstorm.max_cost']).toBe('0.25');
    expect(snapshot?.['brainstorm.domainXbank.prefixes:keep']).toBe('ordinary-setting');
    expect(await engine.getConfig(legacyKey)).toBe(large);
    const reader = await snapshotConfigReader(engine);
    expect(await reader!.getConfig(legacyKey)).toBe(large);
    expect(await preparationReads(engine).getConfig(legacyKey)).toBe(large);
    await withRequestConfigSnapshot(engine, async () => {
      expect((await engine.getAllConfig())[legacyKey]).toBeUndefined();
      expect(await engine.getConfig(legacyKey)).toBe(large);
      await engine.setConfig(legacyKey, 'updated inventory');
      expect(await engine.getConfig(legacyKey)).toBe('updated inventory');
      expect((await engine.getAllConfig())[legacyKey]).toBeUndefined();
    });
    await engine.unsetConfig(legacyKey);
  });

  test('federated and unscoped inventories have distinct reusable cache identities', async () => {
    await engine.unsetConfig(legacyKey);
    const options = { m: 1, closeSet: [], questionEmbedding: null };
    const federated = await fetchFar(engine, { ...options, sourceIds: ['cache-a'] });
    expect(federated.total_prefixes).toBe(1);
    const unscoped = await fetchFar(engine, options);
    expect(unscoped.total_prefixes).toBe(2);
    const other = await fetchFar(engine, { ...options, sourceId: 'cache-a', sourceIds: ['cache-b'] });
    expect(other.total_prefixes).toBe(1);
    expect(other.pages.map(p => p.source_id)).toEqual(['cache-b']);
    const explicitDefault = await fetchFar(engine, { ...options, sourceId: 'default' });
    expect(explicitDefault.total_prefixes).toBe(0);
    const combined = await fetchFar(engine, { ...options, sourceIds: ['cache-b', 'cache-a'] });
    expect(combined.total_prefixes).toBe(2);
    const reads = spyOn(engine, 'executeRaw');
    try {
      await withRequestConfigSnapshot(engine, async () => {
        const replay = await fetchFar(engine, { ...options, sourceIds: ['cache-a'] });
        expect(replay.total_prefixes).toBe(1);
        expect(replay.pages.map(p => p.source_id)).toEqual(['cache-a']);
        expect((await fetchFar(engine, { ...options, sourceIds: ['cache-a', 'cache-b', 'cache-a'] })).total_prefixes).toBe(2);
        expect((await fetchFar(engine, { ...options, sourceId: 'default' })).total_prefixes).toBe(0);
      });
      expect(reads.mock.calls.filter(([sql]) => sql.includes('SELECT DISTINCT substring'))).toHaveLength(0);
    } finally { reads.mockRestore(); }
  });
});
