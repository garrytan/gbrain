/**
 * GST-1582: a page write never bounces because a sync is running (docs/designs/REFRESH_WRITE_BARRIER.md, "Writes that
 * wait for an import").
 *
 * Protects: with persistence.refresh_barrier on, a put_page, capture, remember or add_timeline_entry whose page file holds a committed change
 * managed sync has not imported yet (`pending_import`) is held `deferred` and answered pending, then published by itself
 * once the import lands, prepared again as if it had queued behind the import: remember and add_timeline_entry apply on top, a put_page with
 * expected_revision (what a remote caller must send for an existing page) ends revision_conflict, a blind (force) put_page or capture lands, and a put_page's receipt,
 * its commit trailer and the commit ledger name the imported revision and commit it replaced (both stay in page history and git). A write admitted while a
 * refresh is in recovery_required waits behind it and lands once the refresh is released. A held write whose import never
 * lands ends `pending_import_expired`. With the barrier off the refusal is unchanged.
 * Seams: the real managed sync and refresh state machine; GBRAIN_REFRESH_BARRIER; the effect worker run in-process.
 */
import postgres from '#postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer, preparePersistedMutation, waitForWrite } from '../src/core/persistence/service.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { getWriteRequestById } from '../src/core/persistence/journal.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { _setRefreshFenceWaitForTests } from '../src/core/persistence/admission-retry.ts';
import { _resetRefreshBarrierCacheForTests, _setAfterImportExpiryScanForTests, deferredBacklog, expireDeferredWrites } from '../src/core/persistence/refresh-barrier.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { refreshWorktree, resumeWorktreeRefreshes } from '../src/core/persistence/worktree-refresh.ts';
import { readLedger } from '../src/core/git/commit-ledger.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { replayImportedRemembers } from '../src/core/repair/failed-writes.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
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

const each = (fn: (f: RefreshFixture) => Promise<void>, barrier = '1') => withEnv({ GBRAIN_REFRESH_BARRIER: barrier }, async () => {
  resetWriteSwitches();
  for (const engine of engines) await withRefreshFixture(engine, async f => {
    git(f.root, 'config', 'user.name', 'Example'); git(f.root, 'config', 'user.email', 'example@example.invalid'); git(f.root, 'config', 'commit.gpgsign', 'false');
    await fn(f);
  });
});

async function call(f: RefreshFixture, name: string, params: Record<string, unknown>) {
  const result = await dispatchToolCall(f.engine, name, params, { remote: true, transport: 'stdio', sourceId: f.alpha, admissionOrigin: 'interactive' });
  return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) as Record<string, any> };
}
async function requestRow(f: RefreshFixture, requestId: string): Promise<WriteRequest> {
  const [row] = await f.engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
  return row!;
}
/** A blind local CLI write (force, no expected_revision): its receipt whether it settled or was left pending (write_pending). */
async function local(f: RefreshFixture, operation: 'put_page' | 'capture', params: Record<string, unknown>): Promise<{ pending: boolean; receipt: Record<string, any> }> {
  try {
    const receipt = await submitPageMutation(f.ctx(f.alpha), { operation, params: { request_id: randomUUID(), force: true, ...params } }) as Record<string, any>;
    return { pending: false, receipt };
  } catch (error) {
    const e = error as { code?: string; writeError?: string; writeRequest?: Record<string, any> };
    if ((e.code === 'write_pending' || e.writeError === 'write_pending') && e.writeRequest) return { pending: true, receipt: e.writeRequest };
    throw error;
  }
}
const settle = async (f: RefreshFixture, row: WriteRequest) => waitForWrite(f.engine, (await getWriteRequestById(f.engine, row.id))!, { engine: f.engine.kind } as never, 30_000);
const importNow = (f: RefreshFixture) => performManagedSync(f.engine, { sourceId: f.alpha, noPull: true, noEmbed: true });
const file = (f: RefreshFixture, rel: string) => readFileSync(join(f.root, 'alpha', rel), 'utf8');
const IMPORTED = 'Another writer committed this line.';
/** Runs the effect worker until request `id`'s Git effect has committed (the resident consumer may hold it meanwhile). */
async function gitEffectDone(f: RefreshFixture, id: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await runPersistenceEffects(f.engine, { engine: f.engine.kind } as never, { hostId: localHostId() });
    const [effect] = await f.engine.executeRaw<{ state: string; outcome: { git?: string } | null }>("SELECT state,outcome FROM persistence_effects WHERE request_id=$1::uuid AND kind='git'", [id]);
    if (effect?.state === 'committed') { expect(effect.outcome?.git).toBe('committed'); return; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`the Git effect of request ${id} did not commit`);
}
/** Records Git durability on for the owner, so its Git effects commit instead of completing as skipped. */
const durable = (f: RefreshFixture) => f.engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled'");

