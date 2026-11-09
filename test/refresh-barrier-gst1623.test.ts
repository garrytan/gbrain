/**
 * GST-1623: refresh write barrier follow-ups (docs/designs/REFRESH_WRITE_BARRIER.md).
 *
 * Protects, with persistence.refresh_barrier on: deferred writes count toward their source's fair share of the local CLI cap;
 * a released deferred write is an earlier write in receipt health, and a worktree whose refresh awaits recovery reports
 * recovery_required; a hold refuses only a journaled request admitted after the held write, never an effect or a maintenance
 * read of the file; a deferred write never lands on top of a later write to its page that committed first; a write deferred
 * behind a refresh is checked against that refresh before it is held for an import, and the hold drops the released refresh;
 * a write held again and again expires at a ceiling counted from its admission; a held write never outlives its source row
 * (confirmation); an expired remember says whether a sync replays it; the retry-hint history has an index; a refresh merges
 * only when it marked the merge started; the drain never sleeps past its refresh budget; a case-insensitive checkout compares
 * refreshed paths case-folded; receipt polling never publishes a released deferred write; the managed sync capacity discount counts
 * only writes still held for that source; a capture of the very file its import brought in names no supersedes.
 * Seams: the real refresh state machine (hooks.boundary), managed sync and consumer; GBRAIN_REFRESH_BARRIER.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import { settleTopologyRequests, topologyPrincipal } from '../src/core/persistence/topology-locks.ts';
import { getWriteRequestById, writeHealthFacts } from '../src/core/persistence/journal.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { _setRefreshFenceWaitForTests } from '../src/core/persistence/admission-retry.ts';
import { _resetRefreshBarrierCacheForTests, deferredReplayRefusal, expireDeferredWrites } from '../src/core/persistence/refresh-barrier.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { prepareFileTarget } from '../src/core/persistence/page-prepare.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { refreshWorktree, resumeWorktreeRefreshes, type RefreshBoundary } from '../src/core/persistence/worktree-refresh.ts';
import { _transientDelayForTests } from '../src/core/persistence/sync-drain.ts';
import { deleteSourceRow } from '../src/core/source-delete.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { commitFile, git, page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

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

const each = (fn: (f: RefreshFixture) => Promise<void>) => withEnv({ GBRAIN_REFRESH_BARRIER: '1' }, async () => {
  resetWriteSwitches();
  for (const engine of engines) await withRefreshFixture(engine, async f => {
    git(f.root, 'config', 'user.name', 'Example'); git(f.root, 'config', 'user.email', 'example@example.invalid'); git(f.root, 'config', 'commit.gpgsign', 'false');
    await fn(f);
  });
});

async function call(f: RefreshFixture, name: string, params: Record<string, unknown>, sourceId = f.alpha) {
  const result = await dispatchToolCall(f.engine, name, params, { remote: true, transport: 'stdio', sourceId, admissionOrigin: 'interactive' });
  return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) as Record<string, any> };
}
async function requestRow(f: RefreshFixture, requestId: string): Promise<WriteRequest> {
  const [row] = await f.engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
  return row!;
}
/** A blind local CLI write: its receipt whether it settled or was left pending (write_pending). */
async function local(f: RefreshFixture, operation: 'put_page' | 'capture', params: Record<string, unknown>, sourceId = f.alpha): Promise<{ pending: boolean; receipt: Record<string, any> }> {
  try {
    const receipt = await submitPageMutation(f.ctx(sourceId), { operation, params: { request_id: randomUUID(), force: true, ...params } }) as Record<string, any>;
    return { pending: false, receipt };
  } catch (error) {
    const e = error as { code?: string; writeError?: string; writeRequest?: Record<string, any> };
    if ((e.code === 'write_pending' || e.writeError === 'write_pending') && e.writeRequest) return { pending: true, receipt: e.writeRequest };
    throw error;
  }
}
const settle = async (f: RefreshFixture, row: WriteRequest) => waitForWrite(f.engine, (await getWriteRequestById(f.engine, row.id))!, { engine: f.engine.kind } as never, 30_000);
const importNow = (f: RefreshFixture, sourceId = f.alpha) => performManagedSync(f.engine, { sourceId, noPull: true, noEmbed: true });
const file = (f: RefreshFixture, rel: string, sub = 'alpha') => readFileSync(join(f.root, sub, rel), 'utf8');
const IMPORTED = 'Another writer committed this line.';
const foreignCommit = (f: RefreshFixture, rel: string, content: string, sub = 'alpha') => commitFile(f.root, `${sub}/${rel}`, content, 'another writer');
const maxWait = (f: RefreshFixture, ms: number) => f.engine.executeRaw(`INSERT INTO config(key,value) VALUES('persistence.refresh_barrier_max_wait_ms',$1)
  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [String(ms)]);
const clearMaxWait = (f: RefreshFixture) => f.engine.executeRaw("DELETE FROM config WHERE key='persistence.refresh_barrier_max_wait_ms'");
const ownerHost = async (f: RefreshFixture) => (await f.engine.executeRaw<{ owner: string }>('SELECT owner_host_id::text AS owner FROM persistence_worktrees WHERE id=$1::uuid', [f.worktreeId]))[0]!.owner;
/** Drives this process's consumer on `row` for up to `ms`: until it settles, or (a write held again) until the wait ends. */
const drive = async (f: RefreshFixture, row: WriteRequest, ms = 5_000) => waitForWrite(f.engine, (await getWriteRequestById(f.engine, row.id))!, { engine: f.engine.kind } as never, ms);

/** Runs `fn` while a real refresh of the checkout is paused at its drained boundary; the refresh changes alpha/two.md by default. `at` runs at every later boundary. */
async function duringRefresh(f: RefreshFixture, fn: () => Promise<void>, change: [string, string] = ['alpha/two.md', page('Alpha two', 'An upstream observation.')],
  at?: (point: RefreshBoundary) => Promise<void>) {
  f.push(...change);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void; const drained = new Promise<void>(resolve => { reached = resolve; });
  const refresh = refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => { if (point === 'drained') { reached(); await gate; } else await at?.(point); } } });
  await drained;
  try { await fn(); } catch (error) { release(); await refresh.catch(() => undefined); throw error; }
  release();
  return refresh;
}

test('items 3 and 15: writes held deferred count toward their source\'s fair share, so another source still gets its share of the local CLI cap', () => each(async f => {
  await f.engine.setConfig('persistence.limits.principal_outstanding', '2');
  try {
    foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
    const first = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Held first.') });
    const second = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Held second.') });
    expect([first.pending, second.pending]).toEqual([true, true]);
    expect((await requestRow(f, second.receipt.request_id)).state).toBe('deferred');
    const other = await local(f, 'put_page', { slug: 'beta-note', content: page('Beta note', 'Admitted on its fair share.') }, f.beta);
    expect(other.receipt.state ?? 'committed').not.toBe('failed');
    expect((await requestRow(f, other.receipt.request_id)).state).toBe('committed');
  } finally {
    await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.limits.principal_outstanding'");
  }
}), 180_000);

test('item 3: a released deferred write is the earlier write a later queued write waits on in receipt health', () => each(async f => {
  let deferred!: WriteRequest;
  const refresh = await duringRefresh(f, async () => {
    const out = await call(f, 'put_page', { slug: 'notes/deferred', content: page('Deferred', 'written during the refresh') });
    deferred = await requestRow(f, out.body.request_id);
    expect(deferred.state).toBe('deferred');
    await disposePersistenceConsumer(f.engine);
  });
  expect((await refresh).status).toBe('completed');
  const released = (await getWriteRequestById(f.engine, deferred.id))!;
  expect(released.state).toBe('deferred');
  const later = { ...released, id: randomUUID(), state: 'queued', sequence: String(BigInt(released.sequence) + 1n), deferred_refresh_id: null } as WriteRequest;
  const facts = await writeHealthFacts(f.engine, [released, later]);
  expect(facts.get(later.id)?.earlier_write).toBe(true);
  expect(facts.get(released.id)?.earlier_write).toBe(false);
  expect((await settle(f, released)).state).toBe('committed');
}), 180_000);

test('item 19: a write deferred behind a refresh awaiting recovery reports recovery_required, and a replay of its request id is never deferred again', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  const old = f.head();
  await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => { if (point === 'merged') throw new Error('simulated crash after merge'); } } }))
    .rejects.toThrow('simulated crash');
  git(f.root, 'reset', '-q', '--hard', old);
  git(f.root, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
  await resumeWorktreeRefreshes(f.engine);
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['recovery_required']);
  const params = { slug: 'notes/during-recovery', content: page('During recovery', 'Accepted while the refresh awaited recovery.') };
  const out = await call(f, 'put_page', params);
  expect(out.body.status).toBe('pending');
  const receipt = await call(f, 'get_write_request', { request_id: out.body.request_id });
  expect(receipt.body.diagnostic).toMatchObject({ reason: 'recovery_required' });
  const replay = await call(f, 'put_page', { ...params, request_id: out.body.request_id });
  expect(replay.body.request_id).toBe(out.body.request_id);
  const [{ n }] = await f.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests WHERE request_id=$1::uuid', [out.body.request_id]);
  expect(Number(n)).toBe(1);
  git(f.root, 'reset', '-q', '--hard', old);
  expect((await refreshWorktree(f.engine, f.alpha, { abandon: true })).status).toBe('abandoned');
  expect((await settle(f, await requestRow(f, out.body.request_id))).state).toBe('committed');
}), 180_000);

test('item 13: a hold refuses only a request admitted after the held write, never an effect or maintenance read of the file', () => each(async f => {
  const before = await f.lastCommit(f.alpha);
  foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
  foreignCommit(f, 'zz-later.md', page('Alpha later', 'A second file in the same import.'));
  const first = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Held while the import waits.') });
  const held = await requestRow(f, first.receipt.request_id);
  expect(held.state).toBe('deferred');
  // A one-page slice imports one.md and yields before its checkpoint: the file matches the page, and the hold is unreleased.
  expect((await performManagedSync(f.engine, { sourceId: f.alpha, noPull: true, noEmbed: true }, { maxPages: 1, maxMs: 60_000 })).status).toBe('partial');
  expect(await f.lastCommit(f.alpha)).toBe(before);
  const snapshot = (await f.engine.readPageSnapshot('one', { sourceId: f.alpha }))!;
  const target = { source_id: f.alpha, worktree_id: f.worktreeId, slug: 'one' };
  const effect = await prepareFileTarget(f.engine, target, snapshot, null, undefined, { allowMissing: true });
  expect(effect?.path).toBe(join(f.root, 'alpha', 'one.md'));
  const later = prepareFileTarget(f.engine, { ...target, sequence: String(BigInt(held.sequence) + 1n), operation: 'put_page' }, snapshot, null, undefined, { allowMissing: true });
  await expect(later).rejects.toMatchObject({ code: 'source_changed' });
  const earlier = await prepareFileTarget(f.engine, { ...target, sequence: String(BigInt(held.sequence) - 1n), operation: 'put_page' }, snapshot, null, undefined, { allowMissing: true });
  expect(earlier?.path).toBe(join(f.root, 'alpha', 'one.md'));
  await importNow(f);
  expect((await settle(f, held)).state).toBe('committed');
}), 180_000);

test('item 1: a deferred write never lands on top of a later write to its page that committed first', () => each(async f => {
  let deferred!: WriteRequest;
  const refresh = await duringRefresh(f, async () => {
    const out = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Deferred, accepted first.') });
    expect(out.pending).toBe(true);
    deferred = await requestRow(f, out.receipt.request_id);
    expect(deferred.state).toBe('deferred');
    await disposePersistenceConsumer(f.engine);
  });
  expect((await refresh).status).toBe('completed');
  // An older consumer claims without EARLIER_DEFERRED: the later write to the page commits before the released deferred one.
  // Emulated by hiding the refresh's release while the later write publishes.
  const [{ released_at }] = await f.engine.executeRaw<{ released_at: Date }>('SELECT released_at FROM persistence_worktree_refreshes WHERE id=$1::uuid', [deferred.deferred_refresh_id]);
  await f.engine.executeRaw('UPDATE persistence_worktree_refreshes SET released_at=NULL WHERE id=$1::uuid', [deferred.deferred_refresh_id]);
  let later: Awaited<ReturnType<typeof local>>;
  try {
    later = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Accepted second, committed first.') });
  } finally {
    await f.engine.executeRaw('UPDATE persistence_worktree_refreshes SET released_at=$2 WHERE id=$1::uuid', [deferred.deferred_refresh_id, released_at]);
  }
  expect((await requestRow(f, later!.receipt.request_id)).state).toBe('committed');
  const done = await settle(f, deferred);
  expect(done).toMatchObject({ state: 'conflict', error_code: 'revision_conflict' });
  expect(done.error_message).toContain(later!.receipt.request_id);
  expect(file(f, 'one.md')).toContain('Accepted second, committed first.');
  // The same check covers a write held for an import.
  const imported = { ...done, deferred_refresh_id: null, deferred_import_from: '' } as WriteRequest;
  expect(await deferredReplayRefusal(f.engine, imported, [])).toMatchObject({ state: 'conflict', failure: { code: 'revision_conflict' } });
  expect(await deferredReplayRefusal(f.engine, { ...imported, operation: 'remember' } as WriteRequest, [])).toBeNull();
}), 180_000);

test('#8765 outside voice: a later write counts unless managed sync wrote it (submit_job), its receipt compacted or not; capture refuses a managed_sync_ kind', () => each(async f => {
  let deferred!: WriteRequest;
  const refresh = await duringRefresh(f, async () => {
    const out = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Deferred, accepted first.') });
    deferred = await requestRow(f, out.receipt.request_id);
    expect(deferred.state).toBe('deferred');
    await disposePersistenceConsumer(f.engine);
  });
  expect((await refresh).status).toBe('completed');
  const later = await requestRow(f, (await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Accepted second.') })).receipt.request_id);
  expect(later.state).toBe('committed');
  const held = { ...deferred, deferred_refresh_id: null, deferred_import_from: '' } as WriteRequest;
  const refusal = () => deferredReplayRefusal(f.engine, held, []);
  // A foreground row whose stored intent names a managed_sync_ kind (a caller-chosen value) is still a later write.
  await f.engine.executeRaw(`UPDATE persistence_requests SET intent=intent||'{"kind":"managed_sync_import"}'::jsonb WHERE id=$1::uuid`, [later.id]);
  expect(await refusal()).toMatchObject({ state: 'conflict', failure: { code: 'revision_conflict' } });
  // Managed sync's own import is not, before or after receipt compaction drops its intent.
  await f.engine.executeRaw(`UPDATE persistence_requests SET operation='submit_job', outcome=COALESCE(outcome,'{}'::jsonb)||'{"imported_file":true}'::jsonb WHERE id=$1::uuid`, [later.id]);
  expect(await refusal()).toBeNull();
  await f.engine.executeRaw('UPDATE persistence_requests SET intent=NULL, compacted=true WHERE id=$1::uuid', [later.id]);
  expect(await refusal()).toBeNull();
  // A compacted foreground write still counts.
  await f.engine.executeRaw(`UPDATE persistence_requests SET operation='put_page', outcome=outcome-'imported_file' WHERE id=$1::uuid`, [later.id]);
  expect(await refusal()).toMatchObject({ state: 'conflict', failure: { code: 'revision_conflict' } });
  // So does a compacted submit_job that imported no file (maintenance work), whose outcome has no imported_file at all.
  await f.engine.executeRaw(`UPDATE persistence_requests SET operation='submit_job' WHERE id=$1::uuid`, [later.id]);
  expect(await refusal()).toMatchObject({ state: 'conflict', failure: { code: 'revision_conflict' } });
  const before = (await f.engine.readPageSnapshot('two', { sourceId: f.alpha }))?.revision;
  const captured = await local(f, 'capture', { slug: 'two', content: 'An event.', kind: 'managed_sync_import' }).catch(error => error);
  expect(captured).toBeInstanceOf(OperationError);
  expect((captured as OperationError).code).toBe('invalid_params');
  expect((await f.engine.readPageSnapshot('two', { sourceId: f.alpha }))?.revision).toBe(before);
}), 180_000);

test('#8765 review: a connector import stays a later write after compaction drops its intent, as overwritten-edits counts it', () => each(async f => {
  let deferred!: WriteRequest;
  const refresh = await duringRefresh(f, async () => {
    const out = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Deferred, accepted first.') });
    deferred = await requestRow(f, out.receipt.request_id);
    expect(deferred.state).toBe('deferred');
    await disposePersistenceConsumer(f.engine);
  });
  expect((await refresh).status).toBe('completed');
  const later = await requestRow(f, (await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Accepted second.') })).receipt.request_id);
  expect(later.state).toBe('committed');
  const held = { ...deferred, deferred_refresh_id: null, deferred_import_from: '' } as WriteRequest;
  // connector-sync.ts records every connector import with imported_file and connector_database (false on a bound source).
  for (const connectorDatabase of [true, false]) {
    await f.engine.executeRaw(`UPDATE persistence_requests SET operation='submit_job', intent=NULL, compacted=true,
      outcome=COALESCE(outcome,'{}'::jsonb)||jsonb_build_object('imported_file',true,'connector_database',$2::boolean) WHERE id=$1::uuid`, [later.id, connectorDatabase]);
    expect(await deferredReplayRefusal(f.engine, held, [])).toMatchObject({ state: 'conflict', failure: { code: 'revision_conflict' } });
  }
}), 180_000);

test('item 16: a write deferred behind a refresh is held for an import without its released refresh, unless the refresh changed its file', () => each(async f => {
  f.push('alpha/three.md', page('Alpha three', 'Before the refresh.'));
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  expect(await f.engine.readPageSnapshot('three', { sourceId: f.alpha })).not.toBeNull();
  let kept!: WriteRequest, changed!: WriteRequest;
  const refresh = await duringRefresh(f, async () => {
    kept = await requestRow(f, (await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Deferred; the refresh left this file alone.') })).receipt.request_id);
    changed = await requestRow(f, (await local(f, 'put_page', { slug: 'three', content: page('Alpha three', 'Deferred; the refresh changed this file.') })).receipt.request_id);
    expect([kept.state, changed.state]).toEqual(['deferred', 'deferred']);
    await disposePersistenceConsumer(f.engine);
  }, ['alpha/three.md', page('Alpha three', 'Upstream.')]);
  expect((await refresh).status).toBe('completed');
  foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
  foreignCommit(f, 'three.md', page('Alpha three', IMPORTED));
  await drive(f, changed);
  await drive(f, kept);
  const held = (await getWriteRequestById(f.engine, kept.id))!;
  expect(held).toMatchObject({ state: 'deferred', deferred_refresh_id: null });
  expect(held.deferred_import_from).not.toBeNull();
  // A consumer older than the import hold claims a deferred row once its refresh is released: it finds none here.
  const [{ n }] = await f.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests r WHERE r.id=$1::uuid AND r.state='deferred'
    AND EXISTS (SELECT 1 FROM persistence_worktree_refreshes f WHERE f.id=r.deferred_refresh_id AND f.released_at IS NOT NULL)`, [kept.id]);
  expect(Number(n)).toBe(0);
  expect(await getWriteRequestById(f.engine, changed.id)).toMatchObject({ state: 'conflict', error_code: 'revision_conflict' });
  await importNow(f);
  expect((await settle(f, held)).state).toBe('committed');
  expect(file(f, 'one.md')).toContain('Deferred; the refresh left this file alone.');
}), 180_000);

