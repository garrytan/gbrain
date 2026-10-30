import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts, SyncResult } from '../src/commands/sync.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { DRAIN_LEASE_TTL_MINUTES, HOLDER_STALL_MS, LEASE_BEACON_QUEUE, followStopAt, holderStalled, readDrainHolder, withDrainLease } from '../src/core/persistence/sync-lease.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { drainNext } from '../src/core/persistence/sync-drain.ts';
import { liveSyncJob } from '../src/core/persistence/sync-movement.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { syncLockId, tryAcquireDbLock } from '../src/core/db-lock.ts';
import { SyncLockBusyError } from '../src/core/sync-lock.ts';
import { noteForwardProgress, registerRunDeadline } from '../src/core/forward-progress.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { makeSyncHandler } from '../src/core/minions/handlers/sync.ts';

// #6712 PR 1: the drain lease. One managed drainer per source, whoever started it, fenced on the lock's acquisition
// token; a plain CLI sync follows a live holder within its budget instead of draining beside it. Each test here fails on
// the base (no lease: both drainers run, nothing is fenced, nothing is followed).

const home = mkdtempSync(join(tmpdir(), 'gbrain-sync-lease-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterEach(() => { installFaultHook(undefined); registerRunDeadline(null); });
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
async function fixture(engine: BrainEngine) {
  const id = `lease-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const name of ['a', 'b', 'c']) writeFileSync(join(root, `${name}.md`), `---\ntitle: ${name}\n---\nA durable observation named ${name} at acme-example.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return id;
}
const isolated = (fn: (engine: BrainEngine) => Promise<void>) => withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
  for (const engine of engines) await fn(engine);
});
const plain = (sourceId: string, extra: Partial<SyncOpts> = {}): SyncOpts => ({ sourceId, noPull: true, noEmbed: true, noExtract: true, ...extra });
const done = (): SyncResult => ({ status: 'up_to_date', fromCommit: null, toCommit: '', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [] });
/** A holder that keeps the lease until `release()`; `started` resolves once it holds it. */
function hold(engine: BrainEngine, sourceId: string, kind: 'serve' | 'cli' | 'job' = 'serve') {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const result = withDrainLease(engine, sourceId, { holder: { kind, id: kind === 'job' ? '4242' : `${kind}-example` } }, async () => { started(); await gate; return done(); });
  return { ready, release: () => { release(); return result; } };
}
const managedRows = async (engine: BrainEngine, id: string) => ({
  cursors: (await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [id])).length,
  requests: (await engine.executeRaw('SELECT 1 FROM persistence_requests WHERE source_id=$1', [id])).length,
});

test('the lease is the per-source sync lock with a short TTL a dead holder loses inside one cron tick', async () => isolated(async engine => {
  const id = await fixture(engine);
  const holder = hold(engine, id);
  await holder.ready;
  const [row] = await engine.executeRaw<{ ttl_seconds: number }>('SELECT extract(epoch from ttl_expires_at - acquired_at)::int AS ttl_seconds FROM gbrain_cycle_locks WHERE id=$1', [syncLockId(id)]);
  expect(row!.ttl_seconds).toBe(DRAIN_LEASE_TTL_MINUTES * 60);
  expect(DRAIN_LEASE_TTL_MINUTES * 60_000 + 60_000).toBeLessThan(15 * 60_000);
  expect(await readDrainHolder(engine, id)).toMatchObject({ kind: 'serve', id: 'serve-example', pid: process.pid, version: expect.any(String), progress: { committed: 0 } });
  await holder.release();
  expect(await engine.executeRaw('SELECT 1 FROM gbrain_cycle_locks WHERE id=$1', [syncLockId(id)])).toHaveLength(0);
}), 120_000);

test('a job, the cycle and sync_brain skip a busy lease with SyncLockBusyError; a nested pass inside the lease runs under it', async () => isolated(async engine => {
  const id = await fixture(engine);
  const holder = hold(engine, id);
  await holder.ready;
  await expect(performSync(engine, plain(id, { drainHolder: { kind: 'job', id: '7' } }))).rejects.toBeInstanceOf(SyncLockBusyError);
  await holder.release();
  // Reentrancy: a pass inside a held lease (a drain's passes, staged stages) never follows itself.
  const nested = await withDrainLease(engine, id, { holder: { kind: 'cli' } }, () => performManagedSync(engine, plain(id)));
  expect(nested.status).toBe('first_sync');
}), 120_000);

