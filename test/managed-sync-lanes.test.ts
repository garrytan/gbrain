/**
 * #5984 lanes (Postgres only): several bulk groups of one draining managed
 * sync publish at once and still commit in manifest order.
 */
import { afterAll, beforeAll, expect, setSystemTime, test } from 'bun:test';
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
import { acquireShared, DEFER_WAIT_MS, deferToLease, exclusiveAcquired, joinLease, leaseDraining, leaseWounded, yieldLease } from '../src/core/persistence/worktree-lease.ts';
import type { NativeLockHandle } from '../src/core/persistence/native-lock.ts';
import { withEnv } from './helpers/with-env.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { awaitLaneTurn, closeLaneRun, laneApplyBegin, laneClaim, laneOf, laneRoots, laneTask, openLanes } from '../src/core/persistence/sync-lanes.ts';
import { lanesLimit } from '../src/core/persistence/sync-drain.ts';

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

test('lane settings are a maximum: flag > env > config > 16, clamped to the pool, and need bulk groups', async () => {
  if (!engine) return;
  expect(await resolveBulkSettings(engine, false)).toMatchObject({ enabled: true, lanes: 8, lanesMax: 16, lanesCap: 'pool',
    lanesReason: 'the connection pool holds 11 long transactions; set GBRAIN_POOL_SIZE=20 for 16 lanes' });
  expect(await resolveBulkSettings(engine, false, 1)).toMatchObject({ lanes: 1, lanesMax: 1, lanesCap: 'disabled', lanesReason: 'disabled by --no-lanes' });
  expect(await resolveBulkSettings(engine, false, 8)).toMatchObject({ lanes: 8, lanesMax: 8, lanesCap: 'maximum', lanesReason: null });
  expect(await resolveBulkSettings(engine, false, 12)).toMatchObject({ lanes: 8, lanesMax: 12, lanesCap: 'pool' });
  expect(await resolveBulkSettings(engine, true, 4)).toMatchObject({ enabled: false, lanes: 1 });
  await withEnv({ GBRAIN_SYNC_LANES: '2' }, async () => expect(await resolveBulkSettings(engine!, false)).toMatchObject({ lanes: 2, lanesCap: 'maximum' }));
  await expect(resolveBulkSettings(engine, false, 17)).rejects.toMatchObject({ code: 'invalid_params' });
  await withEnv({ GBRAIN_SYNC_LANES: '17' }, async () => expect(resolveBulkSettings(engine!, false)).rejects.toMatchObject({ code: 'invalid_params' }));
});

test('the drain names what limited its lanes and what raises it', () => {
  const base = { maximum: 16, configured: 6, effective: 6, step_down: null, busy: 5.8 };
  expect(lanesLimit({ ...base, configured: 1, effective: 1, maximum: 1 }, 'disabled')).toMatchObject({ kind: 'lanes_off' });
  expect(lanesLimit({ ...base, effective: 5, step_down: 'lock_timeout on a lane group' }, 'pool')).toMatchObject({ kind: 'database_contention' });
  expect(lanesLimit({ ...base, busy: 3.1 }, 'pool')).toMatchObject({ kind: 'feeder', raise: null });
  expect(lanesLimit(base, 'pool')).toMatchObject({ kind: 'pool', raise: expect.stringContaining('GBRAIN_POOL_SIZE=20') });
  expect(lanesLimit({ ...base, maximum: 6 }, 'maximum')).toMatchObject({ kind: 'maximum', raise: expect.stringContaining('sync.lanes 16') });
  expect(lanesLimit({ ...base, maximum: 16, configured: 16, effective: 16, busy: 15 }, 'maximum')).toMatchObject({ kind: 'maximum', raise: null });
});

