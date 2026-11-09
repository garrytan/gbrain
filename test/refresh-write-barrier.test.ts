/**
 * PR B refresh write barrier (docs/designs/REFRESH_WRITE_BARRIER.md).
 *
 * Protects: with persistence.refresh_barrier on, a page write that reaches a refreshing checkout is journaled `deferred`
 * and answered pending at once (MCP isError false, status pending; receipt state queued plus `deferred`); after the
 * refresh ends it commits, unless the refresh changed its file, which ends it `revision_conflict` with nothing applied;
 * a consumer claim without the barrier's session declaration (an older binary) cannot move a deferred row; a replay of the
 * request id returns the same receipt; a write past the wait limit ends `refresh_barrier_expired` with its counters
 * released; a token revoked while its write waits ends it `permission_denied`; every write during a refresh is deferred, with no per-refresh cap; a live consumer without the capability keeps the
 * refusal; a repo-less source is never deferred; `gbrain upgrade --check-downgrade` exits 3 while a deferred write waits.
 * Seams: the real refresh state machine paused at its drained boundary (`hooks.boundary`); GBRAIN_REFRESH_BARRIER.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import postgres from '#postgres';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run as runUpgradeCommand } from '../src/cli/commands/upgrade.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer, preparePersistedMutation, waitForWrite } from '../src/core/persistence/service.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { settleTopologyRequests, topologyPrincipal } from '../src/core/persistence/topology-locks.ts';
import { pendingReceiptOf, writeErrorExitCode } from '../src/core/persistence/write-wait.ts';
import { PENDING_WRITE_EXIT_CODE } from '../src/core/exit-codes.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { refreshWorktree, resumeWorktreeRefreshes } from '../src/core/persistence/worktree-refresh.ts';
import { ledgerFiles, ledgerLocation, recordCommit } from '../src/core/git/commit-ledger.ts';
import { getWriteRequestById } from '../src/core/persistence/journal.ts';
import { readWriteWatermark } from '../src/core/persistence/applied-watermark.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { _setRefreshFenceWaitForTests } from '../src/core/persistence/admission-retry.ts';
import { _resetRefreshBarrierCacheForTests, deferredBacklog, expireDeferredWrites } from '../src/core/persistence/refresh-barrier.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { quarantineSharedSkillRestore } from '../src/core/shared-skills/restore.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { commitFile, git, page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let postgresUrl: string | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close; postgresUrl = pg.databaseUrl;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});
beforeEach(() => { _setRefreshFenceWaitForTests(0); _resetRefreshBarrierCacheForTests(); });
afterEach(() => { resetWriteSwitches(); _setRefreshFenceWaitForTests(null); });

/** Runs `fn` per engine with the barrier on (GBRAIN_REFRESH_BARRIER through withEnv). */
const each = (fn: (f: RefreshFixture) => Promise<void>) => withEnv({ GBRAIN_REFRESH_BARRIER: '1' }, async () => {
  resetWriteSwitches();
  for (const engine of engines) await withRefreshFixture(engine, fn);
});

/** Runs `fn` while a real refresh of the checkout is paused at its drained boundary; the refresh changes alpha/two.md. */
async function duringRefresh(f: RefreshFixture, fn: () => Promise<void>, change: [string, string] = ['alpha/two.md', page('Alpha two', 'An upstream observation.')]) {
  f.push(...change);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void; const drained = new Promise<void>(resolve => { reached = resolve; });
  const refresh = refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => { if (point === 'drained') { reached(); await gate; } } } });
  await drained;
  try { await fn(); } catch (error) { release(); await refresh.catch(() => undefined); throw error; }
  release();
  return refresh;
}

