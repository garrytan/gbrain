/**
 * F0 `gbrain sources refresh` (spec section 1.8; tests 1 and 3-13, test 2 is
 * persistence-worktree-refresh-restart.test.ts).
 *
 * Protects: a managed checkout shared by several sources is fast-forwarded only
 * after every accepted write to it drained, never under a moving HEAD, and the
 * refresh converges or refuses with a typed, filled fix.
 * Regression it catches: admission, claiming or the consumer's idle probe
 * ignoring the refresh fence (a write publishing onto a checkout whose HEAD is
 * moving, or a fenced effect waking the consumer every poll), a per-source fence,
 * a refresh that merges dirty or diverged checkouts, a refresh that leaves the
 * fence up after a refusal, or topology changes racing a refresh.
 * Existing coverage: none; managed sync refused to pull and lane B only
 * reported the stale upstream.
 * Seams: the `hooks.boundary` callback pauses the real state machine at its
 * drained, fenced and merged points; no production behavior is replaced.
 */
import { afterAll, beforeAll, expect, setSystemTime, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { parseRefreshArgs, runSourcesRefresh } from '../src/commands/sources-refresh.ts';
import { claimCoalescedGitEffects, claimPersistenceEffect } from '../src/core/persistence/effect-journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { tryAcquireNativeLock } from '../src/core/persistence/native-lock.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { refreshLockPath, refreshWorktree, resumeWorktreeRefreshes } from '../src/core/persistence/worktree-refresh.ts';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { gitConvergenceCheck } from '../src/commands/doctor/checks/git-convergence.ts';
import { MANAGED_SYNC_PASS_OP, writePassRow, type ManagedSyncPassValue } from '../src/core/persistence/sync-pass-row.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
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

const each = async (fn: (f: RefreshFixture) => Promise<void>) => { for (const engine of engines) await withRefreshFixture(engine, fn); };
const refusedWith = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(() => null, e => e as { code?: string; suggestion?: string; message?: string; docs?: string });
  expect(error, `expected refusal ${code}`).not.toBeNull();
  expect(error!.code).toBe(code);
  return error!;
};
test('refresh timer bounds reject overflow and accept the maximum delay', () => each(async f => {
  await refusedWith(refreshWorktree(f.engine, f.alpha, { fetchTimeoutMs: 2 ** 31 }), 'invalid_params');
  const drain = parseRefreshArgs([f.alpha, '--wait-drain', String((2 ** 31) / 1000), '--dry-run']).options;
  expect(drain.waitDrainMs).toBeGreaterThan(2 ** 31 - 1); // the drain wait is a performance.now() deadline, not a timer: still accepted
  expect((await refreshWorktree(f.engine, f.alpha, drain)).status).toBe('dry_run');
  expect((await refreshWorktree(f.engine, f.alpha, { fetchTimeoutMs: 2 ** 31 - 1, dryRun: true })).status).toBe('dry_run');
}));
test('GBRA-133: another HOME refuses refresh_not_owner naming the identity file and HOME it read, and mints no identity', () => each(async f => {
  const other = mkdtempSync(join(tmpdir(), 'gbrain-refresh-other-home-'));
  try {
    const identity = join(other, '.gbrain', 'persistence', 'host.json');
    await withEnv({ GBRAIN_HOME: other, HOME: other }, async () => {
      const missing = await refusedWith(refreshWorktree(f.engine, f.alpha, { dryRun: true }), 'refresh_not_owner');
      expect(missing.message).toContain(`no host identity at ${identity} (none was created)`);
      expect(missing.message).toContain(`HOME=${other} and GBRAIN_HOME=${other}`);
      expect(existsSync(identity)).toBe(false);
      mkdirSync(join(other, '.gbrain', 'persistence'), { recursive: true });
      const foreign = randomUUID();
      writeFileSync(identity, JSON.stringify({ version: 1, id: foreign }));
      const mismatch = await refusedWith(refreshWorktree(f.engine, f.alpha, { dryRun: true }), 'refresh_not_owner');
      expect(mismatch.message).toContain(`this process has host identity ${foreign} from ${identity}`);
    });
    expect((await refreshWorktree(f.engine, f.alpha, { dryRun: true })).status).toBe('dry_run');
  } finally { rmSync(other, { recursive: true, force: true }); }
}));
/** Requeue a committed git effect so the drain must wait for the consumer to process it again. */
async function requeueGitEffect(f: RefreshFixture, delayMs: number): Promise<number> {
  const [effect] = await f.engine.executeRaw<{ id: number }>(`SELECT id FROM persistence_effects WHERE worktree_id=$1::uuid AND kind='git' ORDER BY id DESC LIMIT 1`, [f.worktreeId]);
  expect(effect).toBeDefined();
  await f.engine.executeRaw(`UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,
    next_attempt_at=now()+($2::double precision*interval '1 millisecond') WHERE id=$1`, [effect.id, delayMs]);
  return Number(effect.id);
}

test('1. O-ENG-9: writes and syncs to every member are refused while draining, then the same request ids succeed', () => each(async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'An upstream observation about narwhals.'));
  const before = await f.requestCount();
  const ids = { alpha: randomUUID(), beta: randomUUID() };
  const result = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => {
    if (point !== 'drained') return;
    await refusedWith(f.put(f.alpha, 'notes/during-alpha', page('During', 'alpha body'), ids.alpha), 'worktree_refreshing');
    const beta = await refusedWith(f.put(f.beta, 'notes/during-beta', page('During', 'beta body'), ids.beta), 'worktree_refreshing');
    expect(beta.suggestion).toContain(`gbrain sources writer status ${f.beta}`);
    expect(beta.docs).toBe('docs/guides/write-refusals.md#worktree_refreshing');
    await refusedWith(performManagedSync(f.engine, { sourceId: f.beta, noPull: true, noEmbed: true }), 'worktree_refreshing');
    expect(await f.requestCount()).toBe(before);
    const status = await runPersistenceAdministration(f.engine, 'writer_status', { source_id: f.beta }) as { worktree_refreshes: Array<Record<string, unknown>> };
    expect(status.worktree_refreshes).toMatchObject([{ state: 'draining', source_ids: [f.alpha, f.beta].sort(), target_head: target }]);
  } } });
  expect(result).toMatchObject({ status: 'completed', target_head: target, source_ids: [f.alpha, f.beta].sort() });
  expect(await f.lastCommit(f.alpha)).toBe(target);
  expect(await f.lastCommit(f.beta)).toBe(target);
  expect(f.head()).toBe(target);
  expect((await f.put(f.alpha, 'notes/during-alpha', page('During', 'alpha body'), ids.alpha)).state ?? 'committed').toBe('committed');
  expect((await f.put(f.beta, 'notes/during-beta', page('During', 'beta body'), ids.beta)).state ?? 'committed').toBe('committed');
  expect((await f.engine.getPage('two', { sourceId: f.alpha }))?.compiled_truth ?? (await f.engine.getPage('alpha/two', { sourceId: f.alpha }))?.compiled_truth).toContain('narwhals');
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['completed']);
}), 180_000);

test('3. a fetch killed by its bound leaves no refresh row and HEAD unchanged', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Never fetched.'));
  const head = f.head();
  git(f.root, 'config', 'remote.origin.uploadpack', 'sleep 5; git-upload-pack');
  const error = await refusedWith(refreshWorktree(f.engine, f.alpha, { fetchTimeoutMs: 300 }), 'fetch_failed');
  expect(error.message).toContain('300 ms');
  expect(error.suggestion).toContain('--fetch-timeout-ms');
  expect(await f.refreshRows()).toEqual([]);
  expect(f.head()).toBe(head);
}), 120_000);