test('lane timing counts busy lanes, apply time per page and the commit-turn wait share', async () => {
  // The clock is driven by the test, so a late timer on a loaded machine cannot move the measured shares.
  const t0 = Date.now();
  try {
    setSystemTime(new Date(t0));
    openLanes('wt-time', 'run-time', 4, null);
    const state = laneOf({ worktree_id: 'wt-time', intent: { lane: 'run-time' } } as never)!;
    const a = laneApplyBegin(state), b = laneApplyBegin(state);
    setSystemTime(new Date(t0 + 60));
    a.turn(); b.turn();
    setSystemTime(new Date(t0 + 100));
    a.turned(); a.end(4);
    b.turned(); b.end(2);
    const stats = (await closeLaneRun('run-time'))!;
    expect(stats.busy).toBe(2);
    expect(stats.applyMsPerPage).toBe(20);
    expect(stats.turnWaitShare).toBe(0.4);
  } finally {
    setSystemTime();
  }
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

test('a background writer never wounds the lanes: the lease drains for it after the defer wait, and no new lease starts until it has the lock', async () => {
  const native = (): Promise<NativeLockHandle> => { let done = false; return Promise.resolve({ get released() { return done; }, async release() { done = true; } }); };
  const path = join(home, 'lease-defer');
  // The clock is pinned before the writer defers, so the defer wait is measured from a known instant.
  const start = Date.now();
  setSystemTime(new Date(start));
  try {
    const lane = (await acquireShared(path, native))!;
    expect(deferToLease(path)).toBe(false);
    expect(leaseWounded(path) || leaseDraining(path)).toBe(false);
    setSystemTime(new Date(start + DEFER_WAIT_MS));
    expect(leaseDraining(path)).toBe(true);
    expect(leaseWounded(path)).toBe(false);
    await lane.release();
    // Between leases the waiting writer goes first: lanes do not open a new lease until it took the lock.
    expect(leaseDraining(path)).toBe(true);
    expect(deferToLease(path)).toBe(true);
    exclusiveAcquired(path);
    expect(leaseDraining(path)).toBe(false);
  } finally { setSystemTime(); }
});

test('a foreground write joins a live lane lease and keeps it open until it leaves; it never takes a wounded or absent one', async () => {
  let released = 0;
  const native = (): Promise<NativeLockHandle> => { let done = false; return Promise.resolve({ get released() { return done; }, async release() { done = true; released++; } }); };
  const path = join(home, 'lease-join');
  expect(joinLease(path)).toBeNull();
  const lane = (await acquireShared(path, native))!;
  const write = joinLease(path)!;
  expect(write).not.toBeNull();
  await lane.release(); expect(released).toBe(0);
  await write.release(); expect(released).toBe(1);
  const again = (await acquireShared(path, native))!;
  expect(await yieldLease(path, 0)).toBe(false);
  expect(joinLease(path)).toBeNull();
  await again.release();
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

test('closing a lane run waits for a claim still in flight to count its lane task', async () => {
  openLanes('wt-claim', 'run-claim', 4, null);
  const state = laneOf({ worktree_id: 'wt-claim', intent: { lane: 'run-claim' } } as never)!;
  const claimed = laneClaim();
  let closed = false;
  const closing = closeLaneRun('run-claim').then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(closed).toBe(false);
  const release = laneTask(state);
  claimed();
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(closed).toBe(false);
  release();
  await closing;
  expect(laneOf({ worktree_id: 'wt-claim', intent: { lane: 'run-claim' } } as never)).toBeNull();
});

test('lanes publish several groups at once and every page still commits, attributed to its own request, in manifest order', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_BULK_SIZE: '4' }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(80));
  const result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 4 });
  expect(result.drain).toMatchObject({ outcome: 'synced', bulk: { enabled: true, lanes: { maximum: 4, configured: 4, limited_by: { kind: expect.any(String) } } } });
  expect(result.drain!.bulk!.lanes.busy).toBeGreaterThan(1);
  expect(result.drain!.bulk!.lanes.apply_ms_per_page).toBeGreaterThan(0);
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

test('admit-ahead fits the writer\'s outstanding-request limit instead of stopping when a batch would exceed it', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_BULK_SIZE: '4' }, async () => {
  if (!engine) return;
  // Eight lanes keep sixteen groups of four admitted ahead; the principal may hold only 40 outstanding requests.
  await engine.setConfig('persistence.limits.principal_outstanding', '40');
  try {
    const f = await fixture(engine, notes(160));
    const admitted: number[] = []; // the source's queued and running requests at each cursor step
    installFaultHook(async (point, detail) => {
      if (point !== 'sync:mid_checkpoint' || detail.sourceId !== f.id) return;
      const [row] = await engine!.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running')", [f.id]);
      admitted.push(row!.n);
    });
    // Every admission transaction the limit refused (an admission over it used to stop admit-ahead until the window drained).
    const refused: string[] = [];
    const transaction = engine.transaction;
    engine.transaction = async function (this: BrainEngine, fn: (tx: BrainEngine) => Promise<unknown>) {
      try { return await transaction.call(this, fn); }
      catch (error) { if ((error as { code?: string }).code === 'queue_capacity') refused.push((error as Error).message); throw error; }
    } as BrainEngine['transaction'];
    let result;
    try { result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 8 }); }
    finally { engine.transaction = transaction; installFaultHook(undefined); }
    expect(result.drain).toMatchObject({ outcome: 'synced' });
    expect((await imports(engine, f.id)).every(row => row.state === 'committed')).toBe(true);
    expect(refused).toEqual([]);
    // Admit-ahead still kept groups admitted while it stayed under the limit.
    expect(Math.max(...admitted)).toBeGreaterThan(8);
    expect(Math.max(...admitted)).toBeLessThanOrEqual(40);
  } finally {
    installFaultHook(undefined);
    await engine.executeRaw("DELETE FROM config WHERE key='persistence.limits.principal_outstanding'");
  }
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
  expect(rows.slice(failedAt + 1).filter(row => row.state !== 'cancelled').map(row => `${row.slug} ${row.state} group=${row.grp} lane=${row.lane}`)).toEqual([]);
  for (const row of rows.slice(failedAt + 1)) expect(await engine.getPage(row.slug, { sourceId: f.id })).toBeNull();
  const laterGroups = rows.slice(failedAt + 1).filter(row => row.grp !== rows[failedAt]!.grp);
  for (const row of laterGroups) expect(row.error_message).toBe(WINDOW_CANCEL_MESSAGE);
}), 300_000);

