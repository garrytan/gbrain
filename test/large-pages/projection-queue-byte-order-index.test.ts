/**
 * The projection queue's walks compare and order `slug COLLATE "C"` (byte order on every engine). The primary key of
 * page_projection_jobs is (source_incarnation, slug) in the database's default collation, so it cannot serve them; v351
 * adds idx_page_projection_jobs_slug_c on (source_incarnation, slug COLLATE "C").
 *
 * 1. Protects: initSchema leaves a valid idx_page_projection_jobs_slug_c, and on Postgres the resident window read
 *    (`projectionWindowFragment`, run by selectProjectionWindowJobs) reads its forward and wrap lanes through that index
 *    over a seeded, analyzed queue. CI Postgres sorts text in en_US.utf8; the default collation and "C" are different
 *    collations to the planner either way, so only this index matches the "C" comparison.
 * 2. Fails when: the index is missing or its collation is not "C": the lanes then read the whole queue and sort it
 *    (the control below drops the index and sees exactly that), and rerunning v351 rebuilds it.
 * Runs on PGLite (index present), and on Postgres when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MIGRATIONS, runMigrations } from '../../src/core/migrate.ts';
import { projectionWindowFragment } from '../../src/core/engine-sql/persistence-housekeeping.ts';
import { renderFragment } from '../../src/core/engine-sql/fragment.ts';
import { PAGE_PROJECTION_JOBS_BYTE_ORDER_INDEX } from '../../src/core/schema-migrations/v351-projection-jobs-byte-order-index.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const INDEX = PAGE_PROJECTION_JOBS_BYTE_ORDER_INDEX.name;

for (const kind of testBackends()) {
  describe(`projection queue byte-order index (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('initSchema builds a valid index on (source_incarnation, slug COLLATE "C")', async () => {
      const rows = await engine.executeRaw<{ indexdef: string; valid: boolean }>(
        `SELECT i.indexdef, x.indisvalid AS valid FROM pg_indexes i JOIN pg_index x ON x.indexrelid = to_regclass(i.indexname)
          WHERE i.tablename = 'page_projection_jobs' AND i.indexname = $1`, [INDEX]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.valid).toBe(true);
      expect(rows[0]!.indexdef).toContain('(source_incarnation, slug COLLATE "C")');
    });

    if (kind !== 'postgres') return;

    const windowPlan = async (incarnation: string): Promise<string> => {
      const { text, params } = renderFragment(projectionWindowFragment(
        { after: { source_incarnation: incarnation, slug: 'notes/p5' }, highWater: null }, true));
      return (await engine.executeRaw<{ 'QUERY PLAN': string }>(`EXPLAIN ${text}`, params)).map(r => r['QUERY PLAN']).join('\n');
    };
    // A lane that cannot use the index sorts the queue on its own key (the planner names the lanes' scans j_1, j_2).
    const LANE_SORT = /Sort Key: j(_\d+)?\.source_incarnation, j(_\d+)?\.slug COLLATE "C"/;
    const indexScans = (plan: string) => plan.split('\n').filter(line => line.includes(`Index Scan using ${INDEX} on page_projection_jobs`)).length;

    test('the resident window reads its forward and wrap lanes through the index', async () => {
      const [source] = await engine.executeRaw<{ incarnation: string }>(`SELECT incarnation::text AS incarnation FROM sources WHERE id='default'`);
      await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason,updated_at)
        SELECT $1::uuid,'notes/p'||g,gen_random_uuid(),'content',now()-interval '1 hour'+g*interval '1 ms' FROM generate_series(1,20000) g`,
      [source!.incarnation]);
      await engine.executeRaw('ANALYZE page_projection_jobs');
      const plan = await windowPlan(source!.incarnation);
      expect(indexScans(plan)).toBeGreaterThanOrEqual(2);
      expect(plan).not.toMatch(LANE_SORT);
    }, 120_000);

    test('control: without the index the lanes scan and sort the queue, and rerunning v351 rebuilds it', async () => {
      const [source] = await engine.executeRaw<{ incarnation: string }>(`SELECT incarnation::text AS incarnation FROM sources WHERE id='default'`);
      const latest = await engine.getConfig('version');
      await engine.executeRaw(`DROP INDEX ${INDEX}`);
      const bare = await windowPlan(source!.incarnation);
      expect(indexScans(bare)).toBe(0);
      expect(bare).toMatch(LANE_SORT);
      const version = MIGRATIONS.find(m => m.name === 'projection_jobs_byte_order_index')!.version;
      await engine.setConfig('version', String(version - 1));
      await runMigrations(engine);
      const [row] = await engine.executeRaw<{ valid: boolean }>('SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass($1)', [INDEX]);
      expect(row?.valid).toBe(true);
      expect(await engine.getConfig('version')).toBe(latest);
      expect(indexScans(await windowPlan(source!.incarnation))).toBeGreaterThanOrEqual(2);
    }, 120_000);
  });
}
