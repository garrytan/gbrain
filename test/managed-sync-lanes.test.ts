/**
 * #5984 lanes (Postgres only): several bulk groups of one draining managed
 * sync publish at once and still commit in manifest order.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resolveBulkSettings } from '../src/core/persistence/sync-group.ts';
import { WINDOW_CANCEL_MESSAGE } from '../src/core/persistence/sync-window.ts';
import { acquireShared, leaseDraining, leaseWounded, yieldLease } from '../src/core/persistence/worktree-lease.ts';
import type { NativeLockHandle } from '../src/core/persistence/native-lock.ts';
import { withEnv } from './helpers/with-env.ts';
import { awaitLaneTurn, closeLaneRun, laneOf, laneRoots, laneTask, openLanes } from '../src/core/persistence/sync-lanes.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-lanes-'));
let engine: BrainEngine | undefined;
let closePostgres: (() => Promise<void>) | undefined;
const sources: string[] = [];
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function fixture(e: BrainEngine, files: Record<string, string>) {
  const id = `lanes-${randomUUID().replace(/-/g, '').slice(0, 20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) { const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, body); }
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await e.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(e, id, root);
  await e.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}
const pad = (i: number) => String(i).padStart(3, '0');
const notes = (count: number, edit: (i: number) => string | null = () => null) => Object.fromEntries(Array.from({ length: count }, (_, i) =>
  [`notes/n${pad(i)}.md`, edit(i) ?? `---\ntitle: Note ${i}\n---\nA durable observation number ${i}, see [[notes/n${pad((i + 7) % count)}]].\n`]));
const imports = (e: BrainEngine, source: string) => e.executeRaw<{ slug: string; state: string; grp: string | null; lane: string | null; error_message: string | null }>(
  `SELECT slug,state,intent->>'group' AS grp,intent->>'lane' AS lane,error_message FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence`, [source]);

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL, 'instance', 12); engine = pg.engine; closePostgres = pg.close;
}, 120_000);
afterAll(async () => {
  if (engine) await withEnv({ GBRAIN_HOME: home }, async () => {
    await disposePersistenceConsumer(engine!); await engine!.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    for (const id of sources) await engine!.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('lane settings follow flag > env > config > 6, clamp to the pool and need bulk groups', async () => {
  if (!engine) return;
  expect(await resolveBulkSettings(engine, false)).toMatchObject({ enabled: true, lanes: 6, lanesReason: null });
  expect(await resolveBulkSettings(engine, false, 1)).toMatchObject({ lanes: 1, lanesReason: 'disabled by --no-lanes' });
  expect(await resolveBulkSettings(engine, false, 8)).toMatchObject({ lanes: 8, lanesReason: null });
  expect(await resolveBulkSettings(engine, true, 4)).toMatchObject({ enabled: false, lanes: 1 });
  await withEnv({ GBRAIN_SYNC_LANES: '2' }, async () => expect(await resolveBulkSettings(engine!, false)).toMatchObject({ lanes: 2 }));
  await expect(resolveBulkSettings(engine, false, 9)).rejects.toMatchObject({ code: 'invalid_params' });
});

test('a lease is shared by lanes; an exclusive writer drains and wounds it and gets the lock once the lanes leave', async () => {
  let locks = 0, released = 0;
  const native = (): Promise<NativeLockHandle> => { locks++; let done = false; return Promise.resolve({ get released() { return done; }, async release() { done = true; released++; } }); };
  const path = join(home, 'lease-probe');
  const a = (await acquireShared(path, native))!, b = (await acquireShared(path, native))!;
  expect(locks).toBe(1);
  expect(await yieldLease(path, 0)).toBe(false);
  expect(leaseDraining(path) && leaseWounded(path)).toBe(true);
  expect(await acquireShared(path, native)).toBeNull();
  const waiting = yieldLease(path, 5000);
  await a.release(); expect(released).toBe(0);
  await b.release(); expect(released).toBe(1);
  expect(await waiting).toBe(true);
  expect(leaseDraining(path)).toBe(false);
});

test('lanes that start together share one native lock instead of all but one reporting busy', async () => {
  let held = false, locks = 0;
  const native = async (): Promise<NativeLockHandle | null> => {
    await new Promise(resolve => setTimeout(resolve, 20));
    if (held) return null;
    held = true; locks++;
    let done = false;
    return { get released() { return done; }, async release() { held = false; done = true; } };
  };
  const path = join(home, 'lease-start-race');
  const lanes = await Promise.all([acquireShared(path, native), acquireShared(path, native), acquireShared(path, native)]);
  expect(lanes.every(Boolean)).toBe(true);
  expect(locks).toBe(1);
  for (const lane of lanes) await lane!.release();
  expect(held).toBe(false);
});

test('a lane that joins while the last holder is still releasing the native lock waits for it instead of reporting busy', async () => {
  let held = false, locks = 0;
  const native = async (): Promise<NativeLockHandle | null> => {
    if (held) return null;
    held = true; locks++;
    let done = false;
    return { get released() { return done; }, async release() { await new Promise(resolve => setTimeout(resolve, 50)); held = false; done = true; } };
  };
  const path = join(home, 'lease-release-gap');
  const first = (await acquireShared(path, native))!;
  const releasing = first.release();
  const next = await acquireShared(path, native);
  await releasing;
  expect(next).not.toBeNull();
  expect(locks).toBe(2);
  expect(held).toBe(true);
  await next!.release();
  expect(held).toBe(false);
});

test('a lane waits for its predecessor to commit, yields to a requeued or unadmitted one and stops after a failed one', async () => {
  openLanes('wt-turn', 'run-turn', 4, null);
  const state = laneOf({ worktree_id: 'wt-turn', intent: { lane: 'run-turn' } } as never)!;
  const rows = [{ request_id: 'b', principal_kind: 'local_cli', principal_id: 'p', intent: { after: 'a', lane: 'run-turn' } }] as never;
  const tx = (states: Array<string | null>) => ({ executeRaw: async () => { const next = states.shift(); return next === null || next === undefined ? [] : [{ state: next }]; } }) as never;
  await awaitLaneTurn(tx(['running', 'running', 'committed']), state, rows);
  await expect(awaitLaneTurn(tx(['running', 'queued']), state, rows)).rejects.toMatchObject({ reason: 'predecessor_requeued' });
  await expect(awaitLaneTurn(tx([null]), state, rows)).rejects.toMatchObject({ reason: 'predecessor_requeued' });
  await expect(awaitLaneTurn(tx(['running', 'failed']), state, rows)).rejects.toMatchObject({ reason: 'predecessor_failed' });
  await expect(awaitLaneTurn(tx(['running', 'running', 'running']), state, rows, 60)).rejects.toMatchObject({ reason: 'order_timeout' });
  await closeLaneRun('run-turn');
  expect(laneOf({ worktree_id: 'wt-turn', intent: { lane: 'run-turn' } } as never)).toBeNull();
});

test('closing a lane run stops new lane claims and waits for the lane tasks still running', async () => {
  openLanes('wt-close', 'run-close', 4, null);
  const state = laneOf({ worktree_id: 'wt-close', intent: { lane: 'run-close' } } as never)!;
  const release = laneTask(state);
  let closed = false;
  const closing = closeLaneRun('run-close').then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(closed).toBe(false);
  expect(laneRoots().find(root => root.worktreeId === 'wt-close')?.capacity).toBe(0);
  release(); release();
  await closing;
  expect(state.tasks).toBe(0);
  expect(laneOf({ worktree_id: 'wt-close', intent: { lane: 'run-close' } } as never)).toBeNull();
});

test('lanes publish several groups at once and every page still commits, attributed to its own request, in manifest order', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_BULK_SIZE: '4' }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(80));
  const result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 4 });
  expect(result.drain).toMatchObject({ outcome: 'synced', bulk: { enabled: true, lanes: { configured: 4 } } });
  expect(result.drain!.bulk!.lanes.overlapped_groups).toBeGreaterThan(0);
  expect(result.drain!.bulk!.lanes.fallbacks).toBe(0);
  const rows = await imports(engine, f.id);
  expect(rows).toHaveLength(80);
  expect(rows.every(row => row.state === 'committed')).toBe(true);
  expect(rows.some(row => row.lane)).toBe(true);
  const attributed = await engine.executeRaw<{ mismatched: boolean }>(`SELECT p.revision_write_request_id IS DISTINCT FROM r.id AS mismatched
    FROM pages p JOIN persistence_requests r ON r.source_id=p.source_id AND r.slug=p.slug AND r.intent->>'kind'='managed_sync_import' WHERE p.source_id=$1`, [f.id]);
  expect(attributed).toHaveLength(80);
  expect(attributed.filter(row => row.mismatched)).toEqual([]);
  const [cursor] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM op_checkpoints WHERE op='managed-sync' AND (completed_keys->0 ? 'window' OR completed_keys->0 ? 'group') AND completed_keys->0->>'sourceId'=$1", [f.id]);
  expect(cursor!.n).toBe(0);
}), 300_000);

test('a failed page under lanes stops the run: earlier pages commit, nothing after it publishes', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SYNC_BULK_SIZE: '4' }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(60, i => i === 30 ? '---\ntitle: Conflict\nslug: notes/other\n---\nA conflicting identity must not be imported.\n' : null));
  await engine.setConfig('sync.holds', 'fail');
  const result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 4 })
    .finally(() => engine!.unsetConfig('sync.holds'));
  expect(result.drain).toMatchObject({ outcome: 'blocked' });
  expect(result.managedWrite?.slug).toBe('notes/n030');
  const rows = await imports(engine, f.id);
  const failedAt = rows.findIndex(row => row.slug === 'notes/n030');
  expect(rows[failedAt]!.state).toBe('failed');
  expect(rows.slice(0, failedAt).every(row => row.state === 'committed')).toBe(true);
  expect(rows.slice(failedAt + 1).every(row => row.state === 'cancelled')).toBe(true);
  for (const row of rows.slice(failedAt + 1)) expect(await engine.getPage(row.slug, { sourceId: f.id })).toBeNull();
  const laterGroups = rows.slice(failedAt + 1).filter(row => row.grp !== rows[failedAt]!.grp);
  for (const row of laterGroups) expect(row.error_message).toBe(WINDOW_CANCEL_MESSAGE);
}), 300_000);

test('lanes and --no-lanes build the same pages and the same links from a cross-linked corpus', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_BULK_SIZE: '4' }, async () => {
  if (!engine) return;
  const corpus = notes(48);
  const laned = await fixture(engine, corpus), serial = await fixture(engine, corpus);
  const a = await performSync(engine, { sourceId: laned.id, noPull: true, noEmbed: true, drain: true, lanes: 4 });
  const b = await performSync(engine, { sourceId: serial.id, noPull: true, noEmbed: true, drain: true, lanes: 1 });
  expect(a.drain).toMatchObject({ outcome: 'synced', bulk: { lanes: { configured: 4 } } });
  expect(b.drain).toMatchObject({ outcome: 'synced', bulk: { lanes: { configured: 1, reason: 'disabled by --no-lanes' } } });
  const graph = (source: string) => engine!.executeRaw<{ edge: string }>(`SELECT f.slug||'>'||t.slug AS edge FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
    WHERE f.source_id=$1 ORDER BY 1`, [source]).then(rows => rows.map(row => row.edge));
  const pages = (source: string) => engine!.executeRaw<{ slug: string; hash: string }>('SELECT slug,content_hash AS hash FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [source]);
  expect(await graph(laned.id)).toEqual(await graph(serial.id));
  expect((await graph(laned.id)).length).toBeGreaterThan(0);
  expect(await pages(laned.id)).toEqual(await pages(serial.id));
}), 300_000);
