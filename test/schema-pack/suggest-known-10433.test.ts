import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runSuggest } from '../../src/core/schema-pack/suggest.ts';
import { runDetect } from '../../src/core/schema-pack/detect.ts';
import { runSchemaSuggestPhase } from '../../src/core/cycle/schema-suggest.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { testBackends } from '../helpers/test-backends.ts';

const home = mkdtempSync(join(tmpdir(), 'schema-suggest-known-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined };
const packName = 'suggest-known-10433';
const backends = testBackends();
beforeAll(async () => {
  if (backends.includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
  const dir = join(home, '.gbrain', 'schema-packs', packName); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({ api_version: 'gbrain-schema-pack-v1', name: packName, version: '1.0.0',
    extends: 'gbrain-base', page_types: [
      { name: 'ingredient', primitive: 'entity', path_prefixes: ['ingredients/', 'literal_%/'], aliases: ['pantry-item'] },
      { name: 'recipe', primitive: 'entity', path_prefixes: ['recipes/known/'], aliases: [] },
    ], takes_kinds: ['fact', 'take', 'bet', 'hunch'] }));
}, 120_000);
afterAll(async () => { for (const engine of engines) await engine.disconnect(); await closePostgres?.(); rmSync(home, { recursive: true, force: true }); });

async function fixture(engine: BrainEngine, source: string, groups: Array<[string, string | null, number]>) {
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [source]);
  await engine.setConfig(`schema_pack.source.${source}`, packName);
  for (const [prefix, type, count] of groups) {
    await engine.executeRaw(`INSERT INTO pages(source_id,slug,title,type,compiled_truth,frontmatter)
      SELECT $1,$2 || n::text,'Synthetic page', COALESCE($3::text,''),'Synthetic body','{}'::jsonb FROM generate_series(1,$4::int) n`, [source, prefix, type, count]);
  }
}

for (const label of ['shared schema suggestions']) describe(label, () => {
  test('source pack prefixes, inherited types and aliases suppress duplicate type suggestions, not real gaps', async () => withEnv(env, async () => {
    for (const engine of engines) {
      await fixture(engine, 'known', [['ingredients/', null, 6], ['elsewhere/', 'ingredient', 6], ['alias/', 'pantry-item', 6],
        ['inherited/', 'company', 6], ['concepts/', 'concept', 6], ['gap/', 'unregistered', 6], ['Ingredient/', null, 6], ['pantry_item/', null, 6]]);
      const before = await runDetect(engine, { sourceId: 'known' }); expect(before.prefixes).toHaveLength(8);
      const result = await runSuggest(engine, { sourceId: 'known' });
      expect(result.suggestions.map(s => s.summary)).toEqual(['Add type `gap` for 6 pages under `gap/`']);
      expect(await runSchemaSuggestPhase(engine, { sourceId: 'known', dryRun: true })).toMatchObject({ suggestions_emitted: 1, skipped: false });
      expect((await runDetect(engine, { sourceId: 'known' })).prefixes).toEqual(before.prefixes);
    }
  }), 120_000);
  test('partial nested prefix and literal wildcard spelling preserve unknown siblings and untyped rows', async () => withEnv(env, async () => {
    for (const engine of engines) {
      await fixture(engine, 'nested', [['recipes/known/', null, 8], ['recipes/new/', null, 5], ['literal_%/', null, 7],
        ['literal-xx/', null, 5], ['mixed/typed/', 'ingredient', 8], ['mixed/untyped/', null, 5]]);
      const result = await runSuggest(engine, { sourceId: 'nested' });
      expect(result.suggestions.map(s => s.summary).sort()).toEqual([
        'Add type `literal-xx` for 5 pages under `literal-xx/`', 'Add type `mixed` for 5 pages under `mixed/`', 'Add type `recipes` for 5 pages under `recipes/`']);
    }
  }), 120_000);
  test('known prefixes do not consume the bounded candidate slots and another source keeps its own pack', async () => withEnv(env, async () => {
    for (const engine of engines) {
      await fixture(engine, 'crowded', [...Array.from({ length: 51 }, (_, n) => [`known${n}/`, 'ingredient', 7] as [string, string, number]), ['tail-gap/', null, 5]]);
      expect((await runSuggest(engine, { sourceId: 'crowded' })).suggestions.map(s => s.summary)).toEqual(['Add type `tail-gap` for 5 pages under `tail-gap/`']);
      await fixture(engine, 'other', [['elsewhere/', 'ingredient', 5]]);
      await engine.setConfig('schema_pack.source.other', 'gbrain-base');
      expect((await runSuggest(engine, { sourceId: 'other' })).suggestions.map(s => s.summary)).toEqual(['Add type `elsewhere` for 5 pages under `elsewhere/`']);
    }
  }), 120_000);
});