test('item 14: a write held again and again expires at the ceiling counted from its admission', () => each(async f => {
  foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
  const out = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Held again after every import.') });
  const held = await requestRow(f, out.receipt.request_id);
  expect(held.state).toBe('deferred');
  await maxWait(f, 60_000);
  try {
    await f.engine.executeRaw("UPDATE persistence_requests SET created_at=now()-interval '3 hours' WHERE id=$1::uuid", [held.id]);
    expect(await expireDeferredWrites(f.engine, await ownerHost(f))).toEqual([]);
    await f.engine.executeRaw("UPDATE persistence_requests SET created_at=now()-interval '5 hours' WHERE id=$1::uuid", [held.id]);
    expect((await expireDeferredWrites(f.engine, await ownerHost(f))).map(row => row.id)).toEqual([held.id]);
  } finally { await clearMaxWait(f); }
  expect(await getWriteRequestById(f.engine, held.id)).toMatchObject({ state: 'failed', error_code: 'pending_import_expired' });
  expect(file(f, 'one.md')).toContain(IMPORTED);
}), 180_000);

test('item 20 (confirmation): a held write never outlives its source row; a source row is removed only through writer administration, which ends it', () => each(async f => {
  foreignCommit(f, 'one.md', page('Beta one', IMPORTED), 'beta');
  const out = await local(f, 'put_page', { slug: 'one', content: page('Beta one', 'Held, then its source was removed.') }, f.beta);
  const held = await requestRow(f, out.receipt.request_id);
  expect(held.state).toBe('deferred');
  await expect(deleteSourceRow(f.engine, f.beta)).rejects.toThrow('writer_coordinator_required');
  const principal = await topologyPrincipal(f.engine);
  expect(await f.engine.transaction(tx => settleTopologyRequests(tx, [f.beta], [f.worktreeId], principal))).toBe(1);
  expect(await getWriteRequestById(f.engine, held.id)).toMatchObject({ state: 'conflict', error_code: 'source_changed' });
}), 180_000);

