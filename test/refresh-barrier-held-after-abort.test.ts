/**
 * GST-1853: a write held behind a refresh that ends without completing (aborted, or abandoned by --resume after the
 * refreshing process was killed) is decided against the checkout as the refresh left it, not left pending until some
 * later refresh completes. The refresh's fence refused the managed sync that would import a commit another writer made, so
 * a write to that file was held for the import (deferred_import_from) and nothing else imported it. A refresh run that
 * finds the worktree's newest refresh aborted now runs the members' managed --no-pull sync on its way out, so each held
 * write is prepared again as designed: a put_page with expected_revision ends revision_conflict, a blind put_page lands and
 * names the imported revision it replaced, an add_timeline_entry applies on top.
 * Seams: the real refresh state machine and managed sync; GBRAIN_REFRESH_BARRIER; PGLite, and Postgres when DATABASE_URL is set.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import { getWriteRequestById } from '../src/core/persistence/journal.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { _setRefreshFenceWaitForTests } from '../src/core/persistence/admission-retry.ts';
import { _resetRefreshBarrierCacheForTests } from '../src/core/persistence/refresh-barrier.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { refreshWorktree, resumeWorktreeRefreshes } from '../src/core/persistence/worktree-refresh.ts';
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
  for (const engine of engines) await withRefreshFixture(engine, fn);
});

async function call(f: RefreshFixture, name: string, params: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await dispatchToolCall(f.engine, name, params, { remote: true, transport: 'stdio', sourceId: f.alpha, admissionOrigin: 'interactive' });
  const body = JSON.parse(result.content[0]!.text) as Record<string, any>;
  expect(result.isError === true).toBe(false);
  return body;
}
/** A blind local CLI put_page (force, no expected_revision); its request id, settled or left pending (write_pending). */
async function blindPut(f: RefreshFixture, content: string): Promise<string> {
  try {
    return (await submitPageMutation(f.ctx(f.alpha), { operation: 'put_page', params: { request_id: randomUUID(), force: true, slug: 'one', content } }) as { request_id: string }).request_id;
  } catch (error) {
    const e = error as { code?: string; writeError?: string; writeRequest?: { request_id: string } };
    if ((e.code === 'write_pending' || e.writeError === 'write_pending') && e.writeRequest) return e.writeRequest.request_id;
    throw error;
  }
}
async function requestRow(f: RefreshFixture, requestId: string): Promise<WriteRequest> {
  const [row] = await f.engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
  return row!;
}
const settle = async (f: RefreshFixture, row: WriteRequest) => waitForWrite(f.engine, (await getWriteRequestById(f.engine, row.id))!, { engine: f.engine.kind } as never, 30_000);
const file = (f: RefreshFixture) => readFileSync(join(f.root, 'alpha', 'one.md'), 'utf8');
const IMPORTED = 'Another writer committed this line while the refresh drained.';
const MINE = 'Mine, written while the refresh drained.';
const ENTRY = 'Entry written while the refresh drained.';

/**
 * While the refresh drains: another writer commits alpha/one.md with plain git (HEAD moves on its own line, and sync is
 * fenced off, so the commit waits for an import), then three writes to that page are admitted and deferred behind the refresh.
 */
async function writeWhileDraining(f: RefreshFixture, seen: string): Promise<{ foreign: string; revision: string; blind: string; append: string }> {
  const foreign = commitFile(f.root, 'alpha/one.md', page('Alpha one', IMPORTED), 'another writer');
  const revision = (await call(f, 'put_page', { slug: 'one', content: page('Alpha one', 'Based on the old revision.'), expected_revision: seen })).request_id as string;
  const blind = await blindPut(f, page('Alpha one', MINE));
  const append = (await call(f, 'add_timeline_entry', { slug: 'one', date: '2026-11-07', summary: ENTRY })).request_id as string;
  const [active] = await f.refreshRows();
  for (const id of [revision, blind, append]) expect(await requestRow(f, id)).toMatchObject({ state: 'deferred', deferred_refresh_id: active!.id });
  return { foreign, revision, blind, append };
}

/** Every held write is decided against the checkout the refresh left: the right revision check, never lost, never pending. */
async function expectDecided(f: RefreshFixture, ids: { foreign: string; revision: string; blind: string; append: string }): Promise<void> {
  // The release path: the refresh run that ended the refresh imported the checkout HEAD it left behind.
  expect(await f.lastCommit(f.alpha)).toBe(f.head());
  const revision = await requestRow(f, ids.revision), blind = await requestRow(f, ids.blind), append = await requestRow(f, ids.append);
  expect(await settle(f, revision)).toMatchObject({ state: 'conflict', error_code: 'revision_conflict' });
  const landed = await settle(f, blind);
  expect(landed.state).toBe('committed');
  expect((landed.outcome as { supersedes?: { commit: string } }).supersedes).toMatchObject({ slug: 'one', commit: ids.foreign });
  expect((await settle(f, append)).state).toBe('committed');
  const content = file(f);
  expect(content).toContain(MINE);
  expect(content).toContain(ENTRY);
  const history = await f.engine.executeRaw<{ compiled_truth: string | null }>(
    'SELECT v.compiled_truth FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND p.slug=$2', [f.alpha, 'one']);
  expect(history.some(v => (v.compiled_truth ?? '').includes(IMPORTED))).toBe(true);
}

