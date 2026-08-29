/**
 * collectGitVisibleFiles (src/core/git-visible-files.ts) — behavioral pins.
 *
 * Real contract (pinned here, from the implementation):
 *   - Returns ABSOLUTE paths (join(dir, rel)), sorted lexicographically.
 *   - Returns null when `dir` is not inside a git work tree (or git fails).
 *   - Visible set = `ls-files --cached --others --exclude-standard` MINUS
 *     `ls-files -ci --exclude-standard` (tracked files that a later
 *     .gitignore rule covers are excluded, without untracking them).
 *   - Symlinks (valid or dangling) and non-regular files are excluded via
 *     lstat; a path that fails lstat (tracked but deleted from the work
 *     tree) is skipped without throwing.
 *   - `acceptRelPath` receives forward-slash RELATIVE paths.
 *
 * The `.git/info/exclude` arm is already covered by the walk-parity suite in
 * test/brain-writer-walk-prune.test.ts — not duplicated here.
 *
 * Repo-setup git spawns pass explicit cwd + per-spawn env overrides
 * (GIT_CONFIG_GLOBAL/SYSTEM, HOME, identity vars); process.env is never
 * mutated. The function under test spawns git with the ambient env — this
 * sandbox routes `git` through a Conductor shim that execs real git for all
 * non-network subcommands, so ls-files output shape is real-git.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, isAbsolute } from 'path';
import { collectGitVisibleFiles } from '../src/core/git-visible-files.ts';

const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

/** Run git inside `repo` with hermetic per-spawn env (no process.env mutation). */
function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: repo,
      XDG_CONFIG_HOME: join(repo, '.xdg-config'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'F6 Test',
      GIT_AUTHOR_EMAIL: 'f6@example.com',
      GIT_COMMITTER_NAME: 'F6 Test',
      GIT_COMMITTER_EMAIL: 'f6@example.com',
    },
  });
}

function makeRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'F6 Test']);
  git(repo, ['config', 'user.email', 'f6@example.com']);
  return repo;
}

describe('collectGitVisibleFiles — tracked-but-ignored arm (ls-files -ci)', () => {
  test('a TRACKED file later covered by .gitignore is excluded; its tracked sibling stays', () => {
    const repo = makeRepo('gbrain-f6-ci-');
    writeFileSync(join(repo, 'keep.md'), '# keep\n');
    writeFileSync(join(repo, 'drop.md'), '# drop\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);

    // Later: ignore the already-tracked file (do NOT git rm it).
    writeFileSync(join(repo, '.gitignore'), 'drop.md\n');
    git(repo, ['add', '.gitignore']);
    git(repo, ['commit', '-q', '-m', 'ignore drop.md']);

    // Prove the exclusion comes from the -ci arm, not from untracking:
    // git itself still tracks drop.md.
    const cached = git(repo, ['ls-files', '--cached']);
    expect(cached.split('\n')).toContain('drop.md');

    const result = collectGitVisibleFiles(repo, () => true);
    expect(result).not.toBeNull();
    expect(result!).toContain(join(repo, 'keep.md'));
    expect(result!).toContain(join(repo, '.gitignore'));
    expect(result!).not.toContain(join(repo, 'drop.md'));
  });
});

describe('collectGitVisibleFiles — symlinks and vanished paths', () => {
  test('valid symlink (tracked) and dangling symlink (untracked) are both excluded, no throw; deleted-but-tracked path is skipped', () => {
    const repo = makeRepo('gbrain-f6-symlink-');
    writeFileSync(join(repo, 'real.md'), '# real\n');
    writeFileSync(join(repo, 'gone.md'), '# gone\n');
    // Tracked symlink to a valid .md — appears in --cached, excluded by lstat.
    symlinkSync('real.md', join(repo, 'link.md'));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);
    // Dangling symlink — untracked (--others lane), lstat succeeds but
    // isSymbolicLink() excludes it. Must not throw.
    symlinkSync('missing.md', join(repo, 'dangling.md'));
    // Tracked but deleted from the work tree — lstat fails, skipped silently.
    rmSync(join(repo, 'gone.md'));

    let result: string[] | null = null;
    expect(() => {
      result = collectGitVisibleFiles(repo, () => true);
    }).not.toThrow();
    expect(result).not.toBeNull();
    expect(result!).toContain(join(repo, 'real.md'));
    expect(result!).not.toContain(join(repo, 'link.md'));
    expect(result!).not.toContain(join(repo, 'dangling.md'));
    expect(result!).not.toContain(join(repo, 'gone.md'));
  });
});

describe('collectGitVisibleFiles — result shape', () => {
  test('returns sorted ABSOLUTE paths, union of tracked (--cached) and untracked (--others)', () => {
    const repo = makeRepo('gbrain-f6-shape-');
    // Created out of order; tracked + untracked mixed.
    writeFileSync(join(repo, 'zeta.md'), '# z\n'); // untracked
    writeFileSync(join(repo, 'alpha.md'), '# a\n'); // tracked
    mkdirSync(join(repo, 'mid'));
    writeFileSync(join(repo, 'mid', 'b.md'), '# b\n'); // untracked, nested
    git(repo, ['add', 'alpha.md']);
    git(repo, ['commit', '-q', '-m', 'init']);

    const result = collectGitVisibleFiles(repo, () => true);
    expect(result).not.toBeNull();
    // Pinned contract: absolute paths, lexicographically sorted.
    for (const p of result!) expect(isAbsolute(p)).toBe(true);
    expect(result!).toEqual([...result!].sort());
    expect(result!).toEqual([
      join(repo, 'alpha.md'),
      join(repo, 'mid', 'b.md'),
      join(repo, 'zeta.md'),
    ]);
  });
});

describe('collectGitVisibleFiles — non-git directory', () => {
  test('returns null (caller keeps its filesystem-walk fallback)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-f6-nogit-'));
    cleanups.push(dir);
    writeFileSync(join(dir, 'note.md'), '# note\n');
    expect(collectGitVisibleFiles(dir, () => true)).toBeNull();
  });
});

describe('collectGitVisibleFiles — acceptRelPath callback', () => {
  test('receives forward-slash RELATIVE paths and its verdict filters the result', () => {
    const repo = makeRepo('gbrain-f6-accept-');
    writeFileSync(join(repo, 'top.md'), '# top\n');
    mkdirSync(join(repo, 'sub', 'dir'), { recursive: true });
    writeFileSync(join(repo, 'sub', 'dir', 'file.md'), '# nested\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);

    const seen: string[] = [];
    const result = collectGitVisibleFiles(repo, (rel) => {
      seen.push(rel);
      return rel !== 'top.md';
    });

    expect(seen).toContain('top.md');
    expect(seen).toContain('sub/dir/file.md');
    for (const rel of seen) {
      expect(isAbsolute(rel)).toBe(false);
      expect(rel.includes('\\')).toBe(false);
    }

    expect(result).not.toBeNull();
    expect(result!).toContain(join(repo, 'sub', 'dir', 'file.md'));
    expect(result!).not.toContain(join(repo, 'top.md'));
  });
});