/** Another writer's commit to alpha/<rel> that managed sync has not imported yet. */
const foreignCommit = (f: RefreshFixture, rel: string, content: string) => commitFile(f.root, `alpha/${rel}`, content, 'another writer');

test('a blind put_page onto a file awaiting import is held pending, lands after the import, and names the imported revision it replaced', () => each(async f => {
  await durable(f);
  const before = await f.lastCommit(f.alpha);
  const imported = foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
  const out = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Mine, written while the import waited.') });
  expect(out).toMatchObject({ pending: true, receipt: { state: 'queued', deferred: { pending_import: true } } });
  const held = await requestRow(f, out.receipt.request_id);
  expect(held).toMatchObject({ state: 'deferred', deferred_refresh_id: null, deferred_import_from: before });
  expect((await deferredBacklog(f.engine)).count).toBe(1);
  await importNow(f);
  const done = await settle(f, held);
  expect(done.state).toBe('committed');
  expect(file(f, 'one.md')).toContain('Mine, written while the import waited.');
  const supersedes = (done.outcome as { supersedes?: { slug: string; revision: unknown; commit: string } }).supersedes;
  expect(supersedes).toMatchObject({ slug: 'one', commit: imported });
  expect(supersedes!.revision).toBeTruthy();
  // The replaced content stays in page history and in git.
  const history = await f.engine.executeRaw<{ compiled_truth: string | null }>(
    'SELECT v.compiled_truth FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND p.slug=$2', [f.alpha, 'one']);
  expect(history.some(v => (v.compiled_truth ?? '').includes(IMPORTED))).toBe(true);
  expect(git(f.root, 'show', `${imported}:alpha/one.md`)).toContain(IMPORTED);
  git(f.root, 'merge-base', '--is-ancestor', imported, 'HEAD');
  await gitEffectDone(f, done.id);
  const commit = git(f.root, 'log', '-1', '--format=%H', '--', 'alpha/one.md');
  expect(git(f.root, 'log', '-1', '--format=%B', commit)).toContain(`gbrain-supersedes: one.md: revision ${supersedes!.revision} from ${imported}`);
  const line = readLedger(join(f.root, '.git')).find(r => r.e === 'commit' && r.sha === commit) as { supersedes?: string[] } | undefined;
  expect(line?.supersedes).toEqual([`one.md: revision ${supersedes!.revision} from ${imported}`]);
  expect((await deferredBacklog(f.engine)).count).toBe(0);
}), 180_000);

test('a capture onto a file awaiting import lands after the import and names the imported revision it replaced', () => each(async f => {
  const imported = foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
  const out = await local(f, 'capture', { slug: 'one', content: 'Captured while the import waited.' });
  expect(out.pending).toBe(true);
  const held = await requestRow(f, out.receipt.request_id);
  expect(held.state).toBe('deferred');
  await importNow(f);
  const done = await settle(f, held);
  expect(done.state).toBe('committed');
  expect(file(f, 'one.md')).toContain('Captured while the import waited.');
  const supersedes = (done.outcome as { supersedes?: { slug: string; revision: unknown; commit: string } }).supersedes;
  expect(supersedes).toMatchObject({ slug: 'one', commit: imported });
  expect(supersedes!.revision).toBeTruthy();
}), 180_000);

const PERSON = '---\ntitle: Alice Example\ntype: person\n---\nAlice is a person.\n';