const PERSON = '---\ntitle: Alice Example\ntype: person\n---\nAlice is a person.\n';

test('item 21: an expired remember says one replay attempt is queued only when it named its entity', () => each(async f => {
  foreignCommit(f, 'people/alice-example.md', PERSON);
  await importNow(f);
  foreignCommit(f, 'people/alice-example.md', PERSON.replace('Alice is a person.', `Alice is a person. ${IMPORTED}`));
  const pinned = await requestRow(f, (await call(f, 'remember', { fact: 'alice-example likes tea', entity: 'people/alice-example', provenance: 'test' })).body.request_id);
  const unpinned = await requestRow(f, (await call(f, 'remember', { fact: 'alice-example likes coffee', entity: 'people/alice-example', provenance: 'test' })).body.request_id);
  expect([pinned.state, unpinned.state]).toEqual(['deferred', 'deferred']);
  await f.engine.executeRaw("UPDATE persistence_requests SET intent=intent-'entity_slug' WHERE id=$1::uuid", [unpinned.id]);
  await maxWait(f, 1);
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await expireDeferredWrites(f.engine, await ownerHost(f))).map(row => row.id).sort()).toEqual([pinned.id, unpinned.id].sort());
  } finally { await clearMaxWait(f); }
  const replayed = (await getWriteRequestById(f.engine, pinned.id))!, manual = (await getWriteRequestById(f.engine, unpinned.id))!;
  expect(replayed.error_message).toContain('one automatic replay attempt');
  expect(replayed.error_message).toContain(`gbrain repair failed-writes --source ${f.alpha}`);
  expect(manual.error_message).toContain('named no entity, so no sync replays it');
  for (const row of [replayed, manual]) expect(row.error_message).toContain('Do not save it again');
}), 180_000);

