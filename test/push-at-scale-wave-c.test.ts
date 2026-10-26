/**
 * Wave C 1A (spec §10 1A, §4.4, §17 default 4 / eng-r3-native-3): pushes that scale with what they send
 * (src/core/persistence/push-preflight.ts), through the Git effect's push (pushGitRoot) and gbrain git commit-push.
 * Protects:
 *   - a push through a throttled remote (a pre-receive hook that sleeps) succeeds under the deadline scaled to its bytes;
 *     the forced probe pins master's fixed deadline (pushTiming.msPerMiB = 0) and the same push times out;
 *   - a remote that refuses packs over a threshold (receive.maxInputSize) receives the unpushed range in ordered batches
 *     under git.push_max_pack_bytes, each a fast-forward of the branch;
 *   - a push stopped between batches records the last pushed commit and the next run resumes after it;
 *   - a remote that moved, with a range over the cap: every batch goes to refs/gbrain/push-staging/<branch>, the
 *     in-memory merge goes to the branch last, and the staging ref is deleted;
 *   - a single commit over the cap holds git_push_pack_too_large with its numbers and pushes nothing;
 *   - a branch with no push remote skips the preflight and the backstop; a clean push is one push, as before.
 * Seams: pushTiming and pushSeams.afterBatch; real repositories and a local bare remote otherwise.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { pushGitRoot } from '../src/core/persistence/effect-git.ts';
import { PUSH_MAX_PACK_BYTES_ENV, PUSH_TIMEOUT_CAP_MS, pushRange, pushSeams, pushTiming, pushTimeoutMs, planBatches, parseByteSize, pushCap, readPushProgress } from '../src/core/persistence/push-preflight.ts';
import { git } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';

const MiB = 1024 ** 2;
const homes: string[] = [];
const timing = { ...pushTiming };
afterEach(() => {
  Object.assign(pushTiming, timing);
  pushSeams.afterBatch = undefined;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

interface Repo { home: string; root: string; remote: string; log: string }

/** A checkout on main tracking a bare remote whose post-receive hook logs every ref update ("old new ref"). */
function repo(): Repo {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-push-scale-')));
  homes.push(home);
  const root = join(home, 'brain'), remote = join(home, 'remote.git'), log = join(home, 'updates.log');
  git(home, 'init', '-q', '--bare', '-b', 'main', remote);
  writeFileSync(join(remote, 'hooks', 'post-receive'), '#!/bin/sh\ncat >> \'' + log + '\'\n');
  chmodSync(join(remote, 'hooks', 'post-receive'), 0o755);
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(root, 'initial.md'), 'Initial\n');
  git(root, 'add', 'initial.md'); git(root, 'commit', '-q', '-m', 'Initial');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', '-u', 'origin', 'main');
  writeFileSync(log, '');
  return { home, root, remote, log };
}

/** Commits a file of incompressible bytes; returns the commit. */
function commitBlob(root: string, name: string, bytes: number): string {
  writeFileSync(join(root, name), randomBytes(bytes));
  git(root, 'add', name); git(root, 'commit', '-q', '-m', 'Add ' + name);
  return git(root, 'rev-parse', 'HEAD').trim();
}