async function call(f: RefreshFixture, name: string, params: Record<string, unknown>, sourceId = f.alpha) {
  const result = await dispatchToolCall(f.engine, name, params, { remote: true, transport: 'stdio', sourceId, admissionOrigin: 'interactive' });
  return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

async function requestRow(f: RefreshFixture, requestId: string): Promise<WriteRequest> {
  const [row] = await f.engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
  return row!;
}

/** Drives this process's consumer until the released deferred row settles. */
async function settle(f: RefreshFixture, row: WriteRequest): Promise<WriteRequest> {
  return waitForWrite(f.engine, (await getWriteRequestById(f.engine, row.id))!, { engine: f.engine.kind } as never, 30_000);
}

/**
 * Postgres only: on a separate connection, moves refresh `refreshId` to aborted and keeps that transaction open while `start`
 * runs, until `start` waits on that connection's lock (or settles), then commits and returns what `start` returns and
 * whether it waited on that lock (a race test that never waited proves nothing).
 */
async function endRefreshDuring<T>(f: RefreshFixture, refreshId: string, start: () => Promise<T>): Promise<{ value: T; blocked: boolean }> {
  const sql = postgres(postgresUrl!, { max: 1, prepare: false });
  try {
    const conn = await sql.reserve();
    try {
      await conn.unsafe('BEGIN');
      const [{ pid }] = await conn.unsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
      await conn.unsafe("UPDATE persistence_worktree_refreshes SET state='aborted',completed_at=now(),updated_at=now() WHERE id=$1::uuid", [refreshId]);
      let settled = false; let blocked = false;
      const running = start().finally(() => { settled = true; });
      running.catch(() => undefined);
      for (let i = 0; i < 800 && !settled; i++) {
        const [waiting] = await f.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [pid]);
        if (Number(waiting!.n) > 0) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await conn.unsafe('COMMIT');
      return { value: await running, blocked };
    } finally { conn.release(); }
  } finally { await sql.end(); }
}

async function outstanding(f: RefreshFixture): Promise<number> {
  const [row] = await f.engine.executeRaw<{ n: number }>("SELECT outstanding_count::int AS n FROM persistence_counters WHERE key='brain'");
  return Number(row?.n ?? 0);
}

test('a page write during a refresh is deferred, answered pending at once, and commits after the refresh', () => each(async f => {
  let deferred!: WriteRequest;
  const refresh = await duringRefresh(f, async () => {
    const started = performance.now();
    const out = await call(f, 'put_page', { slug: 'notes/deferred', content: page('Deferred', 'written during the refresh') });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(out.isError).toBe(false);
    expect(out.body).toMatchObject({ status: 'pending', receipt: { state: 'queued' }, next: { tool: 'get_write_request' } });
    expect(out.body.deferred.refresh_id).toBe(out.body.receipt.deferred.refresh_id);
    deferred = await requestRow(f, out.body.request_id);
    expect(deferred.state).toBe('deferred');
    expect(deferred.deferred_refresh_id).toBe(out.body.deferred.refresh_id);
    expect((await deferredBacklog(f.engine)).count).toBe(1);
    const replay = await call(f, 'put_page', { slug: 'notes/deferred', content: page('Deferred', 'written during the refresh'), request_id: out.body.request_id });
    expect(replay.isError).toBe(false);
    expect(replay.body.request_id).toBe(out.body.request_id);
    expect(await f.requestCount()).toBeGreaterThan(0);
    const [{ n }] = await f.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests WHERE request_id=$1::uuid', [out.body.request_id]);
    expect(Number(n)).toBe(1);
  });
  expect((await refresh).status).toBe('completed');
  const done = await settle(f, deferred);
  expect(done.state).toBe('committed');
  const [row] = await f.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [f.alpha, 'notes/deferred']);
  expect(Number(row!.n)).toBe(1);
  expect((await deferredBacklog(f.engine)).count).toBe(0);
}), 180_000);

test('a deferred create of a page the refresh added is refused by the page guard and never overwrites it', () => each(async f => {
  let deferred!: WriteRequest;
  const refresh = await duringRefresh(f, async () => {
    const out = await call(f, 'put_page', { slug: 'two', content: page('Mine', 'a local version that must not win') });
    expect(out.isError).toBe(false);
    deferred = await requestRow(f, out.body.request_id);
    expect(deferred.state).toBe('deferred');
  });
  expect((await refresh).status).toBe('completed');
  const done = await settle(f, deferred);
  expect(done.state).toBe('conflict');
  expect(done.error_code).toBe('revision_required');
  const [stored] = await f.engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [f.alpha, 'two']);
  expect(stored?.compiled_truth ?? '').not.toContain('must not win');
}), 180_000);

const PERSON = '---\ntitle: Alice Example\ntype: person\n---\nAlice is a person.\n';

test('a deferred blind write to a page the refresh changed ends revision_conflict naming the file, nothing applied', () => each(async f => {
  f.push('alpha/people/alice-example.md', PERSON);
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  let deferred!: WriteRequest;
  const refresh = await duringRefresh(f, async () => {
    const out = await call(f, 'remember', { fact: 'alice-example likes tea', entity: 'people/alice-example', provenance: 'test' });
    expect(out.isError).toBe(false);
    expect(out.body.status).toBe('pending');
    deferred = await requestRow(f, out.body.request_id);
    expect(deferred.state).toBe('deferred');
  }, ['alpha/people/alice-example.md', PERSON.replace('Alice is a person.', 'Alice is a person who moved.')]);
  expect((await refresh).status).toBe('completed');
  const done = await settle(f, deferred);
  expect(done).toMatchObject({ state: 'conflict', error_code: 'revision_conflict' });
  expect(done.error_message).toContain('people/alice-example.md');
  const [{ n }] = await f.engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE fact LIKE '%likes tea%'");
  expect(Number(n)).toBe(0);
}), 180_000);

test('a claim without the barrier declaration cannot move a deferred row, released or not', () => each(async f => {
  let deferred!: WriteRequest;
  const refresh = await duringRefresh(f, async () => {
    const out = await call(f, 'put_page', { slug: 'notes/guarded', content: page('Guarded', 'body') });
    deferred = await requestRow(f, out.body.request_id);
    await expect(f.engine.executeRaw("UPDATE persistence_requests SET state='running' WHERE id=$1::uuid", [deferred.id])).rejects.toThrow();
    await expect(f.engine.executeRaw("UPDATE persistence_requests SET state='queued' WHERE id=$1::uuid", [deferred.id])).rejects.toThrow();
  });
  expect((await refresh).status).toBe('completed');
  await expect(f.engine.executeRaw("UPDATE persistence_requests SET state='running' WHERE id=$1::uuid", [deferred.id])).rejects.toThrow();
  expect((await settle(f, deferred)).state).toBe('committed');
}), 180_000);

