/**
 * #6696 C4 / #6712 PR 2 (L5): the tail of a managed sync whose checkpoint committed (projection statistics, link extraction).
 * C4 kept it inside the governed pass under a drain step `finish` with its own budget, so the governor stopped reading it
 * as `no_admission`. L5 moves it out: the checkpoint's own transaction records the tail as owed, the pass returns at the
 * checkpoint commit, and the tail runs after the drain lease is released, bounded, with a degraded notice when it fails or
 * is cut short. These tests pinned the C4 behavior (the `finish` step and window); they now assert the L5 behavior.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncResult } from '../src/commands/sync.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { stampDrainStep } from '../src/core/persistence/drain-step.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runDrain, type StallProbe } from '../src/core/persistence/sync-drain.ts';
import { readSyncTail } from '../src/core/persistence/sync-tail-record.ts';
import { withEnv } from './helpers/with-env.ts';

const empty: StallProbe = { blockedHead: async () => null, fingerprint: async () => null, head: async () => null };
const synced: SyncResult = { status: 'synced', fromCommit: 'a', toCommit: 'b', added: 1, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [],
  managedCursor: { index: 1, total: 1 } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('in-pass governor: no tail inside the pass', () => {
  test('a pass that returns at its checkpoint commit ends synced', async () => {
    const result = await runDrain({ governMs: 10, noProgressMs: 80, probe: empty, pass: async (_signal, onProgress) => {
      onProgress({ phase: 'managed_sync.page_committed', bankedFiles: 1, total: 1 });
      onProgress({ phase: 'managed_sync.finish', bankedFiles: 1, total: 1 });
      return synced;
    } });
    expect(result.drain).toMatchObject({ outcome: 'synced', passes: 1 });
  });

  test('a pass quiet past the window after its last commit stops no_progress (no finish window any more)', async () => {
    const result = await runDrain({ governMs: 10, noProgressMs: 80, probe: empty, pass: (_signal, onProgress) => {
      onProgress({ phase: 'managed_sync.finish', bankedFiles: 1, total: 1 });
      return new Promise<SyncResult>(() => undefined);
    } });
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'no_progress', in_pass: true } });
  });

  test('a pass stuck in admission with nothing unfinished stops no_progress naming its step (no_admission is retired)', async () => {
    const started = Date.now();
    const result = await runDrain({ governMs: 10, noProgressMs: 80, probe: empty, pass: signal => {
      stampDrainStep('admission', signal);
      return new Promise<SyncResult>(() => undefined);
    } });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'no_progress', step: 'admission' } });
  });
});

const home = mkdtempSync(join(tmpdir(), 'gbrain-finish-tail-'));
let engine: BrainEngine;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeAll(async () => { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; }, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

/** A managed source of two notes that link to each other. */
async function source(): Promise<string> {
  const id = `tail-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < 2; i++) writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nSee [[notes/n${1 - i}]] for acme-example.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return id;
}
const stale = (sourceId: string) => engine.countStalePagesForExtraction({ sourceId });

test('the tail runs after the drain lease is released: a second sync takes the lease while the first one\'s links still run (PGLite)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const id = await source();
  const count = engine.countStalePagesForExtraction.bind(engine);
  let entered: () => void = () => {};
  const inTail = new Promise<void>(resolve => { entered = resolve; });
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let slowed = false;
  engine.countStalePagesForExtraction = async opts => { if (!slowed) { slowed = true; entered(); await held; } return count(opts); };
  try {
    const first = performSync(engine, { sourceId: id, noPull: true, noEmbed: true, drain: true });
    await Promise.race([inTail, sleep(60_000)]);
    expect(slowed).toBe(true);
    // On the base the first run still held the lease here (its link tail ran inside the pass), so this threw SyncLockBusyError.
    const second = await performSync(engine, { sourceId: id, noPull: true, noEmbed: true, drain: true });
    expect(second.status).toBe('up_to_date');
    release();
    const result = await first;
    expect(result.drain).toMatchObject({ outcome: 'synced', written: 2, remaining: 0 });
    expect(result.status).toBe('first_sync');
    expect(result.tail).toMatchObject({ status: 'done', runs: 1 });
    expect(result.links?.pages).toBe(2);
    expect(await stale(id)).toBe(0);
    expect(await readSyncTail(engine, id)).toBeNull();
  } finally {
    release();
    engine.countStalePagesForExtraction = count;
  }
}), 120_000);

test('a tail that never ran after its checkpoint committed stays owed and the next sync runs it; the failed one carries a degraded notice (PGLite)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const id = await source();
  let fired = 0;
  installFaultHook(point => { if (point === 'sync:tail_started' && fired++ === 0) throw new Error('injected death between the checkpoint commit and the tail'); });
  try {
    const first = await performSync(engine, { sourceId: id, noPull: true, noEmbed: true, drain: true });
    expect(fired).toBe(1);
    expect(first.drain?.outcome).toBe('synced');
    expect(first.status).toBe('first_sync');
    expect(first.tail).toMatchObject({ status: 'failed', runs: 1, notice: { code: 'sync_tail_degraded', kind: 'degraded', fix: { argv: ['gbrain', 'extract', '--stale', '--source-id', id] } } });
    expect(first.links).toBeUndefined();
    const owed = await readSyncTail(engine, id);
    expect(owed?.map(item => ({ changed: item.changed, extract: item.extract }))).toEqual([{ changed: 2, extract: true }]);
    expect(await stale(id)).toBe(2);
    const second = await performSync(engine, { sourceId: id, noPull: true, noEmbed: true, drain: true });
    expect(second.status).toBe('up_to_date');
    expect(second.tail).toMatchObject({ status: 'done', runs: 1, statistics: 'refreshed' });
    expect(second.tail?.notice).toBeUndefined();
    expect(await stale(id)).toBe(0);
    expect(await readSyncTail(engine, id)).toBeNull();
  } finally { installFaultHook(undefined); }
}), 120_000);

test('a --no-extract run owes statistics only, and a run past its deadline defers the links with the notice (PGLite)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const id = await source();
  const result = await performSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, drain: true });
  expect(result.tail).toMatchObject({ status: 'done', statistics: 'refreshed' });
  expect(result.links).toBeUndefined();
  expect(await stale(id)).toBe(2);
  const { runSyncTail } = await import('../src/core/persistence/sync-tail.ts');
  const { recordSyncTail } = await import('../src/core/persistence/sync-tail-record.ts');
  const [cursor] = await engine.executeRaw<{ fingerprint: string; run_id: string }>("SELECT fingerprint, completed_keys->0->>'runId' AS run_id FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [id]);
  await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,processingOptions,noExtract}','false'::jsonb) WHERE op='managed-sync' AND fingerprint=$1", [cursor!.fingerprint]);
  await recordSyncTail(engine, id, cursor!.fingerprint, cursor!.run_id);
  const deferred = await runSyncTail(engine, id, { deadlineAtMs: Date.now() - 1 });
  expect(deferred).toMatchObject({ status: 'deferred', notice: { code: 'sync_tail_degraded' } });
  expect(await readSyncTail(engine, id)).not.toBeNull();
  expect((await runSyncTail(engine, id))?.status).toBe('done');
  expect(await stale(id)).toBe(0);
  // An obligation that cannot be read is a failed tail with its notice, never a silent synced receipt.
  const unreadable = new Proxy(engine, { get(target, prop, receiver) {
    if (prop === 'executeRaw') return (sql: string, ...rest: unknown[]) => /managed-sync-tail|op=\$1 AND fingerprint=\$2/.test(sql) && /^SELECT completed_keys/.test(sql)
      ? Promise.reject(new Error('connection terminated'))
      : (target.executeRaw as (...a: unknown[]) => unknown).call(target, sql, ...rest);
    return Reflect.get(target, prop, receiver);
  } }) as unknown as BrainEngine;
  expect(await runSyncTail(unreadable, id)).toMatchObject({ status: 'failed', runs: 0, notice: { code: 'sync_tail_degraded', kind: 'degraded' } });
}), 120_000);

test('a tail cut short reports only the imported pages it left underived, never the source\'s older stale backlog (PGLite)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const id = await source();
  await performSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, drain: true });
  expect(await stale(id)).toBe(2);
  const [{ local_path: root }] = await engine.executeRaw<{ local_path: string }>('SELECT local_path FROM sources WHERE id=$1', [id]);
  for (const name of ['n2', 'n3']) writeFileSync(join(root, 'notes', `${name}.md`), `---\ntitle: ${name}\n---\nSee [[notes/n0]].\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'two more');
  await performSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, drain: true });
  expect(await stale(id)).toBe(4);
  const { runSyncTail } = await import('../src/core/persistence/sync-tail.ts');
  const { recordSyncTail } = await import('../src/core/persistence/sync-tail-record.ts');
  const [cursor] = await engine.executeRaw<{ fingerprint: string; run_id: string }>("SELECT fingerprint, completed_keys->0->>'runId' AS run_id FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [id]);
  await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,processingOptions,noExtract}','false'::jsonb) WHERE op='managed-sync' AND fingerprint=$1", [cursor!.fingerprint]);
  // The first page read of each tail outlasts its budget, so exactly one page is derived before the deadline stops it.
  const slowFirst = (budgetMs: number) => {
    let reads = 0;
    return new Proxy(engine, { get(target, prop, receiver) {
      // A transaction engine inherits from this proxy, so the read runs on whichever engine it was called on.
      if (prop === 'readPageSnapshot') return async function (this: BrainEngine, ...args: unknown[]) {
        if (reads++ === 0) await sleep(budgetMs + 200);
        return (target.readPageSnapshot as (...a: unknown[]) => unknown).apply(this, args);
      };
      return Reflect.get(target, prop, receiver);
    } }) as unknown as BrainEngine;
  };
  // Two imported pages, one derived: the notice counts the one left, not the two older stale pages behind it.
  await recordSyncTail(engine, id, cursor!.fingerprint, cursor!.run_id);
  const cut = await runSyncTail(slowFirst(1_000), id, { budgetMs: 1_000 });
  expect(cut?.links).toMatchObject({ pages: 1 });
  expect(cut).toMatchObject({ status: 'truncated', notice: { code: 'sync_tail_degraded', fix: { argv: ['gbrain', 'extract', '--stale', '--source-id', id] } } });
  expect(cut?.notice?.why).toContain('with 1 imported page(s) not yet derived');
  // One imported page, derived before the deadline, with the older backlog still stale: the tail is done.
  writeFileSync(join(root, 'notes', 'n4.md'), '---\ntitle: n4\n---\nSee [[notes/n0]].\n');
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'one more');
  await performSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, drain: true });
  const [next] = await engine.executeRaw<{ fingerprint: string; run_id: string }>("SELECT fingerprint, completed_keys->0->>'runId' AS run_id FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [id]);
  await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,processingOptions,noExtract}','false'::jsonb) WHERE op='managed-sync' AND fingerprint=$1", [next!.fingerprint]);
  await recordSyncTail(engine, id, next!.fingerprint, next!.run_id);
  const staleBefore = await stale(id);
  expect(staleBefore).toBeGreaterThan(1);
  const done = await runSyncTail(slowFirst(1_000), id, { budgetMs: 1_000 });
  expect(done?.links?.remaining).toBeGreaterThan(0);
  expect(done).toMatchObject({ status: 'done' });
  expect(done?.notice).toBeUndefined();
}), 120_000);

