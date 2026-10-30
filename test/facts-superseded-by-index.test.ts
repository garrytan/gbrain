/**
 * facts.superseded_by is a self-referencing FK (ON DELETE SET NULL). Deleting a fact makes the
 * database find the rows that point at it (the RI action `UPDATE ONLY facts SET superseded_by = NULL
 * WHERE superseded_by = $1`), and clearConversationFacts' `EXISTS (... g.superseded_by = f.id)` guard
 * asks the same question. With no index on superseded_by each lookup was a Seq Scan of the whole facts
 * table, so every fact DELETE cost grew with the brain. Protects: initSchema leaves a valid partial index
 * idx_facts_superseded_by, and both lookup shapes plan an index scan on it over a seeded, analyzed facts
 * table. Control: without the index the same statements read facts with a Seq Scan, and rerunning the
 * migration from the version before it rebuilds the index. PGLite always, Postgres when DATABASE_URL is
 * set (testBackends; test/e2e/facts-superseded-by-index-postgres.test.ts runs the Postgres arm).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: Array<{ backend: string; engine: BrainEngine }> = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema();
    engines.push({ backend: 'pglite', engine });
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push({ backend: 'postgres', engine: pg.engine }); closePostgres = pg.close;
  }
}, 120_000);

afterAll(async () => {
  for (const { engine } of engines) await engine.disconnect();
  await closePostgres?.();
});

async function plans(engine: BrainEngine): Promise<string[]> {
  const [target] = await engine.executeRaw<{ id: number }>('SELECT max(superseded_by)::int AS id FROM facts');
  const id = Number(target!.id);
  const explain = async (statement: string) => (await engine.executeRaw<{ 'QUERY PLAN': string }>(`EXPLAIN ${statement}`))
    .map(r => r['QUERY PLAN']).join('\n');
  return [
    await explain(`SELECT 1 FROM facts WHERE superseded_by = ${id}`),
    await explain(`UPDATE ONLY facts SET superseded_by = NULL WHERE superseded_by = ${id}`),
  ];
}

describe('facts (superseded_by) partial index for fact deletes', () => {
  for (const backend of backends) {
    const engineFor = () => engines.find(e => e.backend === backend)!.engine;

    test(`[${backend}] initSchema builds a valid partial index on facts (superseded_by)`, async () => {
      const rows = await engineFor().executeRaw<{ indexdef: string; valid: boolean }>(
        `SELECT i.indexdef, x.indisvalid AS valid FROM pg_indexes i JOIN pg_index x ON x.indexrelid = to_regclass(i.indexname)
          WHERE i.tablename = 'facts' AND i.indexname = 'idx_facts_superseded_by'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.valid).toBe(true);
      expect(rows[0]!.indexdef).toContain('(superseded_by)');
      expect(rows[0]!.indexdef).toContain('WHERE (superseded_by IS NOT NULL)');
    });

    test(`[${backend}] the superseded_by lookup and the FK set-null action read facts through that index`, async () => {
      const engine = engineFor();
      await engine.executeRaw(
        `INSERT INTO facts (source_id, fact, source, context)
         SELECT 'default', 'Probe fact ' || g, 'superseded-index-probe', repeat('x', 200) FROM generate_series(1, 20000) g`);
      await engine.executeRaw(
        `UPDATE facts f SET superseded_by = n.id, expired_at = now() FROM facts n
          WHERE f.source = 'superseded-index-probe' AND f.id % 20 = 0 AND n.id = f.id + 1`);
      await engine.executeRaw('ANALYZE facts');
      for (const plan of await plans(engine)) {
        expect(plan).toMatch(/Index (Only )?Scan using idx_facts_superseded_by on facts/);
        expect(plan).not.toContain('Seq Scan on facts');
      }
    });

    test(`[${backend}] control: without the index both lookups Seq Scan facts, and the migration rebuilds it`, async () => {
      const engine = engineFor();
      const latest = await engine.getConfig('version');
      await engine.executeRaw('DROP INDEX idx_facts_superseded_by');
      for (const plan of await plans(engine)) expect(plan).toContain('Seq Scan on facts');
      const version = MIGRATIONS.find(m => m.name === 'facts_superseded_by_index')!.version;
      await engine.setConfig('version', String(version - 1));
      await runMigrations(engine);
      const [row] = await engine.executeRaw<{ valid: boolean }>(`SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass('idx_facts_superseded_by')`);
      expect(row?.valid).toBe(true);
      expect(await engine.getConfig('version')).toBe(latest);
      for (const plan of await plans(engine)) expect(plan).toMatch(/Index (Only )?Scan using idx_facts_superseded_by on facts/);
    });
  }
});
