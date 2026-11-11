/**
 * GST-1465, GST-1472, GST-1477: the refresh-recovery follow-ups from the GST-1457 reviews (#8661).
 *
 * Protects: "git is the parent" on every manual way out of an interrupted `gbrain sources refresh`. `--abandon` never lifts the fence
 * while a member's database is past the start commit, whether its `last_commit` moved or a sliced pass imported part of the target
 * (GST-1465 #1), or while a sync pass that pinned the target still holds a member's drain lease (GST-1465 #2). Every way out a refusal
 * or writer status names actually finishes the refresh, or the refusal names its own distinct reason: a HEAD past the target (GST-1472
 * #1), members synced to diverged lines (#2), a member commit git cannot place (#3), writer status read off the owner host (GST-1477 #1),
 * and an operator who reset the checkout on purpose to reject an upstream change (GST-1477 #2: revert on top of the target, then --resume).
 * Seams: the refresh's `hooks.boundary` crash, the real managed sync (a slice for #1, a fault hook pausing a pass after its level read for
 * #2), HEAD moved by hand; member commits set with the coordinated write only where a test says so.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { tryAcquireNativeLock } from '../src/core/persistence/native-lock.ts';
import { refreshLockPath, refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
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
  installFaultHook(undefined);
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});

type Refusal = { code?: string; message?: string; suggestion?: string; fix?: Record<string, any> };
const each = async (fn: (f: RefreshFixture) => Promise<void>) => { for (const engine of engines) await withRefreshFixture(engine, fn); };
const settle = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: null as Refusal | null }), error => ({ value: null as T | null, error: error as Refusal }));
const refused = async (promise: Promise<unknown>, code: string): Promise<Refusal> => {
  const { error } = await settle(promise);
  expect(error, `expected refusal ${code}`).not.toBeNull();
  expect(error!.code).toBe(code);
  return error!;
};
const sync = (f: RefreshFixture, sourceId: string) => performManagedSync(f.engine, { sourceId, noPull: true, noEmbed: true });
const livePages = async (f: RefreshFixture, sourceId: string) => (await f.engine.executeRaw<{ slug: string }>(
  'SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [sourceId])).map(row => row.slug);
const states = async (f: RefreshFixture) => (await f.refreshRows()).map(row => row.state);
const setLastCommit = (f: RefreshFixture, member: string, sha: string) => f.engine.transaction(tx => withCoordinatedWrite(tx, [member],
  () => tx.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [member, sha]), TEST_WRITE_ATTRIBUTION));
const writerStatusRow = async (f: RefreshFixture) => (await runPersistenceAdministration(f.engine, 'writer_status', { source_id: f.alpha }) as
  { worktree_refreshes: Array<Record<string, any>> }).worktree_refreshes[0];
/** A refresh killed at `point`, its row left in `state` with the consumer stopped, so only the manual path recovers it. */
async function orphanAt(f: RefreshFixture, point: 'fenced' | 'merged' | 'syncing', state: string) {
  await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: at => { if (at === point) throw new Error(`simulated crash at ${at}`); } } }))
    .rejects.toThrow('simulated crash');
  await disposePersistenceConsumer(f.engine);
  const [orphan] = await f.refreshRows();
  await f.engine.executeRaw('UPDATE persistence_worktree_refreshes SET state=$2,completed_at=NULL WHERE id=$1::uuid', [orphan.id, state]);
  return orphan;
}

