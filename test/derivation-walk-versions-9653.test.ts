/**
 * #9653: a purge's derivation walk collects retained versions after the live walk, under their own limit, so a concept
 * with a long history never truncates the walk before it reaches a live row still built from the purged input. PGLite
 * and, with DATABASE_URL, Postgres. Synthetic ids only.
 */
import { describe, expect, test } from 'bun:test';
import { derivedRowsFrom } from '../src/core/facts/derivation-inputs.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`#9653 derivation walk and retained versions (${backend})`, () => {
    test('a live row built from the input is reached even when its versions outnumber the limit', async () => {
      await withEnv({ DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          const edges = [...Array.from({ length: 5 }, (_, i) => ['page_versions', String(9000 + i)]), ['pages', '8001'], ['facts', '7001']];
          for (const [table, id] of edges) {
            await engine.executeRaw(`INSERT INTO derivation_inputs(derived_table,derived_id,input_table,input_id,source_id) VALUES($1,$2,'pages','42','default')`, [table, id]);
          }
          const tight = await derivedRowsFrom(engine, [{ table: 'pages', id: '42' }], { limit: 3 });
          expect(tight.rows.filter(r => r.table !== 'page_versions').map(r => `${r.table}:${r.id}`).sort()).toEqual(['facts:7001', 'pages:8001']);
          expect(tight.truncated).toBe(true);
          const roomy = await derivedRowsFrom(engine, [{ table: 'pages', id: '42' }], { limit: 10 });
          expect(roomy).toMatchObject({ truncated: false });
          expect(roomy.rows.filter(r => r.table === 'page_versions').map(r => r.depth)).toEqual([1, 1, 1, 1, 1]);
        } finally { await close(); }
      });
    }, 60_000);
  });
}
