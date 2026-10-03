/**
 * `collectSyncableFilesAsync` — the non-blocking variant of the git-aware
 * walker that `runImport` and `performFullSync` use.
 *
 * Contract: the same output as `collectSyncableFiles` for every input (sorted
 * absolute paths, strategy filter, prune/metafile/malformed gates, no
 * symlinks, `onExcluded`, `includeHidden`, `includeGitignored`, multimodal
 * admission, non-git FS-walk fallback), but `git ls-files` and the per-file
 * lstat are awaited, so timers and in-flight I/O keep running during the walk.
 * The synchronous walk held the thread for the whole lstat loop, which on a
 * large tree over a network filesystem starved every other source's database
 * handshakes in the same `sync --all` process.
 *
 * No PGLite needed: the walker is pure filesystem + git.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join, relative } from 'path';
// Namespace import: the async walker is looked up at call time, so these
// cases run (and fail) against a tree that predates it.
import * as walker from '../src/commands/import.ts';
import { withEnv } from './helpers/with-env.ts';
import { writeLargeWorktree } from './helpers/large-worktree.ts';

const PAGE = '---\ntitle: Page\n---\nbody\n';
let repo: string;
let plain: string;

function sh(cwd: string, cmd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

function gitInit(dir: string): void {
  sh(dir, 'git init -q');
  sh(dir, 'git config user.email "t@example.com"');
  sh(dir, 'git config user.name "T"');
}

function write(root: string, rel: string, body = PAGE): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), body);
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'gbrain-walk-async-'));
  gitInit(repo);
  write(repo, '.gitignore', 'ignored/\n*.secret.md\n');
  write(repo, 'notes/a.md');
  write(repo, 'notes/b.md');
  write(repo, 'code/x.ts', 'export const x = 1;\n');
  write(repo, 'img/pic.png', 'not really a png');
  write(repo, 'README.md', '# metafile\n');
  write(repo, '.dira/hidden.md');
  write(repo, 'node_modules/dep/notes.md');
  write(repo, 'notes/bad[1].md');
  write(repo, 'gone.md');
  write(repo, 'ignored/i.md');
  write(repo, 'notes/x.secret.md');
  symlinkSync('notes/a.md', join(repo, 'link.md'));
  symlinkSync('notes', join(repo, 'linkdir'));
  sh(repo, 'git add -A && git commit -q -m fixture');
  // Still in the index but gone from disk: listed by --cached, dropped by lstat.
  rmSync(join(repo, 'gone.md'));
  // Untracked and not ignored: listed by --others.
  write(repo, 'notes/untracked.md');
  write(repo, 'ignored/j.md');

  // Not a git work tree: both variants take the FS walk.
  plain = mkdtempSync(join(tmpdir(), 'gbrain-walk-async-plain-'));
  write(plain, 'a.md');
  write(plain, 'sub/b.md');
  write(plain, 'sub/c.ts', 'export const c = 1;\n');
  write(plain, '.hidden/d.md');
  symlinkSync('a.md', join(plain, 'link.md'));
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});

const STRATEGIES = ['markdown', 'code', 'auto'] as const;
const VARIANTS = [{}, { includeHidden: ['.dira/**'] }, { includeGitignored: true }];

async function expectSameAsSync(dir: string, opts: { strategy: (typeof STRATEGIES)[number]; includeHidden?: string[]; includeGitignored?: boolean }): Promise<string[]> {
  const syncExcluded: string[] = [];
  const asyncExcluded: string[] = [];
  const expected = walker.collectSyncableFiles(dir, { ...opts, onExcluded: (rel) => { syncExcluded.push(rel); } });
  const actual = await walker.collectSyncableFilesAsync(dir, { ...opts, onExcluded: (rel) => { asyncExcluded.push(rel); } });
  expect(actual).toEqual(expected);
  expect(asyncExcluded).toEqual(syncExcluded);
  return actual;
}

describe('collectSyncableFilesAsync matches collectSyncableFiles', () => {
  test('git work tree: every strategy x hidden/gitignored variant', async () => {
    for (const strategy of STRATEGIES) {
      for (const variant of VARIANTS) await expectSameAsSync(repo, { strategy, ...variant });
    }
  });

  test('non-git directory: the FS-walk fallback', async () => {
    for (const strategy of STRATEGIES) await expectSameAsSync(plain, { strategy });
  });

  test('multimodal admission applies to both', async () => {
    await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, async () => {
      for (const strategy of ['markdown', 'auto'] as const) {
        const files = await expectSameAsSync(repo, { strategy });
        expect(files).toContain(join(repo, 'img/pic.png'));
      }
    });
  });

  test('the git fast path keeps its filters: tracked + untracked, no ignored, pruned, metafile, malformed, symlinked or index-only paths', async () => {
    const excluded: string[] = [];
    const files = await walker.collectSyncableFilesAsync(repo, { strategy: 'markdown', onExcluded: (rel) => { excluded.push(rel); } });
    expect(files.map((f) => relative(repo, f))).toEqual(['notes/a.md', 'notes/b.md', 'notes/untracked.md']);
    expect(excluded).toEqual(['notes/bad[1].md']);
  });
});

describe('collectSyncableFilesAsync does not hold the event loop', () => {
  test('a timer queued before the walk fires before the walk resolves', async () => {
    const big = mkdtempSync(join(tmpdir(), 'gbrain-walk-async-big-'));
    try {
      gitInit(big);
      writeLargeWorktree(big, 2000);
      let fired = false;
      setTimeout(() => { fired = true; }, 0);
      const files = await walker.collectSyncableFilesAsync(big, { strategy: 'markdown' });
      expect(files.length).toBe(2000);
      // A walk that runs to completion without yielding (the synchronous
      // ls-files + lstat loop) resolves before any timer can run.
      expect(fired).toBe(true);
    } finally {
      rmSync(big, { recursive: true, force: true });
    }
  });
});