test('GST-1853: writes held behind a refresh that aborts and then meets a diverged checkout are decided by that run, not left for a later refresh', () => each(async f => {
  const seen = (await f.engine.readPageSnapshot('one', { sourceId: f.alpha }))!.revision as string;
  f.push('alpha/two.md', page('Alpha two', 'An upstream observation.'));
  let ids!: Awaited<ReturnType<typeof writeWhileDraining>>;
  const error = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => { if (point === 'drained') ids = await writeWhileDraining(f, seen); } } })
    .then(() => null, thrown => thrown as { code?: string; message: string });
  // The HEAD the other writer moved aborts the refresh; the retry in the same tick finds the checkout diverged.
  expect(error?.code).toBe('refresh_source_changed');
  expect(error?.message).toContain('refresh_diverged');
  const rows = await f.refreshRows();
  expect(rows.map(r => r.state)).toEqual(['aborted']);
  await expectDecided(f, ids);
}), 180_000);

/** A refresh whose process is killed at fenced after another writer's commit and three writes landed while it drained. */
async function killedAtFenced(f: RefreshFixture): Promise<Awaited<ReturnType<typeof writeWhileDraining>>> {
  const seen = (await f.engine.readPageSnapshot('one', { sourceId: f.alpha }))!.revision as string;
  f.push('alpha/two.md', page('Alpha two', 'An upstream observation.'));
  let ids!: Awaited<ReturnType<typeof writeWhileDraining>>;
  await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => {
    if (point === 'drained') ids = await writeWhileDraining(f, seen);
    if (point === 'fenced') throw new Error('simulated kill at fenced');
  } } })).rejects.toThrow('simulated kill');
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['fenced']);
  for (const id of [ids.revision, ids.blind, ids.append]) expect((await requestRow(f, id)).state).toBe('deferred');
  return ids;
}

test('GST-1853: writes held behind a refresh killed at fenced are decided once --resume abandons it, not left for a later refresh', () => each(async f => {
  const ids = await killedAtFenced(f);
  const resumed = await refreshWorktree(f.engine, f.alpha, { resume: true });
  expect(resumed.status).toBe('abandoned');
  const rows = await f.refreshRows();
  expect(rows.map(r => r.state)).toEqual(['aborted']);
  await expectDecided(f, ids);
}), 180_000);

test('GST-1853: when the owner scan aborts the killed refresh, the next refresh run decides its held writes even though the checkout diverged', () => each(async f => {
  const ids = await killedAtFenced(f);
  await resumeWorktreeRefreshes(f.engine);
  const rows = await f.refreshRows();
  expect(rows.map(r => r.state)).toEqual(['aborted']);
  await expect(refreshWorktree(f.engine, f.alpha)).rejects.toMatchObject({ code: 'refresh_diverged' });
  await expectDecided(f, ids);
}), 180_000);

/** The killed refresh aborted by the owner scan, its held writes still pending and the checkout diverged. */
async function abortedByScan(f: RefreshFixture): Promise<void> {
  await killedAtFenced(f);
  await resumeWorktreeRefreshes(f.engine);
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['aborted']);
}

test('GST-1853: a refresh run that already synced the members runs no second owed sync and lists each member once', () => each(async f => {
  await abortedByScan(f);
  git(f.root, 'push', '-q', '-f', 'origin', 'HEAD:main');
  const result = await refreshWorktree(f.engine, f.alpha, { syncBudgetMs: 0 });
  expect(result.status).toBe('sync_deferred');
  expect(result.synced.map(member => member.source_id).sort()).toEqual([f.alpha, f.beta].sort());
}), 180_000);

test('GST-1853: a member the owed sync leaves behind HEAD is named with its resume command, on success and on refusal', () => each(async f => {
  await abortedByScan(f);
  const resume = `gbrain sync --source ${f.alpha} --no-pull`;
  const refused = await refreshWorktree(f.engine, f.alpha, { syncBudgetMs: 0 }).then(() => null, thrown => thrown as { code?: string; message: string });
  expect(refused?.code).toBe('refresh_diverged');
  expect(refused?.message).toContain(resume);
  const resumed = await refreshWorktree(f.engine, f.alpha, { resume: true, syncBudgetMs: 0 });
  expect(resumed.synced.map(member => member.source_id)).toContain(f.alpha);
  expect(['sync_blocked', 'sync_deferred']).toContain(resumed.status);
  expect(resumed.next ?? '').toContain(resume);
}), 180_000);

test('GST-1853: a refusal of the run\'s own arguments runs no owed sync', () => each(async f => {
  await abortedByScan(f);
  const before = await f.lastCommit(f.alpha);
  const refused = await refreshWorktree(f.engine, f.alpha, { waitDrainMs: -1 }).then(() => null, thrown => thrown as { code?: string; message: string });
  expect(refused?.code).toBe('invalid_params');
  expect(refused?.message).not.toContain('ended without completing');
  expect(await f.lastCommit(f.alpha)).toBe(before);
}), 180_000);

test('GST-1853: an owed sync that fails is logged with connection details redacted, and the refusal still stands', () => each(async f => {
  await abortedByScan(f);
  const secret = 'pw-example-not-real';
  const executeRaw = f.engine.executeRaw;
  const logged: string[] = [];
  const error = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  (f.engine as { executeRaw: unknown }).executeRaw = function (this: BrainEngine, sql: string, ...rest: unknown[]) {
    return sql.startsWith('SELECT state,source_ids FROM persistence_worktree_refreshes')
      ? Promise.reject(new Error(`connect failed: postgresql://owner:${secret}@db.example.invalid:5432/brain`)) : executeRaw.call(this, sql, ...(rest as [never]));
  };
  try {
    await expect(refreshWorktree(f.engine, f.alpha)).rejects.toMatchObject({ code: 'refresh_diverged' });
  } finally {
    delete (f.engine as { executeRaw?: unknown }).executeRaw;
    error.mockRestore();
  }
  const owed = logged.filter(line => line.includes('the sync owed after an unfinished refresh'));
  expect(owed).toHaveLength(1);
  expect(owed[0]).not.toContain(secret);
}), 180_000);
