/**
 * Wave C 1H-a: the upgrade path to the git-first migration (git_first_strict_path, provisional v302) from the schema
 * before it, on PGLite and Postgres. A brain at head is taken back to the previous version's shape (the three v302
 * tables, pages.indexed_commit and the 'indexing' request state removed); the test first proves that shape differs from
 * head only by the v302 objects, then writes a page and runs the upgrade two ways, a full boot (`initSchema`, the
 * schema blob then migrations, as an existing brain boots) and migrations alone (`runMigrations`). Either way the catalog
 * reaches head (column ordinals aside: a column dropped and added again takes a new attnum), the request-state check is
 * validated, the page keeps its row with indexed_commit NULL (nothing is backfilled), and a second run applies nothing.
 * Head is read after a repeat boot: on master a repeat boot already re-creates bump_page_generation_clock_fn from the blob
 * with a differently formatted body (pinned by test/pglite-upgrade-replay.test.ts), which is not this migration's.
 * Each backend's brain is opened once; each test returns it to head, so the next one starts from head again.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../../src/core/migrate.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { catalogGoldenView, flattenGoldenView, pgliteCatalogQuery, postgresCatalogQuery } from '../helpers/schema-catalog.ts';
import { snapshotCatalog } from '../helpers/schema-diff.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';

const V302 = /page_pending_heads|page_upload_spool|indexed_commit|persistence_requests_state_check/;
const migration = MIGRATIONS.find(m => m.name === 'git_first_strict_path')!;

const DOWNGRADE = [
  'DROP TABLE page_upload_spool_parts',
  'DROP TABLE page_upload_spools',
  'DROP TABLE page_pending_heads',
  'ALTER TABLE pages DROP COLUMN indexed_commit',
  'ALTER TABLE persistence_requests DROP CONSTRAINT persistence_requests_state_check',
  `ALTER TABLE persistence_requests ADD CONSTRAINT persistence_requests_state_check
    CHECK (state IN ('queued','deferred','running','recovering','committed','conflict','failed','cancelled'))`,
];

async function flatCatalog(query: Parameters<typeof snapshotCatalog>[0]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [key, value] of flattenGoldenView(catalogGoldenView(await snapshotCatalog(query))))
    out.set(key, /^tables\.[^.]+\.columns\[/.test(key) ? value.replace(/^\d+ /, '') : value);
  return out;
}

for (const backend of testBackends()) describe(`[${backend}] upgrade path to the git-first migration`, () => {
  let engine: BrainEngine;
  let catalog: () => Promise<Map<string, string>>;
  let admin: ReturnType<typeof postgres> | null = null;
  const database = `gbrain_test_v302_${randomUUID().replace(/-/g, '')}`;

  beforeAll(async () => {
    if (backend === 'pglite') {
      const pglite = new PGLiteEngine();
      await pglite.connect({});
      engine = pglite;
      catalog = () => flatCatalog(pgliteCatalogQuery(pglite));
    } else {
      const url = requirePostgresTestDatabase();
      assertSafeE2eDatabaseUrl(url);
      admin = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
      await admin.unsafe(`CREATE DATABASE ${database}`);
      const at = new URL(url); at.pathname = `/${database}`;
      const pg = new PostgresEngine();
      await pg.connect({ database_url: at.toString(), poolSize: 2 });
      engine = pg;
      catalog = () => flatCatalog(postgresCatalogQuery(pg.sql));
    }
    await engine.initSchema();
  }, 300_000);

  afterAll(async () => {
    await engine?.disconnect();
    if (admin) { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end({ timeout: 5 }); }
  });

  test('the migration is the newest one, so the shape before it is the previous release\'s', () => {
    expect(migration.version).toBe(LATEST_VERSION);
  });

  for (const how of ['boot', 'migrations'] as const) {
    test(`from the previous schema with a page: ${how === 'boot' ? 'a full boot (initSchema)' : 'migrations alone (runMigrations)'} reaches head`, async () => {
      const slug = `notes/before-upgrade-${how}`;
      await engine.initSchema();
      const head = await catalog();
      for (const statement of DOWNGRADE) await engine.executeRaw(statement);
      await engine.setConfig('version', String(migration.version - 1));
      const before = await catalog();
      const differing = [...new Set([...head.keys(), ...before.keys()])].filter(key => head.get(key) !== before.get(key));
      expect(differing.length).toBeGreaterThan(0);
      expect(differing.filter(key => !V302.test(`${key} ${head.get(key) ?? ''} ${before.get(key) ?? ''}`))).toEqual([]);
      expect([...before.keys()].filter(key => !head.has(key))).toEqual([]);

      await engine.putPage(slug, { type: 'note', title: 'Before upgrade', compiled_truth: 'Written before the git-first migration.\n', timeline: '' });
      const [page] = await engine.executeRaw<{ id: number; content_hash: string }>('SELECT id, content_hash FROM pages WHERE slug = $1', [slug]);

      if (how === 'boot') await engine.initSchema();
      else expect((await runMigrations(engine)).applied).toBe(1);
      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      expect(await catalog()).toEqual(head);
      const [check] = await engine.executeRaw<{ validated: boolean; def: string }>(
        "SELECT convalidated AS validated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'persistence_requests_state_check'");
      expect(check?.validated).toBe(true);
      expect(check?.def).toContain('indexing');
      expect(await engine.executeRaw('SELECT id, content_hash, indexed_commit FROM pages WHERE slug = $1', [slug]))
        .toEqual([{ id: page!.id, content_hash: page!.content_hash, indexed_commit: null }]);
      expect((await runMigrations(engine)).applied).toBe(0);
      expect(await catalog()).toEqual(head);
    }, 300_000);
  }
});