test('a deferred write past the wait limit ends refresh_barrier_expired and releases its counters', () => each(async f => {
  const refresh = await duringRefresh(f, async () => {
    const before = await outstanding(f);
    const out = await call(f, 'put_page', { slug: 'notes/expired', content: page('Expired', 'body') });
    const deferred = await requestRow(f, out.body.request_id);
    expect(await outstanding(f)).toBe(before + 1);
    await disposePersistenceConsumer(f.engine);
    await f.engine.executeRaw("INSERT INTO config(key,value) VALUES('persistence.refresh_barrier_max_wait_ms','1') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      const [{ owner }] = await f.engine.executeRaw<{ owner: string }>('SELECT owner_host_id::text AS owner FROM persistence_worktrees WHERE id=$1::uuid', [f.worktreeId]);
      const expired = await expireDeferredWrites(f.engine, owner);
      expect(expired.map(row => row.id)).toEqual([deferred.id]);
      const after = (await getWriteRequestById(f.engine, deferred.id))!;
      expect(after).toMatchObject({ state: 'failed', error_code: 'refresh_barrier_expired' });
      expect(await outstanding(f)).toBe(before);
    } finally {
      await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.refresh_barrier_max_wait_ms'");
    }
  });
  expect((await refresh).status).toBe('completed');
}), 180_000);

test('an expiry racing the end of its refresh leaves the write deferred, and it commits after the release (Postgres)', () => each(async f => {
  if (f.engine.kind !== 'postgres') return;
  let deferred!: WriteRequest;
  await duringRefresh(f, async () => {
    const out = await call(f, 'put_page', { slug: 'notes/expiry-race', content: page('Expiry race', 'body') });
    deferred = await requestRow(f, out.body.request_id);
    expect(deferred.state).toBe('deferred');
    await disposePersistenceConsumer(f.engine);
    await f.engine.executeRaw("INSERT INTO config(key,value) VALUES('persistence.refresh_barrier_max_wait_ms','1') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      const [{ owner }] = await f.engine.executeRaw<{ owner: string }>('SELECT owner_host_id::text AS owner FROM persistence_worktrees WHERE id=$1::uuid', [f.worktreeId]);
      const { value: expired, blocked } = await endRefreshDuring(f, deferred.deferred_refresh_id!, () => expireDeferredWrites(f.engine, owner));
      expect(expired.map(row => row.id)).toEqual([]);
      expect((await getWriteRequestById(f.engine, deferred.id))!.state).toBe('deferred');
      expect(blocked).toBe(true);
    } finally {
      await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.refresh_barrier_max_wait_ms'");
    }
  }).catch(error => { if (!(error instanceof OperationError)) throw error; });
  expect((await settle(f, deferred)).state).toBe('committed');
}), 180_000);

test('a write admitted while its refresh ends is never deferred to the released refresh (Postgres)', () => each(async f => {
  if (f.engine.kind !== 'postgres') return;
  let row!: WriteRequest;
  await duringRefresh(f, async () => {
    const active = (await f.refreshRows()).find(r => r.state === 'draining')!;
    const { value: out, blocked } = await endRefreshDuring(f, active.id, () => call(f, 'put_page', { slug: 'notes/admission-race', content: page('Admission race', 'body') }));
    row = await requestRow(f, out.body.request_id);
    expect(row.deferred_refresh_id).toBeNull();
    expect(row.state).not.toBe('deferred');
    expect(blocked).toBe(true);
  }).catch(error => { if (!(error instanceof OperationError)) throw error; });
  expect((await settle(f, row)).state).toBe('committed');
}), 180_000);

test('a shared-skill restore cancels a deferred write too and releases its counters (restore is PGLite-only)', () => each(async f => {
  if (f.engine.kind !== 'pglite') return;
  let deferred!: WriteRequest;
  const refresh = await duringRefresh(f, async () => {
    const before = await outstanding(f);
    const out = await call(f, 'put_page', { slug: 'notes/restored', content: page('Restored', 'deferred before the restore') });
    deferred = await requestRow(f, out.body.request_id);
    expect(deferred.state).toBe('deferred');
    expect(await outstanding(f)).toBe(before + 1);
    const rolledBack = new Error('roll the restore back');
    await f.engine.transaction(async tx => {
      await quarantineSharedSkillRestore(tx, randomUUID());
      const [row] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [deferred.id]);
      expect(row).toMatchObject({ state: 'cancelled', error_code: 'restore_new_brain' });
      const [counter] = await tx.executeRaw<{ n: number }>("SELECT outstanding_count::int AS n FROM persistence_counters WHERE key='brain'");
      expect(Number(counter!.n)).toBe(before);
      throw rolledBack;
    }).catch(error => { if (error !== rolledBack) throw error; });
  });
  expect((await refresh).status).toBe('completed');
  expect((await settle(f, deferred)).state).toBe('committed');
}), 180_000);

