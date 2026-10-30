/**
 * #7381 (GBRA-180): writer safety in a brain checkout several writers share.
 * Real git against local bare remotes. Pins: integrate never re-applies a
 * change the remote already took (and maybe reverted); gbrain never commits
 * without the lock and never leaves a failed commit's paths staged; commit-push
 * never sweeps another writer's staged files or files outside the source root;
 * the opt-in guard hook refuses branch updates made around gbrain; the helper's
 * no-gbrain fallback releases the commit lock before it pushes.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { commitAndPush, commitPathsLocked, pullShared, readPendingWriteThrough, readQuarantine } from '../src/core/git/commit-push.ts';
import { renderCommitPushHelper } from '../src/core/brain-repo-durability.ts';

let root: string;
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

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

/** A bare remote plus two clones on `main`, seeded with a 20-line page and two other files. */
function setup(): { bare: string; a: string; b: string } {
  const bare = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore', env: process.env });
  const a = clone(bare, 'a');
  writeFileSync(join(a, 'page.md'), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  for (const f of ['x.md', 'y.md']) writeFileSync(join(a, f), `${f} v1\n`);
  git(a, 'add', '.'); git(a, 'commit', '-qm', 'seed'); git(a, 'push', '-q', '-u', 'origin', 'main');
  const b = clone(bare, 'b');
  return { bare, a, b };
}

const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');
const line3 = (text: string) => text.split('\n')[2];
const status = (dir: string) => execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf-8', env: process.env }).replace(/\n$/, '');
const editLine3 = (dir: string, to: string) => writeFileSync(join(dir, 'page.md'), read(dir, 'page.md').replace(/^line 3( .*)?$/m, `line 3 ${to}`));

/** Local commit X on a; b carries X' (the same patch under another commit id) to the remote, then runs `after`. */
function copyUpstream(after: (b: string) => void): { bare: string; a: string; b: string; x: string } {
  const { bare, a, b } = setup();
  editLine3(a, 'LOCAL');
  git(a, 'commit', '-qam', 'X: local edit');
  const x = git(a, 'rev-parse', 'HEAD');
  git(b, 'fetch', '-q', a, 'main');
  git(b, 'cherry-pick', '-x', x);
  after(b);
  git(b, 'push', '-q', 'origin', 'main');
  return { bare, a, b, x };
}

function cli(cwd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

beforeAll(() => { process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1'; });
afterAll(() => { delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT; });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cp7381-')); });
afterEach(() => { delete process.env.GBRAIN_GIT_NO_MERGE_TREE; rmSync(root, { recursive: true, force: true }); });

describe('integrate leaves out local commits the remote already has', () => {
  for (const fallback of [false, true]) {
    test(`a change the remote took and then reverted stays reverted${fallback ? ' (git < 2.38 fallback)' : ''}`, () => {
      if (fallback) process.env.GBRAIN_GIT_NO_MERGE_TREE = '1';
      const { bare, a, x } = copyUpstream(b => git(b, 'revert', '--no-edit', 'HEAD'));
      expect(line3(git(bare, 'show', 'main:page.md') + '\n')).toBe('line 3');
      const r = commitAndPush({ repo: a, pushOnly: true, cwd: a });
      expect(r.outcome).toBe('pushed');
      expect(line3(git(bare, 'show', 'main:page.md') + '\n')).toBe('line 3');
      expect(line3(read(a, 'page.md'))).toBe('line 3');
      expect(git(bare, 'log', '-1', '--format=%B', 'main')).toContain(`whose patch origin/main already has: ${x.slice(0, 12)}`);
      expect(git(a, 'merge-base', '--is-ancestor', x, 'main')).toBe('');
    });
  }

  test('the pull path leaves it out too', () => {
    const { bare, a } = copyUpstream(b => git(b, 'revert', '--no-edit', 'HEAD'));
    expect(pullShared(a)).toMatchObject({ status: 'advanced', merged: true });
    expect(line3(read(a, 'page.md'))).toBe('line 3');
    expect(commitAndPush({ repo: a, pushOnly: true, cwd: a }).outcome).toBe('pushed');
    expect(line3(git(bare, 'show', 'main:page.md') + '\n')).toBe('line 3');
  });

  test('a newer remote edit of the copied line publishes without a conflict and keeps the remote\'s line', () => {
    const { bare, a } = copyUpstream(b => { editLine3(b, 'NEWER'); git(b, 'commit', '-qam', 'Y: newer edit'); });
    writeFileSync(join(a, 'x.md'), 'unique local work\n');
    const r = commitAndPush({ repo: a, paths: ['x.md'], message: 'L: unique', cwd: a });
    expect(r).toMatchObject({ outcome: 'pushed', checkout: 'advanced' });
    expect(line3(git(bare, 'show', 'main:page.md') + '\n')).toBe('line 3 NEWER');
    expect(git(bare, 'show', 'main:x.md')).toBe('unique local work');
    expect(line3(read(a, 'page.md'))).toBe('line 3 NEWER');
  });

  test('a rebased copy (another parent, the same patch) publishes cleanly', () => {
    const { bare, a } = setup();
    editLine3(a, 'LOCAL');
    git(a, 'commit', '-qam', 'X');
    const { b } = { b: join(root, 'b') };
    writeFileSync(join(b, 'y.md'), 'remote first\n');
    git(b, 'commit', '-qam', 'R');
    git(b, 'fetch', '-q', a, 'main');
    git(b, 'cherry-pick', git(a, 'rev-parse', 'HEAD'));
    git(b, 'push', '-q', 'origin', 'main');
    expect(commitAndPush({ repo: a, pushOnly: true, cwd: a }).outcome).toBe('pushed');
    expect(line3(git(bare, 'show', 'main:page.md') + '\n')).toBe('line 3 LOCAL');
    expect(git(bare, 'show', 'main:y.md')).toBe('remote first');
  });

  test('a unique local change to the same line as a remote edit still conflicts (nothing is skipped that the remote lacks)', () => {
    const { a } = copyUpstream(b => { writeFileSync(join(b, 'x.md'), 'remote x\n'); git(b, 'commit', '-qam', 'remote x'); });
    writeFileSync(join(a, 'x.md'), 'local x\n');
    expect(() => commitAndPush({ repo: a, paths: ['x.md'], message: 'local x', cwd: a })).toThrow(expect.objectContaining({ code: 'integrate_conflict' }));
    expect(read(a, 'x.md')).toBe('local x\n');
  });
});

describe('opt-in quarantine', () => {
  /** a and b both change x.md; a also changes y.md, which the remote left alone. */
  function bothChanged() {
    const { bare, a, b } = setup();
    writeFileSync(join(b, 'x.md'), 'remote x\n'); git(b, 'commit', '-qam', 'remote x'); git(b, 'push', '-q', 'origin', 'main');
    writeFileSync(join(a, 'x.md'), 'local x\n');
    writeFileSync(join(a, 'y.md'), 'local y\n');
    return { bare, a };
  }

  test('is off by default: the conflict stops the push and nothing is parked', () => {
    const { bare, a } = bothChanged();
    expect(() => commitAndPush({ repo: a, paths: ['x.md', 'y.md'], message: 'local', cwd: a })).toThrow(expect.objectContaining({ code: 'integrate_conflict' }));
    expect(git(bare, 'show', 'main:y.md')).toBe('y.md v1');
    expect(git(a, 'for-each-ref', 'refs/gbrain/quarantine/')).toBe('');
    expect(readQuarantine(a)).toEqual([]);
  });

  test('when enabled, publishes the rest, parks this machine\'s version under a ref, and never drops it', () => {
    const { bare, a } = bothChanged();
    git(a, 'config', 'gbrain.quarantine', 'true');
    const r = commitAndPush({ repo: a, paths: ['x.md', 'y.md'], message: 'local', cwd: a });
    expect(r.outcome).toBe('pushed');
    expect(r.quarantined?.paths).toEqual(['x.md']);
    expect(git(bare, 'show', 'main:x.md')).toBe('remote x');
    expect(git(bare, 'show', 'main:y.md')).toBe('local y');
    const ref = r.quarantined!.ref;
    expect(ref.startsWith('refs/gbrain/quarantine/')).toBe(true);
    expect(git(a, 'show', `${ref}:x.md`)).toBe('local x');
    expect(git(bare, 'cat-file', '-t', r.quarantined!.local)).toBe('commit');
    expect(git(bare, 'log', '-1', '--format=%B', 'main')).toContain(`under ${ref}: x.md`);
    expect(readQuarantine(a).map(e => e.ref)).toEqual([ref]);
    git(a, 'update-ref', '-d', ref);
    expect(readQuarantine(a)).toEqual([]);
  });

  test('a file/directory conflict is never quarantined', () => {
    const { bare, a, b } = setup();
    rmSync(join(b, 'x.md')); mkdirSync(join(b, 'x.md')); writeFileSync(join(b, 'x.md', 'inner.md'), 'dir\n');
    git(b, 'add', '-A'); git(b, 'commit', '-qm', 'x as dir'); git(b, 'push', '-q', 'origin', 'main');
    git(a, 'config', 'gbrain.quarantine', 'true');
    writeFileSync(join(a, 'x.md'), 'local x\n');
    expect(() => commitAndPush({ repo: a, paths: ['x.md'], message: 'local', cwd: a })).toThrow(expect.objectContaining({ code: 'integrate_conflict' }));
    expect(readQuarantine(a)).toEqual([]);
    expect(git(bare, 'cat-file', '-t', 'main:x.md')).toBe('tree');
  });
});

describe('a commit that does not land leaves nothing staged', () => {
  function refuseCommits(dir: string): void {
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(dir, '.git', 'hooks', 'pre-commit'), 0o755);
  }

  test('commit-push: a refused commit unstages its paths, so a later commit without paths cannot sweep them', () => {
    const { bare, a } = setup();
    refuseCommits(a);
    writeFileSync(join(a, 'x.md'), 'mine, not committed\n');
    mkdirSync(join(a, 'new'), { recursive: true });
    writeFileSync(join(a, 'new', 'page.md'), 'brand new\n');
    expect(() => commitAndPush({ repo: a, paths: ['x.md', 'new'], message: 'm', cwd: a })).toThrow(expect.objectContaining({ code: 'git_unavailable' }));
    expect(status(a)).toBe(' M x.md\n?? new/');
    rmSync(join(a, '.git', 'hooks', 'pre-commit'));
    writeFileSync(join(a, 'y.md'), 'cron\n');
    git(a, 'add', 'y.md');
    git(a, 'commit', '-q', '--no-verify', '-m', 'cron: no pathspec');
    expect(git(a, 'show', '--name-only', '--format=', 'HEAD')).toBe('y.md');
    expect(git(bare, 'show', 'main:x.md')).toBe('x.md v1');
  });

  test('write-through: a refused commit unstages the page and keeps it in the pending ledger', () => {
    const { a } = setup();
    refuseCommits(a);
    writeFileSync(join(a, 'x.md'), 'page write\n');
    expect(() => commitPathsLocked(a, [join(a, 'x.md')], 'gbrain: write-through x', { lockWaitMs: 1000 })).toThrow(expect.objectContaining({ code: 'git_unavailable' }));
    expect(status(a)).toBe(' M x.md');
    expect(readPendingWriteThrough(a).map(e => e.path)).toEqual(['x.md']);
  });

  test('a file staged before the refused commit keeps that staged version, not the newer bytes', () => {
    const { a } = setup();
    writeFileSync(join(a, 'x.md'), 'staged earlier by the caller\n');
    git(a, 'add', 'x.md');
    writeFileSync(join(a, 'x.md'), 'newer bytes\n');
    const staged = git(a, 'ls-files', '-s', 'x.md');
    refuseCommits(a);
    expect(() => commitAndPush({ repo: a, paths: ['x.md'], message: 'm', cwd: a })).toThrow(expect.objectContaining({ code: 'git_unavailable' }));
    expect(git(a, 'ls-files', '-s', 'x.md')).toBe(staged);
    expect(read(a, 'x.md')).toBe('newer bytes\n');
  });
});

describe('commit scope: staged files and source roots', () => {
  test('refuses to sweep files another writer staged under a named directory; naming the file claims it', () => {
    const { bare, a } = setup();
    mkdirSync(join(a, 'daily'), { recursive: true });
    writeFileSync(join(a, 'daily', 'mine.md'), 'mine\n');
    writeFileSync(join(a, 'daily', 'theirs.md'), 'staged by another writer\n');
    git(a, 'add', 'daily/theirs.md');
    let error: { code?: string; detail?: string } = {};
    try { commitAndPush({ repo: a, paths: ['daily'], message: 'daily', cwd: a }); } catch (e) { error = e as typeof error; }
    expect(error.code).toBe('commit_prestaged_paths');
    expect(JSON.parse(error.detail!).paths).toEqual(['daily/theirs.md']);
    expect(status(a)).toBe('A  daily/theirs.md\n?? daily/mine.md');
    expect(commitAndPush({ repo: a, paths: ['daily/mine.md'], message: 'mine', cwd: a }).outcome).toBe('pushed');
    expect(git(bare, 'ls-tree', '--name-only', '-r', 'main', 'daily')).toBe('daily/mine.md');
    expect(status(a)).toBe('A  daily/theirs.md');
  });

  test('with gbrain.sourceRoot set, commits and publishes that change files outside it are refused until the user agrees', () => {
    const { bare, a } = setup();
    mkdirSync(join(a, 'brain'), { recursive: true });
    git(a, 'config', '--add', 'gbrain.sourceRoot', 'brain');
    writeFileSync(join(a, 'x.md'), 'outside the brain\n');
    expect(() => commitAndPush({ repo: a, paths: ['x.md'], message: 'm', cwd: a })).toThrow(expect.objectContaining({ code: 'commit_outside_source_root' }));
    expect(status(a)).toBe(' M x.md');
    // A cron commits the outside file around gbrain; the next publish of a brain page refuses to carry it.
    git(a, 'commit', '-q', '-am', 'cron: swept');
    const before = git(bare, 'rev-parse', 'main');
    writeFileSync(join(a, 'brain', 'page.md'), 'brain page\n');
    let error: { code?: string; detail?: string } = {};
    try { commitAndPush({ repo: a, paths: ['brain/page.md'], message: 'page', cwd: a }); } catch (e) { error = e as typeof error; }
    expect(error.code).toBe('commit_outside_source_root');
    expect(JSON.parse(error.detail!).commits[0].paths).toEqual(['x.md']);
    expect(git(bare, 'rev-parse', 'main')).toBe(before);
    expect(git(a, 'show', 'HEAD:brain/page.md')).toBe('brain page');
    expect(commitAndPush({ repo: a, pushOnly: true, cwd: a, allowOutsideSourceRoot: true }).outcome).toBe('pushed');
    expect(git(bare, 'show', 'main:x.md')).toBe('outside the brain');
  });

  test('write-through stays inside its source root even when the source sits below the toplevel', () => {
    const { a } = setup();
    mkdirSync(join(a, 'brain'), { recursive: true });
    writeFileSync(join(a, 'brain', 'p.md'), 'page\n');
    writeFileSync(join(a, 'x.md'), 'outside\n');
    expect(() => commitPathsLocked(join(a, 'brain'), [join(a, 'x.md')], 'gbrain: write-through x', { lockWaitMs: 1000 })).toThrow(expect.objectContaining({ code: 'commit_outside_source_root' }));
    expect(commitPathsLocked(join(a, 'brain'), [join(a, 'brain', 'p.md')], 'gbrain: write-through p', { lockWaitMs: 1000 })).not.toBeNull();
    expect(status(a)).toBe(' M x.md');
  });

  test('--pending commits and pushes the files write-through could not commit', async () => {
    const { bare, a } = setup();
    const lockPath = join(a, '.git', 'brain-commit.lock');
    writeFileSync(lockPath, '');
    const holder = spawn('flock', ['-o', lockPath, 'sleep', '20'], { stdio: 'ignore' });
    try {
      await new Promise(r => setTimeout(r, 300));
      writeFileSync(join(a, 'x.md'), 'page write\n');
      expect(() => commitPathsLocked(a, [join(a, 'x.md')], 'gbrain: write-through x', { lockWaitMs: 100 })).toThrow(expect.objectContaining({ code: 'commit_lock_busy' }));
    } finally { holder.kill('SIGKILL'); }
    await new Promise(r => setTimeout(r, 200));
    writeFileSync(join(a, 'y.md'), 'another writer, not pending\n');
    const r = cli(a, ['git', 'commit-push', '--pending', '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ outcome: 'pushed', paths: ['x.md'] });
    expect(git(bare, 'show', 'main:x.md')).toBe('page write');
    expect(status(a)).toBe(' M y.md');
    expect(readPendingWriteThrough(a)).toEqual([]);
  }, 30_000);
});

describe('opt-in commit guard', () => {
  test('refuses commits made around gbrain (--no-verify and -a included); gbrain\'s own commits, pulls and the bypass pass', () => {
    const { bare, a, b } = setup();
    expect(cli(a, ['git', 'guard', '--json']).stdout).toContain('"installed":false');
    const install = cli(a, ['git', 'guard', '--install', '--json']);
    expect(install.status).toBe(0);
    expect(JSON.parse(install.stdout)).toMatchObject({ installed: true, changed: true });
    writeFileSync(join(a, 'x.md'), 'cron edit\n');
    git(a, 'add', 'x.md');
    const plain = spawnSync('git', ['-C', a, 'commit', '-q', '--no-verify', '-m', 'cron'], { encoding: 'utf8', env: process.env });
    expect(plain.status).not.toBe(0);
    expect(plain.stderr).toContain('gbrain commit guard: refused');
    git(a, 'restore', '--staged', 'x.md');
    expect(cli(a, ['git', 'commit-push', '-m', 'via gbrain', '--', 'x.md']).status).toBe(0);
    expect(git(bare, 'show', 'main:x.md')).toBe('cron edit');
    writeFileSync(join(a, 'y.md'), 'page write\n');
    expect(commitPathsLocked(a, [join(a, 'y.md')], 'gbrain: write-through y', { lockWaitMs: 1000 })).not.toBeNull();
    writeFileSync(join(a, 'x.md'), 'swept by -a\n');
    const all = spawnSync('git', ['-C', a, 'commit', '-q', '-a', '-m', 'sweep'], { encoding: 'utf8', env: process.env });
    expect(all.status).not.toBe(0);
    expect(status(a)).toBe(' M x.md');
    git(a, 'checkout', '--', 'x.md');
    git(b, 'pull', '-q', '--no-rebase');
    writeFileSync(join(b, 'page.md'), 'remote\n');
    git(b, 'commit', '-qam', 'remote'); git(b, 'push', '-q', 'origin', 'main');
    expect(pullShared(a).status).toBe('advanced');
    expect(read(a, 'page.md')).toBe('remote\n');
    writeFileSync(join(a, 'x.md'), 'a person, deliberately\n');
    execFileSync('git', ['-C', a, 'commit', '-qam', 'by hand'], { env: { ...process.env, GBRAIN_COMMIT_GUARD: 'off' } });
    expect(JSON.parse(cli(a, ['git', 'guard', '--uninstall', '--json']).stdout)).toMatchObject({ installed: false, changed: true });
    writeFileSync(join(a, 'x.md'), 'after uninstall\n');
    git(a, 'commit', '-qam', 'plain again');
  }, 60_000);

  test('refuses to replace another tool\'s prepare-commit-msg hook', () => {
    const { a } = setup();
    writeFileSync(join(a, '.git', 'hooks', 'prepare-commit-msg'), '#!/bin/sh\nexit 0\n');
    const r = cli(a, ['git', 'guard', '--install']);
    expect(r.status).not.toBe(0);
    expect(read(a, '.git/hooks/prepare-commit-msg')).toBe('#!/bin/sh\nexit 0\n');
  });
});

describe('the helper\'s no-gbrain fallback', () => {
  test('marks its children with the real lock path and releases the commit lock before it pushes', async () => {
    const { bare, a } = setup();
    mkdirSync(join(a, 'scripts'), { recursive: true });
    writeFileSync(join(a, 'scripts', 'brain-commit-push.sh'), renderCommitPushHelper(), { mode: 0o755 });
    const lockPath = git(a, 'rev-parse', '--path-format=absolute', '--git-path', 'brain-commit.lock');
    writeFileSync(join(a, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\nprintf '%s' "$BRAIN_COMMIT_LOCK_HELD" > ${JSON.stringify(join(root, 'marker'))}\n`);
    chmodSync(join(a, '.git', 'hooks', 'pre-commit'), 0o755);
    writeFileSync(join(bare, 'hooks', 'pre-receive'), `#!/bin/sh\n: > ${JSON.stringify(join(root, 'pushing'))}\nsleep 3\n`, { mode: 0o755 });
    writeFileSync(join(a, 'x.md'), 'via the fallback\n');
    const helper = spawn('bash', [join(a, 'scripts', 'brain-commit-push.sh'), 'fallback', 'x.md'], {
      cwd: a, stdio: 'ignore', env: { ...process.env, PATH: '/usr/bin:/bin', GIT_CONFIG_PARAMETERS: "'protocol.file.allow=always'" } });
    const exited = new Promise<number | null>(r => helper.on('exit', code => r(code)));
    let freeDuringPush = false;
    for (let i = 0; i < 100 && !freeDuringPush; i++) {
      await new Promise(r => setTimeout(r, 50));
      try { readFileSync(join(root, 'pushing')); } catch { continue; }
      freeDuringPush = spawnSync('flock', ['-n', lockPath, 'true']).status === 0;
    }
    expect(await exited).toBe(0);
    expect(freeDuringPush).toBe(true);
    expect(read(root, 'marker')).toBe(lockPath);
    expect(git(bare, 'show', 'main:x.md')).toBe('via the fallback');
  }, 30_000);
});
