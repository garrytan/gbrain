/**
 * #6932: the canonical writer reclaims a Git index lock that provably belongs to no live process, and never one
 * that a live process may own.
 *
 * Protects: a git step SIGKILLed after it created `index.lock` (a bounded step past its deadline, a job group
 * killed after its grace, the OOM killer) left a 0-byte lock, and every later Git effect in that checkout
 * reported git_index_locked, then git_index_stale, and parked until a person removed the lock. Now the writer,
 * while it holds its writer lock, proves the lock abandoned (no process has it open, no git runs in the checkout,
 * it is empty or stale) and reclaims it with a receipt; anything short of proof keeps the lock and names why.
 * Seams: none for git. Real repositories, a real git killed with SIGKILL while it holds the lock (a clean
 * filter that blocks inside `git add`), real live holders, a real native writer lock. Where this process
 * cannot see the whole process table (macOS, a container, hidepid), the same cases assert the refusal instead.
 */
import { afterEach, expect, test } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitGitTargets, gitStepTimeoutMs, INDEX_LOCK_GRACE_FOR_TESTS } from '../src/core/persistence/effect-git.ts';
import { processTableBlind, proveIndexLockAbandoned, readIndexLockReclaims, reclaimIndexLock, RECLAIM_MIN_AGE_MS } from '../src/core/persistence/index-lock-reclaim.ts';
import { tryAcquireNativeLock } from '../src/core/persistence/native-lock.ts';
import { checkParkedEffects } from '../src/commands/doctor/checks/parked-effects.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { randomUUID } from 'node:crypto';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { durableGitRepo } from './helpers/git-publication.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const blind = processTableBlind();
const scratch: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): { root: string; home: string; lock: string } {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-reclaim-'));
  const home = mkdtempSync(join(tmpdir(), 'gbrain-reclaim-home-'));
  scratch.push(root, home);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  writeFileSync(join(root, 'a.md'), 'first\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
  writeFileSync(join(root, 'a.md'), 'second\n');
  return { root, home, lock: join(root, '.git', 'index.lock') };
}
const age = (path: string, ms: number) => { const t = (Date.now() - ms) / 1000; utimesSync(path, t, t); };
const until = async (done: () => boolean, ms = 20_000) => {
  for (const deadline = Date.now() + ms; !done() && Date.now() < deadline;) await Bun.sleep(10);
  expect(done()).toBe(true);
};
/** Another user's git on this host (a CI agent, a system service) cannot be inspected, so it blocks every proof while it runs. */
const foreignGit = () => process.platform === 'linux' && readdirSync('/proc').some(pid => {
  if (!/^\d+$/.test(pid)) return false;
  try { if (!readFileSync(`/proc/${pid}/comm`, 'utf8').startsWith('git')) return false; } catch { return false; }
  try { readdirSync(`/proc/${pid}/fd`); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EACCES'; }
});
/** Whether a reclaim can be proven here now: the process table is visible and no uninspectable git runs (waited out up to 30 s). */
async function canProve(): Promise<boolean> {
  if (blind) return false;
  for (const deadline = Date.now() + 30_000; foreignGit() && Date.now() < deadline;) await Bun.sleep(100);
  return !foreignGit();
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function writerLock(home: string) {
  const lock = await tryAcquireNativeLock(join(home, 'writer.lock'));
  expect(lock).not.toBeNull();
  return lock!;
}

/**
 * A real `git add` that creates the index lock and then blocks in a clean filter, so it holds an empty
 * index.lock for as long as the test wants. Returns git's pid (the filter's parent) and the filter's.
 */
async function gitHoldingLock(root: string, lock: string): Promise<{ git: number; filter: number }> {
  const pids = join(root, '.git', 'filter-pids');
  git(root, 'config', 'filter.blocking.clean', `echo "$PPID $$" > '${pids}'; exec sleep 120`);
  writeFileSync(join(root, '.git', 'info', 'attributes'), 'a.md filter=blocking\n');
  const child = spawn('git', ['-C', root, 'add', 'a.md'], { stdio: 'ignore' });
  children.push(child);
  await until(() => existsSync(pids) && readFileSync(pids, 'utf8').trim().split(' ').length === 2);
  const [gitPid, filterPid] = readFileSync(pids, 'utf8').trim().split(' ').map(Number);
  expect(existsSync(lock)).toBe(true);
  expect(statSync(lock).size).toBe(0);
  return { git: gitPid!, filter: filterPid! };
}
function dropFilter(root: string) {
  writeFileSync(join(root, '.git', 'info', 'attributes'), '');
  git(root, 'config', '--unset', 'filter.blocking.clean');
}

test('probe: a git SIGKILLed while it holds the index lock leaves a 0-byte lock, and the writer reclaims it and commits', async () => {
  const { root, home, lock } = repo();
  const held = await gitHoldingLock(root, lock);
  process.kill(held.git, 'SIGKILL');
  process.kill(held.filter, 'SIGKILL');
  await until(() => !alive(held.git) && !alive(held.filter));
  dropFilter(root);
  expect(existsSync(lock)).toBe(true);
  expect(statSync(lock).size).toBe(0);
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const writer = await writerLock(home);
    const reclaims: unknown[] = [];
    const owner = { writerLock: writer, onReclaim: (receipt: unknown) => { reclaims.push(receipt); } };
    // A lock created moments ago may belong to a git that just started: it is waited out as contention.
    await expect(commitGitTargets(root, ['a.md'], undefined, undefined, owner)).rejects.toMatchObject({ code: 'git_index_locked' });
    expect(existsSync(lock)).toBe(true);
    age(lock, RECLAIM_MIN_AGE_MS + 1_000);
    if (!(await canProve())) {
      await expect(commitGitTargets(root, ['a.md'], undefined, undefined, owner)).rejects.toMatchObject({ code: 'git_index_locked' });
      expect(existsSync(lock)).toBe(true);
      expect(reclaims).toEqual([]);
    } else {
      expect((await commitGitTargets(root, ['a.md'], undefined, undefined, owner)).get('a.md')).toEqual({ git: 'committed' });
      expect(existsSync(lock)).toBe(false);
      expect(git(root, 'show', 'HEAD:a.md')).toBe('second\n');
      expect(reclaims).toEqual([expect.objectContaining({ checkout: root, lock, size: 0 })]);
      expect(readIndexLockReclaims()).toEqual([expect.objectContaining({ checkout: root, lock, size: 0, pid: process.pid })]);
      const doctor = await checkParkedEffects({ executeRaw: async (sql: string) => sql.includes('COUNT(*)') ? [{ count: 0 }] : [] } as unknown as BrainEngine);
      expect(doctor).toMatchObject({ status: 'ok', details: { parked_effects: 0, index_lock_reclaims: { last_7_days: 1, latest: { checkout: root, lock, size: 0 } } } });
      expect(doctor.message).toContain('reclaimed 1 abandoned Git index lock(s) in the last 7 days');
    }
    await writer.release();
  });
}, 60_000);

test('probe: a lock a live git holds is never reclaimed, however old, and the refusal names the live git', async () => {
  const { root, home, lock } = repo();
  const held = await gitHoldingLock(root, lock);
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const writer = await writerLock(home);
    const owner = { writerLock: writer };
    age(lock, RECLAIM_MIN_AGE_MS + 30_000);
    await expect(commitGitTargets(root, ['a.md'], undefined, undefined, owner)).rejects.toMatchObject({ code: 'git_index_locked' });
    expect(existsSync(lock)).toBe(true);
    age(lock, INDEX_LOCK_GRACE_FOR_TESTS + 60_000);
    const stale = await commitGitTargets(root, ['a.md'], undefined, undefined, owner).catch(error => error);
    expect(stale).toMatchObject({ code: 'git_index_stale', detail: lock,
      suggestion: expect.stringContaining(blind ?? `process ${held.git} (git`),
      fix: { ask_user: true, actor: 'user', user_message: expect.stringContaining(lock), verify: { argv: ['gbrain', 'sources', 'writer', 'status', '--json'] } } });
    expect(existsSync(lock)).toBe(true);
    expect(alive(held.git)).toBe(true);
    expect(readIndexLockReclaims()).toEqual([]);
    await writer.release();
  });
}, 60_000);

