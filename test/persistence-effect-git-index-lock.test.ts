/**
 * A Git effect never deletes a Git index lock, and never counts a live one as a target failure.
 *
 * Protects: a git run refused because another process holds `index.lock` (a user's git, or a git of
 * this owner that was SIGKILLed on abort or deadline and left its lock) used to fail as
 * `git_unavailable` and count toward parking the target (seen as w5 "a healthy scan and contention
 * never park" on CI). Now git's own refusal message identifies the lock: a fresh one is
 * `git_index_locked` contention, an old or future-dated one is `git_index_stale` naming the path, and
 * the lock itself is always preserved, since no timestamp proves who holds it.
 * Seams: the real `commitGitTargets` over real repositories; a PATH git shim that takes the lock and
 * hangs, so an abort always lands while the lock is held.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitGitTargets, INDEX_LOCK_GRACE_FOR_TESTS } from '../src/core/persistence/effect-git.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-index-lock-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  writeFileSync(join(root, 'a.md'), 'first\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
  writeFileSync(join(root, 'a.md'), 'second\n');
  return root;
}
const age = (path: string, ms: number) => { const t = (Date.now() - ms) / 1000; utimesSync(path, t, t); };

test('a fresh lock is contention; an old or future-dated one is stale and named; the lock is never removed', async () => {
  const root = repo();
  try {
    const lock = join(root, '.git', 'index.lock');
    writeFileSync(lock, '');
    await expect(commitGitTargets(root, ['a.md'])).rejects.toMatchObject({ code: 'git_index_locked' });
    expect(existsSync(lock)).toBe(true);
    age(lock, INDEX_LOCK_GRACE_FOR_TESTS + 60_000);
    await expect(commitGitTargets(root, ['a.md'])).rejects.toMatchObject({ code: 'git_index_stale', message: expect.stringContaining(lock),
      suggestion: expect.stringContaining('retry-effects') });
    expect(existsSync(lock)).toBe(true);
    age(lock, -3_600_000);
    await expect(commitGitTargets(root, ['a.md'])).rejects.toMatchObject({ code: 'git_index_stale' });
    expect(existsSync(lock)).toBe(true);
    rmSync(lock);
    expect((await commitGitTargets(root, ['a.md'])).get('a.md')).toEqual({ git: 'committed' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a linked worktree resolves its own index lock from git', async () => {
  const main = repo();
  const linked = `${main}-linked`;
  try {
    git(main, 'worktree', 'add', '-q', linked);
    writeFileSync(join(linked, 'a.md'), 'linked edit\n');
    const lock = git(linked, 'rev-parse', '--git-path', 'index.lock').trim();
    const path = lock.startsWith('/') ? lock : join(linked, lock);
    writeFileSync(path, '');
    await expect(commitGitTargets(linked, ['a.md'])).rejects.toMatchObject({ code: 'git_index_locked' });
    expect(existsSync(path)).toBe(true);
  } finally { rmSync(linked, { recursive: true, force: true }); rmSync(main, { recursive: true, force: true }); }
});

test('an aborted git run that held the lock leaves it in place; the next attempt is contention, not a target failure', async () => {
  const root = repo();
  const bin = mkdtempSync(join(tmpdir(), 'gbrain-slow-git-'));
  try {
    // A git whose `add` takes the index lock and hangs, standing in for a git killed mid-write.
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh
root=""; prev=""
for a in "$@"; do [ "$prev" = "-C" ] && root="$a"; prev="$a"; done
for a in "$@"; do if [ "$a" = "add" ]; then : > "$root/.git/index.lock"; : > "$root/.git/shim-add-holds-lock"; exec sleep 30; fi; done
exec ${realGit} "$@"
`, { mode: 0o755 });
    const lock = join(root, '.git', 'index.lock');
    const holding = join(root, '.git', 'shim-add-holds-lock');
    const abort = new AbortController();
    const run = withEnv({ PATH: `${bin}:${process.env.PATH}` }, async () => {
      const pending = commitGitTargets(root, ['a.md'], abort.signal);
      // Abort only once the shim's add holds the lock (git status may briefly take and release its own lock first).
      for (let i = 0; i < 1000 && !existsSync(holding); i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(existsSync(holding)).toBe(true);
      abort.abort();
      return pending;
    });
    await expect(run).rejects.toMatchObject({ code: 'git_unavailable' });
    expect(existsSync(lock)).toBe(true);
    await expect(commitGitTargets(root, ['a.md'])).rejects.toMatchObject({ code: 'git_index_locked' });
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
}, 60_000);

/** A git whose `add` exits 128 with the given refusal (written by the shim script); every other command is the real git. */
function refusingGit(refusal: string): { bin: string; path: string } {
  const bin = mkdtempSync(join(tmpdir(), 'gbrain-refusing-git-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh
root=""; prev=""
for a in "$@"; do [ "$prev" = "-C" ] && root="$a"; prev="$a"; done
for a in "$@"; do if [ "$a" = "add" ]; then ${refusal}; exit 128; fi; done
exec ${realGit} "$@"
`, { mode: 0o755 });
  return { bin, path: `${bin}:${process.env.PATH}` };
}

test('a checkout path with an apostrophe still resolves its index lock', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'gbrain-apostrophe-'));
  const root = join(parent, "owner's-brain");
  try {
    execFileSync('mkdir', [root]);
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
    writeFileSync(join(root, 'a.md'), 'first\n'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
    writeFileSync(join(root, 'a.md'), 'second\n');
    writeFileSync(join(root, '.git', 'index.lock'), '');
    await expect(commitGitTargets(root, ['a.md'])).rejects.toMatchObject({ code: 'git_index_locked' });
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('git runs untranslated: a localized refusal under the operator locale is still detected', async () => {
  const root = repo();
  // Stands in for a translated git: it answers in German unless the child environment pins LC_ALL=C.
  const shim = refusingGit(`if [ "$LC_ALL" = "C" ]; then echo "fatal: Unable to create '$root/.git/index.lock': File exists." >&2; `
    + `else echo "fatal: Konnte '$root/.git/index.lock' nicht erstellen: Datei existiert bereits." >&2; fi`);
  try {
    writeFileSync(join(root, '.git', 'index.lock'), '');
    await expect(withEnv({ PATH: shim.path, LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8' }, () => commitGitTargets(root, ['a.md'])))
      .rejects.toMatchObject({ code: 'git_index_locked' });
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(shim.bin, { recursive: true, force: true }); }
});

test('a ref lock with the same wording is not the checkout index lock', async () => {
  const root = repo();
  const shim = refusingGit(`echo "fatal: Unable to create '$root/.git/refs/heads/index.lock': File exists." >&2`);
  try {
    writeFileSync(join(root, '.git', 'refs', 'heads', 'index.lock'), '');
    await expect(withEnv({ PATH: shim.path }, () => commitGitTargets(root, ['a.md']))).rejects.toMatchObject({ code: 'git_unavailable' });
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(shim.bin, { recursive: true, force: true }); }
});

test('a lock reported under another spelling of the checkout (symlink) or under a path with a newline is still the index lock', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'gbrain-spelling-'));
  try {
    const real = join(parent, 'line\nbreak-brain');
    execFileSync('mkdir', [real]);
    git(real, 'init', '-q');
    git(real, 'config', 'user.name', 'Example'); git(real, 'config', 'user.email', 'example@example.invalid');
    writeFileSync(join(real, 'a.md'), 'first\n'); git(real, 'add', '-A'); git(real, 'commit', '-qm', 'seed');
    writeFileSync(join(real, 'a.md'), 'second\n');
    writeFileSync(join(real, '.git', 'index.lock'), '');
    await expect(commitGitTargets(real, ['a.md'])).rejects.toMatchObject({ code: 'git_index_locked' });
    const alias = join(parent, 'alias');
    symlinkSync(real, alias);
    // Git may report the inherited PWD spelling of the same directory.
    await expect(withEnv({ PWD: alias }, () => commitGitTargets(real, ['a.md']))).rejects.toMatchObject({ code: 'git_index_locked' });
    await expect(commitGitTargets(alias, ['a.md'])).rejects.toMatchObject({ code: 'git_index_locked' });
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('a different lock that is a symlink to the index lock is not the index lock', async () => {
  const root = repo();
  const lock = join(root, '.git', 'index.lock');
  const other = join(root, '.git', 'refs', 'heads', 'main.lock');
  const shim = refusingGit(`echo "fatal: Unable to create '${other}': File exists." >&2`);
  try {
    writeFileSync(lock, '');
    symlinkSync(lock, other);
    await expect(withEnv({ PATH: shim.path }, () => commitGitTargets(root, ['a.md']))).rejects.toMatchObject({ code: 'git_unavailable' });
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(shim.bin, { recursive: true, force: true }); }
});