test('GST-1465 #1: a member a sliced sync carried partly into the target, still at the start commit, keeps --abandon from lifting the fence', () => each(async f => {
  // Value: protects=the database never ends ahead of git after --abandon: a member whose pass imported pages of the target but stopped before
  // its stamp (last_commit still old_head) counts as past the start commit, so --resume names the fast-forward, --abandon refuses, and that
  // way out completes with every page at HEAD; fails_when=the member check reads last_commit alone, so --abandon lifts the fence and the
  // imported pages stay live with no file at HEAD; why_new=GBRA-323's probe; 7r-7t move last_commit; seam=performManagedSync's slice (one page);
  // no_claim=a slice that deleted pages (the same request check).
  f.push('alpha/two.md', page('Alpha two', 'Upstream two.'));
  f.push('alpha/three.md', page('Alpha three', 'Upstream three.'));
  const target = f.push('alpha/four.md', page('Alpha four', 'Upstream four.'));
  const old = f.head();
  const before = await livePages(f, f.alpha);
  const orphan = await orphanAt(f, 'syncing', 'syncing');
  const sliced = await performManagedSync(f.engine, { sourceId: f.alpha, noPull: true, noEmbed: true }, { maxPages: 1, maxMs: 60_000 });
  expect(sliced.status).toBe('partial');
  expect(await f.lastCommit(f.alpha)).toBe(old);
  const partial = await livePages(f, f.alpha);
  expect(partial.length).toBe(before.length + 1);
  git(f.root, 'reset', '-q', '--hard', old);
  const resume = await refused(refreshWorktree(f.engine, f.alpha, { resume: true }), 'refresh_recovery_required');
  expect(resume.suggestion).not.toContain('--abandon');
  expect(resume.fix).toMatchObject({ ask_user: true, argv: ['git', '-C', f.root, 'merge', '--ff-only', target] });
  expect((await writerStatusRow(f)).fix.argv).not.toContain('--abandon');
  const abandon = await refused(refreshWorktree(f.engine, f.alpha, { abandon: true }), 'refresh_recovery_required');
  expect(abandon.message).toContain(f.alpha);
  await refused(sync(f, f.alpha), 'refresh_recovery_required');
  expect(await livePages(f, f.alpha)).toEqual(partial);
  expect(await states(f)).toEqual(['recovery_required']);
  git(f.root, 'merge', '-q', '--ff-only', target);
  expect(await refreshWorktree(f.engine, f.alpha, { resume: true })).toMatchObject({ refresh_id: orphan.id, status: 'completed' });
  expect(await f.lastCommit(f.alpha)).toBe(target);
  expect(await livePages(f, f.alpha)).toEqual(['four', 'one', 'three', 'two']);
}), 180_000);

test('GST-1465 #2: --abandon refuses while a pass that pinned the target holds a member\'s drain lease, so it never publishes after the fence lifts', () => each(async f => {
  // Value: protects=the member check and the abort run under every member's drain lease: a cycle pass that read HEAD at the target while the
  // row was syncing, still in flight when HEAD is reset and --resume/--abandon run, makes --abandon refuse sync_drain_lease_held instead of
  // lifting the fence under it; once it finishes, the check sees what it published and names the fast-forward; fails_when=--abandon reads
  // last_commit and aborts without the leases, so the pass stamps last_commit=target over HEAD=old_head; why_new=GST-1465 #2 was theoretical;
  // seam=a fault hook pausing the real pass after its level read; no_claim=a holder that stopped renewing (the lease takeover fences it).
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream two.'));
  const old = f.head();
  const before = await livePages(f, f.alpha);
  const orphan = await orphanAt(f, 'syncing', 'syncing');
  let reached!: () => void, release!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  installFaultHook(async (point, detail) => {
    if (point !== 'sync:level_read' || detail.sourceId !== f.alpha) return;
    installFaultHook(undefined);
    reached();
    await gate;
  });
  let pass: Promise<unknown> | undefined;
  try {
    pass = settle(sync(f, f.alpha));
    await paused;
    git(f.root, 'reset', '-q', '--hard', old);
    await refused(refreshWorktree(f.engine, f.alpha, { resume: true }), 'refresh_recovery_required');
    const held = await refused(refreshWorktree(f.engine, f.alpha, { abandon: true }), 'sync_drain_lease_held');
    expect(held.message).toContain(f.alpha);
    expect(held.suggestion).toContain(`gbrain sources refresh ${f.alpha} --abandon`);
    expect(await states(f)).toEqual(['recovery_required']);
  } finally { installFaultHook(undefined); release(); await pass; }
  const after = await settle(refreshWorktree(f.engine, f.alpha, { abandon: true }));
  if (after.error) {
    expect(after.error.code).toBe('refresh_recovery_required');
    git(f.root, 'merge', '-q', '--ff-only', target);
    expect(await refreshWorktree(f.engine, f.alpha, { resume: true })).toMatchObject({ refresh_id: orphan.id, status: 'completed' });
    expect(await livePages(f, f.alpha)).toEqual(['one', 'two']);
  } else {
    expect(after.value).toMatchObject({ status: 'abandoned' });
    expect(await f.lastCommit(f.alpha)).toBe(old);
    expect(await livePages(f, f.alpha)).toEqual(before);
  }
}), 180_000);