test('a remember onto a file awaiting import lands on top of the imported page', () => each(async f => {
  foreignCommit(f, 'people/alice-example.md', PERSON);
  await importNow(f);
  foreignCommit(f, 'people/alice-example.md', PERSON.replace('Alice is a person.', `Alice is a person. ${IMPORTED}`));
  const out = await call(f, 'remember', { fact: 'alice-example likes tea', entity: 'people/alice-example', provenance: 'test' });
  expect(out.isError).toBe(false);
  expect(out.body.status).toBe('pending');
  const held = await requestRow(f, out.body.request_id);
  expect(held.state).toBe('deferred');
  await importNow(f);
  expect((await settle(f, held)).state).toBe('committed');
  const content = file(f, 'people/alice-example.md');
  expect(content).toContain(IMPORTED);
  expect(content).toContain('alice-example likes tea');
}), 180_000);

test('an add_timeline_entry onto a file awaiting import lands on top of the imported page', () => each(async f => {
  foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
  const out = await call(f, 'add_timeline_entry', { slug: 'one', date: '2026-11-06', summary: 'Entry added while the import waited.' });
  expect(out.isError).toBe(false);
  expect(out.body.status).toBe('pending');
  const held = await requestRow(f, out.body.request_id);
  expect(held.state).toBe('deferred');
  await importNow(f);
  expect((await settle(f, held)).state).toBe('committed');
  const content = file(f, 'one.md');
  expect(content).toContain(IMPORTED);
  expect(content).toContain('Entry added while the import waited.');
}), 180_000);

