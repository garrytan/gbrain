/**
 * #8072: a scheduled `gbrain sources refresh` tick on files over the 24 MiB page ceiling.
 *
 * 1. Protects: a Markdown file the streamed (segmented) preparation already read and refused is held `file_too_large`
 *    and stays held, unread, on later ticks while its bytes are unchanged: no new write request for it, no pass-2
 *    block read, the hold's attempt count unchanged. `gbrain sources retry-held` (and a gbrain upgrade) still
 *    re-screens it; a hold decided from the size alone keeps re-screening every sync (one lstat).
 *    The member syncs of one refresh are bounded by `sources.refresh_sync_budget_ms`, each member with an equal share of
 *    what is left: past it the refresh reports `sync_deferred` and still completes, so writes are admitted while the
 *    members catch up. A member whose sync commits nothing in its share (its write is never claimed: the
 *    `consumer:claiming` fault point holds the consumer; or its pass hangs at `sync:after_freeze`) is reported
 *    `refresh_sync_timeout` and the next member still syncs in the same run; the refresh completes and its lock is
 *    free, with hundreds of preserved uncommitted paths in the checkout.
 * 2. Fails when: every tick re-hashes and re-streams the unchanged held file (the hold re-screened on every sync), or a
 *    refresh tick keeps syncing past its budget under the refresh lock (on master the stalled refresh re-entered bare
 *    passes for about 300 s and did not return within the test's timeout), a deferred member leaves the row `syncing`
 *    (every other write refused `worktree_refreshing`), or a stalled first member spends the whole budget.
 * Counts, not wall-clock time: write requests, `streamedImportWork` bytes and the hold's attempts; the one time
 * assertion is the stalled refresh's upper bound (budget + the drain's deadline grace + 30 s of slack).
 * Repo-less brains have no managed sync or refresh (both need Git), so nothing here runs there.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { streamedImportWork } from '../src/core/page-body/streamed-import.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { holdRescreenDue, readGitSourceHolds, type GitHoldRecord } from '../src/core/persistence/sync-holds.ts';
import { refreshLiveness, refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { DEADLINE_PASS_GRACE_MS } from '../src/core/persistence/sync-drain.ts';
import { retryHeld } from '../src/commands/sources-retry-held.ts';
import { printRefreshOutcome } from '../src/commands/sources-refresh.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { VERSION } from '../src/version.ts';
import { conversationPage } from './helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const keyless = { OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, GEMINI_API_KEY: undefined, GBRAIN_REFRESH_SYNC_BUDGET_MS: undefined };

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});

/** Hundreds of uncommitted paths outside the incoming diff, like the checkout that hit the hang; and a short budget for the stalled sync. */
const PRESERVED = 300, STALL_BUDGET_MS = 20_000, FAIR_BUDGET_MS = 20_000;
const each = (fn: (f: RefreshFixture) => Promise<void>) => withEnv(keyless, async () => { for (const engine of engines) await withRefreshFixture(engine, fn); });
/** Over the page ceiling, under the segmented ceiling, with a facts fence the streamed import refuses after reading the whole file. */
const fenced = `${conversationPage(PAGE_MAX_BYTES + 1024 * 1024, { seed: 8072 }).trimEnd()}\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | Example fact | fact | 1.0 | world | high | | | test | |\n<!--- gbrain:facts:end -->\n`;

const holdsOf = async (f: RefreshFixture) => (await readGitSourceHolds(f.engine, { sourceIds: [f.alpha] }))[0]?.holds ?? [];
const requestsFor = async (f: RefreshFixture, slug: string) => Number((await f.engine.executeRaw<{ n: number }>(
  'SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND slug=$2', [f.alpha, slug]))[0]!.n);