/** Runs `fn` with a PATH git that fails (stderr line, then `code`) whenever an argument equals `token`; every other command is the real git. */
async function withFailingGit<T>(token: string, code: number, fn: () => Promise<T>): Promise<T> {
  const bin = mkdtempSync(join(tmpdir(), 'gbrain-failing-git-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh
for a in "$@"; do if [ "$a" = "${token}" ]; then echo "fatal: injected failure of ${token}" >&2; exit ${code}; fi; done
PATH='${process.env.PATH}' exec ${realGit} "$@"
`, { mode: 0o755 });
  try { return await withEnv({ PATH: `${bin}:${process.env.PATH}` }, fn); } finally { rmSync(bin, { recursive: true, force: true }); }
}
const refusedOnGit = async (f: RefreshFixture, token: string, code: number, command: string) => {
  const head = f.head();
  const error = await withFailingGit(token, code, () => refusedWith(refreshWorktree(f.engine, f.alpha), 'git_unavailable'));
  expect(error.message).toContain(`git ${command} failed (fatal: injected failure of ${token})`);
  expect(error.suggestion).toContain(`gbrain sources refresh ${f.alpha}`);
  expect(await f.refreshRows()).toEqual([]);
  expect(f.head()).toBe(head);
};

test('3b. a failing git symbolic-ref is a git failure, not a detached HEAD', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await refusedOnGit(f, 'symbolic-ref', 128, 'symbolic-ref --quiet --short HEAD');
  git(f.root, 'checkout', '-q', '--detach');
  const detached = await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_no_upstream');
  expect(detached.message).toContain('(detached HEAD)');
}), 120_000);

test('3c. a failing git remote is a git failure, not a checkout without remotes', () => each(async f => {
  git(f.root, 'branch', '--unset-upstream');
  await refusedOnGit(f, 'remote', 128, 'remote');
  const noUpstream = await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_no_upstream');
  expect(noUpstream.suggestion).toContain('branch --set-upstream-to origin/main');
}), 120_000);

test('3d. a failing git config --get of the branch remote or merge is a git failure, not an unset key', () => each(async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await refusedOnGit(f, 'branch.main.remote', 3, 'config --get branch.main.remote');
  await refusedOnGit(f, 'branch.main.merge', 3, 'config --get branch.main.merge');
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  expect(f.head()).toBe(target);
}), 120_000);

test('3e. a checkout that is not a Git checkout is refresh_no_upstream naming that, not a detached HEAD or a git failure', () => each(async f => {
  renameSync(join(f.root, '.git'), join(f.dir, 'moved.git'));
  try {
    const error = await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_no_upstream');
    expect(error.message).toContain(`The checkout ${f.root} is not a Git checkout`);
    expect(error.suggestion).toContain('Nothing to refresh');
    expect(await f.refreshRows()).toEqual([]);
  } finally { renameSync(join(f.dir, 'moved.git'), join(f.root, '.git')); }
}), 120_000);

test('4. a diverged checkout is refused with no row and HEAD unchanged', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream side.'));
  writeFileSync(join(f.root, 'beta/local.md'), page('Local', 'A local commit nobody pushed.'));
  git(f.root, 'add', 'beta/local.md'); git(f.root, 'commit', '-qm', 'local only');
  const head = f.head();
  const error = await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_diverged');
  expect(error.suggestion).toContain(`gbrain sources reclone ${f.alpha}`);
  expect(await f.refreshRows()).toEqual([]);
  expect(f.head()).toBe(head);
}), 120_000);

test('4b. Q1: the diverged refusal names the keep-checkout publish; running it, then the refresh, brings the checkout up to date with the local commit kept', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream side.'));
  writeFileSync(join(f.root, 'beta/local.md'), page('Local', 'A local commit nobody pushed.'));
  git(f.root, 'add', 'beta/local.md'); git(f.root, 'commit', '-qm', 'local only');
  const local = f.head();
  const error = await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_diverged') as { suggestion?: string; fix?: { argv: string[]; ask_user?: boolean; actor?: string } };
  expect(error.suggestion).toContain('1 local commit(s)');
  expect(error.fix).toMatchObject({ argv: ['gbrain', 'git', 'commit-push', '--push-only', '--keep-checkout', '--path', f.root, '--json'], ask_user: true, actor: 'user' });
  git(f.root, 'config', 'user.name', 'Example'); git(f.root, 'config', 'user.email', 'example@example.invalid');
  expect(commitAndPush({ repo: f.root, pushOnly: true, keepCheckout: true })).toMatchObject({ outcome: 'pushed', integrated: 1, checkout: 'unchanged' });
  expect(f.head()).toBe(local);
  const done = await refreshWorktree(f.engine, f.alpha);
  expect(done).toMatchObject({ status: 'completed', old_head: local });
  git(f.root, 'merge-base', '--is-ancestor', local, 'HEAD');
  expect(readFileSync(join(f.root, 'alpha/two.md'), 'utf8')).toContain('Upstream side.');
  expect((await f.engine.getPage('two', { sourceId: f.alpha }))?.compiled_truth ?? (await f.engine.getPage('alpha/two', { sourceId: f.alpha }))?.compiled_truth).toContain('Upstream side.');
}), 120_000);

test('4e. #7685: sources refresh --json emits the diverged refusal\'s structured fix (argv, next, actor) as the v1 fix, prose in suggestion', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream side.'));
  writeFileSync(join(f.root, 'beta/local.md'), page('Local', 'A local commit nobody pushed.'));
  git(f.root, 'add', 'beta/local.md'); git(f.root, 'commit', '-qm', 'local only');
  const out: string[] = [];
  const log = console.log;
  _resetCliExitVerdictForTests();
  console.log = (line: string) => { out.push(line); };
  try { await runSourcesRefresh(f.engine, [f.alpha, '--json']); } finally { console.log = log; }
  try {
    const refusal = JSON.parse(out.join('\n'));
    expect(refusal).toMatchObject({ status: 'refused', code: 'refresh_diverged', contract_version: 1,
      fix: { argv: ['gbrain', 'git', 'commit-push', '--push-only', '--keep-checkout', '--path', f.root, '--json'], next: 'ask_user', actor: 'user' } });
    expect(refusal.fix.user_message).toContain(f.alpha);
    expect(refusal.suggestion).toContain('1 local commit(s)');
    expect(currentExitCode()).toBe(1);
  } finally { _resetCliExitVerdictForTests(); process.exitCode = 0; }
}), 120_000);

test('4c. Q1: commit-push on the managed checkout commits only the named page path, fetches and pushes nothing, and keeps other dirt', () => each(async f => {
  git(f.root, 'config', 'user.name', 'Example'); git(f.root, 'config', 'user.email', 'example@example.invalid');
  writeFileSync(join(f.root, 'beta/agent.md'), page('Agent', 'Written by an agent script.'));
  writeFileSync(join(f.root, 'beta/other.md'), page('Other', 'Another writer, not named.'));
  const before = f.head(), remote = git(f.root, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0];
  const result = commitAndPush({ repo: f.root, cwd: f.root, paths: ['beta/agent.md'], message: 'agent: file one page' });
  expect(result).toMatchObject({ outcome: 'committed_local', paths: ['beta/agent.md'], integrated: 0, checkout: 'unchanged' });
  expect(git(f.root, 'rev-parse', 'HEAD^').trim()).toBe(before);
  expect(git(f.root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim()).toBe('beta/agent.md');
  expect(git(f.root, 'status', '--porcelain', '--', 'beta/other.md').trim()).toBe('?? beta/other.md');
  expect(git(f.root, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]).toBe(remote);
  expect(() => commitAndPush({ repo: f.root, cwd: f.root, pending: true, message: 'pending' })).toThrow(expect.objectContaining({ code: 'commit_paths_invalid' }));
  expect(() => commitAndPush({ repo: f.root, cwd: f.root, pushOnly: true })).toThrow(expect.objectContaining({ code: 'writer_coordinator_required' }));
}), 120_000);

test('4d. Q1: writer status and doctor name each commit a diverged managed checkout holds (sha, author, date, paths) and its porcelain', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream side.'));
  git(f.root, 'fetch', '-q', 'origin');
  writeFileSync(join(f.root, 'beta/local.md'), page('Local', 'A commit made outside gbrain.'));
  git(f.root, 'add', 'beta/local.md'); git(f.root, 'commit', '-qm', 'cron: bare commit');
  const sha = f.head(), author = git(f.root, 'log', '-1', '--format=%an <%ae>').trim(), date = git(f.root, 'log', '-1', '--format=%aI').trim();
  writeFileSync(join(f.root, 'beta/scratch.txt'), 'untracked\n');
  const status = await runPersistenceAdministration(f.engine, 'writer_status', { source_id: f.beta }) as { checkouts: Array<Record<string, any>> };
  expect(status.checkouts).toHaveLength(1);
  expect(status.checkouts[0]).toMatchObject({ source_ids: [f.beta], branch: 'main', upstream: 'origin/main', ahead: 1, behind: 1, diverged: true, fetched: false,
    unpushed_truncated: false, porcelain: { staged: 0, modified: 0, untracked: 1, conflicted: 0 } });
  expect(status.checkouts[0]!.unpushed_commits).toEqual([{ sha, author, date, subject: 'cron: bare commit', paths: ['beta/local.md'], paths_total: 1 }]);
  const check = await gitConvergenceCheck(f.engine);
  expect(check?.status).toBe('warn');
  expect(check?.message).toContain('diverged');
  expect(check?.message).toContain(sha.slice(0, 7));
  const root = (check?.details as { roots: Array<Record<string, any>> }).roots.find(r => r.root === f.root)!;
  expect(root).toMatchObject({ managed: true, diverged: true, ahead: 1, behind: 1, porcelain: { untracked: 1 } });
  expect(root.unpushed_commits[0]).toMatchObject({ sha, author, paths: ['beta/local.md'] });
  expect(check?.fix).toMatchObject({ ask_user: true, actor: 'user', argv: ['gbrain', 'git', 'commit-push', '--push-only', '--keep-checkout', '--path', f.root, '--json'] });
}), 120_000);

test('5. dirt overlapping the incoming diff refuses naming the path; unrelated dirt is preserved and listed', () => each(async f => {
  const target = f.push('alpha/one.md', page('Alpha one', 'The upstream rewrite.'));
  writeFileSync(join(f.root, 'alpha/one.md'), page('Alpha one', 'An uncommitted local edit.'));
  writeFileSync(join(f.root, 'beta/draft.txt'), 'unrelated scratch\n');
  const error = await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_dirty');
  expect(error.message).toContain('alpha/one.md');
  expect(error.message).not.toContain('beta/draft.txt');
  expect(await f.refreshRows()).toEqual([]);
  git(f.root, 'checkout', '--', 'alpha/one.md');
  const result = await refreshWorktree(f.engine, f.alpha);
  expect(result.status).toBe('completed');
  expect(result.preserved_uncommitted).toEqual(['beta/draft.txt']);
  expect(readFileSync(join(f.root, 'beta/draft.txt'), 'utf8')).toBe('unrelated scratch\n');
  expect(f.head()).toBe(target);
}), 180_000);

test('6. an external commit between precheck and merge aborts with refresh_source_changed and lifts the fence', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await refusedWith(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => {
    if (point === 'drained') git(f.root, 'commit', '-q', '--allow-empty', '-m', 'external');
  } } }), 'refresh_source_changed');
  const rows = await f.refreshRows();
  expect(rows.map(r => r.state)).toEqual(['aborted']);
  expect((rows[0].outcome.refusal as { code: string }).code).toBe('refresh_source_changed');
  expect((await f.put(f.alpha, 'notes/after', page('After', 'admitted again'))).state ?? 'committed').toBe('committed');
}), 180_000);

test('7. a crash leaving HEAD on an unrelated commit is recovery_required; writes name the resume; --abandon after reset lifts the fence', () => each(async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  const old = f.head();
  await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => { if (point === 'merged') throw new Error('simulated crash after merge'); } } }))
    .rejects.toThrow('simulated crash');
  expect(f.head()).toBe(target);
  git(f.root, 'reset', '-q', '--hard', old);
  git(f.root, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
  await resumeWorktreeRefreshes(f.engine);
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['recovery_required']);
  const refused = await refusedWith(f.put(f.alpha, 'notes/blocked', page('Blocked', 'refused')), 'refresh_recovery_required');
  expect(refused.suggestion).toContain(`gbrain sources refresh ${f.alpha} --resume`);
  // Ship review: a refused --resume never hides the refresher that died. Value: protects=previous_holder keeps the first holder replaced across
  // refused resumes; fails_when=each resume shifts its own pid into previous_holder; why_new=no test resumed twice; seam=a holder written with SQL;
  // no_claim=a real foreign process (the holder pid is a placeholder).
  await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET outcome=outcome||jsonb_build_object('holder',jsonb_build_object('host_id',NULL,'hostname','host-example','pid',424242,'started_at','2026-01-01T00:00:00.000Z')) WHERE state='recovery_required'`);
  await refusedWith(refreshWorktree(f.engine, f.alpha, { resume: true }), 'refresh_recovery_required');
  const resume = await refusedWith(refreshWorktree(f.engine, f.alpha, { resume: true }), 'refresh_recovery_required');
  expect((await f.refreshRows())[0].outcome).toMatchObject({ holder: { pid: process.pid }, previous_holder: { pid: 424242, hostname: 'host-example' } });
  expect(resume.suggestion).toContain(`reset --hard ${old}`);
  // Ship audit, #7679. Value: protects=a plain refresh never adopts a recovery_required row, and writer status says nothing recovers it on its
  // own (auto_recovery none, ask the user before resetting); fails_when=adoption drops its recovery_required guard, or the holder report treats
  // it as an orphan the next refresh finishes; why_new=the #7679 tests cover syncing orphans only; seam=none; no_claim=the reset choice itself.
  // The plain refresh refuses with the row's own code and stored fix (both resets), not refresh_in_progress: no process will finish it.
  const plain = await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_recovery_required');
  expect(plain.suggestion).toContain(`reset --hard ${old}`);
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['recovery_required']);
  const [held] = (await runPersistenceAdministration(f.engine, 'writer_status', { source_id: f.alpha }) as { worktree_refreshes: Array<Record<string, any>> }).worktree_refreshes;
  expect(held).toMatchObject({ state: 'recovery_required', auto_recovery: 'none', fix: { argv: ['gbrain', 'sources', 'refresh', f.alpha, '--resume'], actor: 'agent' } });
  expect(held.fix.why).toContain('ask the user');
  // Ship audit (Step 7). Value: protects=sync status reports a recovery_required refresh and its next is the ask-the-user --resume step, not a
  // hold, pass or another read; fails_when=the sync-status probe skips recovery_required rows or another next outranks the refresh's fix;
  // why_new=writer status is read above; sync status has its own probe and next order; seam=none; no_claim=the reset choice itself.
  const sync = await readSyncStatus(f.engine, f.alpha, { detail: false });
  expect(sync.worktree_refresh).toMatchObject({ state: 'recovery_required', auto_recovery: 'none' });
  expect(sync.next).toMatchObject({ argv: ['gbrain', 'sources', 'refresh', f.alpha, '--resume'], actor: 'agent' });
  expect(sync.next?.why).toContain('ask the user');
  expect(await resumeWorktreeRefreshes(f.engine)).toBe(0);
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['recovery_required']);
  git(f.root, 'reset', '-q', '--hard', old);
  expect((await refreshWorktree(f.engine, f.alpha, { abandon: true })).status).toBe('abandoned');
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['aborted']);
  expect((await f.put(f.alpha, 'notes/after', page('After', 'admitted again'))).state ?? 'committed').toBe('committed');
}), 180_000);

