/**
 * #7702: `gbrain sources purge <id>` of a large archived source ran its one
 * cascading `DELETE FROM sources` under the topology transaction's 5 s
 * statement cap. A source whose pages, chunks, links and timeline rows take
 * longer than that to delete was cancelled (SQLSTATE 57014) on every run and
 * reported `write_pending` with "retry after the current writer finishes",
 * advice no retry can satisfy.
 *
 * Protects: the purge's (and remove's) bulk delete runs without the statement
 * cap while the 1 s lock_timeout stays, the cap is back for the statements
 * after it, the purge stays one atomic transaction, and a statement timeout
 * in a topology transaction reports `write_interrupted` (not retryable, no
 * "retry after the writer" advice) while a lock wait still reports
 * `write_pending`.
 * Seams: the cascade's cost is a BEFORE DELETE trigger on `pages`. PGLite does
 * not enforce statement_timeout, so there the trigger raises 57014 whenever
 * the statement still runs under a finite cap (and fails the test if the lock
 * bound was dropped). On Postgres a second case makes the cascade really take
 * longer than the 5 s cap (pg_sleep), so the server cancels it. PGLite always,
 * Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { topologyTransaction } from '../src/core/persistence/topology-transaction.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;
const SOURCE = 'source-a';
const PAGES = 40;

for (const flavor of ['pglite', ...(databaseUrl ? ['postgres'] : [])] as const) describe(`source purge past the topology statement cap (${flavor})`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (flavor === 'postgres') {
      const fixture = await isolatedPersistencePostgres(databaseUrl!);
      engine = fixture.engine; closePostgres = fixture.close;
    } else {
      engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    }
  }, 120_000);
  afterAll(async () => {
    if (!engine) return;
    await disposePersistenceConsumer(engine);
    if (closePostgres) await closePostgres(); else await engine.disconnect();
  });

  async function fixture(trigger: string, run: () => Promise<void>): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-cap-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        await resetPgliteState(engine as PGLiteEngine);
        await registerLocalWriter(engine, 'cli');
        const root = join(home, 'canonical'); mkdirSync(root);
        writeFileSync(join(root, 'alice-example.md'), '---\ntitle: Alice Example\ntype: note\n---\n\nCanonical\n');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [SOURCE, root]);
        await claimWorktree(engine, SOURCE, root);
        await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title) SELECT $1,'notes/page-'||n,'note','Page '||n FROM generate_series(1,${PAGES}) n`, [SOURCE]);
        await engine.executeRaw("INSERT INTO pages(slug,type,title) VALUES('notes/survivor','note','Survivor')");
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await engine.executeRaw(trigger);
        await engine.executeRaw('DROP TRIGGER IF EXISTS lane_7702_cascade_cost ON pages');
        await engine.executeRaw('CREATE TRIGGER lane_7702_cascade_cost BEFORE DELETE ON pages FOR EACH ROW EXECUTE FUNCTION lane_7702_cascade_cost()');
        try { await run(); } finally { await engine.executeRaw('DROP TRIGGER IF EXISTS lane_7702_cascade_cost ON pages'); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }

  /** A cascade that costs more than any finite statement cap; it also fails if the purge dropped the 1 s lock bound. */
  const OVER_ANY_CAP = `CREATE OR REPLACE FUNCTION lane_7702_cascade_cost() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('lock_timeout') <> '1s' THEN RAISE EXCEPTION 'the bulk delete lost its lock bound'; END IF;
      IF current_setting('statement_timeout') <> '0' THEN RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE = '57014'; END IF;
      RETURN OLD; END $$`;
  const pages = async () => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [SOURCE]))[0].n);
  const archivedPast = async () => {
    await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: SOURCE });
    await engine.executeRaw(`UPDATE sources SET archived_at=now()-interval '4 days', archive_expires_at=now()-interval '1 day' WHERE id=$1`, [SOURCE]);
  };

  test('purge of an archived source whose cascade outlasts the cap commits atomically, with the lock bound kept and the cap restored after', () => fixture(OVER_ANY_CAP, async () => {
    await archivedPast();
    let capAfterDelete: string | undefined;
    const receipt = await runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: SOURCE, confirmDestructive: true }, {
      before: async () => {},
      after: async tx => { capAfterDelete = (await tx.executeRaw<{ cap: string }>("SELECT current_setting('statement_timeout') AS cap"))[0].cap; },
    });
    expect(receipt).toMatchObject({ state: 'committed', pages_deleted: PAGES });
    expect(capAfterDelete).toBe('5s');
    expect(await pages()).toBe(0);
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [SOURCE])).toEqual([]);
    expect(await engine.executeRaw('SELECT slug FROM pages ORDER BY slug')).toEqual([{ slug: 'notes/survivor' }]);
  }), 60_000);

  test('the expired-archive sweep purge and a remove take the same uncapped bulk delete', async () => {
    await fixture(OVER_ANY_CAP, async () => {
      await archivedPast();
      expect(await runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: SOURCE, confirmDestructive: true, expiredOnly: true }))
        .toMatchObject({ state: 'committed', pages_deleted: PAGES });
      expect(await pages()).toBe(0);
    });
    await fixture(OVER_ANY_CAP, async () => {
      expect(await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: SOURCE, confirmDestructive: true }))
        .toMatchObject({ state: 'committed', pages_deleted: PAGES });
      expect(await pages()).toBe(0);
    });
  }, 60_000);

  test('a purge that rolls back after the bulk delete keeps every page', () => fixture(OVER_ANY_CAP, async () => {
    await archivedPast();
    await expect(runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: SOURCE, confirmDestructive: true }, {
      before: async () => {},
      after: async () => { throw new Error('rollback probe'); },
    })).rejects.toThrow('rollback probe');
    expect(await pages()).toBe(PAGES);
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [SOURCE])).toHaveLength(1);
  }), 60_000);

  if (flavor === 'postgres') test('Postgres: a cascade that really runs past the 5 s cap still purges', () => fixture(
    `CREATE OR REPLACE FUNCTION lane_7702_cascade_cost() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.slug = 'notes/page-1' THEN PERFORM pg_sleep(5.5); END IF;
      RETURN OLD; END $$`, async () => {
      await archivedPast();
      expect(await runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: SOURCE, confirmDestructive: true }))
        .toMatchObject({ state: 'committed', pages_deleted: PAGES });
      expect(await pages()).toBe(0);
    }), 60_000);

  test('a statement timeout is write_interrupted without retry advice; a lock wait stays write_pending', async () => {
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const refused = await topologyTransaction(engine, async () => { throw timeout; }).then(() => null, (error: unknown) => error as { code?: string; suggestion?: string; retryable?: boolean });
    expect(refused).toMatchObject({ code: 'write_interrupted', retryable: false });
    expect(refused!.suggestion).not.toContain('after the current writer finishes');
    await expect(topologyTransaction(engine, async () => { throw Object.assign(new Error('lock timeout'), { code: '55P03' }); }))
      .rejects.toMatchObject({ code: 'write_pending' });
  });
});
