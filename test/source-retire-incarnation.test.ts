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
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle, SOURCE_RETIRE_BATCH_PAGES } from '../src/core/persistence/source-lifecycle.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { deactivationBlockers } from '../src/core/persistence/deactivation.ts';
import { graduationBlockers } from '../src/core/persistence/graduation-drain.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';

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
/** Arms a failure of the second page batch, so exactly one batch of SOURCE_RETIRE_BATCH_PAGES pages commits. */
async function failAfterFirstBatch<T>(run: () => Promise<T>): Promise<T> {
  await engine.executeRaw('CREATE TABLE retire_fail(armed boolean NOT NULL, seen integer NOT NULL)');
  await engine.executeRaw(`CREATE FUNCTION retire_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE n integer; BEGIN
    UPDATE retire_fail SET seen=seen+1 WHERE armed RETURNING seen INTO n;
    IF n > ${SOURCE_RETIRE_BATCH_PAGES} THEN RAISE EXCEPTION 'injected retire batch failure'; END IF; RETURN OLD; END $$`);
  await engine.executeRaw('CREATE TRIGGER retire_fail BEFORE DELETE ON pages FOR EACH ROW EXECUTE FUNCTION retire_fail_fn()');
  try {
    await engine.executeRaw('INSERT INTO retire_fail VALUES(true,0)');
    return await run();
  } finally {
    for (const sql of ['DROP TRIGGER IF EXISTS retire_fail ON pages', 'DROP FUNCTION IF EXISTS retire_fail_fn()', 'DROP TABLE IF EXISTS retire_fail']) await engine.executeRaw(sql);
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
  const requestId = randomUUID();
  const remove = () => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId });
  const first = await incarnation();
  await expect(failAfterFirstBatch(remove)).rejects.toThrow('injected retire batch failure');
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
}), 60_000);

test('a restore after an interrupted purge abandons the purge: its retry refuses and nothing blocks deactivate or graduation', () => fixture(SOURCE_RETIRE_BATCH_PAGES * 2, async () => {
  expect(await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: source })).toMatchObject({ state: 'committed' });
  const requestId = randomUUID();
  const purge = () => runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: source, confirmDestructive: true, requestId });
  const first = await incarnation();
  await expect(failAfterFirstBatch(purge)).rejects.toThrow('injected retire batch failure');
  expect(await pages()).toBe(SOURCE_RETIRE_BATCH_PAGES);
  expect(await runManagedSourceLifecycle(engine, { operation: 'restore', sourceId: source })).toMatchObject({ state: 'committed' });
  expect(await change(requestId)).toMatchObject({ state: 'failed', source_incarnation: first });
  for (let i = 0; i < 2; i++) await expect(purge()).rejects.toMatchObject({ code: 'source_retire_superseded' });
  expect(await pages()).toBe(SOURCE_RETIRE_BATCH_PAGES);
  expect(await incarnation()).toBe(first);
  expect((await deactivationBlockers(engine)).filter(b => b.kind === 'topology_recovery')).toEqual([]);
  expect((await graduationBlockers(engine, localHostId())).filter(b => b.kind === 'topology_recovery')).toEqual([]);
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
    detail: `remove of ${source} (request ${requestId}) stopped before it finished`,
    exit: expect.stringMatching(new RegExp(`^ask the user .*--request-id ${requestId}`)) });
  expect((await graduationBlockers(engine, localHostId())).find(b => b.kind === 'topology_recovery')).toMatchObject({
    argv: ['gbrain', 'sources', 'writer', 'status', source, '--json'], needsUser: true });
  const receipt = await remove();
  expect(receipt).toMatchObject({ state: 'committed', operation: 'remove', source_incarnation: first });
  expect(await remove()).toEqual(receipt);
  expect(await change(requestId)).toMatchObject({ state: 'committed', recovery: null });
  expect((await deactivationBlockers(engine)).filter(b => b.kind === 'topology_recovery')).toEqual([]);
  expect(await incarnation()).toBeUndefined();
}), 60_000);

test('a retry under a replaced CLI registration finishes and settles the old registration\'s stopped admission', () => fixture(SOURCE_RETIRE_BATCH_PAGES + 3, async () => {
  const requestId = randomUUID();
  const remove = () => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId });
  await expect(failFinalTransaction(remove)).rejects.toThrow('injected final retire failure');
  const [old] = await engine.executeRaw<{ principal_id: string }>('SELECT principal_id::text AS principal_id FROM persistence_topology_changes WHERE request_id=$1::uuid', [requestId]);
  const replaced = await registerLocalWriter(engine, 'cli', undefined, true);
  expect(replaced.id).not.toBe(old.principal_id);
  expect(await remove()).toMatchObject({ state: 'committed', operation: 'remove' });
  expect(await engine.executeRaw('SELECT principal_id::text AS principal_id, state FROM persistence_topology_changes WHERE request_id=$1::uuid ORDER BY created_at', [requestId]))
    .toEqual([{ principal_id: old.principal_id, state: 'failed' }, { principal_id: replaced.id, state: 'committed' }]);
  expect((await deactivationBlockers(engine)).filter(b => b.kind === 'topology_recovery')).toEqual([]);
  expect((await graduationBlockers(engine, localHostId())).filter(b => b.kind === 'topology_recovery')).toEqual([]);
}), 60_000);