const updates = (r: Repo) => readFileSync(r.log, 'utf8').split('\n').filter(Boolean).map(line => { const [from, to, ref] = line.split(' '); return { from, to, ref }; });
const remoteTip = (r: Repo, ref = 'refs/heads/main') => git(r.remote, 'rev-parse', ref).trim();
const remoteHas = (r: Repo, ref: string) => git(r.remote, 'for-each-ref', '--format=%(refname)', ref).trim() !== '';
const env = (cap?: number) => ({ GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1', [PUSH_MAX_PACK_BYTES_ENV]: cap === undefined ? undefined : String(cap) });

describe('Wave C 1A: push sizing', () => {
  test('the deadline is 20 s plus 1 s per MiB, capped at an hour; sizes parse; github.com caps at 2 GiB', () => {
    expect(pushTimeoutMs(0)).toBe(20_000);
    expect(pushTimeoutMs(300 * MiB)).toBe(320_000);
    expect(pushTimeoutMs(10 * 1024 * MiB)).toBe(3_600_000);
    expect([parseByteSize('1.5GiB'), parseByteSize('1536MiB'), parseByteSize('4096'), parseByteSize('1.5'), parseByteSize('-1'), parseByteSize('lots')])
      .toEqual([1.5 * 1024 * MiB, 1536 * MiB, 4096, null, null, null]);
    expect(pushCap(null, ['/srv/remote.git'])).toBe(1.5 * 1024 * MiB);
    expect(pushCap(3 * 1024 * MiB, ['git@github.com:acme-example/brain.git'])).toBe(2 * 1024 * MiB);
    expect(pushCap(3 * 1024 * MiB, ['https://git.example.invalid/brain.git'])).toBe(3 * 1024 * MiB);
    expect(planBatches([{ sha: 'a', bytes: 2 }, { sha: 'b', bytes: 2 }, { sha: 'c', bytes: 3 }, { sha: 'd', bytes: 1 }], 4))
      .toEqual({ batches: [{ end: 'b', bytes: 4 }, { end: 'd', bytes: 4 }] });
    expect(planBatches([{ sha: 'a', bytes: 2 }, { sha: 'b', bytes: 5 }], 4)).toEqual({ tooLarge: { sha: 'b', bytes: 5 } });
  });
});

describe('Wave C 1A: a push through a throttled remote', () => {
  const throttle = (r: Repo) => {
    writeFileSync(join(r.remote, 'hooks', 'pre-receive'), '#!/bin/sh\ncat >/dev/null\nsleep 3\n');
    chmodSync(join(r.remote, 'hooks', 'pre-receive'), 0o755);
  };

  test('succeeds under the deadline scaled to its bytes (the Git effect push)', () => withEnv(env(), async () => {
    const r = repo();
    const tip = commitBlob(r.root, 'large.bin', 8 * MiB);
    throttle(r);
    Object.assign(pushTiming, { baseMs: 1_000, msPerMiB: 4_000 });
    expect(await pushGitRoot(r.root)).toEqual({ push: 'committed' });
    expect(remoteTip(r)).toBe(tip);
  }), 120_000);

  test('forced probe: master\'s fixed deadline (no per-MiB budget) times the same push out', () => withEnv(env(), async () => {
    const r = repo();
    commitBlob(r.root, 'large.bin', 8 * MiB);
    const before = remoteTip(r);
    throttle(r);
    Object.assign(pushTiming, { baseMs: 1_000, msPerMiB: 0 });
    await expect(pushGitRoot(r.root)).rejects.toMatchObject({ code: 'git_unavailable', message: expect.stringContaining('did not finish within its bounded attempt') });
    expect(remoteTip(r)).toBe(before);
  }), 120_000);
});

describe('Wave C 1A: batches under git.push_max_pack_bytes', () => {
  /** Four commits of 1.2 MiB each; the remote refuses any pack over 3 MiB, and the cap is 2.5 MiB. */
  const range = (r: Repo) => {
    git(r.remote, 'config', 'receive.maxInputSize', String(3 * MiB));
    return [1, 2, 3, 4].map(i => commitBlob(r.root, 'part-' + i + '.bin', 1.2 * MiB));
  };

  test('forced probe: without batching the remote refuses the whole range', () => withEnv(env(), async () => {
    const r = repo();
    range(r);
    const before = remoteTip(r);
    expect(() => git(r.root, 'push', '-q', 'origin', 'HEAD:main')).toThrow();
    expect(remoteTip(r)).toBe(before);
  }), 120_000);

  test('the range goes in ordered batches, each a fast-forward of the branch', () => withEnv(env(2.5 * MiB), async () => {
    const r = repo();
    const [, second, , fourth] = range(r);
    const result = commitAndPush({ repo: r.root, pushOnly: true, cwd: r.root });
    expect(result).toMatchObject({ outcome: 'pushed', sha: fourth });
    expect(updates(r).map(u => [u.to, u.ref])).toEqual([[second, 'refs/heads/main'], [fourth, 'refs/heads/main']]);
    expect(readPushProgress(join(r.root, '.git'))).toBeNull();
  }), 120_000);

  test('a push stopped between batches resumes after the recorded commit', () => withEnv(env(2.5 * MiB), async () => {
    const r = repo();
    const [, second, , fourth] = range(r);
    pushSeams.afterBatch = () => { throw new Error('killed between batches'); };
    expect(() => commitAndPush({ repo: r.root, pushOnly: true, cwd: r.root })).toThrow('killed between batches');
    expect(readPushProgress(join(r.root, '.git'))).toMatchObject({ ref: 'refs/heads/main', pushed: second, staging: null });
    expect(remoteTip(r)).toBe(second);
    pushSeams.afterBatch = undefined;
    expect(commitAndPush({ repo: r.root, pushOnly: true, cwd: r.root })).toMatchObject({ outcome: 'pushed', sha: fourth });
    expect(updates(r).map(u => [u.from, u.to])).toEqual([[expect.any(String), second], [second, fourth]]);
    expect(readPushProgress(join(r.root, '.git'))).toBeNull();
  }), 120_000);

  test('a moved remote: batches go to the staging ref, the merge goes to the branch last, and the staging ref is deleted', () => withEnv(env(2.5 * MiB), async () => {
    const r = repo();
    const other = join(r.home, 'other');
    git(r.home, 'clone', '-q', r.remote, other);
    git(other, 'config', 'user.name', 'Other Machine'); git(other, 'config', 'user.email', 'other@example.invalid');
    writeFileSync(join(other, 'other.md'), 'From the other machine\n');
    git(other, 'add', 'other.md'); git(other, 'commit', '-q', '-m', 'Other'); git(other, 'push', '-q');
    const theirs = git(other, 'rev-parse', 'HEAD').trim();
    writeFileSync(r.log, '');
    const [, second, , fourth] = range(r);
    const result = commitAndPush({ repo: r.root, pushOnly: true, keepCheckout: true, cwd: r.root });
    expect(result).toMatchObject({ outcome: 'pushed', integrated: 1, checkout: 'unchanged' });
    const merge = remoteTip(r);
    expect(git(r.remote, 'rev-list', '--parents', '-n', '1', merge).trim().split(' ').slice(1).sort()).toEqual([fourth, theirs].sort());
    const landed = updates(r).filter(u => u.from !== u.to);
    const staged = landed.filter(u => u.ref === 'refs/gbrain/push-staging/main' && !/^0+$/.test(u.to!));
    expect(staged.map(u => u.to)).toEqual([second, merge]);
    expect(landed.filter(u => u.ref === 'refs/heads/main').map(u => u.to)).toEqual([merge]);
    expect(landed.findIndex(u => u.ref === 'refs/heads/main')).toBeGreaterThan(landed.indexOf(staged.at(-1)!));
    expect(remoteHas(r, 'refs/gbrain/push-staging/main')).toBe(false);
    expect(git(r.root, 'rev-parse', 'HEAD').trim()).toBe(fourth);
  }), 120_000);

  test('a single commit over the cap holds git_push_pack_too_large with its numbers and pushes nothing', () => withEnv(env(2 * MiB), async () => {
    const r = repo();
    const before = remoteTip(r);
    const big = commitBlob(r.root, 'big.bin', 3 * MiB);
    let caught: any;
    try { commitAndPush({ repo: r.root, pushOnly: true, cwd: r.root }); } catch (error) { caught = error; }
    expect(caught?.code).toBe('git_push_pack_too_large');
    const detail = JSON.parse(caught.detail);
    expect(detail).toMatchObject({ commit: big, cap: 2 * MiB });
    expect(detail.bytes).toBeGreaterThan(2 * MiB);
    const [raised, ...argv] = [caught.fix.argv[4], ...caught.fix.argv.slice(0, 4)];
    expect(Number(raised)).toBeGreaterThan(detail.bytes);
    expect({ ask_user: caught.fix.ask_user, argv }).toEqual({ ask_user: true, argv: ['gbrain', 'config', 'set', 'git.push_max_pack_bytes'] });
    expect(remoteTip(r)).toBe(before);
    expect(updates(r)).toEqual([]);
  }), 120_000);
});

describe('Wave C 1A: pushes that need no preflight', () => {
  test('a branch with no push remote skips the preflight and the backstop', () => withEnv(env(), async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-push-scale-')));
    homes.push(home);
    git(home, 'init', '-q', '-b', 'main');
    git(home, 'config', 'user.name', 'Example Writer'); git(home, 'config', 'user.email', 'writer@example.invalid');
    writeFileSync(join(home, 'big.md'), 'x'.repeat(25 * MiB) + '\n-----BEGIN RSA PRIVATE KEY-----\n' + 'A'.repeat(64) + '\n-----END RSA PRIVATE KEY-----\n');
    git(home, 'add', 'big.md'); git(home, 'commit', '-q', '-m', 'Unpushable');
    expect(await pushGitRoot(home)).toEqual({ push: 'skipped', reason: 'no_tracking_remote' });
    expect(existsSync(join(home, '.git', 'gbrain-push-progress.json'))).toBe(false);
    expect(existsSync(join(home, '.git', 'gbrain-scan-cleared'))).toBe(false);
  }), 120_000);

  test('a clean push is one push of the tip to the branch, as before', () => withEnv(env(), async () => {
    const r = repo();
    writeFileSync(join(r.root, 'note.md'), 'A small note\n');
    git(r.root, 'add', 'note.md'); git(r.root, 'commit', '-q', '-m', 'Note');
    const tip = git(r.root, 'rev-parse', 'HEAD').trim();
    expect(await pushGitRoot(r.root)).toEqual({ push: 'committed' });
    expect(updates(r).map(u => [u.to, u.ref])).toEqual([[tip, 'refs/heads/main']]);
  }), 120_000);
});

describe('Wave C 1A review: progress and measurement', () => {
  test('progress recorded toward one remote is not reused after the remote changes: the new remote gets every batch', () => withEnv(env(2.5 * MiB), async () => {
    const r = repo();
    git(r.remote, 'config', 'receive.maxInputSize', String(3 * MiB));
    const [, second, , fourth] = [1, 2, 3, 4].map(i => commitBlob(r.root, 'part-' + i + '.bin', 1.2 * MiB));
    pushSeams.afterBatch = () => { throw new Error('killed between batches'); };
    expect(() => commitAndPush({ repo: r.root, pushOnly: true, cwd: r.root })).toThrow('killed between batches');
    expect(readPushProgress(join(r.root, '.git'))).toMatchObject({ pushed: second, urls: [r.remote] });
    pushSeams.afterBatch = undefined;
    const moved = join(r.home, 'moved.git'), movedLog = join(r.home, 'moved.log');
    git(r.home, 'clone', '-q', '--bare', '--branch', 'main', r.remote, moved);
    git(moved, 'update-ref', 'refs/heads/main', 'refs/heads/main~2');
    git(moved, 'config', 'receive.maxInputSize', String(3 * MiB));
    writeFileSync(join(moved, 'hooks', 'post-receive'), '#!/bin/sh\ncat >> \'' + movedLog + '\'\n');
    chmodSync(join(moved, 'hooks', 'post-receive'), 0o755);
    git(moved, 'gc', '-q', '--prune=now');
    git(r.root, 'remote', 'set-url', 'origin', moved);
    expect(commitAndPush({ repo: r.root, pushOnly: true, cwd: r.root })).toMatchObject({ outcome: 'pushed', sha: fourth });
    expect(readFileSync(movedLog, 'utf8').split('\n').filter(Boolean).map(line => line.split(' ')[1])).toEqual([second, fourth]);
    expect(readPushProgress(join(r.root, '.git'))).toBeNull();
  }), 120_000);

  test('an unmeasured push goes as one push with the longest deadline; an unmeasured batch plan pushes nothing', () => {
    const pushes: Array<[string[], number]> = [];
    const io = (measure: (args: string[]) => boolean) => ({
      gitDir: realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-push-unmeasured-'))), remote: 'origin', urls: ['/srv/remote.git'],
      git: (args: string[]) => args.includes('--disk-usage')
        ? (measure(args) ? { code: 0, stdout: String(5 * MiB), stderr: '' } : { code: 128, stdout: '', stderr: 'unsupported' })
        : args[0] === 'rev-list' ? { code: 0, stdout: 'c1\nc2\n', stderr: '' } : { code: 1, stdout: '', stderr: '' },
      push: (refspecs: string[], timeoutMs: number) => { pushes.push([refspecs, timeoutMs]); return { code: 0, stdout: '', stderr: '' }; },
    });
    const single = io(() => false);
    homes.push(single.gitDir);
    expect(pushRange(single, { tip: 'c2', ref: 'refs/heads/main', cap: MiB, remoteTip: null }).code).toBe(0);
    expect(pushes).toEqual([[['c2:refs/heads/main'], PUSH_TIMEOUT_CAP_MS]]);
    pushes.length = 0;
    const batched = io(args => args.includes('--remotes=origin') && args.length === 6);
    homes.push(batched.gitDir);
    const result = pushRange(batched, { tip: 'c2', ref: 'refs/heads/main', cap: MiB, remoteTip: null });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 1, stderr: expect.stringContaining('could not measure') });
    expect(pushes).toEqual([]);
  });
});
