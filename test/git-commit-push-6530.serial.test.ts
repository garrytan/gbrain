/**
 * #6530: shared-checkout-safe commit, push and pull. Real git against local
 * bare remotes. Pins the protocol in src/core/git/commit-push.ts: a short
 * commit lock and a separate publish lock per checkout, path-scoped commits, remote commits merged in memory,
 * the checkout advanced fast-forward only, nothing ever rebased or stashed.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireCommitLock, commitAndPush, commitPathsLocked, pullShared, readIntegrateConflict } from '../src/core/git/commit-push.ts';
import { getLastPushOutcome } from '../src/core/brain-repo-durability.ts';

let root: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', env: process.env,
  }).trim();
}

function clone(bare: string, name: string): string {
  const dir = join(root, name);
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, dir], { stdio: 'ignore', env: process.env });
  git(dir, 'config', 'user.email', `${name}@example.com`);
  git(dir, 'config', 'user.name', name);
  return dir;
}

/** A bare remote plus two clones of it on one branch `main`, seeded with x/y/z. */
function setup(): { bare: string; a: string; b: string } {
  const bare = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore', env: process.env });
  const a = clone(bare, 'a');
  for (const f of ['x.md', 'y.md', 'z.md']) writeFileSync(join(a, f), `${f} v1\n`);
  git(a, 'add', '.'); git(a, 'commit', '-qm', 'seed'); git(a, 'push', '-q', '-u', 'origin', 'main');
  const b = clone(bare, 'b');
  return { bare, a, b };
}

const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');
const status = (dir: string) => execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf-8', env: process.env }).replace(/\n$/, '');
const remoteHead = (bare: string) => git(bare, 'rev-parse', 'refs/heads/main');

function conflictOf(fn: () => unknown): { local: string; remote: string; paths: string[]; structural: string[]; fix: string } {
  try { fn(); } catch (e) {
    const err = e as { code?: string; detail?: string; fix?: unknown; message?: string };
    expect(err.code).toBe('integrate_conflict');
    return { ...JSON.parse(err.detail!), fix: JSON.stringify(err) + String((e as Error).message) };
  }
  throw new Error('expected integrate_conflict');
}

/** Hold an OS lock file in a child (flock) until killed. */
async function holdLock(path: string): Promise<{ kill(): void }> {
  writeFileSync(path, '');
  const holder = spawn('flock', [path, 'sleep', '30'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 300));
  return { kill: () => holder.kill('SIGKILL') };
}

