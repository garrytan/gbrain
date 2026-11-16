/**
 * #7838: brainstorm's slug-prefix cache stays out of the `config` table.
 *
 * Every command reads the whole config table (loadConfigSnapshot), so a cached
 * prefix list there travelled with every `gbrain` call on a large brain. The
 * cache now lives in the process, keyed by the whole source scope (a federated
 * `sourceIds` call no longer shares the unscoped entry), and the next run
 * removes the row an older version wrote.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { _resetPrefixCacheForTests, fetchFar } from '../../src/core/brainstorm/domain-bank.ts';

let engine: PGLiteEngine;
const LEGACY_KEY = 'brainstorm.domain_bank.prefixes:default';

async function seed(slug: string, sourceId = 'default'): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ($1, $2, 'note', $1, 'body', '')`, [slug, sourceId]);
}

const far = (scope: { sourceId?: string; sourceIds?: string[] } = {}) =>
  fetchFar(engine, { m: 1, closeSet: [], questionEmbedding: null, ...scope });

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-a', 'source-a') ON CONFLICT DO NOTHING");
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  mock.restore();
  _resetPrefixCacheForTests();
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'brainstorm.%'");
});

describe('brainstorm prefix cache (#7838)', () => {
  test('the prefix list is never written to the config table every command reads', async () => {
    for (let i = 0; i < 40; i++) await seed(`topic-${i}/page-example`);
    const setConfig = spyOn(engine, 'setConfig');
    expect((await far()).total_prefixes).toBe(40);
    expect(setConfig.mock.calls.map(([key]) => key).filter(key => key.startsWith('brainstorm.'))).toEqual([]);
    expect(Object.keys(await engine.getAllConfig()).filter(key => key.startsWith('brainstorm.'))).toEqual([]);
  });

  test('a second call in the same process reuses the enumeration', async () => {
    await seed('alpha/page-example');
    const executeRaw = spyOn(engine, 'executeRaw');
    await far();
    await far();
    expect(executeRaw.mock.calls.filter(([sql]) => String(sql).includes('SELECT DISTINCT substring(slug')).length).toBe(1);
  });

  test('a federated sourceIds call and an unscoped call keep separate entries', async () => {
    await seed('alpha/page-example');
    await seed('beta/page-example', 'source-a');
    expect((await far({ sourceIds: ['source-a'] })).total_prefixes).toBe(1);
    expect((await far()).total_prefixes).toBe(2);
  });

  test('the next run removes the row an older version cached in config', async () => {
    await seed('alpha/page-example');
    await engine.setConfig(LEGACY_KEY, JSON.stringify({ prefixes: ['stale/page-example'], cached_at: Date.now() }));
    expect((await far()).total_prefixes).toBe(1);
    expect(await engine.getConfig(LEGACY_KEY)).toBeNull();
  });
});