test('an expiry that overlaps a fence waits on the brain row instead of deadlocking with it (Postgres)', () => each(async f => {
  if (f.engine.kind !== 'postgres') return;
  const refresh = await duringRefresh(f, async () => {
    const out = await call(f, 'put_page', { slug: 'notes/expiry-order', content: page('Expiry order', 'body') });
    const deferred = await requestRow(f, out.body.request_id);
    expect(deferred.state).toBe('deferred');
    await disposePersistenceConsumer(f.engine);
    await f.engine.executeRaw("INSERT INTO config(key,value) VALUES('persistence.refresh_barrier_max_wait_ms','1') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      const [{ owner }] = await f.engine.executeRaw<{ owner: string }>('SELECT owner_host_id::text AS owner FROM persistence_worktrees WHERE id=$1::uuid', [f.worktreeId]);
      let holding!: () => void; const held = new Promise<void>(resolve => { holding = resolve; });
      let waiting!: () => void; const expiryWaits = new Promise<void>(resolve => { waiting = resolve; });
      // fenceAndMerge's order: the brain row FOR UPDATE, then the refresh row.
      const fence = f.engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('lock_timeout','10s',true)");
        await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
        holding();
        await expiryWaits;
        await tx.executeRaw('SELECT 1 FROM persistence_worktree_refreshes WHERE id=$1::uuid FOR NO KEY UPDATE', [deferred.deferred_refresh_id]);
      });
      await held;
      const expiry = expireDeferredWrites(f.engine, owner);
      for (let i = 0; i < 400; i++) {
        const [w] = await f.engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
        if (Number(w!.n) > 0) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      waiting();
      const [fenced, expired] = await Promise.allSettled([fence, expiry]);
      expect(fenced.status === 'rejected' ? String(fenced.reason) : 'fence committed').toBe('fence committed');
      expect(expired.status === 'fulfilled' ? expired.value.map(row => row.id) : String(expired.reason)).toEqual([deferred.id]);
    } finally {
      await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.refresh_barrier_max_wait_ms'");
    }
  });
  expect((await refresh).status).toBe('completed');
}), 180_000);

test('a live consumer without the capability keeps the refusal; a repo-less source is never deferred', () => each(async f => {
  const refresh = await duringRefresh(f, async () => {
    const repoLess = await call(f, 'put_page', { slug: 'notes/repo-less', content: page('Repo-less', 'database only') }, 'default');
    expect(repoLess.isError).toBe(false);
    expect(repoLess.body.status).not.toBe('pending');
    const [{ owner }] = await f.engine.executeRaw<{ owner: string }>('SELECT owner_host_id::text AS owner FROM persistence_worktrees WHERE id=$1::uuid', [f.worktreeId]);
    await f.engine.executeRaw(`INSERT INTO persistence_consumers(host_id,pid,nonce,kind,mode,host_json_path,persistence_home,version,capabilities)
      VALUES($1::uuid,1,'old-binary-example','serve','full','/nonexistent/host.json','/nonexistent','0.0.1','{}')`, [owner]);
    const before = await f.requestCount();
    const refused = await call(f, 'put_page', { slug: 'notes/old-consumer', content: page('Old consumer', 'refused') });
    expect(refused.isError).toBe(true);
    expect(refused.body.code).toBe('worktree_refreshing');
    expect(await f.requestCount()).toBe(before);
    await f.engine.executeRaw("DELETE FROM persistence_consumers WHERE nonce='old-binary-example'");
  });
  expect((await refresh).status).toBe('completed');
}), 180_000);

test('GST-1582: writes during one refresh are all deferred, none refused, and each commits after it (a configured cap no longer refuses)', () => each(async f => {
  await f.engine.executeRaw("INSERT INTO config(key,value) VALUES('persistence.refresh_barrier_max_deferred','1') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
  const held: WriteRequest[] = [];
  try {
    const refresh = await duringRefresh(f, async () => {
      for (const name of ['cap-one', 'cap-two', 'cap-three']) {
        const out = await call(f, 'put_page', { slug: `notes/${name}`, content: page(name, 'deferred') });
        expect(out.isError).toBe(false);
        expect(out.body.status).toBe('pending');
        held.push(await requestRow(f, out.body.request_id));
      }
      expect(held.map(row => row.state)).toEqual(['deferred', 'deferred', 'deferred']);
    });
    expect((await refresh).status).toBe('completed');
    for (const row of held) expect((await settle(f, row)).state).toBe('committed');
  } finally {
    await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.refresh_barrier_max_deferred'");
  }
}), 180_000);

test('gbrain upgrade --check-downgrade exits 3 downgrade_blocked_deferred_writes while a deferred write waits, 0 once it drained', () => each(async f => {
  const engine = new Proxy(f.engine, { get: (target, key) => key === 'disconnect' ? async () => undefined : Reflect.get(target, key, target) });
  const check = async () => {
    _resetCliExitVerdictForTests();
    const errors: string[] = []; const errorSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    const writes: string[] = []; const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { writes.push(String(chunk)); return true; }) as never);
    const logs: string[] = []; const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    try { await runUpgradeCommand(['--check-downgrade', '--json'], { connectEngine: async () => engine } as never); }
    finally { errorSpy.mockRestore(); stderrSpy.mockRestore(); logSpy.mockRestore(); }
    const code = currentExitCode(); _resetCliExitVerdictForTests(); process.exitCode = 0;
    return { code, out: [...errors, ...writes, ...logs].join('\n') };
  };
  let deferred!: WriteRequest;
  const refresh = await duringRefresh(f, async () => {
    const out = await call(f, 'put_page', { slug: 'notes/downgrade', content: page('Downgrade', 'waits') });
    deferred = await requestRow(f, out.body.request_id);
    const blocked = await check();
    expect(blocked.code).toBe(3);
    expect(blocked.out).toContain('downgrade_blocked_deferred_writes');
  });
  expect((await refresh).status).toBe('completed');
  const rollback = new Error('rollback');
  await expect(f.engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.refresh_barrier','1',true)");
    await tx.executeRaw("UPDATE persistence_requests SET state='running' WHERE id=$1::uuid", [deferred.id]);
    expect((await deferredBacklog(tx)).count).toBe(1);
    throw rollback;
  })).rejects.toBe(rollback);
  expect((await settle(f, deferred)).state).toBe('committed');
  const clear = await check();
  expect(clear.code).toBe(0);
  expect(JSON.parse(clear.out)).toEqual({ ok: true, deferred: 0 });
}), 180_000);