test('7b. #7679: a plain refresh rolls back an orphan that died before merging, then runs its own refresh', () => each(async f => {
  // Ship audit. Value: protects=an orphan that died while fenced (HEAD unmoved) is rolled back by the next plain refresh, which then fast-forwards;
  // fails_when=refreshWorktree returns the abandoned recovery instead of refreshing, or adoption skips pre-syncing rows; why_new=the #7679 tests
  // kill only at syncing; seam=none; no_claim=a real process death (the crash is a hook throw; the refresh lock is released as on exit).
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  const old = f.head();
  await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => { if (point === 'fenced') throw new Error('simulated crash while fenced'); } } }))
    .rejects.toThrow('simulated crash');
  await disposePersistenceConsumer(f.engine);
  const [orphan] = await f.refreshRows();
  // The resident consumer's owner scan may already have rolled it back; restore what the crash left so only the plain refresh recovers it.
  await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET state='fenced',completed_at=NULL WHERE id=$1::uuid`, [orphan.id]);
  expect(f.head()).toBe(old);
  const result = await refreshWorktree(f.engine, f.alpha);
  expect(result).toMatchObject({ status: 'completed', old_head: old, target_head: target,
    recovered: { refresh_id: orphan.id, state: 'aborted', status: 'abandoned', previous_holder: { pid: process.pid } } });
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['aborted', 'completed']);
  expect(f.head()).toBe(target);
  expect(await f.lastCommit(f.alpha)).toBe(target);
}), 180_000);

test('7c. #7679 state matrix: an interrupted refresh of each kind, settled by the owner scan, a plain refresh and --resume', async () => {
  // Value: protects=each kind of interrupted refresh row leaves the row section 1.5 names when the owner scan, a plain refresh (adoption) or
  // --resume (resumeHeld) settles it; fails_when=a kind falls through to a sibling's path (an unverified HEAD adopted as the target, a syncing
  // row with an unrelated HEAD completed or refreshed over, a dead drain left standing); why_new=the #7679 tests cover syncing orphans with HEAD at
  // the target only; seam=none; no_claim=a real process death (the crash is a hook throw; the refresh lock is released as on exit).
  type Kind = 'draining' | 'fenced_old' | 'fenced_target' | 'fenced_unrelated' | 'merged_target' | 'merged_unrelated' | 'syncing_at_target' | 'syncing_descendant'
    | 'syncing_unrelated' | 'syncing_unrelated_synced';
  type Action = 'owner_scan' | 'plain' | 'resume';
  const kinds: Kind[] = ['draining', 'fenced_old', 'fenced_target', 'fenced_unrelated', 'merged_target', 'merged_unrelated', 'syncing_at_target', 'syncing_descendant',
    'syncing_unrelated', 'syncing_unrelated_synced'];
  const stateOf = (kind: Kind) => kind.split('_')[0] as 'draining' | 'fenced' | 'merged' | 'syncing';
  const crashAt = { draining: 'drained', fenced: 'fenced', merged: 'fenced', syncing: 'syncing' } as const;
  // The owner scan's row and moved count; a merged row's bookkeeping leaves it syncing, and a syncing row with an unrelated HEAD waits for --resume.
  const scanned: Record<Kind, [string, number]> = { draining: ['aborted', 1], fenced_old: ['aborted', 1], fenced_target: ['syncing', 1], fenced_unrelated: ['recovery_required', 1],
    merged_target: ['syncing', 1], merged_unrelated: ['recovery_required', 1], syncing_at_target: ['completed', 1], syncing_descendant: ['syncing', 0], syncing_unrelated: ['syncing', 0], syncing_unrelated_synced: ['syncing', 0] };
  const cells = kinds.flatMap(kind => (['owner_scan', 'plain', 'resume'] as Action[]).map(action => [kind, action] as [Kind, Action]));
  for (const engine of engines) for (const [kind, action] of cells) await withRefreshFixture(engine, async f => {
    const label = `${kind} x ${action}`;
    const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
    const old = f.head();
    await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => { if (point === crashAt[stateOf(kind)]) throw new Error(`simulated crash at ${point}`); } } }))
      .rejects.toThrow('simulated crash');
    await disposePersistenceConsumer(f.engine);
    const [orphan] = await f.refreshRows();
    // The resident consumer's owner scan may already have settled it; restore what the crash left.
    await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET state=$2,completed_at=NULL WHERE id=$1::uuid`, [orphan.id, stateOf(kind)]);
    if (kind === 'fenced_target' || kind === 'merged_target') git(f.root, 'merge', '-q', '--ff-only', target);
    if (kind === 'syncing_descendant') commitFile(f.root, 'beta/local.md', page('Local', 'Committed on top of the target.'));
    if (kind.includes('_unrelated')) { git(f.root, 'reset', '-q', '--hard', old); commitFile(f.root, 'beta/unrelated.md', page('Unrelated', 'Not the upstream commit.')); }
    if (kind === 'syncing_at_target' || kind === 'syncing_unrelated_synced') for (const member of [f.alpha, f.beta]) await f.engine.transaction(tx => withCoordinatedWrite(tx, [member],
      () => tx.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [member, target]), TEST_WRITE_ATTRIBUTION));
    const head = f.head();
    const rows = async () => (await f.refreshRows()).map(r => r.state);
    if (kind === 'draining') {
      // Ship audit (Step 7). Value: protects=writer status tells an orphaned draining refresh's writers to --resume it, never to retry (only a live
      // drain finishes on its own); fails_when=the draining branch of next stops checking liveness (master's wording); why_new=test 10 reads a live
      // drain only; seam=none; no_claim=a real process death (the crash is a hook throw; the refresh lock is released as on exit).
      const [status] = (await runPersistenceAdministration(f.engine, 'writer_status', { source_id: f.alpha }) as { worktree_refreshes: Array<Record<string, any>> }).worktree_refreshes;
      expect(status, label).toMatchObject({ refresh_id: orphan.id, state: 'draining', liveness: 'orphaned', auto_recovery: 'next_refresh',
        fix: { argv: ['gbrain', 'sources', 'refresh', f.alpha, '--resume'] }, next: `gbrain sources refresh ${f.alpha} --resume` });
    }
    if (action === 'owner_scan') {
      const [state, moved] = scanned[kind];
      expect(await resumeWorktreeRefreshes(f.engine), label).toBe(moved);
      expect(await rows(), label).toEqual([state]);
      expect(f.head(), label).toBe(head);
      return;
    }
    const run = refreshWorktree(f.engine, f.alpha, action === 'resume' ? { resume: true } : {});
    if (kind.includes('_unrelated')) {
      await refusedWith(run, 'refresh_recovery_required');
      expect(await rows(), label).toEqual(['recovery_required']);
      expect(f.head(), label).toBe(head);
      return;
    }
    if (kind === 'syncing_descendant' && action === 'plain') {
      // The adoption completes the orphan at the descendant HEAD; the refresh itself then refuses the unpushed local commit.
      await refusedWith(run, 'refresh_diverged');
      expect(await rows(), label).toEqual(['completed']);
      expect(f.head(), label).toBe(head);
      expect(await f.lastCommit(f.alpha), label).toBe(head);
      expect(await f.lastCommit(f.beta), label).toBe(head);
      return;
    }
    const result = await run;
    const rolledBack = kind === 'draining' || kind === 'fenced_old';
    if (action === 'resume') {
      expect(result, label).toMatchObject({ status: rolledBack ? 'abandoned' : 'completed', refresh_id: orphan.id });
      expect(await rows(), label).toEqual([rolledBack ? 'aborted' : 'completed']);
      expect(f.head(), label).toBe(head);
      return;
    }
    if (rolledBack) {
      expect(result, label).toMatchObject({ status: 'completed', target_head: target, recovered: { refresh_id: orphan.id, state: 'aborted', status: 'abandoned' } });
      expect(await rows(), label).toEqual(['aborted', 'completed']);
    } else {
      expect(result, label).toMatchObject({ status: 'already_current', recovered: { refresh_id: orphan.id, state: 'completed', status: 'completed', previous_holder: { pid: process.pid } } });
      expect(await rows(), label).toEqual(['completed']);
    }
    const synced = kind === 'syncing_descendant' ? head : target;
    expect(f.head(), label).toBe(synced);
    expect(await f.lastCommit(f.alpha), label).toBe(synced);
    expect(await f.lastCommit(f.beta), label).toBe(synced);
  });
}, 900_000);

