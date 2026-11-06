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
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run as runUpgradeCommand } from '../src/cli/commands/upgrade.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import { refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { getWriteRequestById } from '../src/core/persistence/journal.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { _setRefreshFenceWaitForTests } from '../src/core/persistence/admission-retry.ts';
import { _resetRefreshBarrierCacheForTests, deferredBacklog, expireDeferredWrites } from '../src/core/persistence/refresh-barrier.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
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
    await f.engine.executeRaw("INSERT INTO config(key,value) VALUES('persistence.refresh_barrier_max_wait_ms','1') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
    await new Promise(resolve => setTimeout(resolve, 20));
    const [{ owner }] = await f.engine.executeRaw<{ owner: string }>('SELECT owner_host_id::text AS owner FROM persistence_worktrees WHERE id=$1::uuid', [f.worktreeId]);
    const expired = await expireDeferredWrites(f.engine, owner);
    expect(expired.map(row => row.id)).toEqual([deferred.id]);
    const after = (await getWriteRequestById(f.engine, deferred.id))!;
    expect(after).toMatchObject({ state: 'failed', error_code: 'refresh_barrier_expired' });
    expect(await outstanding(f)).toBe(before);
    await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.refresh_barrier_max_wait_ms'");
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