for (const state of ['fenced', 'merged'] as const) {
  test(`GST-1472 #1: a ${state} orphan whose HEAD descends from the target finishes on the first --resume, and --abandon names --resume`, () => each(async f => {
    // Value: protects=a HEAD past the target is accepted for fenced and merged rows (after the member check), so one --resume completes and
    // --abandon refuses refresh_in_progress naming --resume without moving the row to recovery_required or naming a reset; fails_when=either
    // path marks the row recovery_required first, so the first --resume (or --abandon) names a fast-forward and a hard-reset fallback the
    // operator does not need; why_new=7v covers recovery_required rows only; seam=a crash at merged, a local commit on top of the target;
    // no_claim=a member synced off HEAD's line (7w, 7x).
    const target = f.push('alpha/two.md', page('Alpha two', 'Upstream two.'));
    const orphan = await orphanAt(f, 'merged', state);
    expect(f.head()).toBe(target);
    const past = commitFile(f.root, 'alpha/three.md', page('Alpha three', 'A local commit on top of the target.'));
    const abandon = await refused(refreshWorktree(f.engine, f.alpha, { abandon: true }), 'refresh_in_progress');
    expect(abandon.suggestion).toContain(`gbrain sources refresh ${f.alpha} --resume`);
    expect(abandon.suggestion).not.toContain('reset --hard');
    expect(await states(f)).toEqual([state]);
    expect(await refreshWorktree(f.engine, f.alpha, { resume: true })).toMatchObject({ refresh_id: orphan.id, status: 'completed' });
    expect(f.head()).toBe(past);
    expect(await f.lastCommit(f.alpha)).toBe(past);
  }), 180_000);
}

test('GST-1472 #2: members synced to diverged lines refuse with the divergence named, and the named merge then --resume finishes', () => each(async f => {
  // Value: protects=when member commits do not form one line, the refusal and writer status name each diverged commit and ask the user to
  // merge them (git merge keeps both members' pages), never the target-only fast-forward --resume would refuse again; that merge then
  // --resume completes with every synced page live; fails_when=keepPagesHead falls back to target_head, so every named way out loops back to
  // the fenced row; why_new=7x has one member on a sibling line of the HEAD it tries, not two diverged members; seam=two local commits on top of
  // the target, each synced by the real managed sync while the test holds the refresh lock (so the owner scan leaves the row syncing);
  // no_claim=a merge that conflicts (git stops with the conflicts in the checkout), or the owner scan completing such a row (rewritten history).
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream two.'));
  const old = f.head();
  const orphan = await orphanAt(f, 'syncing', 'syncing');
  const betaLine = commitFile(f.root, 'beta/two.md', page('Beta two', 'Synced on one line past the target.'));
  await sync(f, f.beta);
  git(f.root, 'reset', '-q', '--hard', target);
  const alphaLine = commitFile(f.root, 'alpha/three.md', page('Alpha three', 'Synced on another line past the target.'));
  const lock = (await tryAcquireNativeLock(refreshLockPath(f.worktreeId)))!;
  try { await sync(f, f.alpha); await disposePersistenceConsumer(f.engine); } finally { await lock.release(); }
  expect(await states(f)).toEqual(['syncing']);
  expect([await f.lastCommit(f.alpha), await f.lastCommit(f.beta)]).toEqual([alphaLine, betaLine]);
  const pages = [await livePages(f, f.alpha), await livePages(f, f.beta)];
  git(f.root, 'reset', '-q', '--hard', old);
  const resume = await refused(refreshWorktree(f.engine, f.alpha, { resume: true }), 'refresh_recovery_required');
  for (const text of [resume.message!, resume.suggestion!]) { expect(text).toContain(alphaLine); expect(text).toContain(betaLine); }
  expect(resume.fix).toMatchObject({ ask_user: true, then: { argv: ['gbrain', 'sources', 'refresh', f.alpha, '--resume'] } });
  expect(resume.fix!.argv).not.toEqual(['git', '-C', f.root, 'merge', '--ff-only', target]);
  expect(resume.fix!.user_message).toContain(alphaLine);
  const status = await writerStatusRow(f);
  expect(status.fix.why).toContain(betaLine);
  expect(status.fix.why).not.toContain(`fast-forward the checkout to ${target}`);
  await refused(refreshWorktree(f.engine, f.alpha, { abandon: true }), 'refresh_recovery_required');
  git(f.root, ...resume.fix!.argv.slice(3));
  expect(await refreshWorktree(f.engine, f.alpha, { resume: true })).toMatchObject({ refresh_id: orphan.id, status: 'completed' });
  for (const member of [f.alpha, f.beta]) await sync(f, member);
  expect([await livePages(f, f.alpha), await livePages(f, f.beta)]).toEqual(pages);
}), 180_000);

