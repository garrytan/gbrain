/**
 * #7702 / #8905 on PGLite: a managed remove or purge deletes a source's pages in bounded batches behind the same
 * preconditions as its final transaction, never deletes for a dry run or a refused operation, and a retry with the
 * same request_id resumes after an interrupted batch.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle, SOURCE_RETIRE_BATCH_PAGES } from '../src/core/persistence/source-lifecycle.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const PAGES = SOURCE_RETIRE_BATCH_PAGES * 2 + 17;
const source = 'retire-batched';

async function fixture(run: () => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-retire-batched-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await registerLocalWriter(engine, 'cli');
      for (const id of [source, 'keep-other']) {
        const root = join(home, id); mkdirSync(root);
        writeFileSync(join(root, 'example.md'), '---\ntitle: Example\ntype: note\n---\n\nCanonical\n');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
        await claimWorktree(engine, id, root);
        await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth)
          SELECT $1,'notes/p-'||g,'note','Page '||g,'Body '||g FROM generate_series(1,$2::int) g`, [id, id === source ? PAGES : 20]);
        await engine.executeRaw(`INSERT INTO content_chunks(page_id,chunk_index,chunk_text)
          SELECT id,0,'chunk of '||slug FROM pages WHERE source_id=$1`, [id]);
      }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await run();
      expect(await pages('keep-other')).toBe(20);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}
const pages = async (id: string) => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [id]))[0].n;
const registered = async () => (await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [source])).length;

test('remove and purge of a source larger than one batch delete every page and count them all', () => fixture(async () => {
  await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: source });
  expect(await runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: source, confirmDestructive: true }))
    .toMatchObject({ state: 'committed', operation: 'purge', pages_deleted: PAGES });
  expect(await registered()).toBe(0);
  expect(await pages(source)).toBe(0);
  expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks c LEFT JOIN pages p ON p.id=c.page_id WHERE p.id IS NULL`))[0].n).toBe(0);
}), 60_000);

test('a dry run or a refused remove/purge deletes no page', () => fixture(async () => {
  await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, dryRun: true });
  await expect(runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source })).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: source, confirmDestructive: true })).rejects.toMatchObject({ code: 'invalid_params' });
  await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: source });
  expect(await runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: source, confirmDestructive: true, expiredOnly: true }))
    .toMatchObject({ state: 'committed', noop: true });
  await expect(runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, expectedIncarnation: randomUUID() }))
    .rejects.toMatchObject({ code: 'source_changed' });
  expect(await pages(source)).toBe(PAGES);
  expect(await registered()).toBe(1);
}), 60_000);

test('an interrupted batch keeps the committed batches and the same request_id resumes to completion', () => fixture(async () => {
  await engine.executeRaw('CREATE TABLE retire_fail(armed boolean NOT NULL, seen integer NOT NULL)');
  await engine.executeRaw(`CREATE FUNCTION retire_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE n integer; BEGIN
    UPDATE retire_fail SET seen=seen+1 WHERE armed RETURNING seen INTO n;
    IF n > ${SOURCE_RETIRE_BATCH_PAGES * 2} THEN RAISE EXCEPTION 'injected retire batch failure'; END IF; RETURN OLD; END $$`);
  await engine.executeRaw('CREATE TRIGGER retire_fail BEFORE DELETE ON pages FOR EACH ROW EXECUTE FUNCTION retire_fail_fn()');
  try {
    await engine.executeRaw('INSERT INTO retire_fail VALUES(true,0)');
    const requestId = randomUUID();
    const remove = () => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId });
    await expect(remove()).rejects.toThrow('injected retire batch failure');
    expect(await pages(source)).toBe(PAGES - SOURCE_RETIRE_BATCH_PAGES * 2);
    expect(await registered()).toBe(1);
    expect(await engine.executeRaw('SELECT id FROM persistence_topology_changes WHERE request_id=$1::uuid', [requestId])).toHaveLength(0);
    await engine.executeRaw('DELETE FROM retire_fail');
    const receipt = await remove();
    expect(receipt).toMatchObject({ state: 'committed', operation: 'remove', pages_deleted: PAGES - SOURCE_RETIRE_BATCH_PAGES * 2 });
    expect(await remove()).toEqual(receipt);
    expect(await pages(source)).toBe(0);
    expect(await registered()).toBe(0);
  } finally {
    for (const sql of ['DROP TRIGGER IF EXISTS retire_fail ON pages', 'DROP FUNCTION IF EXISTS retire_fail_fn()', 'DROP TABLE IF EXISTS retire_fail']) await engine.executeRaw(sql);
  }
}), 60_000);
