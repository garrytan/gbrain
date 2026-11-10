/**
 * #8984 on real Postgres: a retry of an interrupted managed remove/purge after its source was removed and re-added
 * refuses with source_retire_superseded and keeps the new source's pages, including after batches already deleted
 * part of the old source.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../../src/core/engine.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle, SOURCE_RETIRE_BATCH_PAGES } from '../../src/core/persistence/source-lifecycle.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const source = 'retire-again';
const PAGES = SOURCE_RETIRE_BATCH_PAGES * 2 + 17;
const databaseUrl = requirePostgresTestDatabase();
let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
beforeAll(async () => {
  template = await persistencePostgresTemplate(databaseUrl, 2, async engine => {
    for (const id of [source, 'keep-other']) await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]);
    await seed(engine, source, PAGES);
    await seed(engine, 'keep-other', 20);
  });
}, 600_000);
afterAll(async () => { await template?.dispose(); });

function seed(engine: BrainEngine, id: string, n: number, from = 1) {
  return engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth)
    SELECT $1,'notes/p-'||g,'note','Page '||g,'Body '||g FROM generate_series($2::int,$3::int) g`, [id, from, from + n - 1]);
}
const pages = async (engine: BrainEngine, id = source) => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [id]))[0].n;
const incarnation = async (engine: BrainEngine) => (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [source]))[0]?.incarnation;
const change = async (engine: BrainEngine, requestId: string) => (await engine.executeRaw<{ state: string; source_incarnation: string }>(
  'SELECT state,source_incarnation FROM persistence_topology_changes WHERE request_id=$1::uuid', [requestId]))[0];
/** Raw page writes stand in for an import; the managed guard admits them only while the brain is briefly unmanaged. */
async function unmanaged(engine: BrainEngine, run: () => Promise<unknown>) {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { await run(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}

describe('retrying a managed remove after its source was re-added (postgres)', () => {
  async function fixture(run: (engine: BrainEngine, root: string) => Promise<void>) {
    const { engine, close } = await template.clone();
    const home = mkdtempSync(join(tmpdir(), 'gbrain-retire-again-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        await registerLocalWriter(engine, 'cli');
        for (const id of [source, 'keep-other']) {
          const root = join(home, id); mkdirSync(root);
          writeFileSync(join(root, 'example.md'), '---\ntitle: Example\ntype: note\n---\n\nCanonical\n');
          await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [id, root]);
          await claimWorktree(engine, id, root);
        }
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await run(engine, join(home, source));
        expect(await pages(engine, 'keep-other')).toBe(20);
      });
    } finally { await disposePersistenceConsumer(engine); await close(); rmSync(home, { recursive: true, force: true }); }
  }
  async function readd(engine: BrainEngine, root: string, n: number) {
    expect(await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: source, path: root })).toMatchObject({ state: 'committed' });
    await unmanaged(engine, () => seed(engine, source, n, 9000));
  }

  test('a retry after the final transaction failed and the source was removed and re-added refuses', () => fixture(async (engine, root) => {
    await engine.executeRaw(`CREATE FUNCTION retire_final_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'injected final retire failure'; END $$`);
    await engine.executeRaw('CREATE TRIGGER retire_final BEFORE DELETE ON sources FOR EACH ROW EXECUTE FUNCTION retire_final_fn()');
    const requestId = randomUUID();
    const remove = () => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId });
    const first = await incarnation(engine);
    try { await expect(remove()).rejects.toThrow('injected final retire failure'); }
    finally { await engine.executeRaw('DROP TRIGGER retire_final ON sources'); await engine.executeRaw('DROP FUNCTION retire_final_fn()'); }
    expect(await pages(engine)).toBe(0);
    expect(await change(engine, requestId)).toMatchObject({ state: 'recovering', source_incarnation: first });
    expect(await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true })).toMatchObject({ state: 'committed' });
    expect(await change(engine, requestId)).toMatchObject({ state: 'failed', source_incarnation: first });
    await readd(engine, root, 1);
    for (let i = 0; i < 2; i++) await expect(remove()).rejects.toMatchObject({ code: 'source_retire_superseded' });
    expect(await pages(engine)).toBe(1);
  }), 300_000);

  test('a batched retry after partial deletion refuses once the source was replaced, and settles its record', () => fixture(async (engine, root) => {
    await engine.executeRaw('CREATE TABLE retire_fail(armed boolean NOT NULL, seen integer NOT NULL)');
    await engine.executeRaw(`CREATE FUNCTION retire_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE n integer; BEGIN
      UPDATE retire_fail SET seen=seen+1 WHERE armed RETURNING seen INTO n;
      IF n > ${SOURCE_RETIRE_BATCH_PAGES} THEN RAISE EXCEPTION 'injected retire batch failure'; END IF; RETURN OLD; END $$`);
    await engine.executeRaw('CREATE TRIGGER retire_fail BEFORE DELETE ON pages FOR EACH ROW EXECUTE FUNCTION retire_fail_fn()');
    await engine.executeRaw('INSERT INTO retire_fail VALUES(true,0)');
    const requestId = randomUUID();
    const remove = () => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId });
    const first = await incarnation(engine);
    await expect(remove()).rejects.toThrow('injected retire batch failure');
    await engine.executeRaw('DELETE FROM retire_fail');
    expect(await pages(engine)).toBe(PAGES - SOURCE_RETIRE_BATCH_PAGES);
    expect(await change(engine, requestId)).toMatchObject({ state: 'recovering', source_incarnation: first });
    await unmanaged(engine, async () => {
      await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [source]);
      await engine.executeRaw('DELETE FROM persistence_source_bindings WHERE source_id=$1', [source]);
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [source]);
    });
    await readd(engine, root, 3);
    await expect(remove()).rejects.toMatchObject({ code: 'source_retire_superseded' });
    expect(await change(engine, requestId)).toMatchObject({ state: 'failed', source_incarnation: first });
    await expect(remove()).rejects.toMatchObject({ code: 'source_retire_superseded' });
    expect(await pages(engine)).toBe(3);
  }), 300_000);

  test('a retry under a replaced CLI registration after the source was removed and re-added refuses', () => fixture(async (engine, root) => {
    await engine.executeRaw('CREATE TABLE retire_fail(armed boolean NOT NULL, seen integer NOT NULL)');
    await engine.executeRaw(`CREATE FUNCTION retire_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE n integer; BEGIN
      UPDATE retire_fail SET seen=seen+1 WHERE armed RETURNING seen INTO n;
      IF n > ${SOURCE_RETIRE_BATCH_PAGES} THEN RAISE EXCEPTION 'injected retire batch failure'; END IF; RETURN OLD; END $$`);
    await engine.executeRaw('CREATE TRIGGER retire_fail BEFORE DELETE ON pages FOR EACH ROW EXECUTE FUNCTION retire_fail_fn()');
    await engine.executeRaw('INSERT INTO retire_fail VALUES(true,0)');
    const requestId = randomUUID();
    const remove = () => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId });
    const first = await incarnation(engine);
    await expect(remove()).rejects.toThrow('injected retire batch failure');
    await engine.executeRaw('DROP TRIGGER retire_fail ON pages');
    expect(await change(engine, requestId)).toMatchObject({ state: 'recovering', source_incarnation: first });
    await registerLocalWriter(engine, 'cli', undefined, true);
    expect(await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true })).toMatchObject({ state: 'committed' });
    await readd(engine, root, 2);
    for (let i = 0; i < 2; i++) await expect(remove()).rejects.toMatchObject({ code: 'source_retire_superseded' });
    expect(await pages(engine)).toBe(2);
  }), 300_000);
});