test('item 17: the retry-hint history reads an index of completed refreshes per worktree', async () => {
  for (const engine of engines) {
    const [index] = await engine.executeRaw<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname='persistence_worktree_refreshes_completed'");
    expect(index?.indexdef).toContain('(worktree_id, completed_at DESC)');
    expect(index?.indexdef).toContain("state = 'completed'");
  }
});

test('item 18: a refresh whose row recovery moved off fenced before the merge merges nothing', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  const old = f.head();
  const result = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async (point, row) => {
    if (point === 'fenced') await f.engine.executeRaw("UPDATE persistence_worktree_refreshes SET state='aborted',completed_at=now(),updated_at=now() WHERE id=$1::uuid", [(row as { id: string }).id]);
  } } }).catch(error => error);
  expect(result).toBeInstanceOf(OperationError);
  expect((result as OperationError).code).toBe('refresh_source_changed');
  expect(f.head()).toBe(old);
}), 180_000);

/** Runs `fn` with a `git` on PATH that, once armed, runs `after` in the checkout right after the refresh's own `git merge --ff-only` succeeds. */
async function afterMerge(f: RefreshFixture, after: string, fn: () => Promise<void>) {
  const bin = join(f.dir, 'merge-race-bin'), armed = join(f.dir, 'merge-race-armed'), script = join(f.dir, 'merge-race.sh');
  mkdirSync(bin, { recursive: true });
  writeFileSync(script, `cd '${f.root}' || exit 1\n${after}\n`);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nPATH='${process.env.PATH}' git "$@"\ncode=$?\ncase " $* " in *" merge --ff-only "*) if [ $code -eq 0 ] && [ -f '${armed}' ]; then rm -f '${armed}'; PATH='${process.env.PATH}' sh '${script}' >/dev/null 2>&1; fi;; esac\nexit $code\n`, { mode: 0o755 });
  writeFileSync(armed, '');
  await withEnv({ PATH: `${bin}:${process.env.PATH}` }, fn);
}
/** Runs `fn` with a `git` on PATH that, once armed, runs `before` in the checkout right before the refresh's own `git merge --ff-only`. */
async function beforeMerge(f: RefreshFixture, before: string, fn: () => Promise<void>) {
  const bin = join(f.dir, 'merge-race-bin'), armed = join(f.dir, 'merge-race-armed'), script = join(f.dir, 'merge-race.sh');
  mkdirSync(bin, { recursive: true });
  writeFileSync(script, `cd '${f.root}' || exit 1\n${before}\n`);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" merge --ff-only "*) if [ -f '${armed}' ]; then rm -f '${armed}'; PATH='${process.env.PATH}' sh '${script}' >/dev/null 2>&1; fi;; esac\nPATH='${process.env.PATH}' exec git "$@"\n`, { mode: 0o755 });
  writeFileSync(armed, '');
  await withEnv({ PATH: `${bin}:${process.env.PATH}` }, fn);
}
const FOREIGN_ON_TOP = "mkdir -p alpha && printf -- '---\\ntitle: Foreign\\ntype: note\\n---\\nPlain git.\\n' > alpha/foreign.md && git add alpha/foreign.md && git -c user.name=Example -c user.email=example@example.invalid -c commit.gpgsign=false commit -qm foreign";
const bothArms = (fn: (f: RefreshFixture) => Promise<void>) => (async () => {
  for (const arm of ['0', '1']) await withEnv({ GBRAIN_REFRESH_BARRIER: arm }, async () => {
    resetWriteSwitches();
    for (const engine of engines) await withRefreshFixture(engine, fn);
  });
})();