beforeAll(() => { process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1'; });
afterAll(() => { delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT; });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cp6530-')); });
afterEach(() => { delete process.env.BRAIN_COMMIT_LOCK_HELD; delete process.env.GBRAIN_GIT_NO_MERGE_TREE; rmSync(root, { recursive: true, force: true }); });

describe('commit scope', () => {
  test('commits only the named paths; another writer\'s staged and unstaged files stay put', () => {
    const { bare, a } = setup();
    writeFileSync(join(a, 'y.md'), 'staged by another writer\n'); git(a, 'add', 'y.md');
    writeFileSync(join(a, 'z.md'), 'half-written by another writer\n');
    writeFileSync(join(a, 'x.md'), 'mine\n');
    const r = commitAndPush({ repo: a, paths: ['x.md'], message: 'mine', cwd: a });
    expect(r.outcome).toBe('pushed');
    expect(git(bare, 'show', 'main:x.md')).toBe('mine');
    expect(git(bare, 'show', 'main:y.md')).toBe('y.md v1');
    expect(git(bare, 'show', 'main:z.md')).toBe('z.md v1');
    expect(status(a)).toBe('M  y.md\n M z.md');
  });

  test('refuses the whole checkout, paths outside it, .git and an empty list before staging anything', () => {
    const { a } = setup();
    writeFileSync(join(a, 'x.md'), 'dirty\n');
    for (const paths of [['.'], [a], ['../elsewhere.md'], ['.git/config'], []]) {
      expect(() => commitAndPush({ repo: a, paths, message: 'm', cwd: a })).toThrow(expect.objectContaining({ code: 'commit_paths_invalid' }));
    }
    expect(status(a)).toBe(' M x.md');
  });

  test('a staged rename (git mv) commits both sides: no duplicate page, no deletion left staged', () => {
    const { bare, a } = setup();
    git(a, 'mv', 'x.md', 'renamed.md');
    commitAndPush({ repo: a, paths: ['renamed.md'], message: 'rename', cwd: a });
    expect(git(bare, 'ls-tree', '--name-only', 'main').split('\n')).toEqual(['renamed.md', 'y.md', 'z.md']);
    expect(status(a)).toBe('');
  });

  test('nothing to commit still publishes a pending local commit (never reports success over an undelivered one)', () => {
    const { bare, a } = setup();
    writeFileSync(join(a, 'x.md'), 'committed earlier, never pushed\n');
    git(a, 'commit', '-qam', 'pending');
    const pending = git(a, 'rev-parse', 'HEAD');
    const r = commitAndPush({ repo: a, paths: ['y.md'], message: 'noop', cwd: a });
    expect(r.outcome).toBe('nothing_to_commit');
    expect(remoteHead(bare)).toBe(pending);
  });
});

describe('integrate in memory', () => {
  test('a rejected push merges remote commits without touching dirty files; the checkout fast-forwards', () => {
    const { bare, a, b } = setup();
    writeFileSync(join(b, 'y.md'), 'remote edit\n');
    commitAndPush({ repo: b, paths: ['y.md'], message: 'remote', cwd: b });
    writeFileSync(join(a, 'z.md'), 'dirty, unrelated\n');
    writeFileSync(join(a, 'x.md'), 'local edit\n');
    const r = commitAndPush({ repo: a, paths: ['x.md'], message: 'local', cwd: a });
    expect(r).toMatchObject({ outcome: 'pushed', integrated: 1, checkout: 'advanced' });
    expect(remoteHead(bare)).toBe(git(a, 'rev-parse', 'HEAD'));
    expect(git(a, 'log', '-1', '--format=%s')).toBe('gbrain: merge origin/main into main');
    expect(read(a, 'y.md')).toBe('remote edit\n');
    expect(read(a, 'z.md')).toBe('dirty, unrelated\n');
    for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD']) expect(existsSync(join(a, '.git', marker))).toBe(false);
    expect(git(a, 'stash', 'list')).toBe('');
  });

  test('a dirty file the merge must change keeps its bytes: the push lands and the checkout lags', () => {
    const { bare, a, b } = setup();
    writeFileSync(join(b, 'y.md'), 'remote edit\n');
    commitAndPush({ repo: b, paths: ['y.md'], message: 'remote', cwd: b });
    writeFileSync(join(a, 'y.md'), 'in-flight edit by another agent\n');
    writeFileSync(join(a, 'x.md'), 'local edit\n');
    const before = git(a, 'rev-parse', 'HEAD');
    const r = commitAndPush({ repo: a, paths: ['x.md'], message: 'local', cwd: a });
    expect(r.outcome).toBe('pushed_checkout_lagging');
    expect(r.lagging_reason).toContain('y.md');
    expect(read(a, 'y.md')).toBe('in-flight edit by another agent\n');
    expect(git(a, 'rev-parse', 'HEAD')).not.toBe(remoteHead(bare));
    expect(git(a, 'merge-base', '--is-ancestor', before, remoteHead(bare))).toBe('');
    // The lag clears on the next pull once that file is no longer dirty.
    writeFileSync(join(a, 'y.md'), 'y.md v1\n');
    expect(pullShared(a).status).toBe('advanced');
    expect(git(a, 'rev-parse', 'HEAD')).toBe(remoteHead(bare));
  });

  test('a same-file conflict changes nothing; --resolve publishes the chosen side', () => {
    const { bare, a, b } = setup();
    writeFileSync(join(b, 'x.md'), 'remote version\n');
    commitAndPush({ repo: b, paths: ['x.md'], message: 'remote', cwd: b });
    writeFileSync(join(a, 'x.md'), 'local version\n');
    let error: { code?: string; detail?: string } = {};
    try { commitAndPush({ repo: a, paths: ['x.md'], message: 'local', cwd: a }); } catch (e) { error = e as typeof error; }
    expect(error.code).toBe('integrate_conflict');
    expect(JSON.parse(error.detail!).paths).toEqual(['x.md']);
    expect(read(a, 'x.md')).toBe('local version\n');
    expect(git(a, 'status', '--porcelain')).toBe('');
    for (const marker of ['rebase-merge', 'MERGE_HEAD']) expect(existsSync(join(a, '.git', marker))).toBe(false);
    const r = commitAndPush({ repo: a, pushOnly: true, cwd: a, resolutions: new Map([['x.md', { kind: 'theirs' }]]), expectRemote: JSON.parse(error.detail!).remote });
    expect(r.outcome).toBe('pushed');
    expect(git(bare, 'show', 'main:x.md')).toBe('remote version');
    expect(read(a, 'x.md')).toBe('remote version\n');
  });

  test('a non-ASCII conflicted path is reported raw; resolving it as printed publishes exactly the chosen blob', () => {
    const { bare, a, b } = setup();
    const name = 'people/café notes.md';
    mkdirSync(join(a, 'people')); mkdirSync(join(b, 'people'));
    writeFileSync(join(b, name), 'remote version\n');
    commitAndPush({ repo: b, paths: [name], message: 'remote', cwd: b });
    writeFileSync(join(a, name), 'local version\n');
    const c = conflictOf(() => commitAndPush({ repo: a, paths: [name], message: 'local', cwd: a }));
    expect(c.paths).toEqual([name]);
    expect(c.fix).toContain(`'${name}'=ours|theirs`);
    commitAndPush({ repo: a, pushOnly: true, cwd: a, resolutions: new Map([[c.paths[0], { kind: 'theirs' }]]), expectRemote: c.remote });
    expect(git(bare, 'show', `main:${name}`)).toBe('remote version');
    expect(git(bare, 'show', 'main:x.md')).toBe('x.md v1');
  });

  test('a choice binds to the remote commit it was made against: a remote that moved since is reported again', () => {
    const { bare, a, b } = setup();
    writeFileSync(join(b, 'x.md'), 'remote v1\n');
    commitAndPush({ repo: b, paths: ['x.md'], message: 'remote 1', cwd: b });
    writeFileSync(join(a, 'x.md'), 'local\n');
    const c = conflictOf(() => commitAndPush({ repo: a, paths: ['x.md'], message: 'local', cwd: a }));
    writeFileSync(join(b, 'x.md'), 'remote v2, never shown to the user\n');
    commitAndPush({ repo: b, paths: ['x.md'], message: 'remote 2', cwd: b });
    const tip = remoteHead(bare);
    const again = conflictOf(() => commitAndPush({ repo: a, pushOnly: true, cwd: a, resolutions: new Map([['x.md', { kind: 'ours' }]]), expectRemote: c.remote }));
    expect(again.remote).toBe(tip);
    expect(again.fix).toContain('The remote moved');
    expect(remoteHead(bare)).toBe(tip);
  });

  test('a file/directory conflict is refused, never resolved by a per-file choice that could drop a side', () => {
    const { bare, a, b } = setup();
    mkdirSync(join(b, 'topic'));
    writeFileSync(join(b, 'topic', 'remote.md'), 'remote\n');
    commitAndPush({ repo: b, paths: ['topic/remote.md'], message: 'remote dir', cwd: b });
    writeFileSync(join(a, 'topic'), 'local file\n');
    const c = conflictOf(() => commitAndPush({ repo: a, paths: ['topic'], message: 'local file', cwd: a }));
    expect(c.structural.length).toBeGreaterThan(0);
    expect(c.fix).toContain('cannot resolve');
    const tip = remoteHead(bare);
    const choices = new Map(c.paths.map(p => [p, { kind: 'ours' as const }]));
    const refused = conflictOf(() => commitAndPush({ repo: a, pushOnly: true, cwd: a, resolutions: choices, expectRemote: c.remote }));
    expect(refused.structural.length).toBeGreaterThan(0);
    expect(remoteHead(bare)).toBe(tip);
    expect(read(a, 'topic')).toBe('local file\n');
  });

  test('an unresolved conflict is recorded per checkout (put_page / doctor read it) and cleared by the resolving publish', () => {
    const { a, b } = setup();
    writeFileSync(join(b, 'x.md'), 'remote\n');
    commitAndPush({ repo: b, paths: ['x.md'], message: 'remote', cwd: b });
    writeFileSync(join(a, 'x.md'), 'local\n');
    const c = conflictOf(() => commitAndPush({ repo: a, paths: ['x.md'], message: 'local', cwd: a }));
    expect(readIntegrateConflict(a)).toEqual(expect.objectContaining({ branch: 'main', paths: ['x.md'], remote: c.remote }));
    expect(getLastPushOutcome('main', a).status).toBe('needs_attention');
    expect(readIntegrateConflict(b)).toBeNull();
    commitAndPush({ repo: a, pushOnly: true, cwd: a, resolutions: new Map([['x.md', { kind: 'ours' }]]), expectRemote: c.remote });
    expect(readIntegrateConflict(a)).toBeNull();
  });

  test('a push-only retry after the blocking edit clears advances the lagging checkout to the published merge', () => {
    const { bare, a, b } = setup();
    writeFileSync(join(b, 'y.md'), 'remote edit\n');
    commitAndPush({ repo: b, paths: ['y.md'], message: 'remote', cwd: b });
    writeFileSync(join(a, 'y.md'), 'blocking edit\n');
    writeFileSync(join(a, 'x.md'), 'local\n');
    expect(commitAndPush({ repo: a, paths: ['x.md'], message: 'local', cwd: a }).outcome).toBe('pushed_checkout_lagging');
    writeFileSync(join(a, 'y.md'), 'y.md v1\n');
    const r = commitAndPush({ repo: a, pushOnly: true, cwd: a });
    expect(r.checkout).toBe('advanced');
    expect(git(a, 'rev-parse', 'HEAD')).toBe(remoteHead(bare));
    expect(read(a, 'y.md')).toBe('remote edit\n');
  });

  test('git < 2.38 fallback: resolving one file keeps the remote\'s clean changes to other files', () => {
    process.env.GBRAIN_GIT_NO_MERGE_TREE = '1';
    const { bare, a, b } = setup();
    writeFileSync(join(b, 'x.md'), 'remote x\n');
    writeFileSync(join(b, 'y.md'), 'remote y\n');
    commitAndPush({ repo: b, paths: ['x.md', 'y.md'], message: 'remote', cwd: b });
    writeFileSync(join(a, 'x.md'), 'local x\n');
    const c = conflictOf(() => commitAndPush({ repo: a, paths: ['x.md'], message: 'local', cwd: a }));
    expect(c.paths).toEqual(['x.md']);
    commitAndPush({ repo: a, pushOnly: true, cwd: a, resolutions: new Map([['x.md', { kind: 'ours' }]]), expectRemote: c.remote });
    expect(git(bare, 'show', 'main:x.md')).toBe('local x');
    expect(git(bare, 'show', 'main:y.md')).toBe('remote y');
  });

  test('git < 2.38 fallback (3-way read-tree into a temporary index) merges disjoint paths and refuses same-file changes', () => {
    process.env.GBRAIN_GIT_NO_MERGE_TREE = '1';
    const { bare, a, b } = setup();
    writeFileSync(join(b, 'y.md'), 'remote edit\n');
    commitAndPush({ repo: b, paths: ['y.md'], message: 'remote', cwd: b });
    writeFileSync(join(a, 'x.md'), 'local edit\n');
    expect(commitAndPush({ repo: a, paths: ['x.md'], message: 'local', cwd: a }).integrated).toBe(1);
    expect(git(bare, 'show', 'main:y.md')).toBe('remote edit');
    writeFileSync(join(b, 'z.md'), 'b\n');
    pullShared(b);
    commitAndPush({ repo: b, paths: ['z.md'], message: 'b z', cwd: b });
    writeFileSync(join(a, 'z.md'), 'a\n');
    expect(() => commitAndPush({ repo: a, paths: ['z.md'], message: 'a z', cwd: a })).toThrow(expect.objectContaining({ code: 'integrate_conflict' }));
  });
});

describe('advance is a compare-and-swap', () => {
  test('a lockless commit that lands while the push is in flight survives (never checkout -B)', () => {
    const { bare, a, b } = setup();
    writeFileSync(join(b, 'y.md'), 'remote edit\n');
    commitAndPush({ repo: b, paths: ['y.md'], message: 'remote', cwd: b });
    // A git that commits z.md from "another writer" the first time a push runs, then pushes for real.
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env bash
sub=""; i=1
while [ "$i" -le "$#" ]; do a="\${!i}"; case "$a" in -C|-c) i=$((i+2));; -*) i=$((i+1));; *) sub="$a"; break;; esac; done
if [ "$sub" = push ] && [ ! -e "${root}/raced" ]; then
  : > "${root}/raced"
  echo racer > "${a}/z.md"
  "${Bun.which('git')}" -C "${a}" -c user.name=racer -c user.email=r@example.com commit -q --only -m racer -- z.md
fi
exec "${Bun.which('git')}" "$@"
`, { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      writeFileSync(join(a, 'x.md'), 'local edit\n');
      const r = commitAndPush({ repo: a, paths: ['x.md'], message: 'local', cwd: a });
      expect(r.outcome).toBe('pushed_checkout_lagging');
    } finally {
      process.env.PATH = oldPath;
    }
    expect(git(a, 'log', '-1', '--format=%s')).toBe('racer');
    expect(read(a, 'z.md')).toBe('racer\n');
    expect(git(bare, 'show', 'main:x.md')).toBe('local edit');
  });
});

describe('lock', () => {
  test('a held lock makes commit-push fail loudly (commit_lock_busy) and commits nothing', async () => {
    const { a } = setup();
    const lockPath = join(a, '.git', 'brain-commit.lock');
    writeFileSync(lockPath, '');
    const holder = spawn('flock', [lockPath, 'sleep', '20'], { stdio: 'ignore' });
    try {
      await new Promise(r => setTimeout(r, 300));
      writeFileSync(join(a, 'x.md'), 'mine\n');
      expect(() => commitAndPush({ repo: a, paths: ['x.md'], message: 'm', cwd: a, lockWaitMs: 300 }))
        .toThrow(expect.objectContaining({ code: 'commit_lock_busy' }));
      expect(status(a)).toBe(' M x.md');
    } finally { holder.kill('SIGKILL'); }
  }, 30_000);

  test('the re-entrancy marker is honored only when it names this lock and the lock is really held', () => {
    const { a } = setup();
    process.env.BRAIN_COMMIT_LOCK_HELD = join(a, '.git', 'brain-commit.lock');
    const stale = acquireCommitLock(a, 0);
    expect(stale.reentrant).toBe(false);
    const nested = acquireCommitLock(a, 0);
    expect(nested.reentrant).toBe(true);
    process.env.BRAIN_COMMIT_LOCK_HELD = '1';
    expect(() => acquireCommitLock(a, 0)).toThrow(expect.objectContaining({ code: 'commit_lock_busy' }));
    nested.release(); stale.release();
  });

  test('a slow push never blocks commits: the commit lock is free while another publish holds the push lock', async () => {
    const { a } = setup();
    const holder = await holdLock(join(a, '.git', 'brain-publish.lock'));
    try {
      writeFileSync(join(a, 'x.md'), 'page write\n');
      const started = Date.now();
      expect(commitPathsLocked(a, [join(a, 'x.md')], 'gbrain: write-through x', { lockWaitMs: 2000 })).not.toBeNull();
      expect(Date.now() - started).toBeLessThan(2000);
      const deferred = commitAndPush({ repo: a, pushOnly: true, cwd: a, advanceOnlyWhenClean: true });
      expect(deferred.outcome).toBe('push_deferred');
      expect(existsSync(join(a, '.git', 'brain-publish.requested'))).toBe(true);
      writeFileSync(join(a, 'y.md'), 'foreground\n');
      let err: { code?: string } = {};
      try { commitAndPush({ repo: a, paths: ['y.md'], message: 'fg', cwd: a, publishWaitMs: 200 }); } catch (e) { err = e as typeof err; }
      expect(err.code).toBe('push_unconfirmed');
      expect(git(a, 'show', 'HEAD:y.md')).toBe('foreground');
    } finally { holder.kill(); }
  }, 30_000);

  test('a publish that found the push lock busy is honored by the holder after it releases (no stranded commit)', () => {
    const { bare, a } = setup();
    const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env bash
sub=""; i=1
while [ "$i" -le "$#" ]; do a="\${!i}"; case "$a" in -C|-c) i=$((i+2));; -*) i=$((i+1));; *) sub="$a"; break;; esac; done
if [ "$sub" = push ] && [ ! -e "${root}/raced" ]; then
  : > "${root}/raced"
  echo hook > "${a}/w.md"
  "${Bun.which('git')}" -C "${a}" add -- w.md && "${Bun.which('git')}" -C "${a}" commit -q -m "write-through w" -- w.md
  "${process.execPath}" "${cli}" git commit-push --path "${a}" --push-only --require-clean --json > "${root}/deferred.json" 2>/dev/null
fi
exec "${Bun.which('git')}" "$@"
`, { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      writeFileSync(join(a, 'x.md'), 'mine\n');
      commitAndPush({ repo: a, paths: ['x.md'], message: 'mine', cwd: a });
    } finally {
      process.env.PATH = oldPath;
    }
    expect(JSON.parse(read(root, 'deferred.json')).outcome).toBe('push_deferred');
    expect(git(bare, 'show', 'main:w.md')).toBe('hook');
    expect(git(bare, 'show', 'main:x.md')).toBe('mine');
    expect(existsSync(join(a, '.git', 'brain-publish.requested'))).toBe(false);
  }, 60_000);

  test('write-through commits still land path-scoped when another writer holds the lock past the short budget', async () => {
    const { a } = setup();
    const lockPath = join(a, '.git', 'brain-commit.lock');
    writeFileSync(lockPath, '');
    const holder = spawn('flock', [lockPath, 'sleep', '20'], { stdio: 'ignore' });
    try {
      await new Promise(r => setTimeout(r, 300));
      writeFileSync(join(a, 'x.md'), 'page write\n');
      writeFileSync(join(a, 'y.md'), 'other writer\n');
      expect(commitPathsLocked(a, [join(a, 'x.md')], 'gbrain: write-through x', { lockWaitMs: 200 })).not.toBeNull();
      expect(git(a, 'show', 'HEAD:x.md')).toBe('page write');
      expect(status(a)).toBe(' M y.md');
    } finally { holder.kill('SIGKILL'); }
  }, 30_000);
});