test('a plain sync follows a live holder, takes the lease when it releases and drains', async () => isolated(async engine => {
  const id = await fixture(engine);
  const holder = hold(engine, id);
  await holder.ready;
  const lines: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  let followed: Promise<SyncResult>;
  try {
    followed = performSync(engine, plain(id, { followDrainLease: true, drainHolder: { kind: 'cli', id: null } }));
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect(await managedRows(engine, id)).toEqual({ cursors: 0, requests: 0 });
    await holder.release();
    expect((await followed).status).toBe('first_sync');
  } finally { console.error = origError; }
  expect(lines.join('')).toContain('is being drained by a serve drainer');
  expect(lines.join('')).toContain('Ctrl-C stops following and leaves it running');
  expect(await engine.getPage('c', { sourceId: id })).not.toBeNull();
}), 120_000);

test('out of budget the follower is resumable with sync_drain_lease_held, the holder, and a wait fix', async () => isolated(async engine => {
  const id = await fixture(engine);
  const holder = hold(engine, id);
  await holder.ready;
  const result = await performSync(engine, plain(id, { followDrainLease: true, deadlineAtMs: Date.now() + 3000 }));
  expect(result).toMatchObject({ status: 'partial', reason: 'drain_lease_held', drain: { outcome: 'resumable', stop_reason: 'drain_lease_held' },
    leaseHeld: { code: 'sync_drain_lease_held', safe_to_loop: true, retry_after_ms: 60_000,
      holder: { kind: 'serve', id: 'serve-example', pid: process.pid, host: expect.any(String), started_at: expect.any(String), last_heartbeat_at: expect.any(String),
        version: expect.any(String), progress: { committed: 0 } } } });
  expect(result.leaseHeld!.fix.why).toContain('--break-lock');
  const next = drainNext(result, `gbrain sync --source ${id} --no-pull`, id);
  expect(next).toMatchObject({ code: 'sync_drain_lease_held', safe_to_loop: true, retry_after_ms: 60_000, fix: { next: 'wait' } });
  expect(await managedRows(engine, id)).toEqual({ cursors: 0, requests: 0 });
  await holder.release();
}), 120_000);

test('Ctrl-C stops following at once and leaves the holder holding the lease', async () => isolated(async engine => {
  const id = await fixture(engine);
  const holder = hold(engine, id);
  await holder.ready;
  const token = async () => (await engine.executeRaw<{ t: string }>('SELECT acquisition_token::text AS t FROM gbrain_cycle_locks WHERE id=$1', [syncLockId(id)]))[0]?.t;
  const before = await token();
  const interrupt = new AbortController();
  setTimeout(() => interrupt.abort(new Error('SIGINT')), 500);
  const started = Date.now();
  const result = await performSync(engine, plain(id, { followDrainLease: true, signal: interrupt.signal }));
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(result.leaseHeld?.code).toBe('sync_drain_lease_held');
  expect(await token()).toBe(before!);
  await holder.release();
}), 120_000);

test('a holder that heartbeats but makes no progress for the stall window stops the follower blocked, not resumable', async () => isolated(async engine => {
  const id = await fixture(engine);
  const holder = hold(engine, id, 'cli');
  await holder.ready;
  await engine.executeRaw(`UPDATE gbrain_cycle_locks SET acquired_at=now()-make_interval(secs => $2) WHERE id=$1`, [syncLockId(id), HOLDER_STALL_MS / 1000 + 60]);
  const result = await performSync(engine, plain(id, { followDrainLease: true, deadlineAtMs: Date.now() + 30_000 }));
  expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { cause: 'no_progress', owner_kind: 'cli', lease_holder: { kind: 'cli' } } });
  const next = drainNext(result, `gbrain sync --source ${id} --no-pull`, id);
  expect(next).toMatchObject({ code: 'drain_stalled', cause: 'no_progress', safe_to_loop: false });
  expect(next?.why).toContain('--break-lock');
  await holder.release();
}), 120_000);