test('seed 355: a plain-git commit landing on the target right after the merge is recorded and synced, not recovery_required', () => bothArms(async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  let result: unknown;
  await afterMerge(f, FOREIGN_ON_TOP, async () => { result = await refreshWorktree(f.engine, f.alpha).catch(error => error); });
  expect(result).not.toBeInstanceOf(OperationError);
  expect((result as { status: string }).status).toBe('completed');
  const head = f.head();
  expect(head).not.toBe(target);
  expect(git(f.root, 'rev-parse', 'HEAD~1')).toBe(target);
  for (const source of [f.alpha, f.beta]) expect(await f.lastCommit(source)).toBe(head);
  expect((await f.refreshRows()).at(-1)!.state).toBe('completed');
}), 180_000);

test('GST-1674: a plain-git commit landing on the pre-refresh commit right before the merge aborts with the fence lifted, keeps the commit, and the next refresh completes', () => bothArms(async f => {
  const old = f.head();
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  let result: unknown;
  await beforeMerge(f, FOREIGN_ON_TOP, async () => { result = await refreshWorktree(f.engine, f.alpha).catch(error => error); });
  expect(result).toBeInstanceOf(OperationError);
  expect((result as OperationError).code).toBe('refresh_source_changed');
  const foreign = f.head();
  expect(foreign).not.toBe(old);
  expect(git(f.root, 'rev-parse', 'HEAD~1')).toBe(old);
  expect(git(f.root, 'log', '-1', '--format=%s')).toBe('foreign');
  expect((await f.refreshRows()).map(row => row.state)).toEqual(['aborted']);
  git(f.root, 'config', 'user.name', 'Example'); git(f.root, 'config', 'user.email', 'example@example.invalid');
  commitAndPush({ repo: f.root, cwd: f.root, pushOnly: true, keepCheckout: true });
  const done = await refreshWorktree(f.engine, f.alpha);
  expect(done.status).toBe('completed');
  const head = f.head();
  for (const commit of [foreign, target]) expect(git(f.root, 'merge-base', '--is-ancestor', commit, head)).toBe('');
  for (const source of [f.alpha, f.beta]) expect(await f.lastCommit(source)).toBe(head);
  expect((await f.refreshRows()).map(row => row.state)).toEqual(['aborted', 'completed']);
}), 180_000);