test('#8072: a held over-ceiling file the streamed import refused is not read again by later refresh ticks', () => each(async f => {
  await f.engine.setConfig('pages.segmented_storage', 'on');
  f.push('alpha/conv.md', fenced);
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  const [held] = await holdsOf(f);
  expect(held).toMatchObject({ path: 'conv.md', code: 'file_too_large', meta: { attempts: 1 } });
  expect(held!.message).toContain('facts and takes fences');
  const requests = await requestsFor(f, 'conv');
  expect(requests).toBeGreaterThan(0);

  for (const tick of [1, 2]) {
    const target = f.push(`alpha/note-${tick}.md`, page(`Note ${tick}`, 'An unrelated edit that makes the tick sync.'));
    streamedImportWork.bytes = 0;
    expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
    expect(await f.lastCommit(f.alpha)).toBe(target);
    expect(await f.engine.getPage(`note-${tick}`, { sourceId: f.alpha })).not.toBeNull();
    expect(streamedImportWork.bytes).toBe(0);
    expect(await requestsFor(f, 'conv')).toBe(requests);
    expect(await holdsOf(f)).toMatchObject([{ path: 'conv.md', code: 'file_too_large', meta: { attempts: 1, blob_oid: held!.meta.blob_oid } }]);
  }

  // The explicit operator step still re-screens it (and holds it again: the same bytes are refused the same way).
  expect((await retryHeld(f.engine, f.alpha)).scheduled).toBe(1);
  f.push('alpha/note-3.md', page('Note 3', 'Another unrelated edit.'));
  streamedImportWork.bytes = 0;
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  expect(streamedImportWork.bytes).toBeGreaterThan(0);
  expect(await requestsFor(f, 'conv')).toBe(requests + 1);
  expect(await holdsOf(f)).toMatchObject([{ path: 'conv.md', code: 'file_too_large', meta: { attempts: 2 } }]);

  // New bytes for the held file re-screen it on the next tick, with no retry.
  f.push('alpha/conv.md', fenced.replace('Example fact', 'An edited example fact'));
  streamedImportWork.bytes = 0;
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  expect(streamedImportWork.bytes).toBeGreaterThan(0);
  expect(await requestsFor(f, 'conv')).toBe(requests + 2);
  expect(await holdsOf(f)).toMatchObject([{ path: 'conv.md', code: 'file_too_large' }]);
}), 600_000);

test('#8072: a streamed file_too_large hold re-screens on retry or another gbrain version; a size-only one on every sync', () => {
  const hold = (meta: Partial<GitHoldRecord['meta']>) => ({ code: 'file_too_large' as const, meta: { recovery_version: 99, blob_oid: 'a'.repeat(40), ...meta } as GitHoldRecord['meta'] });
  expect(holdRescreenDue(hold({ streamed: { gbrain_version: VERSION } }), false)).toBe(false);
  expect(holdRescreenDue(hold({ streamed: { gbrain_version: VERSION } }), true)).toBe(true);
  expect(holdRescreenDue(hold({ streamed: { gbrain_version: '0.0.1.0' } }), false)).toBe(true);
  expect(holdRescreenDue(hold({}), false)).toBe(true);
});

test('#8072: a refresh past its sync budget completes with its members deferred, admits writes, and reports a deferred member honestly', () => each(async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'An upstream observation.'));
  await f.engine.setConfig('sources.refresh_sync_budget_ms', '0');
  const deferred = await refreshWorktree(f.engine, f.alpha);
  expect(deferred).toMatchObject({ status: 'sync_deferred', target_head: target, next: `gbrain sources refresh ${f.alpha}` });
  expect(deferred.synced.map(member => member.status)).toEqual(['deferred', 'deferred']);
  expect(f.head()).toBe(target);
  expect(await f.lastCommit(f.alpha)).not.toBe(target);
  expect((await f.refreshRows()).map(row => row.state)).toEqual(['completed']);
  // Cron and wrappers read the exit code: a deferred refresh is not a clean 0.
  const log = console.log;
  console.log = () => {};
  try { printRefreshOutcome({ result: deferred }, true); expect(currentExitCode()).toBe(1); } finally { console.log = log; _resetCliExitVerdictForTests(); process.exitCode = 0; }

  const again = await refreshWorktree(f.engine, f.alpha);
  expect(again).toMatchObject({ status: 'sync_deferred', next: `gbrain sources refresh ${f.alpha}` });
  expect(again.synced.map(member => member.status)).toEqual(['deferred', 'deferred']);

  expect((await f.put(f.alpha, 'notes/during-catch-up', page('During', 'A write while the member catches up.'))).state ?? 'committed').toBe('committed');
  await f.engine.setConfig('sources.refresh_sync_budget_ms', '600000');
  for (const source of [f.alpha, f.beta]) await performManagedSync(f.engine, { sourceId: source, noPull: true, noEmbed: true });
  expect(await f.lastCommit(f.alpha)).toBe(f.head());
  expect(await f.lastCommit(f.beta)).toBe(f.head());
}), 300_000);