test('7d. #7679 state matrix: an interrupted refresh that the unattended paths cannot verify, or that a live or remote holder owns, is never moved', async () => {
  // Value: protects=a plain refresh leaves an orphan untouched (state, holder, previous_holder, HEAD) when git cannot read HEAD (refusing
  // refresh_in_progress), when publication/topology recovery is pending or the worktree is not active (refusing refresh_recovery_required, the
  // blocker that must clear first), when a live process holds the refresh lock, or when its holder is on another host; the owner scan aborts a dead
  // drain whatever HEAD reads and leaves every other kind on an unreadable HEAD; fails_when=adoption runs recovery on a null HEAD, ahead of the
  // recovery gate, against a live lock or another host's holder, or the scan escalates an unreadable HEAD; why_new=7c covers readable HEADs with
  // free locks and no pending recovery only; seam=.git/HEAD overwritten with garbage, a recovering topology change row, the worktree state column,
  // the refresh lock held in this process, a foreign holder host id; no_claim=the race where HEAD becomes unreadable between adoption's two reads.
  type Kind = 'draining' | 'fenced_old' | 'fenced_target' | 'merged_target' | 'syncing_lagging' | 'syncing_at_target' | 'recovery_required';
  type Action = 'plain_head_unreadable' | 'scan_head_unreadable' | 'plain_recovery_pending' | 'plain_worktree_inactive' | 'live_holder' | 'other_host_holder';
  const kinds: Kind[] = ['draining', 'fenced_old', 'fenced_target', 'merged_target', 'syncing_lagging', 'syncing_at_target', 'recovery_required'];
  const actions: Action[] = ['plain_head_unreadable', 'scan_head_unreadable', 'plain_recovery_pending', 'plain_worktree_inactive', 'live_holder', 'other_host_holder'];
  const stateOf = (kind: Kind) => kind === 'recovery_required' ? 'recovery_required' : kind.split('_')[0];
  const crashAt = (kind: Kind) => kind === 'draining' ? 'drained' : kind.startsWith('syncing') ? 'syncing' : 'fenced';
  const cells = kinds.flatMap(kind => actions.map(action => [kind, action] as [Kind, Action]));
  for (const engine of engines) for (const [kind, action] of cells) await withRefreshFixture(engine, async f => {
    const label = `${kind} x ${action}`;
    const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
    await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => { if (point === crashAt(kind)) throw new Error(`simulated crash at ${point}`); } } }))
      .rejects.toThrow('simulated crash');
    await disposePersistenceConsumer(f.engine);
    const [orphan] = await f.refreshRows();
    const state = stateOf(kind);
    await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET state=$2,completed_at=NULL WHERE id=$1::uuid`, [orphan.id, state]);
    if (kind === 'fenced_target' || kind === 'merged_target') git(f.root, 'merge', '-q', '--ff-only', target);
    if (kind === 'syncing_at_target') for (const member of [f.alpha, f.beta]) await f.engine.transaction(tx => withCoordinatedWrite(tx, [member],
      () => tx.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [member, target]), TEST_WRITE_ATTRIBUTION));
    const head = f.head();
    const settled = async () => (await f.refreshRows()).map(r => [r.state, (r.outcome.holder as { pid?: number } | undefined)?.pid, r.outcome.previous_holder]);
    const before = await settled();
    const plainCode = kind === 'recovery_required' ? 'refresh_recovery_required' : 'refresh_in_progress';
    const writerStatus = async () => (await runPersistenceAdministration(f.engine, 'writer_status', { source_id: f.alpha }) as { worktree_refreshes: Array<Record<string, any>> }).worktree_refreshes[0];
    if (action === 'plain_recovery_pending' || action === 'plain_worktree_inactive') {
      if (action === 'plain_recovery_pending') await f.engine.executeRaw(`INSERT INTO persistence_topology_changes(principal_id,request_id,digest,operation,source_id,worktree_ids,state,recovery)
        VALUES($1::uuid,$2::uuid,'example','reclone',$3,ARRAY[$4::uuid],'recovering',$5::text::jsonb)`,
        [randomUUID(), randomUUID(), f.alpha, f.worktreeId, JSON.stringify({ worktreeId: f.worktreeId })]);
      else await f.engine.executeRaw(`UPDATE persistence_worktrees SET state='recovering' WHERE id=$1::uuid`, [f.worktreeId]);
      await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_recovery_required');
      // Status does not promise that the next refresh finishes an orphan the recovery gate holds back.
      if (kind !== 'recovery_required') expect(await writerStatus(), label).toMatchObject({ liveness: 'orphaned', auto_recovery: 'none',
        fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', f.alpha, '--json'] } });
    } else if (action === 'live_holder') {
      const lock = await tryAcquireNativeLock(refreshLockPath(f.worktreeId));
      expect(lock, label).not.toBeNull();
      try {
        expect(await resumeWorktreeRefreshes(f.engine), label).toBe(0);
        await refusedWith(refreshWorktree(f.engine, f.alpha), plainCode);
        await refusedWith(refreshWorktree(f.engine, f.alpha, { resume: true }), 'refresh_in_progress');
        expect(await writerStatus(), label).toMatchObject({ liveness: 'live', auto_recovery: 'none' });
      } finally { await lock!.release(); }
    } else if (action === 'other_host_holder') {
      await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET outcome=jsonb_set(outcome,'{holder,host_id}',to_jsonb($2::text)) WHERE id=$1::uuid`, [orphan.id, randomUUID()]);
      await refusedWith(refreshWorktree(f.engine, f.alpha), plainCode);
      if (kind !== 'recovery_required') expect(await writerStatus(), label).toMatchObject({ liveness: 'unknown', auto_recovery: 'unknown', fix: { actor: 'host_admin' },
        next: `gbrain sources writer status --source ${f.alpha} --json` });
    } else {
      const headFile = join(f.root, '.git', 'HEAD');
      const saved = readFileSync(headFile, 'utf8');
      writeFileSync(headFile, 'not a ref\n');
      try {
        if (action === 'plain_head_unreadable') {
          const refused = await refusedWith(refreshWorktree(f.engine, f.alpha), plainCode);
          if (kind !== 'recovery_required') expect(refused.suggestion, label).toContain(`gbrain sources writer status --source ${f.alpha} --json`);
        } else {
          // The scan aborts a dead drain (it does not depend on HEAD) and leaves every other kind for a scan that can read HEAD.
          expect(await resumeWorktreeRefreshes(f.engine), label).toBe(kind === 'draining' ? 1 : 0);
          expect((await f.refreshRows()).map(r => r.state), label).toEqual([kind === 'draining' ? 'aborted' : state]);
        }
      } finally { writeFileSync(headFile, saved); }
      if (action === 'scan_head_unreadable') { expect(f.head(), label).toBe(head); return; }
    }
    expect(await settled(), label).toEqual(before);
    expect(f.head(), label).toBe(head);
  });
}, 900_000);