test('GST-1472 #3: a member commit git cannot place refuses with that reason, never a fast-forward --resume would refuse again; fetching it unblocks the way out', () => each(async f => {
  // Value: protects=membersPastStart, keepPagesHead and the resume guard read git's answer the same way (exit 1 is "not an ancestor", any
  // other failure is "cannot place"), so a member commit missing from the checkout gets its own refusal naming the commit and a fetch, and
  // once git has it the usual fast-forward way out completes; fails_when=keepPagesHead treats the failure as "not ahead" and names the
  // target, so the fast-forward then --resume loops on the same row; why_new=7t checks only that --abandon refuses it; seam=a member
  // last_commit on a commit the managed checkout never fetched (pushed to another upstream branch); no_claim=a pruned object gone for good.
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream two.'));
  const old = f.head();
  const orphan = await orphanAt(f, 'syncing', 'syncing');
  await sync(f, f.alpha);
  const elsewhere = commitFile(f.upstream, 'beta/two.md', page('Beta two', 'Synced from a commit this checkout never fetched.'));
  git(f.upstream, 'push', '-q', 'origin', `${elsewhere}:refs/heads/side`);
  git(f.upstream, 'reset', '-q', '--hard', target);
  await setLastCommit(f, f.beta, elsewhere);
  git(f.root, 'reset', '-q', '--hard', old);
  for (const step of ['--resume at the start commit', '--resume at the target']) {
    if (step.endsWith('target')) git(f.root, 'merge', '-q', '--ff-only', target);
    const unplaced = await refused(refreshWorktree(f.engine, f.alpha, { resume: true }), 'refresh_recovery_required');
    expect(unplaced.message, step).toContain(elsewhere);
    expect(unplaced.message, step).toContain('cannot place');
    expect(unplaced.fix, step).toMatchObject({ argv: ['git', '-C', f.root, 'fetch', '--all', '--no-tags', '--quiet'], then: { argv: ['gbrain', 'sources', 'refresh', f.alpha, '--resume'] } });
    expect((await writerStatusRow(f)).fix.why, step).toContain(elsewhere);
    expect((await writerStatusRow(f)).fix.why, step).not.toContain('finishes it once HEAD is');
  }
  git(f.root, ...['fetch', '--all', '--no-tags', '--quiet']);
  const named = await refused(refreshWorktree(f.engine, f.alpha, { resume: true }), 'refresh_recovery_required');
  expect(named.fix).toMatchObject({ argv: ['git', '-C', f.root, 'merge', '--ff-only', elsewhere] });
  git(f.root, 'merge', '-q', '--ff-only', elsewhere);
  expect(await refreshWorktree(f.engine, f.alpha, { resume: true })).toMatchObject({ refresh_id: orphan.id, status: 'completed' });
}), 180_000);