test('a deferred write whose token is revoked while it waits ends permission_denied with nothing applied', () => each(async f => {
  const minted = await mintLegacyToken(f.engine, { name: `token-${randomUUID()}`, scopes: ['read', 'write'], sourceGrant: [f.alpha], takesHolders: ['world'] });
  let deferred!: WriteRequest;
  const refresh = await duringRefresh(f, async () => {
    const result = await dispatchToolCall(f.engine, 'put_page', { slug: 'notes/revoked', content: page('Revoked', 'never applied') }, { remote: true, transport: 'http', sourceId: f.alpha,
      admissionOrigin: 'interactive', takesHoldersAllowList: ['world'],
      auth: { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id }, sourceId: f.alpha, allowedSources: [f.alpha], scopes: ['read', 'write'] } } as never);
    const body = JSON.parse(result.content[0]!.text) as Record<string, any>;
    expect(body.status).toBe('pending');
    deferred = await requestRow(f, body.request_id);
    expect(deferred.state).toBe('deferred');
    await f.engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE id=$1', [minted.id]);
  });
  expect((await refresh).status).toBe('completed');
  expect(await settle(f, deferred)).toMatchObject({ state: 'failed', error_code: 'permission_denied' });
  const [{ n }] = await f.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2', [f.alpha, 'notes/revoked']);
  expect(Number(n)).toBe(0);
}), 180_000);

test('a queued write whose token is revoked after it was claimed ends permission_denied with nothing applied', () => each(async f => {
  const minted = await mintLegacyToken(f.engine, { name: `token-${randomUUID()}`, scopes: ['read', 'write'], sourceGrant: [f.alpha], takesHolders: ['world'] });
  const requestId = randomUUID();
  installFaultHook(async (point, detail) => {
    if (point === 'consumer:preparing' && detail.requestId === requestId) await f.engine.executeRaw('UPDATE access_tokens SET revoked_at=now() WHERE id=$1', [minted.id]);
  });
  try {
    await dispatchToolCall(f.engine, 'put_page', { slug: 'notes/revoked-queued', content: page('Revoked queued', 'never applied'), request_id: requestId }, { remote: true, transport: 'http',
      sourceId: f.alpha, admissionOrigin: 'interactive', takesHoldersAllowList: ['world'],
      auth: { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id }, sourceId: f.alpha, allowedSources: [f.alpha], scopes: ['read', 'write'] } } as never);
  } finally { installFaultHook(undefined); }
  const row = await requestRow(f, requestId);
  expect(row.deferred_refresh_id).toBeNull();
  expect(await settle(f, row)).toMatchObject({ state: 'failed', error_code: 'permission_denied' });
  const [{ n }] = await f.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2', [f.alpha, 'notes/revoked-queued']);
  expect(Number(n)).toBe(0);
}), 180_000);

test('a write admitted after the release waits behind the released deferred write on its worktree', () => each(async f => {
  let first!: WriteRequest;
  const refresh = await duringRefresh(f, async () => {
    const out = await call(f, 'put_page', { slug: 'notes/order', content: page('Order', 'the deferred version') });
    first = await requestRow(f, out.body.request_id);
    expect(first.state).toBe('deferred');
  });
  expect((await refresh).status).toBe('completed');
  expect((await requestRow(f, first.request_id)).state).toBe('deferred');
  const later = await call(f, 'put_page', { slug: 'notes/order', content: page('Order', 'the later version') });
  expect(later).toMatchObject({ isError: true, body: { code: 'revision_required' } });
  expect((await settle(f, first)).state).toBe('committed');
  const [stored] = await f.engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [f.alpha, 'notes/order']);
  expect(stored?.compiled_truth ?? '').toContain('the deferred version');
}), 180_000);

test('a write deferred behind a refresh that aborts commits once the refresh is released', () => each(async f => {
  let deferred!: WriteRequest;
  await expect(duringRefresh(f, async () => {
    const out = await call(f, 'put_page', { slug: 'notes/after-abort', content: page('After abort', 'body') });
    deferred = await requestRow(f, out.body.request_id);
    expect(deferred.state).toBe('deferred');
    writeFileSync(join(f.root, 'alpha', 'two.md'), page('Alpha two', 'A local edit the merge would overwrite.'));
  })).rejects.toMatchObject({ code: 'refresh_dirty' });
  rmSync(join(f.root, 'alpha', 'two.md'), { force: true });
  const [{ state }] = await f.engine.executeRaw<{ state: string }>('SELECT state FROM persistence_worktree_refreshes WHERE id=$1::uuid', [deferred.deferred_refresh_id]);
  expect(state).toBe('aborted');
  expect((await settle(f, deferred)).state).toBe('committed');
}), 180_000);