describe('pull', () => {
  test('requireClean (the cron) skips on any local edit; the explicit pull advances past unrelated dirt', () => {
    const { a, b } = setup();
    writeFileSync(join(b, 'y.md'), 'remote edit\n');
    commitAndPush({ repo: b, paths: ['y.md'], message: 'remote', cwd: b });
    writeFileSync(join(a, 'z.md'), 'dirty\n');
    expect(pullShared(a, { requireClean: true }).status).toBe('skipped_dirty');
    expect(read(a, 'y.md')).toBe('y.md v1\n');
    expect(pullShared(a).status).toBe('advanced');
    expect(read(a, 'y.md')).toBe('remote edit\n');
    expect(read(a, 'z.md')).toBe('dirty\n');
  });

  test('diverged history merges in memory and never pushes', () => {
    const { bare, a, b } = setup();
    writeFileSync(join(b, 'y.md'), 'remote edit\n');
    commitAndPush({ repo: b, paths: ['y.md'], message: 'remote', cwd: b });
    const remote = remoteHead(bare);
    writeFileSync(join(a, 'x.md'), 'local\n'); git(a, 'commit', '-qam', 'local only');
    const r = pullShared(a);
    expect(r).toMatchObject({ status: 'advanced', merged: true });
    expect(remoteHead(bare)).toBe(remote);
    expect(read(a, 'y.md')).toBe('remote edit\n');
    expect(read(a, 'x.md')).toBe('local\n');
  });

  test('refuses while a rebase is in progress and never deletes its state', () => {
    const { a } = setup();
    mkdirSync(join(a, '.git', 'rebase-merge'));
    writeFileSync(join(a, '.git', 'rebase-merge', 'autostash'), 'deadbeef\n');
    expect(() => pullShared(a)).toThrow(expect.objectContaining({ code: 'git_operation_in_progress' }));
    expect(() => commitAndPush({ repo: a, paths: ['x.md'], message: 'm', cwd: a })).toThrow(expect.objectContaining({ code: 'git_operation_in_progress' }));
    expect(existsSync(join(a, '.git', 'rebase-merge', 'autostash'))).toBe(true);
  });
});