test('a put_page with expected_revision onto a file awaiting import ends revision_conflict once the import moved the page', () => each(async f => {
  const seen = (await f.engine.readPageSnapshot('one', { sourceId: f.alpha }))!.revision;
  foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
  const out = await call(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Based on the old revision.'), expected_revision: seen });
  expect(out.isError).toBe(false);
  const held = await requestRow(f, out.body.request_id);
  expect(held.state).toBe('deferred');
  await importNow(f);
  expect(await settle(f, held)).toMatchObject({ state: 'conflict', error_code: 'revision_conflict' });
  expect(file(f, 'one.md')).toContain(IMPORTED);
}), 180_000);

test('a held write whose import never lands ends pending_import_expired with nothing applied', () => each(async f => {
  foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
  const out = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Never applied.') });
  const held = await requestRow(f, out.receipt.request_id);
  expect(held.state).toBe('deferred');
  await f.engine.executeRaw("INSERT INTO config(key,value) VALUES('persistence.refresh_barrier_max_wait_ms','1') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
  await new Promise(resolve => setTimeout(resolve, 20));
  const [{ owner }] = await f.engine.executeRaw<{ owner: string }>('SELECT owner_host_id::text AS owner FROM persistence_worktrees WHERE id=$1::uuid', [f.worktreeId]);
  expect((await expireDeferredWrites(f.engine, owner)).map(row => row.id)).toEqual([held.id]);
  expect(await getWriteRequestById(f.engine, held.id)).toMatchObject({ state: 'failed', error_code: 'pending_import_expired' });
  await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.refresh_barrier_max_wait_ms'");
  expect(file(f, 'one.md')).toContain(IMPORTED);
}), 180_000);

const maxWait = (f: RefreshFixture, ms: number) => f.engine.executeRaw(`INSERT INTO config(key,value) VALUES('persistence.refresh_barrier_max_wait_ms',$1)
  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [String(ms)]);
const ownerHost = async (f: RefreshFixture) => (await f.engine.executeRaw<{ owner: string }>('SELECT owner_host_id::text AS owner FROM persistence_worktrees WHERE id=$1::uuid', [f.worktreeId]))[0]!.owner;

test('a held remember whose import has not landed in time is kept for the replay after the import, never dropped', () => each(async f => {
  foreignCommit(f, 'people/alice-example.md', PERSON);
  await importNow(f);
  foreignCommit(f, 'people/alice-example.md', PERSON.replace('Alice is a person.', `Alice is a person. ${IMPORTED}`));
  const out = await call(f, 'remember', { fact: 'alice-example likes tea', entity: 'people/alice-example', provenance: 'test' });
  const held = await requestRow(f, out.body.request_id);
  expect(held.state).toBe('deferred');
  await maxWait(f, 1);
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await expireDeferredWrites(f.engine, await ownerHost(f))).map(row => row.id)).toEqual([held.id]);
  } finally {
    await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.refresh_barrier_max_wait_ms'");
  }
  const expired = (await getWriteRequestById(f.engine, held.id))!;
  expect(expired).toMatchObject({ state: 'conflict', error_code: 'source_changed' });
  expect((expired.error_detail as { origin?: string }).origin).toBe('pending_import');
  expect(expired.error_message).toContain('Do not save it again');
  await importNow(f);
  expect(await replayImportedRemembers(f.ctx(f.alpha), f.alpha)).toMatchObject({ replayed: 1 });
  expect(file(f, 'people/alice-example.md')).toContain('alice-example likes tea');
}), 180_000);

test('a held capture or add_timeline_entry whose import never lands ends pending_import_expired, on an idle owner tick, with nothing applied', () => each(async f => {
  foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
  const capture = await local(f, 'capture', { slug: 'one', content: 'Captured, never applied.' });
  const timeline = await call(f, 'add_timeline_entry', { slug: 'one', date: '2026-11-06', summary: 'Entry, never applied.' });
  const held = [await requestRow(f, capture.receipt.request_id), await requestRow(f, timeline.body.request_id)];
  expect(held.map(row => row.state)).toEqual(['deferred', 'deferred']);
  await disposePersistenceConsumer(f.engine);
  const consumer = new PersistenceConsumer(f.engine, { engine: f.engine.kind } as never, preparePersistedMutation);
  try {
    await consumer.tick();
    expect((await Promise.all(held.map(row => getWriteRequestById(f.engine, row.id)))).map(row => row!.state)).toEqual(['deferred', 'deferred']);
    await maxWait(f, 1);
    await new Promise(resolve => setTimeout(resolve, 20));
    await consumer.tick();
    for (const row of held) expect(await getWriteRequestById(f.engine, row.id)).toMatchObject({ state: 'failed', error_code: 'pending_import_expired' });
  } finally {
    await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.refresh_barrier_max_wait_ms'");
    await consumer.stop();
  }
  const content = file(f, 'one.md');
  expect(content).toContain(IMPORTED);
  expect(content).not.toContain('never applied');
}), 180_000);

test("a held write's wait limit counts from when it was held, not from its admission", () => each(async f => {
  foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
  const out = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Held, admitted long ago.') });
  const held = await requestRow(f, out.receipt.request_id);
  expect(held.state).toBe('deferred');
  await f.engine.executeRaw("UPDATE persistence_requests SET created_at=now()-interval '2 hours' WHERE id=$1::uuid", [held.id]);
  await maxWait(f, 60_000);
  try {
    expect(await expireDeferredWrites(f.engine, await ownerHost(f))).toEqual([]);
    expect((await getWriteRequestById(f.engine, held.id))!.state).toBe('deferred');
    await f.engine.executeRaw("UPDATE persistence_requests SET updated_at=now()-interval '2 hours' WHERE id=$1::uuid", [held.id]);
    expect((await expireDeferredWrites(f.engine, await ownerHost(f))).map(row => row.id)).toEqual([held.id]);
  } finally {
    await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.refresh_barrier_max_wait_ms'");
  }
}), 180_000);

test('a live consumer that cannot claim a held write keeps the pending_import refusal', () => each(async f => {
  const seen = (await f.engine.readPageSnapshot('one', { sourceId: f.alpha }))!.revision;
  foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
  await f.engine.executeRaw(`INSERT INTO persistence_consumers(host_id,pid,nonce,kind,mode,host_json_path,persistence_home,version,capabilities)
    VALUES($1::uuid,1,'barrier-only-example','serve','full','/nonexistent/host.json','/nonexistent','0.0.1','{refresh_barrier_1}')`, [await ownerHost(f)]);
  try {
    const out = await call(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Refused.'), expected_revision: seen });
    expect(out.isError).toBe(true);
    const [row] = await f.engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE operation=$1 ORDER BY sequence DESC LIMIT 1', ['put_page']);
    expect(row).toMatchObject({ state: 'conflict', error_code: 'source_changed', deferred_import_from: null });
    expect((row!.error_detail as { origin?: string }).origin).toBe('pending_import');
  } finally {
    await f.engine.executeRaw("DELETE FROM persistence_consumers WHERE nonce='barrier-only-example'");
  }
}), 180_000);

test('with the barrier off a write onto a file awaiting import keeps the pending_import refusal', () => each(async f => {
  const seen = (await f.engine.readPageSnapshot('one', { sourceId: f.alpha }))!.revision;
  foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
  const out = await call(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Refused.'), expected_revision: seen });
  expect(out.isError).toBe(true);
  const [row] = await f.engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE operation=$1 ORDER BY sequence DESC LIMIT 1', ['put_page']);
  expect(row).toMatchObject({ state: 'conflict', error_code: 'source_changed' });
  expect((row!.error_detail as { origin?: string }).origin).toBe('pending_import');
}, '0'), 180_000);

test('a write while a refresh is in recovery_required waits behind it and lands once the refresh is released', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  const old = f.head();
  await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => { if (point === 'merged') throw new Error('simulated crash after merge'); } } }))
    .rejects.toThrow('simulated crash');
  git(f.root, 'reset', '-q', '--hard', old);
  git(f.root, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
  await resumeWorktreeRefreshes(f.engine);
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['recovery_required']);
  const out = await call(f, 'put_page', { slug: 'notes/during-recovery', content: page('During recovery', 'Accepted while the refresh awaited recovery.') });
  expect(out.isError).toBe(false);
  expect(out.body.status).toBe('pending');
  const held = await requestRow(f, out.body.request_id);
  expect(held.state).toBe('deferred');
  git(f.root, 'reset', '-q', '--hard', old);
  expect((await refreshWorktree(f.engine, f.alpha, { abandon: true })).status).toBe('abandoned');
  expect((await settle(f, held)).state).toBe('committed');
  expect(file(f, 'notes/during-recovery.md')).toContain('Accepted while the refresh awaited recovery.');
}), 180_000);

test.skipIf(!backends.includes('postgres'))('an import expiry that overlaps a fence waits on the brain row instead of deadlocking with it', () => each(async f => {
  if (f.engine.kind !== 'postgres') return;
  foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
  const out = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Held past its limit.') });
  const held = await requestRow(f, out.receipt.request_id);
  expect(held.state).toBe('deferred');
  await disposePersistenceConsumer(f.engine);
  await maxWait(f, 1);
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    const owner = await ownerHost(f);
    let holding!: () => void; const held1 = new Promise<void>(resolve => { holding = resolve; });
    let fenceIs!: (rows: Array<{ pid: number }>) => void; const fencePid = new Promise<Array<{ pid: number }>>(resolve => { fenceIs = resolve; });
    let waiting!: () => void; const expiryWaits = new Promise<void>(resolve => { waiting = resolve; });
    // fenceDraining's order (lockTopologyRows): the brain row FOR UPDATE, then the worktree, then the sources.
    const fence = f.engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('lock_timeout','10s',true)");
      await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
      fenceIs(await tx.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid'));
      holding();
      await expiryWaits;
      await tx.executeRaw('SELECT 1 FROM sources WHERE id=$1 FOR UPDATE', [f.alpha]);
    });
    await held1;
    const expiry = expireDeferredWrites(f.engine, owner);
    const [{ pid }] = await fencePid;
    let blocked = false;
    for (let i = 0; i < 400 && !blocked; i++) {
      const [w] = await f.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [pid]);
      blocked = Number(w!.n) > 0;
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 25));
    }
    waiting();
    const [fenced, expired] = await Promise.allSettled([fence, expiry]);
    expect(fenced.status === 'rejected' ? String(fenced.reason) : 'fence committed').toBe('fence committed');
    expect(expired.status === 'fulfilled' ? expired.value.map(row => row.id) : String(expired.reason)).toEqual([held.id]);
    expect(blocked).toBe(true);
  } finally {
    await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.refresh_barrier_max_wait_ms'");
  }
  expect(await getWriteRequestById(f.engine, held.id)).toMatchObject({ state: 'failed', error_code: 'pending_import_expired' });
}), 180_000);

test('a write held for an import is never passed by a later write to the same page', () => each(async f => {
  await durable(f);
  const before = await f.lastCommit(f.alpha);
  foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
  foreignCommit(f, 'zz-later.md', page('Alpha later', 'A second file in the same import.'));
  const first = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Written first, while the import waited.') });
  expect(first.pending).toBe(true);
  const held = await requestRow(f, first.receipt.request_id);
  expect(held).toMatchObject({ state: 'deferred', deferred_import_from: before });
  // The window between managed sync's page import and its checkpoint, through the real path: a one-page slice imports
  // one.md into the database and yields before the checkpoint, so sources.last_commit has not moved and the held write
  // is still unreleased.
  const sliced = await performManagedSync(f.engine, { sourceId: f.alpha, noPull: true, noEmbed: true }, { maxPages: 1, maxMs: 60_000 });
  expect(sliced.status).toBe('partial');
  expect(await f.lastCommit(f.alpha)).toBe(before);
  const imported = await f.engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug=$2', [f.alpha, 'one']);
  expect(imported[0]!.compiled_truth).toContain(IMPORTED);
  expect((await requestRow(f, first.receipt.request_id)).state).toBe('deferred');
  const second = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Written second.') });
  const later = await requestRow(f, second.receipt.request_id);
  expect(later.sequence > held.sequence).toBe(true);
  await importNow(f);
  expect(await f.lastCommit(f.alpha)).not.toBe(before);
  await settle(f, held);
  if (second.pending) await settle(f, later);
  expect((await requestRow(f, first.receipt.request_id)).state).toBe('committed');
  // Writes to one page commit in admission order: the later write is the last to commit, so the earlier one never lands on top of it.
  const versions = (await f.engine.executeRaw<{ body: string }>(
    `SELECT compiled_truth AS body FROM (SELECT v.compiled_truth, v.id FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND p.slug=$2
      UNION ALL SELECT compiled_truth, NULL FROM pages WHERE source_id=$1 AND slug=$2) h ORDER BY h.id NULLS LAST`, [f.alpha, 'one'])).map(v => v.body ?? '');
  const lastIndex = (text: string) => versions.findLastIndex(v => v.includes(text));
  expect(lastIndex('Written second.')).toBeGreaterThan(lastIndex('Written first, while the import waited.'));
  expect(file(f, 'one.md')).toContain('Written second.');
}), 180_000);


// PostgreSQL only: the race needs a second connection, and PGLite has one.
test.skipIf(!backends.includes('postgres'))('a held write whose import lands while its expiry waits on the request lock is not expired', () => each(async f => {
  if (f.engine.kind !== 'postgres') return;
  const before = await f.lastCommit(f.alpha);
  foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
  foreignCommit(f, 'zz-later.md', page('Alpha later', 'A second file in the same import.'));
  const out = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Held, then released by the import.') });
  const held = await requestRow(f, out.receipt.request_id);
  expect(held).toMatchObject({ state: 'deferred', deferred_import_from: before });
  // A one-page slice imports one.md and yields before its checkpoint, so the page rows hold the import and only
  // sources.last_commit is left to move (below, the checkpoint's commit on another connection).
  expect((await performManagedSync(f.engine, { sourceId: f.alpha, noPull: true, noEmbed: true }, { maxPages: 1, maxMs: 60_000 })).status).toBe('partial');
  expect(await f.lastCommit(f.alpha)).toBe(before);
  await f.engine.executeRaw("INSERT INTO config(key,value) VALUES('persistence.refresh_barrier_max_wait_ms','1') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
  await new Promise(resolve => setTimeout(resolve, 20));
  const [{ owner }] = await f.engine.executeRaw<{ owner: string }>('SELECT owner_host_id::text AS owner FROM persistence_worktrees WHERE id=$1::uuid', [f.worktreeId]);
  const other = postgres(postgresUrl!, { max: 1, prepare: false });
  try {
    // The import lands on another connection: last_commit moves to HEAD, uncommitted, and that transaction holds the
    // request row, so the expiry reads the old last_commit and then waits on the row lock.
    await other.unsafe('BEGIN');
    const [{ pid }] = await other.unsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
    await other.unsafe("SELECT set_config('gbrain.write_sources',$1,true)", [JSON.stringify([f.alpha])]);
    await other.unsafe('UPDATE sources SET last_commit=$1 WHERE id=$2', [f.head(), f.alpha]);
    await other.unsafe('SELECT 1 FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [held.id]);
    const expiry = expireDeferredWrites(f.engine, owner);
    const deadline = Date.now() + 20_000;
    while ((await f.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))', [pid]))[0]!.n === 0) {
      if (Date.now() > deadline) throw new Error('the expiry never waited on the landing import');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await other.unsafe('COMMIT');
    expect((await expiry).map(row => row.id)).not.toContain(held.id);
  } finally {
    await other.end();
    await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.refresh_barrier_max_wait_ms'");
  }
  expect(await getWriteRequestById(f.engine, held.id)).not.toMatchObject({ state: 'failed' });
  expect((await settle(f, held)).state).toBe('committed');
  expect(file(f, 'one.md')).toContain('Held, then released by the import.');
}), 180_000);


test('a write held for an import never takes the capacity the import needs', () => each(async f => {
  await f.engine.setConfig('persistence.limits.principal_outstanding', '1');
  try {
    foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
    const out = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Mine, held while the cap is full.') });
    expect(out.pending).toBe(true);
    const held = await requestRow(f, out.receipt.request_id);
    expect(held.state).toBe('deferred');
    await importNow(f);
    expect(await f.lastCommit(f.alpha)).toBe(git(f.root, 'rev-parse', 'HEAD'));
    expect((await settle(f, held)).state).toBe('committed');
    expect(file(f, 'one.md')).toContain('Mine, held while the cap is full.');
  } finally {
    await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.limits.principal_outstanding'");
  }
}), 180_000);


test('a write held for an import never takes the capacity a bulk import group needs', () => each(async f => {
  await f.engine.setConfig('persistence.limits.principal_outstanding', '2');
  try {
    for (const name of ['one', 'two', 'three']) foreignCommit(f, `${name}.md`, page(`Alpha ${name}`, IMPORTED));
    const out = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Mine, held while a bulk group imports.') });
    const held = await requestRow(f, out.receipt.request_id);
    expect(held.state).toBe('deferred');
    await performManagedSync(f.engine, { sourceId: f.alpha, noPull: true, noEmbed: true,
      bulk: { enabled: true, reason: null, size: 16, maxTxnMs: 15_000, maxTxnExplicit: false } } as never);
    expect(await f.lastCommit(f.alpha)).toBe(git(f.root, 'rev-parse', 'HEAD'));
    expect((await settle(f, held)).state).toBe('committed');
  } finally {
    await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.limits.principal_outstanding'");
  }
}), 180_000);

test('GST-1623: an import and a new hold between the expiry scan and its lock never expire the new hold', () => each(async f => {
  foreignCommit(f, 'one.md', page('Alpha one', IMPORTED));
  const out = await local(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Mine, held again after an import.') });
  const held = await requestRow(f, out.receipt.request_id);
  expect(held.state).toBe('deferred');
  await maxWait(f, 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  const next = foreignCommit(f, 'one.md', page('Alpha one', 'A second commit, not imported yet.'));
  _setAfterImportExpiryScanForTests(async rows => {
    expect(rows.map(row => row.id)).toEqual([held.id]);
    await f.engine.transaction(tx => withCoordinatedWrite(tx, [f.alpha], () => tx.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [f.alpha, next]), TEST_WRITE_ATTRIBUTION));
    await f.engine.executeRaw("UPDATE persistence_requests SET deferred_import_from=$2,updated_at=now() WHERE id=$1::uuid", [held.id, next]);
  });
  try {
    expect(await expireDeferredWrites(f.engine, await ownerHost(f))).toEqual([]);
  } finally {
    _setAfterImportExpiryScanForTests(null);
    await f.engine.executeRaw("DELETE FROM config WHERE key='persistence.refresh_barrier_max_wait_ms'");
  }
  expect(await getWriteRequestById(f.engine, held.id)).toMatchObject({ state: 'deferred', deferred_import_from: next });
}), 180_000);