test('7e. #7679: the owner scan leaves an orphaned syncing refresh while one member lags behind its target, and completes it once both reach it', () => each(async f => {
  // Ship audit (Step 7). Value: protects=the owner scan completes an orphaned syncing row only when every member reached the target, even when
  // the SQL prefilter admits it (a member past old_head but short of the target); fails_when=completeSyncedOrphan or membersAtTarget stops
  // checking every member; why_new=every scan test leaves members at old_head, which the prefilter alone skips; seam=none; no_claim=a real
  // process death (the crash is a hook throw) and member syncs (last_commit is set directly, as the admission test does).
  const first = f.push('alpha/two.md', page('Alpha two', 'Upstream first.'));
  const target = f.push('alpha/three.md', page('Alpha three', 'Upstream second.'));
  await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => { if (point === 'syncing') throw new Error('simulated crash at syncing'); } } }))
    .rejects.toThrow('simulated crash');
  await disposePersistenceConsumer(f.engine);
  const [orphan] = await f.refreshRows();
  // The resident consumer's owner scan may already have settled it; restore what the crash left.
  await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET state='syncing',completed_at=NULL WHERE id=$1::uuid`, [orphan.id]);
  expect(f.head()).toBe(target);
  const setLastCommit = (member: string, sha: string) => f.engine.transaction(tx => withCoordinatedWrite(tx, [member],
    () => tx.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [member, sha]), TEST_WRITE_ATTRIBUTION));
  await setLastCommit(f.alpha, target);
  await setLastCommit(f.beta, first);
  expect(await resumeWorktreeRefreshes(f.engine)).toBe(0);
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['syncing']);
  await setLastCommit(f.beta, target);
  expect(await resumeWorktreeRefreshes(f.engine)).toBe(1);
  const [row] = await f.refreshRows();
  expect(row).toMatchObject({ id: orphan.id, state: 'completed', outcome: { completed_by: 'owner_recovery' } });
}), 180_000);

test('7h. #7679: a git failure while the owner scan checks an orphaned syncing refresh is re-checked after a minute, not cached for the life of the process', () => each(async f => {
  // Ship adversarial (Step 11). Value: protects=the owner scan's lagging cache never turns one failed `git merge-base --is-ancestor` (exit 128,
  // a timeout) into a permanent lagging verdict for a row whose members already synced past its target; fails_when=the cache drops its
  // re-check window and keys only on member last_commits; why_new=7e and 7g re-check only after a member moves; seam=the git object store is
  // made unreadable for one scan, and the clock is moved with setSystemTime; no_claim=a real git timeout.
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => { if (point === 'syncing') throw new Error('simulated crash at syncing'); } } }))
    .rejects.toThrow('simulated crash');
  await disposePersistenceConsumer(f.engine);
  const [orphan] = await f.refreshRows();
  await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET state='syncing',completed_at=NULL WHERE id=$1::uuid`, [orphan.id]);
  const descendant = commitFile(f.root, 'beta/local.md', page('Local', 'Committed on top of the target.'));
  for (const member of [f.alpha, f.beta]) await f.engine.transaction(tx => withCoordinatedWrite(tx, [member],
    () => tx.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [member, descendant]), TEST_WRITE_ATTRIBUTION));
  expect(git(f.root, 'merge-base', '--is-ancestor', target, descendant)).toBe('');
  const objects = join(f.root, '.git', 'objects');
  chmodSync(objects, 0o000);
  try { expect(await resumeWorktreeRefreshes(f.engine)).toBe(0); } finally { chmodSync(objects, 0o755); }
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['syncing']);
  // Within the minute the cached verdict stands even though git reads again.
  expect(await resumeWorktreeRefreshes(f.engine)).toBe(0);
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['syncing']);
  setSystemTime(new Date(Date.now() + 61_000));
  try { expect(await resumeWorktreeRefreshes(f.engine)).toBe(1); } finally { setSystemTime(); }
  expect(await f.refreshRows()).toMatchObject([{ id: orphan.id, state: 'completed', outcome: { completed_by: 'owner_recovery' } }]);
  expect(f.head()).toBe(descendant);
}), 180_000);