test('a stopped automatic expired-archive purge is left to the next automatic run, not handed to a person', () => fixture(SOURCE_RETIRE_BATCH_PAGES * 2, async () => {
  expect(await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: source })).toMatchObject({ state: 'committed' });
  await engine.executeRaw("UPDATE sources SET archive_expires_at=now()-interval '1 hour' WHERE id=$1", [source]);
  const first = await incarnation();
  const requestId = randomUUID();
  const purge = () => runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: source, confirmDestructive: true, expiredOnly: true, expectedIncarnation: first, requestId });
  await expect(failAfterFirstBatch(purge)).rejects.toThrow('injected retire batch failure');
  expect(await change(requestId)).toMatchObject({ state: 'recovering', recovery: null });
  const deactivate = (await deactivationBlockers(engine)).find(b => b.kind === 'topology_recovery');
  expect(deactivate?.detail).toContain(`automatic expired-archive purge of ${source} (request ${requestId})`);
  expect(deactivate?.exit).toMatch(/^the next automatic expired-archive purge finishes it/);
  expect(deactivate?.exit).toContain('or gbrain sources purge with no source id finishes it now');
  expect(deactivate?.exit).not.toContain('ask the user');
  const graduation = (await graduationBlockers(engine, localHostId())).find(b => b.kind === 'topology_recovery');
  expect(graduation).toMatchObject({ needsUser: false, argv: ['gbrain', 'sources', 'writer', 'status', source, '--json'] });
  expect(graduation?.detail).toContain('the next automatic expired-archive purge finishes it, or gbrain sources purge with no source id finishes it now');
  expect(await runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: source, confirmDestructive: true, expiredOnly: true, expectedIncarnation: first })).toMatchObject({ state: 'committed' });
  expect(await change(requestId)).toMatchObject({ state: 'failed' });
  expect((await deactivationBlockers(engine)).filter(b => b.kind === 'topology_recovery')).toEqual([]);
}), 60_000);

test('the superseded refusal points at a writer status that lists the stopped and superseded requests', () => fixture(SOURCE_RETIRE_BATCH_PAGES + 3, async root => {
  const requestId = randomUUID();
  const remove = () => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId });
  await expect(failFinalTransaction(remove)).rejects.toThrow('injected final retire failure');
  const status = async () => (await runPersistenceAdministration(engine, 'writer_status', { source_id: source }) as { topology_requests: unknown[] }).topology_requests;
  expect(await status()).toEqual([expect.objectContaining({ request_id: requestId, operation: 'remove', state: 'recovering' })]);
  await unmanaged(async () => {
    await engine.executeRaw('DELETE FROM persistence_source_bindings WHERE source_id=$1', [source]);
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [source]);
  });
  await readd(root, 2);
  const refusal = await remove().then(() => null, (e: { code?: string; fix?: { argv?: string[] } }) => e);
  expect(refusal).toMatchObject({ code: 'source_retire_superseded', fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', source, '--json'] } });
  expect(await status()).toEqual([expect.objectContaining({ request_id: requestId, operation: 'remove', state: 'failed', error: 'source_retire_superseded' })]);
}), 60_000);

test('a retry under a replaced CLI registration after the source was removed and re-added refuses and keeps the new pages', () => fixture(SOURCE_RETIRE_BATCH_PAGES + 7, async root => {
  const requestId = randomUUID();
  const remove = () => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId });
  const first = await incarnation();
  await expect(failAfterFirstBatch(remove)).rejects.toThrow('injected retire batch failure');
  expect(await change(requestId)).toMatchObject({ state: 'recovering', source_incarnation: first });
  await registerLocalWriter(engine, 'cli', undefined, true);
  expect(await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true })).toMatchObject({ state: 'committed' });
  await readd(root, 2);
  expect(await incarnation()).not.toBe(first);
  for (let i = 0; i < 2; i++) await expect(remove()).rejects.toMatchObject({ code: 'source_retire_superseded' });
  await expect(runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId, dryRun: true }))
    .rejects.toMatchObject({ code: 'source_retire_superseded' });
  expect(await pages()).toBe(2);
  expect(await engine.executeRaw('SELECT state FROM persistence_topology_changes WHERE request_id=$1::uuid', [requestId])).toEqual([{ state: 'failed' }]);
}), 60_000);

test('a stopped remove whose source was replaced out of band refuses under a replaced registration and settles the old admission', () => fixture(SOURCE_RETIRE_BATCH_PAGES + 7, async root => {
  const requestId = randomUUID();
  const remove = () => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, confirmDestructive: true, requestId });
  await expect(failAfterFirstBatch(remove)).rejects.toThrow('injected retire batch failure');
  await registerLocalWriter(engine, 'cli', undefined, true);
  await unmanaged(async () => {
    await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [source]);
    await engine.executeRaw('DELETE FROM persistence_source_bindings WHERE source_id=$1', [source]);
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [source]);
  });
  await readd(root, 2);
  await expect(remove()).rejects.toMatchObject({ code: 'source_retire_superseded' });
  expect(await engine.executeRaw('SELECT state FROM persistence_topology_changes WHERE request_id=$1::uuid', [requestId])).toEqual([{ state: 'failed' }]);
  expect((await deactivationBlockers(engine)).filter(b => b.kind === 'topology_recovery')).toEqual([]);
  expect(await pages()).toBe(2);
}), 60_000);