test('probe: a lock any live process holds open is never reclaimed', async () => {
  const { root, home, lock } = repo();
  writeFileSync(lock, '');
  const fd = openSync(lock, 'r');
  const holder = spawn('sleep', ['120'], { stdio: [fd, 'ignore', 'ignore'] });
  children.push(holder);
  closeSync(fd);
  await until(() => holder.pid !== undefined && existsSync(`/proc/${holder.pid}/fd/0`) || process.platform !== 'linux');
  age(lock, INDEX_LOCK_GRACE_FOR_TESTS + 60_000);
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const writer = await writerLock(home);
    await expect(commitGitTargets(root, ['a.md'], undefined, undefined, { writerLock: writer })).rejects.toMatchObject({ code: 'git_index_stale',
      suggestion: expect.stringContaining(blind ?? `process ${holder.pid} (sleep) has the lock open`) });
    expect(existsSync(lock)).toBe(true);
    await writer.release();
  });
}, 60_000);

test('probe: a live git running in the checkout, or pointed at it through GIT_DIR, blocks a reclaim even when no process has the lock open', async () => {
  const { root, home, lock } = repo();
  writeFileSync(lock, '');
  age(lock, INDEX_LOCK_GRACE_FOR_TESTS + 60_000);
  const elsewhere = mkdtempSync(join(tmpdir(), 'gbrain-reclaim-elsewhere-'));
  scratch.push(elsewhere);
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const writer = await writerLock(home);
    for (const [args, options] of [[['-C', root, 'hash-object', '--stdin'], {}], [['cat-file', '--batch'], { cwd: elsewhere, env: { ...process.env, GIT_DIR: join(root, '.git') } }]] as const) {
      const live = spawn('git', [...args], { stdio: ['pipe', 'ignore', 'ignore'], ...options });
      children.push(live);
      await until(() => live.pid !== undefined && alive(live.pid));
      await Bun.sleep(200);
      await expect(commitGitTargets(root, ['a.md'], undefined, undefined, { writerLock: writer })).rejects.toMatchObject({ code: 'git_index_stale',
        suggestion: expect.stringContaining(blind ?? 'git process ') });
      expect(existsSync(lock)).toBe(true);
      live.kill('SIGKILL');
      await until(() => !alive(live.pid!));
    }
    if (await canProve()) {
      expect((await commitGitTargets(root, ['a.md'], undefined, undefined, { writerLock: writer })).get('a.md')).toEqual({ git: 'committed' });
      expect(existsSync(lock)).toBe(false);
    }
    await writer.release();
  });
}, 60_000);