test('#7327: a holder writing only holds is progressing; the follower waits instead of stopping drain_stalled', async () => isolated(async engine => {
  const id = await fixture(engine);
  const holder = hold(engine, id, 'job');
  await holder.ready;
  await engine.executeRaw(`UPDATE gbrain_cycle_locks SET acquired_at=now()-make_interval(secs => $2) WHERE id=$1`, [syncLockId(id), HOLDER_STALL_MS / 1000 + 60]);
  const [binding] = await engine.executeRaw<{ incarnation: string }>('SELECT source_incarnation::text AS incarnation FROM persistence_source_bindings WHERE source_id=$1', [id]);
  await engine.transaction(tx => writeGitHold(tx, { source_id: id, incarnation: binding!.incarnation, path: 'linked/a.md', source_path: 'linked/a.md', slug: 'linked/a', page_id: null,
    code: 'file_unreadable', message: 'Sync did not read linked/a.md: it is a symlink.', upstream_version: null, observed_at: new Date().toISOString(), run_id: 'run-1', mode: 'managed',
    meta: { reason: 'symlink_dangling', recovery_version: 1 } } as Parameters<typeof writeGitHold>[1]));
  const seen = await readDrainHolder(engine, id);
  expect(seen?.progress?.committed).toBe(0);
  expect(Date.now() - Date.parse(seen!.progress!.last_progress_at!)).toBeLessThan(HOLDER_STALL_MS);
  expect(holderStalled(seen)).toBe(false);
  const result = await performSync(engine, plain(id, { followDrainLease: true, deadlineAtMs: Date.now() + 3_000 }));
  expect(result.drain).toMatchObject({ outcome: 'resumable', stop_reason: 'drain_lease_held' });
  await holder.release();
}), 120_000);

test('fencing: a pass whose lease was taken over after its TTL admits nothing and advances no checkpoint', async () => isolated(async engine => {
  const id = await fixture(engine);
  let thief: Awaited<ReturnType<typeof tryAcquireDbLock>> = null;
  installFaultHook(async (point, detail) => {
    if (point !== 'sync:lease_acquired' || detail.sourceId !== id || thief) return;
    // The holder pauses past its TTL (no heartbeat inside the steal grace) and another process takes the lease over.
    await engine.executeRaw(`UPDATE gbrain_cycle_locks SET ttl_expires_at=now()-interval '1 minute', last_refreshed_at=now()-interval '1 hour' WHERE id=$1`, [syncLockId(id)]);
    thief = await tryAcquireDbLock(engine, syncLockId(id), DRAIN_LEASE_TTL_MINUTES);
    expect(thief).not.toBeNull();
  });
  const stale = await performSync(engine, plain(id));
  installFaultHook(undefined);
  expect(stale).toMatchObject({ reason: 'drain_lease_held', leaseHeld: { lost: true } });
  expect(await managedRows(engine, id)).toEqual({ cursors: 0, requests: 0 });
  await thief!.release();
  expect((await performSync(engine, plain(id))).status).toBe('first_sync');
}), 120_000);

// Outside-voice review: a lease that lapsed with nobody taking it over is lost too; the token alone does not admit.
test('fencing: a pass whose lease expired untaken admits nothing and advances no checkpoint', async () => isolated(async engine => {
  const id = await fixture(engine);
  let lapsed = false;
  installFaultHook(async (point, detail) => {
    if (point !== 'sync:lease_acquired' || detail.sourceId !== id || lapsed) return;
    lapsed = true;
    await engine.executeRaw(`UPDATE gbrain_cycle_locks SET ttl_expires_at=now()-interval '1 second' WHERE id=$1`, [syncLockId(id)]);
  });
  const stale = await performSync(engine, plain(id));
  installFaultHook(undefined);
  expect(lapsed).toBe(true);
  expect(stale).toMatchObject({ reason: 'drain_lease_held', leaseHeld: { lost: true } });
  expect(await managedRows(engine, id)).toEqual({ cursors: 0, requests: 0 });
  expect((await performSync(engine, plain(id))).status).toBe('first_sync');
}), 120_000);

// Outside-voice review: a job result is readable remotely (get_job), so the skip names the holder's kind, never its host, pid or id.
test('a sync job that finds the lease held skips with the public holder only', async () => isolated(async engine => {
  const id = await fixture(engine);
  const holder = hold(engine, id, 'cli');
  await holder.ready;
  try {
    const ctx = { id: 9101, name: 'sync', data: { sourceId: id, pull: false }, attempts_made: 0, signal: new AbortController().signal, shutdownSignal: new AbortController().signal,
      deadlineAtMs: Date.now() + 60_000, updateProgress: async () => undefined, updateTokens: async () => undefined, log: async () => undefined, isActive: async () => true,
      readInbox: async () => [] } as unknown as MinionJobContext;
    const skipped = await makeSyncHandler(engine)(ctx) as Record<string, unknown>;
    expect(skipped).toMatchObject({ skipped: true, reason: 'sync_in_progress', holder: { kind: 'cli', host: null, pid: null, id: null } });
  } finally { await holder.release(); }
}), 120_000);