test('#8072: a member whose sync never settles does not starve the next member of the same refresh', () => each(async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'An upstream observation.'));
  await f.engine.setConfig('sources.refresh_sync_budget_ms', String(FAIR_BUDGET_MS));
  let stalls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  installFaultHook(async (point, detail) => { if (point === 'sync:after_freeze' && detail.sourceId === f.alpha) { stalls++; await gate; } });
  try {
    const result = await refreshWorktree(f.engine, f.alpha);
    expect(stalls).toBeGreaterThan(0);
    expect(result.sync_blocked?.map(entry => [entry.source_id, entry.code])).toEqual([[f.alpha, 'refresh_sync_timeout']]);
    expect(result.synced.find(member => member.source_id === f.beta)).toMatchObject({ last_commit: target });
    expect(await f.lastCommit(f.beta)).toBe(target);
    expect(await f.lastCommit(f.alpha)).not.toBe(target);
    expect((await f.refreshRows()).map(row => row.state)).toEqual(['completed']);
  } finally { installFaultHook(undefined); release(); }
}), 300_000);

test('#8072: a refresh whose member sync never settles ends refresh_sync_timeout within its budget, completes and releases the refresh lock', () => each(async f => {
  for (let i = 0; i < PRESERVED; i++) writeFileSync(join(f.root, i % 2 ? 'alpha' : 'beta', `local-${i}.md`), page(`Local ${i}`, 'An uncommitted local note.'));
  const target = f.push('alpha/two.md', page('Alpha two', 'An upstream observation.'));
  await f.engine.setConfig('sources.refresh_sync_budget_ms', String(STALL_BUDGET_MS));
  let stalls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  installFaultHook(async point => { if (point === 'consumer:claiming') { stalls++; await gate; } });
  try {
    const started = performance.now();
    const stalled = await refreshWorktree(f.engine, f.alpha);
    // gstack-timing-ok: ending within refresh_sync_budget_ms is the #8072 contract; the bound carries 30 s of grace
    expect(performance.now() - started).toBeLessThan(STALL_BUDGET_MS + DEADLINE_PASS_GRACE_MS + 30_000);
    expect(stalls).toBeGreaterThan(0);
    expect(stalled).toMatchObject({ status: 'sync_blocked', target_head: target });
    expect(stalled.preserved_uncommitted).toHaveLength(PRESERVED);
    expect(stalled.sync_blocked?.[0]).toMatchObject({ source_id: f.alpha, code: 'refresh_sync_timeout', resume: `gbrain sync --source ${f.alpha} --no-pull` });
    expect(stalled.sync_blocked?.[0]?.message).toContain('is queued');
    expect(f.head()).toBe(target);
    expect(await f.lastCommit(f.alpha)).not.toBe(target);
    expect((await f.refreshRows()).map(row => row.state)).toEqual(['completed']);
    expect(await refreshLiveness(f.worktreeId, localHostId())).toBe('orphaned');
  } finally { installFaultHook(undefined); release(); }

  await f.engine.setConfig('sources.refresh_sync_budget_ms', '600000');
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('already_current');
  expect(await f.lastCommit(f.alpha)).toBe(target);
  expect(await f.lastCommit(f.beta)).toBe(target);
}), 300_000);
