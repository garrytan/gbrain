/**
 * Wave 12 W4.3: Git run in a checkout gbrain does not trust must never execute
 * the checkout's own `filter.<driver>.clean|process` config. `git status` runs
 * a clean filter whenever it re-hashes a stat-dirty file, so the reconcile
 * preview's "is the canonical file changed in Git" check uses filter-free
 * plumbing (`hardenedPathDirty`), and `hardenedGitSync` refuses everything but
 * allow-listed plumbing.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertHardenedGitArgs, hardenedGitSync, hardenedPathDirty } from '../src/core/hardened-git.ts';
import { canonicalFileGitDirty } from '../src/core/persistence/reconcile.ts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function git(root: string, ...args: string[]): string {
  const run = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}

/** A committed checkout holding `note.md` (and whatever `extra` writes before the commit). */
function repo(extra?: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-hardened-git-'));
  dirs.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'writer@example.invalid');
  git(root, 'config', 'user.name', 'Writer Example');
  writeFileSync(join(root, 'note.md'), 'hello\n');
  extra?.(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

/** Make the file stat-dirty without changing its bytes, which is what makes `git status` re-hash it. */
function touch(path: string): void {
  const later = new Date(Date.now() + 5_000);
  utimesSync(path, later, later);
}

describe('W4.3: repository filters never run', () => {
  for (const kind of ['clean', 'process'] as const) {
    test(`a ${kind} filter in the checkout's .git/config is not executed by the reconcile dirty check`, () => {
      const root = repo(r => writeFileSync(join(r, '.gitattributes'), 'note.md filter=evil\n'));
      const marker = join(root, '..', `${root.split('/').pop()}-${kind}-ran`);
      git(root, 'config', `filter.evil.${kind}`, `touch ${marker}; cat`);
      touch(join(root, 'note.md'));
      const verdict = canonicalFileGitDirty(root, join(root, 'note.md'));
      expect(existsSync(marker)).toBe(false);
      expect(verdict).toBe(false);
      rmSync(marker, { force: true });
    });
  }

  test('porcelain and converting options are refused before git runs', () => {
    const root = repo();
    for (const args of [['status', '--porcelain'], ['diff'], ['show', 'HEAD'], ['add', '-A'], ['checkout', '--', '.'],
      ['hash-object', '--', 'note.md'], ['cat-file', '--filters', 'HEAD:note.md'], ['cat-file', '--textconv', 'HEAD:note.md'],
      ['diff-index', 'HEAD'], ['diff-index', '--cached', '-p', 'HEAD']]) {
      expect(() => hardenedGitSync(root, args, { timeoutMs: 5_000, maxBytes: 1024 })).toThrow(/hardened git refuses/);
    }
    expect(() => assertHardenedGitArgs(['hash-object', '--no-filters', '--', 'note.md'])).not.toThrow();
    expect(() => assertHardenedGitArgs(['diff-index', '--cached', '--quiet', 'HEAD'])).not.toThrow();
    expect(() => assertHardenedGitArgs(['ls-tree', '-r', '-z', 'HEAD'])).not.toThrow();
  });
});

describe('W4.3: hardenedPathDirty matches git status without running it', () => {
  test('unchanged, touched-only and modified files', () => {
    const root = repo();
    expect(hardenedPathDirty(root, 'note.md')).toBe(false);
    touch(join(root, 'note.md'));
    expect(hardenedPathDirty(root, 'note.md')).toBe(false);
    writeFileSync(join(root, 'note.md'), 'changed\n');
    expect(hardenedPathDirty(root, 'note.md')).toBe(true);
  });

  test('a staged change whose file equals the index but not HEAD is dirty', () => {
    const root = repo();
    writeFileSync(join(root, 'note.md'), 'staged\n');
    git(root, 'add', 'note.md');
    expect(hardenedPathDirty(root, 'note.md')).toBe(true);
  });

  test('a staged add, a staged delete kept on disk, an untracked file and an ignored file', () => {
    const root = repo(r => writeFileSync(join(r, '.gitignore'), 'ignored.md\n'));
    writeFileSync(join(root, 'added.md'), 'new\n');
    git(root, 'add', 'added.md');
    expect(hardenedPathDirty(root, 'added.md')).toBe(true);
    git(root, 'rm', '-q', '--cached', 'note.md');
    expect(hardenedPathDirty(root, 'note.md')).toBe(true);
    writeFileSync(join(root, 'loose.md'), 'loose\n');
    expect(hardenedPathDirty(root, 'loose.md')).toBe(true);
    writeFileSync(join(root, 'ignored.md'), 'ignored\n');
    expect(hardenedPathDirty(root, 'ignored.md')).toBe(false);
  });

  test('an unborn HEAD makes an indexed file dirty (it is a staged add)', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-hardened-git-unborn-'));
    dirs.push(root);
    git(root, 'init', '-q');
    writeFileSync(join(root, 'note.md'), 'hello\n');
    git(root, 'add', 'note.md');
    expect(hardenedPathDirty(root, 'note.md')).toBe(true);
  });

  test('an executable-bit-only change is unknown (core.filemode is repository config)', () => {
    const root = repo();
    chmodSync(join(root, 'note.md'), 0o755);
    expect(hardenedPathDirty(root, 'note.md')).toBeNull();
  });

  test('CRLF working-tree bytes under core.autocrlf, and a conversion attribute, are unknown rather than dirty', () => {
    const root = repo();
    git(root, 'config', 'core.autocrlf', 'true');
    writeFileSync(join(root, 'note.md'), 'hello\r\n');
    expect(hardenedPathDirty(root, 'note.md')).toBeNull();
    const lfs = repo(r => writeFileSync(join(r, '.gitattributes'), 'note.md filter=lfs diff=lfs merge=lfs -text\n'));
    writeFileSync(join(lfs, 'note.md'), 'real bytes behind a pointer\n');
    expect(hardenedPathDirty(lfs, 'note.md')).toBeNull();
  });

  test('a directory that is not a Git checkout is unknown', () => {
    const plain = mkdtempSync(join(tmpdir(), 'gbrain-hardened-git-plain-'));
    dirs.push(plain);
    mkdirSync(join(plain, 'sub'));
    writeFileSync(join(plain, 'sub', 'note.md'), 'x\n');
    expect(hardenedPathDirty(join(plain, 'sub'), 'note.md')).toBeNull();
  });
});