describe('forced probe: the old in-tree rebase vs the new protocol', () => {
  test('pull --rebase --autostash rewrites another writer\'s in-flight edit; commit-push leaves it byte-identical', () => {
    for (const mode of ['old', 'new'] as const) {
      rmSync(root, { recursive: true, force: true }); mkdirSync(root);
      const { a, b } = setup();
      writeFileSync(join(b, 'y.md'), 'remote edit\n');
      commitAndPush({ repo: b, paths: ['y.md'], message: 'remote', cwd: b });
      writeFileSync(join(a, 'y.md'), 'in-flight edit by another agent\n');
      writeFileSync(join(a, 'x.md'), 'mine\n');
      if (mode === 'old') {
        git(a, 'commit', '-q', '--only', '-m', 'mine', '--', 'x.md');
        try { git(a, 'pull', '--rebase', '--autostash', 'origin', 'main'); } catch { /* conflicted autostash */ }
        expect(read(a, 'y.md')).not.toBe('in-flight edit by another agent\n');
      } else {
        commitAndPush({ repo: a, paths: ['x.md'], message: 'mine', cwd: a });
        expect(read(a, 'y.md')).toBe('in-flight edit by another agent\n');
        expect(git(a, 'stash', 'list')).toBe('');
      }
    }
  });
});

