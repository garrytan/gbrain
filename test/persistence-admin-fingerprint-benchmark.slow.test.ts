import { expect, test } from 'bun:test';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import type { SqlEngine } from '../src/core/persistence/model.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

// Explicit opt-in: generated data only, in a disposable test database.
const enabled = process.env.GBRAIN_TEST_WRITER_MANIFEST_BENCHMARK === '1';
(enabled ? test : test.skip)('generated writer manifests preserve fingerprints with bounded inspection work', async () => {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to a disposable test database');
  const store = await isolatedPersistencePostgres(process.env.DATABASE_URL);
  const engine = store.engine;
  try {
    let currentSql = '';
    await writerAdminState({ executeRaw: async (sql: string) => {
      currentSql = sql; return [{ state: '{}' }];
    } } as SqlEngine);
    const expression = "encode(sha256(convert_to(manifest::text,'UTF8')), 'hex')";
    expect(currentSql).toContain(expression);
    const legacySql = currentSql.replace(expression, 'manifest');
    await engine.executeRaw(`INSERT INTO persistence_worktrees(id,manifest)
      VALUES('11111111-1111-4111-8111-111111111111','{}')`);
    for (const count of [1_000, 10_000, 100_000]) {
      await engine.executeRaw(`UPDATE persistence_worktrees SET manifest=(SELECT jsonb_build_object('files',
        jsonb_object_agg('notes/synthetic-'||i||'.md',jsonb_build_object('hash',repeat(md5(i::text),2),'slug','notes/synthetic-'||i)))
        FROM generate_series(1,$1::int) i)`, [count]);
      const samples: Record<string, number[]> = { legacy: [], current: [] };
      for (let trial = 0; trial < 3; trial++) {
        // Alternate order so one implementation does not always warm the cache.
        for (const name of trial % 2 ? ['current', 'legacy'] : ['legacy', 'current']) {
          const start = performance.now();
          await engine.executeRaw(name === 'legacy' ? legacySql : currentSql);
          samples[name].push(performance.now() - start);
        }
      }
      const before = await writerAdminState(engine);
      await engine.executeRaw(`UPDATE persistence_worktrees SET manifest=jsonb_set(manifest,
        '{files,notes/synthetic-1.md,hash}','"changed"')`);
      expect(await writerAdminState(engine)).not.toBe(before);
      console.info(JSON.stringify({ synthetic_files: count, milliseconds: samples }));
    }
  } finally { await store.close(); }
}, 300_000);
