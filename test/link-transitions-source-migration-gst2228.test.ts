/**
 * GST-2228: migration v302 adds link_transitions.link_source and widens the identity index to include it, without
 * holding a long lock on a large brain and without rewriting a row.
 *
 * 1. Protects: the column is added on its own (metadata only), the widened index is built online under a temporary
 *    name (CONCURRENTLY on Postgres), and one short transaction swaps it into the canonical name. A rerun after the run
 *    stopped at any step finishes the job, and an INVALID leftover of an interrupted concurrent build is dropped and
 *    rebuilt. Statements stored before the column keep a NULL source and are not rewritten.
 * 2. Writes between the column and the swap: the old index still keys a statement without its source, so the projection
 *    writes statements without a source there, as before the migration, and never deletes a stored statement for a
 *    replacement the old index would drop; the page's next write after the swap labels them per row.
 * 3. Real seams: runMigrations and buildIndexOnline on PGLite, and on Postgres when DATABASE_URL is set (testBackends).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { buildIndexOnline } from '../src/core/schema-migrations/helpers.ts';
import { LINK_TRANSITIONS_IDENTITY_NEXT_INDEX } from '../src/core/schema-migrations/v302-link-transitions-source.ts';
import { projectLinksFence } from '../src/core/links-fence-projection.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const OLD_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS link_transitions_identity_idx
  ON link_transitions (origin_page_id, from_page_id, to_page_id, link_type, kind, occurred_on, producer) NULLS NOT DISTINCT`;
const backends = testBackends();
const engines: Array<{ backend: string; engine: BrainEngine; alice: number; acme: number }> = [];
let closePostgres: (() => Promise<void>) | undefined;

async function withPages(backend: string, engine: BrainEngine) {
  const page = (slug: string, title: string, type: string) => engine.putPage(slug, { type, title, compiled_truth: title, timeline: '', frontmatter: {} } as never, { sourceId: 'default' });
  const alice = Number((await page('people/alice-example', 'Alice Example', 'person')).id);
  const acme = Number((await page('companies/acme-example', 'Acme Example', 'company')).id);
  engines.push({ backend, engine, alice, acme });
}

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema();
    await withPages('pglite', engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    closePostgres = pg.close;
    await withPages('postgres', pg.engine);
  }
}, 120_000);

afterAll(async () => {
  for (const { backend, engine } of engines) if (backend === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

describe('GST-2228 v302 link_transitions_source', () => {
  test('v302 runs outside a transaction, through its handler', () => {
    const m = MIGRATIONS.find(x => x.name === 'link_transitions_source');
    expect({ found: !!m, transaction: m?.transaction, sql: m?.sql, handler: typeof m?.handler }).toEqual({ found: true, transaction: false, sql: '', handler: 'function' });
  });

  for (const backend of backends) {
    const brain = () => engines.find(e => e.backend === backend)!;
    const identity = async () => {
      const { engine } = brain();
      const [row] = await engine.executeRaw<{ def: string | null; valid: boolean | null; next: boolean; column: boolean }>(
        `SELECT pg_get_indexdef(to_regclass('link_transitions_identity_idx')) AS def,
                (SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('link_transitions_identity_idx')) AS valid,
                to_regclass('link_transitions_identity_next_idx') IS NOT NULL AS next,
                EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='link_transitions' AND column_name='link_source') AS column`);
      return { ...row!, def: row!.def?.replace(/ public\./, ' ') ?? null };
    };
    const WIDENED = 'CREATE UNIQUE INDEX link_transitions_identity_idx ON link_transitions USING btree (origin_page_id, from_page_id, to_page_id, link_type, link_source, kind, occurred_on, producer) NULLS NOT DISTINCT';
    const DONE = { def: WIDENED, valid: true, next: false, column: true };
    /** The schema a brain one migration before v302 has: no link_source, the seven-column identity index. */
    const beforeV302 = async () => {
      const { engine } = brain();
      await engine.executeRaw('DELETE FROM link_transitions');
      await engine.executeRaw('DROP INDEX IF EXISTS link_transitions_identity_next_idx');
      await engine.executeRaw('ALTER TABLE link_transitions DROP COLUMN IF EXISTS link_source');
      await engine.executeRaw(OLD_INDEX);
      await engine.setConfig('version', String(MIGRATIONS.find(m => m.name === 'link_transitions_source')!.version - 1));
    };
    const latest = String(Math.max(...MIGRATIONS.map(m => m.version)));

    test(`[${backend}] a fresh schema has the widened index and no temporary index`, async () => {
      expect(await identity()).toEqual(DONE);
    });

    test(`[${backend}] upgrading from the previous schema adds the column, swaps the index and rewrites no row`, async () => {
      const { engine, alice, acme } = brain();
      await beforeV302();
      await engine.executeRaw(`INSERT INTO link_transitions (source_id, from_page_id, to_page_id, link_type, kind, occurred_on, producer, origin_page_id)
        VALUES ('default', $1, $2, 'works_at', 'start', '2020-01-01', 'manual', $1)`, [alice, acme]);
      const [before] = await engine.executeRaw<{ id: string; xmin: string }>('SELECT id::text, xmin::text FROM link_transitions');
      await runMigrations(engine);
      expect(await identity()).toEqual(DONE);
      expect(await engine.executeRaw('SELECT id::text, xmin::text, link_source FROM link_transitions')).toEqual([{ ...before, link_source: null }]);
      expect(await engine.getConfig('version')).toBe(latest);
    });

    test(`[${backend}] stopped after the column was added: a rerun swaps the index`, async () => {
      const { engine } = brain();
      await beforeV302();
      await engine.executeRaw('ALTER TABLE link_transitions ADD COLUMN link_source TEXT');
      await runMigrations(engine);
      expect(await identity()).toEqual(DONE);
    });

    test(`[${backend}] stopped after the build, before the swap: a rerun swaps the built index in`, async () => {
      const { engine } = brain();
      await beforeV302();
      await engine.executeRaw('ALTER TABLE link_transitions ADD COLUMN link_source TEXT');
      expect(await buildIndexOnline(engine, 302, LINK_TRANSITIONS_IDENTITY_NEXT_INDEX)).toBe('created');
      expect((await identity()).next).toBe(true);
      await runMigrations(engine);
      expect(await identity()).toEqual(DONE);
    });

    if (backend === 'postgres') {
      test('[postgres] an INVALID leftover of an interrupted concurrent build is dropped and rebuilt', async () => {
        const { engine, alice, acme } = brain();
        await beforeV302();
        await engine.executeRaw('ALTER TABLE link_transitions ADD COLUMN link_source TEXT');
        await engine.executeRaw('DROP INDEX link_transitions_identity_idx');
        const duplicate = `INSERT INTO link_transitions (source_id, from_page_id, to_page_id, link_type, kind, occurred_on, producer, origin_page_id)
          VALUES ('default', $1, $2, 'works_at', 'start', '2020-01-01', 'manual', $1)`;
        await engine.executeRaw(duplicate, [alice, acme]);
        await engine.executeRaw(duplicate, [alice, acme]);
        await expect(engine.executeRaw(LINK_TRANSITIONS_IDENTITY_NEXT_INDEX.sql.replace('CREATE UNIQUE INDEX', 'CREATE UNIQUE INDEX CONCURRENTLY'))).rejects.toThrow();
        const [leftover] = await engine.executeRaw<{ valid: boolean }>(`SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass('link_transitions_identity_next_idx')`);
        expect(leftover).toEqual({ valid: false });
        await engine.executeRaw('DELETE FROM link_transitions WHERE id = (SELECT max(id) FROM link_transitions)');
        await engine.executeRaw(OLD_INDEX);
        await runMigrations(engine);
        expect(await identity()).toEqual(DONE);
      });
    }

    test(`[${backend}] a links-section write between the column and the swap keeps one sourceless statement per date, and the next write after the swap labels each row's`, async () => {
      const { engine, alice } = brain();
      const rows = [
        { to: 'companies/acme-example', type: 'works_at', source: 'manual', context: 'typed in', validFrom: '2020-01-01' },
        { to: 'companies/acme-example', type: 'works_at', source: 'crm-import', context: 'from the import', validFrom: '2020-01-01' },
      ];
      const statements = async () => (await engine.executeRaw<{ source: string | null }>(
        "SELECT link_source AS source FROM link_transitions WHERE origin_page_id=$1 AND producer='manual' ORDER BY 1", [alice])).map(r => r.source);
      await beforeV302();
      await engine.executeRaw('ALTER TABLE link_transitions ADD COLUMN link_source TEXT');
      await projectLinksFence(engine, { id: alice, source_id: 'default' }, rows);
      expect(await statements()).toEqual([null]);
      await runMigrations(engine);
      expect(await identity()).toEqual(DONE);
      await projectLinksFence(engine, { id: alice, source_id: 'default' }, rows);
      expect(await statements()).toEqual(['crm-import', 'manual']);
      await engine.executeRaw('DELETE FROM links WHERE origin_page_id=$1', [alice]);
    });
  }
});