test('a deferred write cancelled while its refresh runs ends cancelled with nothing applied and its counters released', () => each(async f => {
  let deferred!: WriteRequest;
  const before = await outstanding(f);
  const refresh = await duringRefresh(f, async () => {
    const out = await call(f, 'put_page', { slug: 'notes/cancelled', content: page('Cancelled', 'body') });
    deferred = await requestRow(f, out.body.request_id);
    expect(deferred.state).toBe('deferred');
    const cancelled = await call(f, 'cancel_write_request', { request_id: deferred.request_id });
    expect(cancelled.isError).toBe(false);
    expect((await requestRow(f, deferred.request_id)).state).toBe('cancelled');
  });
  expect((await refresh).status).toBe('completed');
  expect(await outstanding(f)).toBe(before);
  const [{ n }] = await f.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [f.alpha, 'notes/cancelled']);
  expect(Number(n)).toBe(0);
  expect((await deferredBacklog(f.engine)).count).toBe(0);
}), 180_000);

test('with the barrier off a write during a refresh is still refused worktree_refreshing', () => each(async f => {
  await withEnv({ GBRAIN_REFRESH_BARRIER: '0' }, async () => {
    resetWriteSwitches();
    const refresh = await duringRefresh(f, async () => {
      const out = await call(f, 'put_page', { slug: 'notes/off', content: page('Off', 'refused') });
      expect(out.isError).toBe(true);
      expect(out.body.code).toBe('worktree_refreshing');
    });
    expect((await refresh).status).toBe('completed');
  });
}), 180_000);

test('the owner socket answers a deferred write as write_pending, so its CLI exits 10 and polls', () => each(async f => {
  const refresh = await duringRefresh(f, async () => {
    const result = await dispatchToolCall(f.engine, 'put_page', { slug: 'notes/socket', content: page('Socket', 'deferred over the owner socket') },
      { remote: false, sourceId: f.alpha, admissionOrigin: 'interactive', pendingAsError: true });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text) as Record<string, any>;
    const error = Object.assign(new OperationError(body.error, body.message), { writeRequest: body.write_request, writeError: body.write_error });
    expect(pendingReceiptOf(error)?.request_id).toBe(body.write_request.request_id);
    expect(writeErrorExitCode(error, false)).toBe(PENDING_WRITE_EXIT_CODE);
    expect((await requestRow(f, body.write_request.request_id)).state).toBe('deferred');
  });
  expect((await refresh).status).toBe('completed');
}), 180_000);

test('an overdue deferred write expires on an idle owner tick when nothing else is queued', () => each(async f => {
  const refresh = await duringRefresh(f, async () => {
    const out = await call(f, 'put_page', { slug: 'notes/idle-expiry', content: page('Idle', 'body') });
    const deferred = await requestRow(f, out.body.request_id);
    await disposePersistenceConsumer(f.engine);
    const consumer = new PersistenceConsumer(f.engine, { engine: f.engine.kind } as never, preparePersistedMutation);
    await consumer.tick();
    expect((await getWriteRequestById(f.engine, deferred.id))!.state).toBe('deferred');
    await f.engine.executeRaw("INSERT INTO config(key,value) VALUES('persistence.refresh_barrier_max_wait_ms','1') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      await consumer.tick();
      expect(await getWriteRequestById(f.engine, deferred.id)).toMatchObject({ state: 'failed', error_code: 'refresh_barrier_expired' });
    } finally {
      await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.refresh_barrier_max_wait_ms'");
      await consumer.stop();
    }
  });
  expect((await refresh).status).toBe('completed');
}), 180_000);

test('a deferred edit_page of a page the refresh changed ends revision_conflict and leaves the refreshed file', () => each(async f => {
  f.push('alpha/people/alice-example.md', PERSON);
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  const upstream = PERSON.replace('Alice is a person.', 'Alice is a person who moved.');
  const read = await call(f, 'get_page', { slug: 'people/alice-example', include_content: true });
  expect(typeof read.body.revision).toBe('string');
  let deferred!: WriteRequest;
  const refresh = await duringRefresh(f, async () => {
    const out = await call(f, 'edit_page', { slug: 'people/alice-example', expected_revision: read.body.revision,
      edits: [{ old_text: 'Alice is a person.', new_text: 'Alice is a person who stayed.' }] });
    expect(out.isError).toBe(false);
    expect(out.body.status).toBe('pending');
    deferred = await requestRow(f, out.body.request_id);
    expect(deferred.state).toBe('deferred');
  }, ['alpha/people/alice-example.md', upstream]);
  expect((await refresh).status).toBe('completed');
  expect(await settle(f, deferred)).toMatchObject({ state: 'conflict', error_code: 'revision_conflict' });
  expect(readFileSync(join(f.root, 'alpha/people/alice-example.md'), 'utf8')).toBe(upstream);
}), 180_000);