test('seed 355 policy: a reset to the pre-refresh commit plus an unrelated commit right after the merge still needs the operator', () => bothArms(async f => {
  const old = f.head();
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  let result: unknown;
  await afterMerge(f, `git reset -q --hard ${old} && ${FOREIGN_ON_TOP}`, async () => { result = await refreshWorktree(f.engine, f.alpha).catch(error => error); });
  expect(result).toBeInstanceOf(OperationError);
  expect((result as OperationError).code).toBe('refresh_recovery_required');
  expect((await f.refreshRows()).at(-1)!.state).toBe('recovery_required');
}), 180_000);

test('item 22: the drain never sleeps a refresh retry hint past its refresh budget', () => {
  const refreshing = new OperationError('worktree_refreshing', 'refreshing');
  refreshing.detail = 'retry_after_ms=240000';
  expect(_transientDelayForTests(refreshing, 1, 0, 250)).toBe(240_000);
  expect(_transientDelayForTests(refreshing, 1, 290_000, 250)).toBe(10_000);
  expect(_transientDelayForTests(refreshing, 1, 300_000, 250)).toBeNull();
});

test('item 5: a case-insensitive checkout compares the refresh\'s changed paths case-folded', () => each(async f => {
  let deferred!: WriteRequest;
  const refresh = await duringRefresh(f, async () => {
    deferred = await requestRow(f, (await call(f, 'put_page', { slug: 'notes/case', content: page('Case', 'deferred') })).body.request_id);
    await disposePersistenceConsumer(f.engine);
  });
  expect((await refresh).status).toBe('completed');
  const row = (await getWriteRequestById(f.engine, deferred.id))!;
  const files = [{ root: f.root, path: join(f.root, 'alpha', 'TWO.md') }];
  git(f.root, 'config', 'core.ignorecase', 'false');
  expect(await deferredReplayRefusal(f.engine, row, files)).toBeNull();
  _resetRefreshBarrierCacheForTests();
  git(f.root, 'config', 'core.ignorecase', 'true');
  try {
    expect(await deferredReplayRefusal(f.engine, row, files)).toMatchObject({ state: 'conflict', failure: { code: 'revision_conflict' } });
  } finally { git(f.root, 'config', 'core.ignorecase', 'false'); _resetRefreshBarrierCacheForTests(); }
  expect((await settle(f, row)).state).toBe('committed');
}), 180_000);