test('7f. #7679: a plain refresh whose adopted orphan ends sync_blocked returns that result and does not refresh over it', () => each(async f => {
  // Ship audit (Step 7, pass 2). Value: protects=a plain refresh that adopts an orphan whose member sync blocks returns sync_blocked naming the
  // member's resume and leaves HEAD at the orphan's target; fails_when=refreshWorktree drops its non-terminal early return and refreshes on;
  // why_new=no adoption test blocks a member sync (#7706); seam=none; no_claim=a real process death (the crash is a hook throw) and other
  // non-terminal recovery statuses (sync.holds=fail stands in for any blocked member write).
  const target = f.push('alpha/broken.md', '---\ntitle: alice-example first line\nalice-example second line\n---\nA synthetic post.\n');
  await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => { if (point === 'syncing') throw new Error('simulated crash at syncing'); } } }))
    .rejects.toThrow('simulated crash');
  await disposePersistenceConsumer(f.engine);
  const [orphan] = await f.refreshRows();
  await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET state='syncing',completed_at=NULL WHERE id=$1::uuid`, [orphan.id]);
  expect(f.head()).toBe(target);
  const next = f.push('alpha/three.md', page('Alpha three', 'Landed upstream while the refresh was orphaned.'));
  await f.engine.setConfig('sync.holds', 'fail');
  try {
    const result = await refreshWorktree(f.engine, f.alpha);
    expect(result).toMatchObject({ status: 'sync_blocked', refresh_id: orphan.id, target_head: target,
      sync_blocked: [{ source_id: f.alpha, resume: `gbrain sync --source ${f.alpha} --no-pull` }],
      recovered: { refresh_id: orphan.id, state: 'completed', status: 'sync_blocked', previous_holder: { pid: process.pid } } });
    expect(result.next).toContain(`gbrain sync --source ${f.alpha} --no-pull`);
    expect(f.head()).toBe(target);
    expect(f.head()).not.toBe(next);
    const rows = await f.refreshRows();
    expect(rows.map(r => r.state)).toEqual(['completed']);
    expect(rows[0].outcome.sync_blocked).toEqual([expect.objectContaining({ source_id: f.alpha })]);
  } finally { await f.engine.unsetConfig('sync.holds'); }
}), 180_000);

test('7g. #7679: a backlog of 16 orphaned syncing refreshes waiting on their members does not starve the owner scan\'s rollback of a dead drain', () => each(async f => {
  // Ship audit (Step 7, pass 2). Value: protects=the owner scan settles a pre-merge orphan (its fence refuses every write) even when 16 older
  // syncing orphans fill its LIMIT; fails_when=the scan's ORDER BY stops putting syncing rows last; why_new=every scan test has one row;
  // seam=none; no_claim=16 real worktrees (the backlog is worktree and refresh rows inserted with SQL, with no host binding).
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => { if (point === 'drained') throw new Error('simulated crash at drained'); } } }))
    .rejects.toThrow('simulated crash');
  await disposePersistenceConsumer(f.engine);
  const [orphan] = await f.refreshRows();
  await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET state='draining',completed_at=NULL WHERE id=$1::uuid`, [orphan.id]);
  const [{ owner_host_id: host, principal_id: principal }] = await f.engine.executeRaw<{ owner_host_id: string; principal_id: string }>(
    `SELECT w.owner_host_id::text AS owner_host_id, r.principal_id::text AS principal_id FROM persistence_worktrees w
     JOIN persistence_worktree_refreshes r ON r.worktree_id=w.id WHERE r.id=$1::uuid`, [orphan.id]);
  const backlog: string[] = [];
  try {
    for (let i = 0; i < 16; i++) {
      const [{ id }] = await f.engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees(owner_host_id) VALUES($1::uuid) RETURNING id::text AS id', [host]);
      backlog.push(id);
      await f.engine.executeRaw(`INSERT INTO persistence_worktree_refreshes(worktree_id,source_ids,principal_id,owner_epoch,topology_generation,state,old_head,target_head,upstream_ref,created_at)
        VALUES($1::uuid,ARRAY[$2]::text[],$3::uuid,0,1,'syncing',$4,$4,'origin/main',now()-interval '1 hour')`, [id, f.alpha, principal, 'f'.repeat(40)]);
    }
    expect(await resumeWorktreeRefreshes(f.engine)).toBe(1);
    expect((await f.refreshRows()).map(r => r.state)).toEqual(['aborted']);
  } finally {
    if (backlog.length) {
      await f.engine.executeRaw('DELETE FROM persistence_worktree_refreshes WHERE worktree_id=ANY($1::uuid[])', [backlog]);
      await f.engine.executeRaw('DELETE FROM persistence_worktrees WHERE id=ANY($1::uuid[])', [backlog]);
    }
  }
}), 180_000);

test('8. a queued git effect drains before fenced, and nothing on the worktree is claimed while fenced', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await f.put(f.beta, 'notes/effect', page('Effect', 'Has a git effect.'));
  const effectId = await requeueGitEffect(f, 800);
  const started = performance.now();
  const result = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => {
    if (point === 'drained') {
      expect(performance.now() - started).toBeGreaterThanOrEqual(700);
      expect((await f.engine.executeRaw<{ state: string }>('SELECT state FROM persistence_effects WHERE id=$1', [effectId]))[0].state).toBe('committed');
    }
    if (point === 'fenced') {
      await f.engine.executeRaw(`UPDATE persistence_effects SET state='queued',next_attempt_at=now()-interval '1 second' WHERE id=$1`, [effectId]);
      expect(await claimPersistenceEffect(f.engine, localHostId())).toBeNull();
      expect(await claimCoalescedGitEffects(f.engine, localHostId(), f.worktreeId, 5)).toEqual([]);
      // The idle probe mirrors the claims: a fenced effect is not work, so the consumer keeps backing off.
      const probe = new PersistenceConsumer(f.engine, {} as never, async () => { throw new Error('no preparation in this probe'); });
      expect(await (probe as unknown as { hasWork(): Promise<boolean> }).hasWork()).toBe(false);
      // The resident consumer polls too; a claimable effect would leave 'queued' within a few polls.
      await new Promise(resolve => setTimeout(resolve, 1200));
      expect((await f.engine.executeRaw<{ state: string }>('SELECT state FROM persistence_effects WHERE id=$1', [effectId]))[0].state).toBe('queued');
      await f.engine.executeRaw(`UPDATE persistence_effects SET state='committed' WHERE id=$1`, [effectId]);
    }
  } } });
  expect(result.status).toBe('completed');
}), 180_000);

