/**
 * #7379: `gbrain facts relink --conversation` (and doctor `unlinked_facts`) re-arm an
 * unmemoized miss when a live page was created in the fact's source after the
 * attempt (`conversationTriedSql`, src/core/facts/conversation-memo.ts). That
 * probe runs once per attempt row, and with no pages index on created_at every
 * probe was a sequential scan of pages: a few thousand attempts over a large
 * brain hit statement_timeout, dry run included. Protects: initSchema leaves a
 * valid partial index on pages (source_id, created_at) WHERE deleted_at IS NULL,
 * and the real re-arm probe reads pages through it. The plan is read at an SSD
 * random_page_cost (1.1, as managed Postgres ships) on an analyzed but not
 * vacuumed table: at the default cost the choice rides the visibility map,
 * which VACUUM cannot set while another snapshot is open (a busy CI database),
 * so the plan flipped between this index and a Seq Scan. PGLite always,
 * Postgres when DATABASE_URL is set (testBackends).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { conversationTriedSql } from '../src/core/facts/conversation-memo.ts';
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

describe('#7379 pages (source_id, created_at) index for the relink re-arm probe', () => {
  for (const backend of backends) {
    const engineFor = () => engines.find(e => e.backend === backend)!.engine;

    test(`[${backend}] initSchema builds a valid live-page (source_id, created_at) index`, async () => {
      const rows = await engineFor().executeRaw<{ indexdef: string; valid: boolean }>(
        `SELECT i.indexdef, x.indisvalid AS valid FROM pg_indexes i JOIN pg_index x ON x.indexrelid = to_regclass(i.indexname)
          WHERE i.tablename = 'pages' AND i.indexname = 'pages_source_created_idx'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.valid).toBe(true);
      expect(rows[0]!.indexdef).toContain('(source_id, created_at)');
      expect(rows[0]!.indexdef).toContain('WHERE (deleted_at IS NULL)');
    });

    test(`[${backend}] upgrading a brain without the index builds it online`, async () => {
      const engine = engineFor();
      const latest = await engine.getConfig('version');
      const version = MIGRATIONS.find(m => m.name === 'pages_source_created_index')!.version;
      await engine.executeRaw('DROP INDEX pages_source_created_idx');
      await engine.setConfig('version', String(version - 1));
      await runMigrations(engine);
      const [row] = await engine.executeRaw<{ valid: boolean }>(`SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass('pages_source_created_idx')`);
      expect(row?.valid).toBe(true);
      expect(await engine.getConfig('version')).toBe(latest);
    });

    test(`[${backend}] the conversation re-arm probe reads pages through that index`, async () => {
      const engine = engineFor();
      // Page rows as wide as real ones, created in insertion order; without the
      // index the probe reads pages with a per-probe Seq Scan (the reported plan).
      await engine.executeRaw(
        `INSERT INTO pages (source_id, slug, type, title, compiled_truth, created_at)
         SELECT 'default', 'notes/idx-probe-' || g, 'note', 'Probe ' || g, repeat('x', 1500), now() - ((501 - g) || ' minutes')::interval
           FROM generate_series(1, 500) g`);
      await engine.executeRaw('ANALYZE pages');
      const plan = await engine.transaction(async tx => {
        await tx.executeRaw('SET LOCAL random_page_cost = 1.1');
        return (await tx.executeRaw<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT f.id FROM facts f WHERE ${conversationTriedSql}`))
          .map(r => r['QUERY PLAN']).join('\n');
      });
      const probe = plan.slice(plan.indexOf('SubPlan'));
      expect(probe).toMatch(/Index (Only )?Scan using pages_source_created_idx on pages np/);
      expect(probe).not.toContain('Seq Scan on pages np');
    });
  }
});