test('GST-1477 #1: writer status read off the owner host says the member check needs the owner host instead of reporting members as past', () => each(async f => {
  // Value: protects=without the owner's checkout, refreshHolderReport does not guess member ancestry (a member merely behind the start commit
  // read as past), so its fix sends the operator to writer status on the owner host, which names --abandon there; fails_when=membersPastStart
  // counts every member whose last_commit is not old_head as past when it has no checkout; why_new=7t reads status on the owner host; seam=the
  // recorded holder host set to another host id; no_claim=a real second host.
  f.push('alpha/two.md', page('Alpha two', 'Upstream two.'));
  const old = f.head();
  const orphan = await orphanAt(f, 'merged', 'recovery_required');
  await setLastCommit(f, f.alpha, git(f.root, 'rev-parse', `${old}~1`));
  git(f.root, 'reset', '-q', '--hard', old);
  const elsewhere = randomUUID();
  await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET outcome=jsonb_set(outcome,'{holder,host_id}',to_jsonb($2::text)) WHERE id=$1::uuid`, [orphan.id, elsewhere]);
  const remote = await writerStatusRow(f);
  expect(remote).toMatchObject({ liveness: 'unknown', auto_recovery: 'none', fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', f.alpha, '--json'], actor: 'host_admin' } });
  expect(remote.fix.why).toContain('owner host');
  expect(remote.fix.why).toContain(elsewhere);
  expect(remote.fix.why).not.toContain('already synced past');
  await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET outcome=jsonb_set(outcome,'{holder,host_id}','null'::jsonb) WHERE id=$1::uuid`, [orphan.id]);
  expect(await writerStatusRow(f)).toMatchObject({ fix: { argv: ['gbrain', 'sources', 'refresh', f.alpha, '--abandon'] } });
  expect((await refreshWorktree(f.engine, f.alpha, { abandon: true })).status).toBe('abandoned');
}), 180_000);

test('GST-1477 #2: an operator who reset to the start commit on purpose is named the revert route, and revert on top of the target then --resume removes those pages through history', () => each(async f => {
  // Value: protects=the members-synced refusal names the deliberate-rollback route (fast-forward, git revert the unwanted commits, --resume)
  // beside the fast-forward, with no consent-free override, and that route keeps git the parent: the refresh completes and the next sync
  // soft-deletes the reverted page because history removed it; fails_when=the only route named is the fast-forward the operator rejected;
  // why_new=7r follows the fast-forward only; seam=the member synced by the real managed sync, HEAD reset by hand; no_claim=a revert that conflicts.
  const target = f.push('alpha/two.md', page('Alpha two', 'An upstream change the operator rejects.'));
  const old = f.head();
  const orphan = await orphanAt(f, 'syncing', 'syncing');
  await sync(f, f.alpha);
  expect(await livePages(f, f.alpha)).toEqual(['one', 'two']);
  git(f.root, 'reset', '-q', '--hard', old);
  const resume = await refused(refreshWorktree(f.engine, f.alpha, { resume: true }), 'refresh_recovery_required');
  const abandon = await refused(refreshWorktree(f.engine, f.alpha, { abandon: true }), 'refresh_recovery_required');
  for (const refusal of [resume, abandon]) {
    expect(refusal.suggestion).toContain(`git -C ${f.root} revert`);
    expect(refusal.fix!.user_message).toContain('git revert');
    expect(refusal.fix!.argv).toEqual(['git', '-C', f.root, 'merge', '--ff-only', target]);
  }
  git(f.root, 'merge', '-q', '--ff-only', target);
  git(f.root, 'revert', '--no-edit', target);
  const reverted = f.head();
  expect(await refreshWorktree(f.engine, f.alpha, { resume: true })).toMatchObject({ refresh_id: orphan.id, status: 'completed' });
  await sync(f, f.alpha);
  expect(await f.lastCommit(f.alpha)).toBe(reverted);
  expect(await livePages(f, f.alpha)).toEqual(['one']);
}), 180_000);