test('item 2 (confirmation): polling a receipt never publishes a released deferred write; the next consumer on the owner host does', () => each(async f => {
  let deferred!: WriteRequest;
  const refresh = await duringRefresh(f, async () => {
    deferred = await requestRow(f, (await call(f, 'put_page', { slug: 'notes/polled', content: page('Polled', 'deferred') })).body.request_id);
    await disposePersistenceConsumer(f.engine);
  }, undefined, async point => {
    if (point === 'synced') await disposePersistenceConsumer(f.engine);
  });
  expect((await refresh).status).toBe('completed');
  for (let i = 0; i < 3; i++) await call(f, 'get_write_request', { request_id: deferred.request_id });
  expect((await getWriteRequestById(f.engine, deferred.id))!.state).toBe('deferred');
  expect((await settle(f, deferred)).state).toBe('committed');
}), 180_000);

test('#8759: the managed sync capacity discount counts only writes still held for that source', () => each(async f => {
  await f.engine.setConfig('persistence.limits.principal_outstanding', '1');
  try {
    foreignCommit(f, 'one.md', page('Beta one', IMPORTED), 'beta');
    const out = await local(f, 'put_page', { slug: 'one', content: page('Beta one', 'Held for the beta import.') }, f.beta);
    expect((await requestRow(f, out.receipt.request_id)).state).toBe('deferred');
    foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
    const before = await f.lastCommit(f.alpha);
    const alpha = await importNow(f).then(result => result, error => error);
    expect(alpha instanceof Error ? (alpha as OperationError).code : (alpha as { status: string }).status).not.toBe('synced');
    expect(await f.lastCommit(f.alpha)).toBe(before);
    await importNow(f, f.beta);
    expect(await f.lastCommit(f.beta)).toBe(git(f.root, 'rev-parse', 'HEAD'));
  } finally {
    await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.limits.principal_outstanding'");
  }
}), 180_000);

test('#8759: a held capture of the very file its import brought in names no supersedes', () => each(async f => {
  const content = page('Alpha one', `${IMPORTED} Captured from this file.`);
  foreignCommit(f, 'one.md', content);
  const out = await local(f, 'capture', { slug: 'one', content, local_file: join(f.root, 'alpha', 'one.md') });
  expect(out.pending).toBe(true);
  const held = await requestRow(f, out.receipt.request_id);
  expect(held.state).toBe('deferred');
  expect(typeof held.intent?.capture_file_hash).toBe('string');
  await importNow(f);
  const done = await settle(f, held);
  expect(done.state).toBe('committed');
  expect((done.outcome as { supersedes?: unknown } | null)?.supersedes).toBeUndefined();
}), 180_000);