test('a deferred forget on a page the refresh changed ends revision_conflict and the fact stays active', () => each(async f => {
  f.push('alpha/people/alice-example.md', PERSON);
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  const remembered = await call(f, 'remember', { fact: 'alice-example likes coffee', entity: 'people/alice-example', provenance: 'test' });
  expect(remembered.isError).toBe(false);
  const [fact] = await f.engine.executeRaw<{ id: number }>("SELECT id FROM facts WHERE fact LIKE '%likes coffee%' AND expired_at IS NULL");
  expect(fact).toBeDefined();
  git(f.root, 'add', '-A'); git(f.root, 'commit', '-q', '-m', 'the remembered fact'); git(f.root, 'push', '-q', 'origin', 'main');
  git(f.upstream, 'pull', '-q', '--ff-only', 'origin', 'main');
  let deferred!: WriteRequest;
  const refresh = await duringRefresh(f, async () => {
    const out = await call(f, 'forget', { id: String(fact!.id) });
    expect(out.isError).toBe(false);
    expect(out.body.status).toBe('pending');
    deferred = await requestRow(f, out.body.request_id);
    expect(deferred.state).toBe('deferred');
  }, ['alpha/people/alice-example.md', readFileSync(join(f.root, 'alpha/people/alice-example.md'), 'utf8').replace('Alice is a person.', 'Alice is a person who moved.')]);
  expect((await refresh).status).toBe('completed');
  expect(await settle(f, deferred)).toMatchObject({ state: 'conflict', error_code: 'revision_conflict' });
  const [{ n }] = await f.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE id=$1 AND expired_at IS NULL', [fact!.id]);
  expect(Number(n)).toBe(1);
}), 180_000);

test('a source lifecycle change while a deferred write waits ends it source_changed and releases its counters', () => each(async f => {
  const refresh = await duringRefresh(f, async () => {
    const before = await outstanding(f);
    const out = await call(f, 'put_page', { slug: 'notes/topology', content: page('Topology', 'body') });
    const deferred = await requestRow(f, out.body.request_id);
    expect(await outstanding(f)).toBe(before + 1);
    const principal = await topologyPrincipal(f.engine);
    expect(await f.engine.transaction(tx => settleTopologyRequests(tx, [f.alpha], [f.worktreeId], principal))).toBe(1);
    expect(await getWriteRequestById(f.engine, deferred.id)).toMatchObject({ state: 'conflict', error_code: 'source_changed' });
    expect(await outstanding(f)).toBe(before);
  });
  expect((await refresh).status).toBe('completed');
}), 180_000);