test('9. an unexhausted managed-sync cursor refuses sync_in_progress with its resume command and no fence', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  const key = `test-cursor-${randomUUID()}`;
  await f.engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::text::jsonb)`,
    [key, JSON.stringify([{ sourceId: f.beta, done: false, processingOptions: { noEmbed: true, noExtract: false, noSchemaPack: false },
      syncOptions: { full: false, workingTree: false, srcSubpath: null, exclude: [], includeHidden: [], strategy: null } }])]);
  try {
    const error = await refusedWith(refreshWorktree(f.engine, f.alpha), 'sync_in_progress');
    expect(error.suggestion).toContain(`gbrain sync --source ${f.beta} --no-pull --no-embed`);
    expect(error.suggestion).not.toContain('--retry-failed');
    expect(await f.refreshRows()).toEqual([]);
  } finally { await f.engine.executeRaw(`DELETE FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1`, [key]); }
}), 120_000);

test('9b. #6712 PR 4b: an open non-company sync pass does not refuse the refresh (a cursor still does, test 9); the next pass converges at the new HEAD', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  const before = f.head();
  const [source] = await f.engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [f.beta]);
  const passId = randomUUID();
  const value: ManagedSyncPassValue = { source_id: f.beta, incarnation: source!.incarnation, lease_token: randomUUID(),
    obligations: { baseline_commit: null, mismatch: {}, not_converged_streak: 0, faults: {} },
    telemetry: { pass_id: passId, target: 'HEAD', started_at: new Date().toISOString(), ended_at: null, kind: 'full', round: 1, outcome: 'open', stop_reason: null,
      candidates: 5, settled: 2, remaining: 3, counts: {}, duration_ms: null, timings_ms: {} } };
  expect(await writePassRow(f.engine, value, { pin: true })).toBe(true);
  try {
    const result = await refreshWorktree(f.engine, f.alpha);
    expect(result).toMatchObject({ status: 'completed', old_head: before });
    expect(result.target_head).not.toBe(before);
    // The refresh's own sync of the members is the next pass: it replaces the open row and converges at the new HEAD.
    expect(result.synced).toContainEqual({ source_id: f.beta, status: 'synced', last_commit: result.target_head as string | null });
    const [row] = await f.engine.executeRaw<{ pass_id: string; outcome: string }>("SELECT completed_keys->0->'telemetry'->>'pass_id' AS pass_id, completed_keys->0->'telemetry'->>'outcome' AS outcome FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'source_id'=$2", [MANAGED_SYNC_PASS_OP, f.beta]);
    expect(row).toMatchObject({ outcome: 'synced' });
    expect(row?.pass_id).not.toBe(passId);
  } finally { await f.engine.executeRaw("DELETE FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'source_id'=$2", [MANAGED_SYNC_PASS_OP, f.beta]); }
}), 120_000);

test('10. source add and remove on the worktree during a refresh refuse refresh_in_progress', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  const result = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => {
    if (point !== 'drained') return;
    const add = await refusedWith(runManagedSourceLifecycle(f.engine, { operation: 'add', sourceId: `gamma-${randomUUID().slice(0, 6)}`, path: join(f.root, 'alpha') }), 'refresh_in_progress');
    expect(add.suggestion).toContain('--resume');
    await refusedWith(runManagedSourceLifecycle(f.engine, { operation: 'remove', sourceId: f.beta, confirmDestructive: true }), 'refresh_in_progress');
    await refusedWith(refreshWorktree(f.engine, f.beta), 'refresh_in_progress');
    // Ship audit, #7679. Value: protects=writer status tells writers to retry a live draining refresh, never to --resume it; fails_when=the
    // draining branch is removed or ordered after the live branch, or liveness misreports the holder; why_new=no test read writer status while draining; seam=none; no_claim=other-host liveness.
    const [draining] = (await runPersistenceAdministration(f.engine, 'writer_status', { source_id: f.beta }) as { worktree_refreshes: Array<Record<string, any>> }).worktree_refreshes;
    expect(draining).toMatchObject({ state: 'draining', liveness: 'live', fix: null });
    expect(draining.next).toContain('queued work drains');
  } } });
  expect(result.status).toBe('completed');
}), 180_000);

test('11. end to end: a new upstream commit, `gbrain sources refresh --json`, then query finds it', () => each(async f => {
  f.push('beta/zebra.md', page('Zebra', 'A zebracorn observation pushed upstream.'));
  const out: string[] = [];
  const log = console.log;
  _resetCliExitVerdictForTests();
  console.log = (line: string) => { out.push(line); };
  try { await runSourcesRefresh(f.engine, [f.beta, '--json']); } finally { console.log = log; }
  const printed = JSON.parse(out.join('\n'));
  expect(printed).toMatchObject({ status: 'completed', target_head: f.head() });
  expect(currentExitCode()).toBe(0);
  const query = operations.find(op => op.name === 'query')!;
  const ctx = { ...f.ctx(f.beta), sourceId: f.beta };
  expect(JSON.stringify(await query.handler(ctx as never, { query: 'zebracorn', limit: 5, expand: false }))).toContain('zebra');
  const [observed] = await f.engine.executeRaw<{ upstream_commit: string; upstream_behind: number }>('SELECT upstream_commit,upstream_behind FROM sources WHERE id=$1', [f.beta]);
  expect(observed).toEqual({ upstream_commit: f.head(), upstream_behind: 0 });
}), 180_000);

test('12. an unmanaged brain refuses refresh_not_managed naming gbrain sync, on stdout with exit 1', () => each(async f => {
  await f.engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try {
    await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_not_managed').then(error => expect(error.suggestion).toBe(`gbrain sync --source ${f.alpha}`));
    const out: string[] = [];
    const log = console.log;
    _resetCliExitVerdictForTests();
    console.log = (line: string) => { out.push(line); };
    try { await runSourcesRefresh(f.engine, [f.alpha, '--json']); } finally { console.log = log; }
    expect(JSON.parse(out.join('\n'))).toMatchObject({ status: 'refused', code: 'refresh_not_managed', fix: `gbrain sync --source ${f.alpha}`,
      docs: 'docs/guides/write-refusals.md#refresh_not_managed' });
    expect(currentExitCode()).toBe(1);
  } finally {
    _resetCliExitVerdictForTests();
    process.exitCode = 0; await f.engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}), 120_000);

test('13. drain starvation: a writer every 50 ms is refused during draining and the refresh completes inside --wait-drain', () => each(async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await f.put(f.alpha, 'notes/seed', page('Seed', 'Has a git effect.'));
  // The git effect the refresh drains becomes runnable once the writer has been refused four times (not after a fixed
  // delay), so the draining window always spans several writer attempts however slow one write is on the host.
  const effect = await requeueGitEffect(f, 60_000);
  let stop = false;
  const outcomes: string[] = [];
  const writer = (async () => {
    while (!stop) {
      try { await f.put(f.alpha, `notes/w-${randomUUID().slice(0, 8)}`, page('W', 'steady traffic')); outcomes.push('accepted'); }
      catch (error) { outcomes.push((error as { code?: string }).code ?? 'error'); }
      if (outcomes.filter(code => code === 'worktree_refreshing').length === 4) await f.engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=$1', [effect]);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  })();
  let result;
  try {
    await new Promise(resolve => setTimeout(resolve, 120));
    result = await refreshWorktree(f.engine, f.alpha, { waitDrainMs: 15_000 });
  } finally { stop = true; await writer; }
  expect(result.status).toBe('completed');
  expect(result.target_head).toBe(target);
  expect(outcomes.filter(code => code === 'worktree_refreshing').length).toBeGreaterThan(3);
  expect(existsSync(join(f.root, 'alpha/two.md'))).toBe(true);
}), 180_000);

test('13b. a publication in flight (recovery under a live claim) is drained, not refused; one no live claim holds is recovery_required', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await f.put(f.alpha, 'notes/seed', page('Seed', 'Has a worktree request.'));
  const [request] = await f.engine.executeRaw<{ id: string }>(
    'SELECT id::text FROM persistence_requests WHERE source_id=$1 AND worktree_id IS NOT NULL ORDER BY sequence DESC LIMIT 1', [f.alpha]);
  const publishing = (claim: string) => f.engine.executeRaw(
    `UPDATE persistence_requests SET state='running', recovery='{"version":1}'::jsonb, claim_expires_at=now()+$2::interval WHERE id=$1::uuid`, [request.id, claim]);
  try {
    await publishing('10 minutes');
    await refusedWith(refreshWorktree(f.engine, f.alpha, { waitDrainMs: 300 }), 'refresh_drain_timeout');
    await publishing('-1 minute');
    await refusedWith(refreshWorktree(f.engine, f.alpha, { waitDrainMs: 300 }), 'refresh_recovery_required');
  } finally {
    await f.engine.executeRaw(`UPDATE persistence_requests SET state='committed', recovery=NULL, claim_expires_at=NULL WHERE id=$1::uuid`, [request.id]);
  }
}), 120_000);

test('13c. a committed write whose publisher still holds the worktree lock (recovery not yet cleared) is drained, not refused', () => each(async f => {
  // The coordinator commits the receipt (completeWrite) and only then clears the request's recovery record
  // (clearResolvedRecovery), holding the worktree native lock throughout. A refresh whose precheck lands in
  // that window used to refuse refresh_recovery_required; on loaded CI this flaked cases 8 and 13.
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await f.put(f.alpha, 'notes/seed', page('Seed', 'Has a worktree request.'));
  const [request] = await f.engine.executeRaw<{ id: string }>(
    'SELECT id::text FROM persistence_requests WHERE source_id=$1 AND worktree_id IS NOT NULL ORDER BY sequence DESC LIMIT 1', [f.alpha]);
  const binding = (await getWorktreeBinding(f.engine, f.alpha))!;
  // Let the seed's Git effect finish, then stop the resident consumer so its recovery scan cannot settle the planted record.
  for (let i = 0; i < 100; i++) {
    const [busy] = await f.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_effects
      WHERE worktree_id=$1::uuid AND kind IN ('git','withdrawal-mirror') AND state IN ('queued','running')`, [f.worktreeId]);
    if (Number(busy.n) === 0) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await disposePersistenceConsumer(f.engine);
  const committedWithRecovery = () => f.engine.executeRaw(
    `UPDATE persistence_requests SET recovery='{"version":1}'::jsonb, claim_expires_at=NULL WHERE id=$1::uuid AND state='committed'`, [request.id]);
  const clear = () => f.engine.executeRaw('UPDATE persistence_requests SET recovery=NULL WHERE id=$1::uuid', [request.id]);
  try {
    // No live owner: the same record left by a crashed publisher is still refused.
    await committedWithRecovery();
    await refusedWith(refreshWorktree(f.engine, f.alpha, { waitDrainMs: 300 }), 'refresh_recovery_required');
    // Live owner: the publisher holds the worktree lock until it clears the record.
    const lock = (await tryAcquireNativeLock(binding.coordination_path!))!;
    expect(lock).not.toBeNull();
    await committedWithRecovery();
    const publisherFinishes = new Promise<void>(resolve => setTimeout(() => { void clear().then(() => lock.release()).then(resolve); }, 400));
    const result = await refreshWorktree(f.engine, f.alpha, { waitDrainMs: 10_000 });
    await publisherFinishes;
    expect(result).toMatchObject({ status: 'completed', target_head: target });
  } finally { await clear(); }
}), 120_000);