test('probe: a git SIGKILLed mid-commit (holding index.lock in its pre-commit hook) leaves the lock, and the writer recovers and commits', async () => {
  const { root, home, lock } = repo();
  const pids = join(root, '.git', 'hook-pids');
  writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho "$PPID $$" > '${pids}'\nexec sleep 120\n`, { mode: 0o755 });
  const child = spawn('git', ['-C', root, 'commit', '-q', '--only', '-m', 'interrupted', '--', 'a.md'], { stdio: 'ignore' });
  children.push(child);
  await until(() => existsSync(pids) && readFileSync(pids, 'utf8').trim().split(' ').length === 2);
  const [gitPid, hookPid] = readFileSync(pids, 'utf8').trim().split(' ').map(Number);
  expect(existsSync(lock)).toBe(true);
  process.kill(gitPid!, 'SIGKILL');
  process.kill(hookPid!, 'SIGKILL');
  await until(() => !alive(gitPid!) && !alive(hookPid!));
  rmSync(join(root, '.git', 'hooks', 'pre-commit'));
  expect(existsSync(lock)).toBe(true);
  // A commit killed after it wrote its new index leaves a lock with content: a git may still be writing
  // one like it, so it is kept as contention until it is older than the stale threshold.
  expect(statSync(lock).size).toBeGreaterThan(0);
  age(lock, RECLAIM_MIN_AGE_MS + 60_000);
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const writer = await writerLock(home);
    await expect(commitGitTargets(root, ['a.md'], undefined, undefined, { writerLock: writer })).rejects.toMatchObject({ code: 'git_index_locked' });
    expect(existsSync(lock)).toBe(true);
    age(lock, INDEX_LOCK_GRACE_FOR_TESTS + 60_000);
    if (!(await canProve())) {
      await expect(commitGitTargets(root, ['a.md'], undefined, undefined, { writerLock: writer })).rejects.toMatchObject({ code: 'git_index_stale' });
      expect(existsSync(lock)).toBe(true);
    } else {
      expect((await commitGitTargets(root, ['a.md'], undefined, undefined, { writerLock: writer })).get('a.md')).toEqual({ git: 'committed' });
      expect(existsSync(lock)).toBe(false);
      expect(git(root, 'show', 'HEAD:a.md')).toBe('second\n');
      expect(git(root, 'log', '--format=%s')).not.toContain('interrupted');
      expect(readIndexLockReclaims()).toEqual([expect.objectContaining({ lock, size: expect.any(Number) })]);
    }
    await writer.release();
  });
}, 60_000);

test('a lock replaced between the proof and the reclaim (a new git took it) is put back and never removed', async () => {
  const { root, home, lock } = repo();
  writeFileSync(lock, '');
  age(lock, RECLAIM_MIN_AGE_MS + 1_000);
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const proof = proveIndexLockAbandoned(lock, root, INDEX_LOCK_GRACE_FOR_TESTS);
    if (!(await canProve())) { expect(proof).toMatchObject({ abandoned: false }); return; }
    expect(proof).toMatchObject({ abandoned: true, size: 0 });
    // A new git removes nothing of ours: the old lock goes and a new one takes its name (a new inode).
    rmSync(lock);
    writeFileSync(lock, 'new git writing');
    const before = statSync(lock).ino;
    expect(reclaimIndexLock(lock, root, proof as Extract<typeof proof, { abandoned: true }>)).toBeNull();
    expect(existsSync(lock)).toBe(true);
    expect(statSync(lock).ino).toBe(before);
    expect(readFileSync(lock, 'utf8')).toBe('new git writing');
    expect(readIndexLockReclaims()).toEqual([]);
    // A lock that changes while it is being checked fails the proof itself.
    age(lock, -60_000);
    expect(proveIndexLockAbandoned(lock, root, INDEX_LOCK_GRACE_FOR_TESTS)).toMatchObject({ abandoned: false });
  });
}, 60_000);

test('without the writer lock, or with a lock that holds content and is not stale, nothing is reclaimed', async () => {
  const { root, home, lock } = repo();
  await withEnv({ GBRAIN_HOME: home }, async () => {
    writeFileSync(lock, '');
    age(lock, INDEX_LOCK_GRACE_FOR_TESTS + 60_000);
    const writer = await writerLock(home);
    await writer.release();
    await expect(commitGitTargets(root, ['a.md'], undefined, undefined, { writerLock: writer })).rejects.toMatchObject({ code: 'git_index_stale',
      suggestion: expect.stringContaining('does not hold the checkout\'s writer lock') });
    await expect(commitGitTargets(root, ['a.md'])).rejects.toMatchObject({ code: 'git_index_stale' });
    expect(existsSync(lock)).toBe(true);
    writeFileSync(lock, 'partial index');
    age(lock, RECLAIM_MIN_AGE_MS + 60_000);
    const held = await writerLock(home);
    await expect(commitGitTargets(root, ['a.md'], undefined, undefined, { writerLock: held })).rejects.toMatchObject({ code: 'git_index_locked' });
    expect(readFileSync(lock, 'utf8')).toBe('partial index');
    if (await canProve()) {
      age(lock, INDEX_LOCK_GRACE_FOR_TESTS + 60_000);
      expect((await commitGitTargets(root, ['a.md'], undefined, undefined, { writerLock: held })).get('a.md')).toEqual({ git: 'committed' });
      expect(existsSync(lock)).toBe(false);
    }
    await held.release();
  });
}, 60_000);

test('a git step deadline grows with the index size, between 20 seconds and 2 minutes', () => {
  const MiB = 1024 * 1024;
  expect(gitStepTimeoutMs(0)).toBe(20_000);
  expect(gitStepTimeoutMs(200 * 1024)).toBe(22_000);
  expect(gitStepTimeoutMs(39 * MiB)).toBe(98_000);
  expect(gitStepTimeoutMs(1024 * MiB)).toBe(120_000);
});

type GitEffect = { id: number; state: string; error_code: string | null; data: { parked?: { slug?: string; error_code: string }[] } };
const gitEffect = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<GitEffect>(`SELECT e.id,e.state,e.error_code,e.data
  FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.kind='git' AND r.slug=$1`, [slug]))[0]!;
const put = (ctx: OperationContext, slug: string) => submitPageMutation(ctx, { operation: 'put_page',
  params: { slug, request_id: randomUUID(), content: `---\ntype: note\ntitle: ${slug}\n---\n\nBody of ${slug}.\n` } });
/** One writer pass over this effect alone, every other effect deferred. */
async function runOnly(engine: BrainEngine, ctx: OperationContext, id: number) {
  await disposePersistenceConsumer(engine);
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw("UPDATE persistence_effects SET next_attempt_at=CASE WHEN id=$1 THEN now() ELSE now()+interval '1 hour' END", [id]);
  });
  await runPersistenceEffects(engine, ctx.config, { hostId: localHostId(), limit: 1 });
}

test('probe: the writer recovers on its own: a Git effect parked by a held lock commits after the lock is abandoned and reclaimed', async () => {
  await managedBrain(async ({ engine, ctx, root }) => {
    const lock = join(root, '.git', 'index.lock');
    writeFileSync(lock, '');
    age(lock, INDEX_LOCK_GRACE_FOR_TESTS + 60_000);
    const fd = openSync(lock, 'r');
    const holder = spawn('sleep', ['120'], { stdio: [fd, 'ignore', 'ignore'] });
    children.push(holder);
    closeSync(fd);
    await put(ctx, 'notes/first');
    const first = await gitEffect(engine, 'notes/first');
    for (let i = 0; i < 10 && (await gitEffect(engine, 'notes/first')).state !== 'failed'; i++) await runOnly(engine, ctx, first.id);
    // While a live process holds it, the lock parks the effect exactly as before: it is never removed.
    expect(await gitEffect(engine, 'notes/first')).toMatchObject({ state: 'failed', error_code: 'targets_parked',
      data: { parked: [{ slug: 'notes/first', error_code: 'git_index_stale' }] } });
    expect(existsSync(lock)).toBe(true);
    holder.kill('SIGKILL');
    await until(() => !alive(holder.pid!));

    // The holder is gone. The next write's Git effect proves the lock abandoned, reclaims it, commits, and
    // gives the effect the lock had parked its one more attempt, with no operator step.
    await put(ctx, 'notes/second');
    const second = await gitEffect(engine, 'notes/second');
    await runOnly(engine, ctx, second.id);
    if (!(await canProve())) {
      expect(existsSync(lock)).toBe(true);
      expect(await gitEffect(engine, 'notes/first')).toMatchObject({ state: 'failed', error_code: 'targets_parked' });
      return;
    }
    expect(existsSync(lock)).toBe(false);
    expect(await gitEffect(engine, 'notes/second')).toMatchObject({ state: 'committed', error_code: null });
    expect(await gitEffect(engine, 'notes/first')).toMatchObject({ state: 'queued' });
    await runOnly(engine, ctx, first.id);
    expect(await gitEffect(engine, 'notes/first')).toMatchObject({ state: 'committed', error_code: null });
    const log = git(root, 'log', '--name-only', '--pretty=format:');
    expect(log).toContain('notes/first.md');
    expect(log).toContain('notes/second.md');
    expect(readIndexLockReclaims()).toEqual([expect.objectContaining({ lock, size: 0 })]);
    const doctor = await checkParkedEffects(engine);
    expect(doctor).toMatchObject({ status: 'ok', details: { parked_effects: 0, index_lock_reclaims: { last_7_days: 1 } } });
  }, { setup: ({ root }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); } });
}, 120_000);
