import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { topologyTransaction } from '../src/core/persistence/topology-transaction.ts';
import { withEnv } from './helpers/with-env.ts';

const engine = new PGLiteEngine();
const directory = mkdtempSync(join(tmpdir(), 'gbrain-purge-timeout-'));
beforeAll(async () => { await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(directory, { recursive: true, force: true }); });

test('purge allows an expensive cascade while retaining lock bounds, atomicity and replay', async () => {
  await withEnv({ GBRAIN_HOME: directory }, async () => {
    await registerLocalWriter(engine, 'cli');
    await engine.executeRaw("INSERT INTO sources(id,name,archived,archived_at,archive_expires_at) VALUES('bulk-source','Bulk',true,now()-interval '4 days',now()-interval '1 day')");
    await engine.executeRaw("INSERT INTO pages(source_id,slug,type,title) SELECT 'bulk-source','page-'||n,'note','Page' FROM generate_series(1,100) n");
    await engine.executeRaw("INSERT INTO pages(slug,type,title) VALUES('survivor','note','Survivor')");
    // Emulate a cascade exceeding a finite budget without timing-sensitive sleeps.
    // The real DELETE and its foreign-key cascades still execute in the engine.
    await engine.executeRaw(`CREATE FUNCTION test_purge_budget() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('lock_timeout') <> '1s' THEN RAISE EXCEPTION 'lock bound lost'; END IF;
      IF current_setting('statement_timeout') <> '0' THEN
        RAISE EXCEPTION 'cascade exceeded statement budget' USING ERRCODE='57014';
      END IF;
      RETURN OLD;
    END $$`);
    await engine.executeRaw('CREATE TRIGGER test_purge_budget BEFORE DELETE ON sources FOR EACH ROW EXECUTE FUNCTION test_purge_budget()');
    const input = { operation: 'purge' as const, sourceId: 'bulk-source', confirmDestructive: true, expiredOnly: true, requestId: randomUUID() };
    expect(await runManagedSourceLifecycle(engine, { ...input, dryRun: true })).toMatchObject({ dry_run: true });
    await expect(runManagedSourceLifecycle(engine, input, {
      before: async () => {},
      after: async tx => {
        expect(await tx.executeRaw("SELECT current_setting('statement_timeout') AS budget")).toEqual([{ budget: '5s' }]);
        throw new Error('rollback probe');
      },
    })).rejects.toThrow('rollback probe');
    expect(await engine.executeRaw("SELECT count(*)::int AS n FROM pages WHERE source_id='bulk-source'")).toEqual([{ n: 100 }]);
    const receipt = await runManagedSourceLifecycle(engine, input);
    expect(receipt).toMatchObject({ state: 'committed', pages_deleted: 100 });
    expect(await engine.executeRaw("SELECT id FROM sources WHERE id='bulk-source'")).toEqual([]);
    expect(await engine.executeRaw('SELECT slug FROM pages ORDER BY slug')).toEqual([{ slug: 'survivor' }]);
    expect(await runManagedSourceLifecycle(engine, input)).toEqual(receipt);
  });
}, 60_000);

test('statement cancellation is not reported as waiting for another writer', async () => {
  const cancellation = Object.assign(new Error('statement timeout'), { code: '57014' });
  await expect(topologyTransaction(engine, async () => { throw cancellation; })).rejects.toBe(cancellation);
  await expect(topologyTransaction(engine, async () => {
    throw Object.assign(new Error('lock timeout'), { code: '55P03' });
  })).rejects.toMatchObject({ code: 'write_pending' });
});