test('13d. a publisher that clears its record and releases the lock between the precheck probe and its lock attempt is not refused', () => each(async f => {
  // TOCTOU on 13c's fix: the precheck sees the record, then the publisher finishes before the lock probe.
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  await f.put(f.alpha, 'notes/seed', page('Seed', 'Has a worktree request.'));
  const [request] = await f.engine.executeRaw<{ id: string }>(
    'SELECT id::text FROM persistence_requests WHERE source_id=$1 AND worktree_id IS NOT NULL ORDER BY sequence DESC LIMIT 1', [f.alpha]);
  for (let i = 0; i < 100; i++) {
    const [busy] = await f.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_effects
      WHERE worktree_id=$1::uuid AND kind IN ('git','withdrawal-mirror') AND state IN ('queued','running')`, [f.worktreeId]);
    if (Number(busy.n) === 0) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await disposePersistenceConsumer(f.engine);
  const clear = () => f.engine.executeRaw('UPDATE persistence_requests SET recovery=NULL WHERE id=$1::uuid', [request.id]);
  await f.engine.executeRaw(`UPDATE persistence_requests SET recovery='{"version":1}'::jsonb, claim_expires_at=NULL WHERE id=$1::uuid AND state='committed'`, [request.id]);
  const engine = f.engine as BrainEngine & { executeRaw: BrainEngine['executeRaw'] };
  const original = engine.executeRaw;
  let finished = false;
  // Intercept only the precheck's first recovery probe, then hand the engine back untouched.
  engine.executeRaw = (async (sql: string, params?: unknown[], opts?: unknown) => {
    if (finished || !sql.includes('AS publication')) return original.call(engine, sql, params as never, opts as never);
    finished = true;
    engine.executeRaw = original;
    const rows = await original.call(engine, sql, params as never, opts as never);
    await clear();
    return rows;
  }) as BrainEngine['executeRaw'];
  try {
    expect(await refreshWorktree(f.engine, f.alpha, { waitDrainMs: 10_000 })).toMatchObject({ status: 'completed', target_head: target });
    expect(finished).toBe(true);
  } finally { engine.executeRaw = original; await clear(); }
}), 120_000);

test('admission completes a syncing refresh whose members all reached the target, and refuses while one lags', () => each(async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  const [row] = await f.refreshRows();
  // A refresh whose process died in `syncing` after a later cycle sync caught one member up but not the other.
  // #7679: the owner scan completes such a row too, so the consumer is stopped to leave it to admission.
  await disposePersistenceConsumer(f.engine);
  await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET state='syncing',completed_at=NULL WHERE id=$1::uuid`, [row.id]);
  const setLastCommit = (sha: string) => f.engine.transaction(tx => withCoordinatedWrite(tx, [f.beta], () => tx.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [f.beta, sha]), TEST_WRITE_ATTRIBUTION));
  await setLastCommit(git(f.root, 'rev-parse', 'HEAD~1'));
  await refusedWith(f.put(f.alpha, 'notes/lagging', page('Lagging', 'refused')), 'worktree_refreshing');
  await setLastCommit(target);
  expect((await f.put(f.alpha, 'notes/caught-up', page('Caught up', 'admitted'))).state ?? 'committed').toBe('committed');
  const done = await f.refreshRows();
  expect(done.map(r => r.state)).toEqual(['completed']);
  expect(done[0].outcome.completed_by).toBeUndefined();
}), 120_000);

test('#6712 wave: a refresh completes once every member synced to a descendant of the target, and --resume completes it the same way', () => each(async f => {
  const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
  let descendant = '';
  // A commit lands on top of the fast-forwarded target before the member syncs run, so each member syncs past the target.
  const result = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => {
    if (point === 'merged') descendant = commitFile(f.root, 'alpha/three.md', page('Alpha three', 'Committed on top of the target.'));
  } } });
  expect(git(f.root, 'merge-base', '--is-ancestor', target, descendant) === '' && descendant !== target).toBe(true);
  expect(await f.lastCommit(f.alpha)).toBe(descendant);
  expect(await f.lastCommit(f.beta)).toBe(descendant);
  expect(result).toMatchObject({ status: 'completed', target_head: target });
  expect(result.next).toBeUndefined();
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['completed']);
  expect((await f.put(f.alpha, 'notes/after-descendant', page('After', 'admitted'))).state ?? 'committed').toBe('committed');
  // A refresh left in syncing (its process died) whose members already synced past the target completes on --resume.
  // #7679: the owner scan would complete it on its own, so the consumer is stopped to leave it to --resume.
  await disposePersistenceConsumer(f.engine);
  const [row] = await f.refreshRows();
  await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET state='syncing',completed_at=NULL WHERE id=$1::uuid`, [row.id]);
  expect(await refreshWorktree(f.engine, f.alpha, { resume: true })).toMatchObject({ status: 'completed', refresh_id: row.id });
  expect((await f.refreshRows()).map(r => r.state)).toEqual(['completed']);
}), 180_000);
