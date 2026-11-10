/**
 * #8984 on PGLite: a managed remove or purge records which incarnation of its source it was admitted against, durably
 * and atomically with its first deleted batch. A retry of that request_id after the source was removed and re-added
 * refuses with source_retire_superseded and never deletes the new source's pages; a retry against the same
 * incarnation still resumes and finishes.
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
import { deactivationBlockers } from '../src/core/persistence/deactivation.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

const source = 'retire-again';
const pages = async (id = source) => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [id]))[0].n;
const incarnation = async () => (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [source]))[0]?.incarnation;
const change = async (requestId: string) => (await engine.executeRaw<{ state: string; source_incarnation: string; recovery: unknown }>(
  'SELECT state,source_incarnation,recovery FROM persistence_topology_changes WHERE request_id=$1::uuid', [requestId]))[0];
const seed = (id: string, n: number, from = 1) => engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth)
  SELECT $1,'notes/p-'||g,'note','Page '||g,'Body '||g FROM generate_series($2::int,$3::int) g`, [id, from, from + n - 1]);

async function fixture(count: number, run: (root: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-retire-again-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await registerLocalWriter(engine, 'cli');
      const roots: Record<string, string> = {};
      for (const id of [source, 'keep-other']) {
        const root = roots[id] = join(home, id); mkdirSync(root);
        writeFileSync(join(root, 'example.md'), '---\ntitle: Example\ntype: note\n---\n\nCanonical\n');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
        await claimWorktree(engine, id, root);
        await seed(id, id === source ? count : 20);
      }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await run(roots[source]);
      expect(await pages('keep-other')).toBe(20);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Arms a one-shot failure of the final topology transaction (its DELETE FROM sources), after every page batch committed. */
async function failFinalTransaction<T>(run: () => Promise<T>): Promise<T> {
  await engine.executeRaw(`CREATE FUNCTION retire_final_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'injected final retire failure'; END $$`);
  await engine.executeRaw('CREATE TRIGGER retire_final BEFORE DELETE ON sources FOR EACH ROW EXECUTE FUNCTION retire_final_fn()');
  try { return await run(); } finally {
    await engine.executeRaw('DROP TRIGGER IF EXISTS retire_final ON sources');
    await engine.executeRaw('DROP FUNCTION IF EXISTS retire_final_fn()');
  }
}
/** Raw page writes stand in for an import; the managed guard admits them only while the brain is briefly unmanaged. */
async function unmanaged(run: () => Promise<unknown>) {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { await run(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}
async function readd(root: string, count: number) {
  expect(await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: source, path: root })).toMatchObject({ state: 'committed' });
  await unmanaged(() => seed(source, count, 9000));
}

test('a retry after the source was removed and re-added refuses and keeps the new source\'s pages', () => fixture(1, async root => {
  const requestId = randomUUID();
  const remove = () => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId });
  const first = await incarnation();
  await expect(failFinalTransaction(remove)).rejects.toThrow('injected final retire failure');
  expect(await pages()).toBe(0);
  expect(await change(requestId)).toMatchObject({ state: 'recovering', source_incarnation: first, recovery: null });
  expect(await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true })).toMatchObject({ state: 'committed' });
  expect(await change(requestId)).toMatchObject({ state: 'failed', source_incarnation: first });
  await readd(root, 1);
  expect(await incarnation()).not.toBe(first);
  for (let i = 0; i < 2; i++) await expect(remove()).rejects.toMatchObject({ code: 'source_retire_superseded' });
  expect(await pages()).toBe(1);
  expect(await incarnation()).toBeDefined();
}), 60_000);

test('a batched retry after partial deletion refuses once the source was replaced out of band, and settles its record', () => fixture(SOURCE_RETIRE_BATCH_PAGES * 2 + 17, async root => {
  await engine.executeRaw('CREATE TABLE retire_fail(armed boolean NOT NULL, seen integer NOT NULL)');
  await engine.executeRaw(`CREATE FUNCTION retire_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE n integer; BEGIN
    UPDATE retire_fail SET seen=seen+1 WHERE armed RETURNING seen INTO n;
    IF n > ${SOURCE_RETIRE_BATCH_PAGES} THEN RAISE EXCEPTION 'injected retire batch failure'; END IF; RETURN OLD; END $$`);
  await engine.executeRaw('CREATE TRIGGER retire_fail BEFORE DELETE ON pages FOR EACH ROW EXECUTE FUNCTION retire_fail_fn()');
  try {
    await engine.executeRaw('INSERT INTO retire_fail VALUES(true,0)');
    const requestId = randomUUID();
    const remove = () => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId });
    const first = await incarnation();
    await expect(remove()).rejects.toThrow('injected retire batch failure');
    await engine.executeRaw('DELETE FROM retire_fail');
    expect(await pages()).toBe(SOURCE_RETIRE_BATCH_PAGES + 17);
    expect(await change(requestId)).toMatchObject({ state: 'recovering', source_incarnation: first });
    await unmanaged(async () => {
      await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [source]);
      await engine.executeRaw('DELETE FROM persistence_source_bindings WHERE source_id=$1', [source]);
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [source]);
    });
    await readd(root, 3);
    await expect(remove()).rejects.toMatchObject({ code: 'source_retire_superseded' });
    expect(await change(requestId)).toMatchObject({ state: 'failed', source_incarnation: first });
    await expect(remove()).rejects.toMatchObject({ code: 'source_retire_superseded' });
    await expect(runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId, dryRun: true }))
      .rejects.toMatchObject({ code: 'source_retire_superseded' });
    expect(await pages()).toBe(3);
  } finally {
    for (const sql of ['DROP TRIGGER IF EXISTS retire_fail ON pages', 'DROP FUNCTION IF EXISTS retire_fail_fn()', 'DROP TABLE IF EXISTS retire_fail']) await engine.executeRaw(sql);
  }
}), 60_000);

test('a retry against the same incarnation resumes, finishes and settles its record committed', () => fixture(SOURCE_RETIRE_BATCH_PAGES + 3, async () => {
  const requestId = randomUUID();
  const remove = () => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId });
  const first = await incarnation();
  const err = await failFinalTransaction(remove).then(() => null, (e: Error & { suggestion?: string }) => e);
  expect(err?.message).toContain('injected final retire failure');
  expect(await pages()).toBe(0);
  expect(await change(requestId)).toMatchObject({ state: 'recovering', source_incarnation: first });
  expect((await deactivationBlockers(engine)).find(b => b.kind === 'topology_recovery')).toMatchObject({
    detail: `remove of ${source} (request ${requestId}) stopped before it finished`, exit: expect.stringContaining(`--request-id ${requestId}`) });
  const receipt = await remove();
  expect(receipt).toMatchObject({ state: 'committed', operation: 'remove', source_incarnation: first });
  expect(await remove()).toEqual(receipt);
  expect(await change(requestId)).toMatchObject({ state: 'committed', recovery: null });
  expect((await deactivationBlockers(engine)).filter(b => b.kind === 'topology_recovery')).toEqual([]);
  expect(await incarnation()).toBeUndefined();
}), 60_000);