describe('many writers, two clones, one remote', () => {
  test('12 concurrent CLI writers: every commit lands, no rebase state, no foreign file committed or lost', async () => {
    const { bare, a, b } = setup();
    const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
    const writers = Array.from({ length: 12 }, (_, i) => ({ dir: i % 2 ? b : a, file: `w${i}.md` }));
    for (const { dir } of writers) writeFileSync(join(dir, `foreign-${dir === a ? 'a' : 'b'}.md`), 'never committed\n');
    const runs = writers.map(({ dir, file }) => new Promise<number>(resolve => {
      writeFileSync(join(dir, file), `${file}\n`);
      const child = spawn(process.execPath, [cli, 'git', 'commit-push', '--path', dir, '-m', `write ${file}`, '--', file], {
        stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GBRAIN_COMMIT_LOCK_WAIT_SECONDS: '120' },
      });
      let err = '';
      child.stderr?.on('data', d => { err += d; });
      child.on('exit', code => { if (code) console.error(`${file}: exit ${code}\n${err}`); resolve(code ?? 1); });
    }));
    const codes = await Promise.all(runs);
    expect(codes).toEqual(writers.map(() => 0));
    const tree = git(bare, 'ls-tree', '--name-only', 'main').split('\n');
    for (const { file } of writers) expect(tree).toContain(file);
    expect(tree.some(f => f.startsWith('foreign-'))).toBe(false);
    for (const dir of [a, b]) {
      expect(existsSync(join(dir, '.git', 'rebase-merge'))).toBe(false);
      expect(git(dir, 'stash', 'list')).toBe('');
      expect(read(dir, `foreign-${dir === a ? 'a' : 'b'}.md`)).toBe('never committed\n');
    }
  }, 180_000);
});