test('a receipt poll reads the open-request index, never the permanent receipt history', () => each(async f => {
  const [source] = await f.engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [f.alpha]);
  await f.engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,worktree_id,
      digest,intent,authority,intent_bytes,terminal_reservation,state)
    SELECT 'local_cli','history',gen_random_uuid(),'put_page',$1,$2::uuid,'history-'||g,$3::uuid,'d','{}'::jsonb,'{}'::jsonb,1,16384,'committed'
    FROM generate_series(1,20000) g`, [f.alpha, source!.incarnation, f.worktreeId]);
  try {
    await f.engine.executeRaw('ANALYZE persistence_requests');
    const scans: string[] = [];
    const nodes = (plan: Record<string, any>): Array<Record<string, any>> => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
    const explaining = { executeRaw: async (sql: string, params?: unknown[]) => {
      const [row] = await f.engine.executeRaw<Record<string, unknown>>(`EXPLAIN (FORMAT JSON) ${sql}`, params);
      const raw = row!['QUERY PLAN'];
      const [explained] = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: Record<string, any> }>;
      for (const node of nodes(explained!.Plan)) if (node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'persistence_requests') scans.push(sql);
      return f.engine.executeRaw(sql, params);
    } } as Pick<BrainEngine, 'executeRaw'>;
    expect((await readWriteWatermark(explaining, f.alpha)).requests_pending.count).toBe(0);
    expect(scans).toEqual([]);
  } finally {
    await f.engine.executeRaw("DELETE FROM persistence_requests WHERE principal_id='history'");
  }
}), 180_000);

/** A refresh whose drain let a write land a commit past old_head, then died at `fenced` before merging; `moveHead` makes that commit. */
async function crashAtFenced(f: RefreshFixture, moveHead: () => string): Promise<{ deferred: WriteRequest; landed: string }> {
  f.push('alpha/two.md', page('Alpha two', 'An upstream observation.'));
  let deferred!: WriteRequest; let landed!: string;
  await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => {
    if (point === 'drained') {
      const out = await call(f, 'put_page', { slug: 'notes/held-at-crash', content: page('Held at crash', 'body') });
      deferred = await requestRow(f, out.body.request_id);
      landed = moveHead();
    }
    if (point === 'fenced') throw new Error('simulated crash at fenced');
  } } })).rejects.toThrow('simulated crash');
  expect(deferred.state).toBe('deferred');
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['fenced']);
  return { deferred, landed };
}

test('GBEV-44: a refresh killed at fenced after its drain landed a gbrain commit resumes: the row aborts, nothing is reset and its deferred write commits', () => each(async f => {
  const { deferred, landed } = await crashAtFenced(f, () => {
    const sha = commitFile(f.root, 'alpha/drained.md', page('Drained', 'A write admitted before the fence.'), 'gbrain: persist canonical memory update');
    recordCommit(f.root, { sha, writer: 'effect' });
    return sha;
  });
  const resumed = await refreshWorktree(f.engine, f.alpha, { resume: true });
  expect(resumed.status).toBe('abandoned');
  const [row] = await f.refreshRows();
  expect(row.state).toBe('aborted');
  expect((row.outcome.refusal as { cause: string }).cause).toContain("gbrain's own commits");
  expect(f.head()).toBe(landed);
  expect((await settle(f, deferred)).state).toBe('committed');
}), 180_000);

test('#8766 review: a refresh killed at fenced after HEAD moved still aborts on resume when the commit ledger cannot be read', () => each(async f => {
  const { landed } = await crashAtFenced(f, () => commitFile(f.root, 'alpha/foreign.md', page('Foreign', 'A commit gbrain did not make.'), 'foreign commit'));
  const { current } = ledgerFiles(ledgerLocation(f.root)!.common);
  rmSync(current, { force: true });
  mkdirSync(current, { recursive: true });
  try {
    const resumed = await refreshWorktree(f.engine, f.alpha, { resume: true });
    expect(resumed.status).toBe('abandoned');
    const [row] = await f.refreshRows();
    expect(row.state).toBe('aborted');
    expect((row.outcome.refusal as { cause: string }).cause).toContain('a commit or checkout gbrain did not make');
    expect(f.head()).toBe(landed);
  } finally {
    rmSync(current, { recursive: true, force: true });
  }
}), 180_000);

test('GBEV-44: the owner scan aborts an orphaned fenced row whose HEAD moved only through gbrain commits before the merge', () => each(async f => {
  const { deferred, landed } = await crashAtFenced(f, () => {
    const first = commitFile(f.root, 'alpha/drained-1.md', page('Drained one', 'A write admitted before the fence.'), 'gbrain: persist canonical memory update');
    recordCommit(f.root, { sha: first, writer: 'effect' });
    const second = commitFile(f.root, 'alpha/drained-2.md', page('Drained two', 'Another write admitted before the fence.'), 'gbrain: persist canonical memory update');
    recordCommit(f.root, { sha: second, writer: 'effect' });
    return second;
  });
  await resumeWorktreeRefreshes(f.engine);
  const [row] = await f.refreshRows();
  expect(row.state).toBe('aborted');
  expect((row.outcome.refusal as { code: string }).code).toBe('refresh_interrupted');
  expect(f.head()).toBe(landed);
  expect((await settle(f, deferred)).state).toBe('committed');
}), 180_000);


test('GST-1674: a refresh killed at fenced after a commit gbrain did not make moved HEAD before the merge resumes: the row aborts and its deferred write commits', () => each(async f => {
  const { deferred, landed } = await crashAtFenced(f, () => commitFile(f.root, 'alpha/outside.md', page('Outside', 'A commit made around gbrain.'), 'outside'));
  const resumed = await refreshWorktree(f.engine, f.alpha, { resume: true });
  expect(resumed.status).toBe('abandoned');
  const [row] = await f.refreshRows();
  expect(row.state).toBe('aborted');
  expect((row.outcome.refusal as { code: string }).code).toBe('refresh_interrupted');
  expect(f.head()).toBe(landed);
  expect((await settle(f, deferred)).state).toBe('committed');
}), 180_000);

test('a refresh killed at fenced after a commit gbrain did not make moved HEAD before the merge aborts on the owner scan, without --resume', () => each(async f => {
  const { deferred, landed } = await crashAtFenced(f, () => commitFile(f.root, 'alpha/outside.md', page('Outside', 'A commit made around gbrain.'), 'outside'));
  await resumeWorktreeRefreshes(f.engine);
  const [row] = await f.refreshRows();
  expect(row.state).toBe('aborted');
  expect((row.outcome.refusal as { code: string }).code).toBe('refresh_interrupted');
  expect(f.head()).toBe(landed);
  expect((await settle(f, deferred)).state).toBe('committed');
}), 180_000);

test('GST-1674: a refresh killed after its merge, with a commit landed on the target before bookkeeping, recovers on the owner scan and completes without --resume', () => each(async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'An upstream observation.'));
  let deferred!: WriteRequest; let landed!: string;
  await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => {
    if (point === 'drained') {
      const out = await call(f, 'put_page', { slug: 'notes/held-past-merge', content: page('Held past merge', 'body') });
      deferred = await requestRow(f, out.body.request_id);
    }
    if (point === 'merged') {
      landed = commitFile(f.root, 'alpha/after-merge.md', page('After merge', 'A commit on top of the target.'), 'gbrain: persist canonical memory update');
      throw new Error('simulated crash after merge');
    }
  } } })).rejects.toThrow('simulated crash');
  expect(git(f.root, 'rev-parse', 'HEAD~1')).toBe(target);
  await resumeWorktreeRefreshes(f.engine);
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['syncing']);
  const next = await refreshWorktree(f.engine, f.alpha).catch(error => error);
  // The scheduled refresh finishes the orphan first; its own tick then stops at the unpublished local commit.
  expect(next.code).toBe('refresh_diverged');
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['completed']);
  expect(f.head()).toBe(landed);
  expect((await settle(f, deferred)).state).toBe('committed');
}), 180_000);


test('GST-1623: a write deferred behind a refresh never takes the capacity its refresh sync needs', () => each(async f => {
  try {
    let deferred!: WriteRequest;
    const refresh = await duringRefresh(f, async () => {
      await f.engine.setConfig('persistence.limits.brain_outstanding', String(await outstanding(f) + 1));
      const out = await call(f, 'put_page', { slug: 'notes/held-at-cap', content: page('Held', 'written while the cap is full') });
      expect(out.body).toMatchObject({ status: 'pending' });
      deferred = await requestRow(f, out.body.request_id);
      expect(deferred.state).toBe('deferred');
    });
    expect((await refresh).status).toBe('completed');
    expect((await settle(f, deferred)).state).toBe('committed');
  } finally {
    await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.limits.brain_outstanding'");
  }
}), 180_000);