test('the follower stops before the process watchdog: the lesser of its deadline and the hard deadline, less a margin', () => {
  const now = Date.now();
  registerRunDeadline({ atMs: now + 13 * 60_000, strict: true });
  expect(followStopAt(now)).toBe(now + 13 * 60_000 - 30_000);
  expect(followStopAt(now, now + 60_000)).toBe(now + 60_000 - 30_000);
  expect(followStopAt(now, now + 20_000)).toBe(now + 10_000);
  // The non-TTY window extends while progress arrives (a holder's commits count as this run's progress).
  registerRunDeadline({ atMs: now + 60_000, strict: false, progressWindowMs: 10 * 60_000 });
  noteForwardProgress();
  expect(followStopAt(now)).toBeGreaterThan(now + 9 * 60_000);
});

// The cron recipe doctor prints (`gbrain sync --all --no-pull --hard-deadline 13m`) against a live serve holder: it follows the
// serve instead of refusing or draining beside it, and finishes the source once the serve's drain ends.
test('doctor\'s cron recipe follows a live serve holder and finishes the source; --no-delegate does not bypass the lease', async () => isolated(async engine => {
  const id = await fixture(engine);
  await engine.executeRaw("UPDATE sources SET config=jsonb_set(config,'{syncEnabled}','false'::jsonb) WHERE id<>$1", [id]);
  const holder = hold(engine, id, 'serve');
  await holder.ready;
  const { runSync } = await import('../src/commands/sync.ts');
  const lines: string[] = [], exits: number[] = [];
  const origError = console.error, origLog = console.log, origExit = process.exit;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  process.exit = ((code?: number) => { exits.push(code ?? 0); throw new Error(`process.exit(${code})`); }) as typeof process.exit;
  try {
    // The recipe as doctor prints it, plus --no-embed (this test brain has no embedding provider key) and --no-delegate.
    const cron = runSync(engine, ['--all', '--no-pull', '--hard-deadline', '13m', '--no-embed', '--no-delegate']).catch((error: unknown) => error);
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect(await managedRows(engine, id)).toEqual({ cursors: 0, requests: 0 });
    await holder.release();
    await cron;
  } finally { console.error = origError; console.log = origLog; process.exit = origExit; }
  expect({ exits, lines: exits.length ? lines : [] }).toEqual({ exits: [], lines: [] });
  expect(await engine.getPage('c', { sourceId: id })).not.toBeNull();
}), 180_000);

// Older binaries take no lease, but their autopilot and sync jobs back off from a live `sync` job row (#6713). The
// query below is master's `liveSyncJob` before this change, verbatim.
test('a holder that is not a sync job is visible to an older binary\'s liveSyncJob, and only while it holds the lease', async () => isolated(async engine => {
  const id = await fixture(engine);
  const legacyLiveSyncJob = async () => (await engine.executeRaw<{ id: number }>(`SELECT id FROM minion_jobs WHERE name='sync' AND status='active' AND lock_until > now()
    AND (COALESCE(data->>'sourceId', data->>'source_id')=$1 OR (COALESCE(data->>'sourceId', data->>'source_id') IS NULL
      AND (data->>'repoPath' IS NULL AND $1='default' OR data->>'repoPath'=(SELECT local_path FROM sources WHERE id=$1)))) ORDER BY started_at LIMIT 1`, [id]))[0]?.id ?? null;
  expect(await legacyLiveSyncJob()).toBeNull();
  const holder = hold(engine, id, 'cli');
  await holder.ready;
  expect(await legacyLiveSyncJob()).not.toBeNull();
  // This build reads the lease itself; the beacon is not a job it reports.
  expect(await liveSyncJob(engine, id)).toBeNull();
  await holder.release();
  expect(await legacyLiveSyncJob()).toBeNull();
  expect(await engine.executeRaw('SELECT 1 FROM minion_jobs WHERE queue=$1', [LEASE_BEACON_QUEUE])).toHaveLength(0);
  // A sync job holder's record names the job, and liveSyncJob reports the job itself, not the record row.
  const job = hold(engine, id, 'job');
  await job.ready;
  expect(await engine.executeRaw("SELECT data->'drain_lease_beacon'->>'id' AS id FROM minion_jobs WHERE queue=$1", [LEASE_BEACON_QUEUE])).toEqual([{ id: '4242' }]);
  expect(await liveSyncJob(engine, id)).toBe(4242);
  await job.release();
  expect(await engine.executeRaw('SELECT 1 FROM minion_jobs WHERE queue=$1', [LEASE_BEACON_QUEUE])).toHaveLength(0);
}), 120_000);