test('a crash right after a group is admitted and saved skips nothing and admits nothing twice; the first group is small', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_BULK_SIZE: '4' }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(40));
  let saves = 0, crashed = 0;
  installFaultHook(point => { if (point === 'sync:mid_checkpoint' && [3, 4, 6].includes(++saves)) { crashed++; throw new Error('injected crash after save-and-admit'); } });
  let result;
  try {
    for (let attempt = 0; attempt < 4 && result?.drain?.outcome !== 'synced'; attempt++) {
      result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 4 }).catch(() => null);
    }
  } finally { installFaultHook(undefined); }
  expect(crashed).toBe(3);
  if (result?.drain?.outcome !== 'synced') result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 4 });
  expect(result!.drain).toMatchObject({ outcome: 'synced' });
  const rows = await imports(engine, f.id);
  expect(rows).toHaveLength(40);
  expect(new Set(rows.map(row => row.slug)).size).toBe(40);
  expect(rows.every(row => row.state === 'committed')).toBe(true);
  const groups = new Map<string, number>();
  for (const row of rows) groups.set(row.grp ?? row.slug, (groups.get(row.grp ?? row.slug) ?? 0) + 1);
  expect(groups.get(rows[0]!.grp ?? rows[0]!.slug)).toBeLessThanOrEqual(2);
}), 300_000);

test('a group admission whose cursor another run moved rolls back: no request is admitted that the cursor does not hold', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_BULK_SIZE: '4' }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(24));
  let moved = false;
  const racing = new Proxy(engine, { get(target, key) {
    if (key === 'transaction') return async (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction(async tx => {
      const out = await fn(new Proxy(tx, { get(inner, k) {
        if (k === 'executeRaw') return async (sql: string, params?: unknown[], opts?: unknown) => {
          if (!moved && /^INSERT INTO persistence_requests/.test(sql.trim()) && /jsonb_array_elements/.test(sql)) {
            moved = true;
            await target.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,progress}','\"moved\"'::jsonb,true) WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [f.id]);
          }
          return inner.executeRaw(sql, params as never, opts as never);
        };
        const value = Reflect.get(inner, k); return typeof value === 'function' ? value.bind(inner) : value;
      } }));
      return out;
    });
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const first = await performSync(racing, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 4 }).catch(() => null);
  expect(moved).toBe(true);
  const result = first?.drain?.outcome === 'synced' ? first : await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 4 });
  expect(result.drain).toMatchObject({ outcome: 'synced' });
  const rows = await imports(engine, f.id);
  expect(rows).toHaveLength(24);
  expect(new Set(rows.map(row => row.slug)).size).toBe(24);
  expect(rows.every(row => row.state === 'committed')).toBe(true);
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
