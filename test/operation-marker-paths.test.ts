/**
 * #8755: operationMarkerPaths names the markers a merge, cherry-pick, revert or rebase in progress leaves in the
 * checkout's own git dir, so local-edit adoption refuses mid-operation even when the checkout root is reached
 * through a symlink, or is a linked worktree.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationMarkerPaths } from '../src/core/persistence/pending-import.ts';
import { withEnv } from './helpers/with-env.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-op-markers-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}
function repo(name: string): string {
  const root = join(base, name);
  mkdirSync(join(root, 'notes', 'deep'), { recursive: true });
  git(root, 'init', '-q');
  writeFileSync(join(root, 'notes', 'deep', 'page.md'), 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'one');
  return root;
}
async function present(root: string): Promise<string[]> {
  const paths = await operationMarkerPaths(root);
  expect(paths).not.toBeNull();
  return paths!.filter(path => existsSync(path));
}

test('a root reached through a symlink below the top level at another depth still sees a merge in progress', async () => {
  const root = repo('symlinked');
  writeFileSync(join(root, '.git', 'MERGE_HEAD'), `${git(root, 'rev-parse', 'HEAD').trim()}\n`);
  mkdirSync(join(base, 'elsewhere', 'x'), { recursive: true });
  symlinkSync(join(root, 'notes'), join(base, 'elsewhere', 'x', 'sublink'));
  symlinkSync(join(root, 'notes', 'deep'), join(base, 'elsewhere', 'deeplink'));
  for (const link of [join(base, 'elsewhere', 'x', 'sublink'), join(base, 'elsewhere', 'deeplink'), join(base, 'elsewhere', 'x', 'sublink', 'deep')]) {
    expect(await present(link)).toEqual([join(root, '.git', 'MERGE_HEAD')]);
  }
  rmSync(join(root, '.git', 'MERGE_HEAD'));
  expect(await present(join(base, 'elsewhere', 'x', 'sublink'))).toEqual([]);
});

test('a linked worktree mid-merge reads its own git dir, and the main checkout sees no merge', async () => {
  const main = repo('worktree-main');
  git(main, 'checkout', '-qb', 'side');
  writeFileSync(join(main, 'notes', 'side.md'), 'side\n');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'side');
  git(main, 'checkout', '-q', 'main');
  const wt = join(base, 'worktree-linked');
  git(main, 'worktree', 'add', '-qb', 'wt', wt);
  git(wt, 'merge', '--no-ff', '--no-commit', 'side');
  const gitDir = git(wt, 'rev-parse', '--absolute-git-dir').trim();
  expect(gitDir).not.toBe(join(main, '.git'));
  expect(await present(wt)).toEqual([join(gitDir, 'MERGE_HEAD')]);
  expect(await present(join(wt, 'notes'))).toEqual([join(gitDir, 'MERGE_HEAD')]);
  expect(await present(main)).toEqual([]);
  git(wt, 'merge', '--abort');
  expect(await present(wt)).toEqual([]);
});

test('a plain checkout mid-rebase sees rebase-merge', async () => {
  const root = repo('rebasing');
  git(root, 'checkout', '-qb', 'topic');
  writeFileSync(join(root, 'notes', 'deep', 'page.md'), 'topic\n');
  git(root, 'commit', '-qam', 'topic');
  git(root, 'checkout', '-q', 'main');
  writeFileSync(join(root, 'notes', 'deep', 'page.md'), 'main\n');
  git(root, 'commit', '-qam', 'main');
  git(root, 'checkout', '-q', 'topic');
  expect(() => git(root, 'rebase', '--merge', 'main')).toThrow();
  expect(await present(join(root, 'notes', 'deep'))).toEqual([join(root, '.git', 'rebase-merge')]);
  git(root, 'rebase', '--abort');
  expect(await present(root)).toEqual([]);
});

async function readsClean(root: string): Promise<boolean> {
  return (await operationMarkerPaths(root))?.every(marker => !existsSync(marker)) === true;
}

test('a checkout whose path holds a newline never reads as clean mid-merge', async () => {
  const root = join(base, 'line\nbreak');
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q');
  writeFileSync(join(root, 'notes', 'page.md'), 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'one');
  git(root, 'checkout', '-qb', 'side');
  writeFileSync(join(root, 'notes', 'page.md'), 'side\n');
  git(root, 'commit', '-qam', 'side');
  git(root, 'checkout', '-q', 'main');
  writeFileSync(join(root, 'notes', 'page.md'), 'main\n');
  git(root, 'commit', '-qam', 'main');
  expect(() => git(root, 'merge', 'side')).toThrow();
  expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(true);
  expect(await readsClean(root)).toBe(false);
  symlinkSync(root, join(base, 'newline-link'));
  expect(await readsClean(join(base, 'newline-link', 'notes'))).toBe(false);
});

test('a cherry-pick range stopped between picks, after the first conflict was committed, is still in progress', async () => {
  const root = repo('sequencer');
  git(root, 'checkout', '-qb', 'topic');
  writeFileSync(join(root, 'notes', 'deep', 'page.md'), 'topic\n');
  git(root, 'commit', '-qam', 'topic one');
  writeFileSync(join(root, 'notes', 'other.md'), 'two\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'topic two');
  git(root, 'checkout', '-q', 'main');
  writeFileSync(join(root, 'notes', 'deep', 'page.md'), 'main\n');
  git(root, 'commit', '-qam', 'main');
  expect(() => git(root, 'cherry-pick', 'main..topic')).toThrow();
  writeFileSync(join(root, 'notes', 'deep', 'page.md'), 'resolved\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '--no-edit');
  expect(existsSync(join(root, '.git', 'CHERRY_PICK_HEAD'))).toBe(false);
  expect(await present(root)).toEqual([join(root, '.git', 'sequencer')]);
  git(root, 'cherry-pick', '--quit');
  expect(await present(root)).toEqual([]);
});


// ── #8826 ───────────────────────────────────────────────────────────────────

/** A repository at `root` (reached by whatever path) whose page has diverging commits on main and side. */
function diverged(root: string): void {
  git(root, 'init', '-q');
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes', 'page.md'), 'one\n');
  writeFileSync(join(root, 'notes', 'other.md'), 'other\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'one');
  git(root, 'checkout', '-qb', 'side');
  writeFileSync(join(root, 'notes', 'page.md'), 'side\n');
  git(root, 'commit', '-qam', 'side');
  git(root, 'checkout', '-q', 'main');
  writeFileSync(join(root, 'notes', 'page.md'), 'main\n');
  git(root, 'commit', '-qam', 'main');
}

test('a git dir whose path is not valid UTF-8, reached through a clean symlink, never reads as clean mid-cherry-pick', async () => {
  const real = Buffer.concat([Buffer.from(join(base, 'bytes-')), Buffer.from([0xff, 0xfe])]);
  mkdirSync(real);
  const link = join(base, 'bytes-link');
  symlinkSync(real, link);
  diverged(link);
  expect(() => git(link, 'cherry-pick', 'side')).toThrow();
  expect(existsSync(join(link, '.git', 'CHERRY_PICK_HEAD'))).toBe(true);
  expect(await readsClean(link)).toBe(false);
  expect(await operationMarkerPaths(link)).toBeNull();
});

test('a squash merge stopped on a conflict leaves no MERGE_HEAD but SQUASH_MSG, which is in progress until reset', async () => {
  const root = join(base, 'squash');
  mkdirSync(root);
  diverged(root);
  expect(() => git(root, 'merge', '--squash', 'side')).toThrow();
  expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(false);
  expect(await present(join(root, 'notes'))).toEqual([join(root, '.git', 'SQUASH_MSG')]);
  git(root, 'reset', '-q', '--hard');
  expect(await present(root)).toEqual([]);
});

test('a bisect in progress sees BISECT_LOG until it is reset', async () => {
  const root = repo('bisecting');
  for (const n of ['two', 'three']) {
    writeFileSync(join(root, 'notes', 'deep', 'page.md'), `${n}\n`);
    git(root, 'commit', '-qam', n);
  }
  git(root, 'bisect', 'start');
  git(root, 'bisect', 'bad');
  git(root, 'bisect', 'good', 'HEAD~2');
  expect(await present(root)).toEqual([join(root, '.git', 'BISECT_LOG')]);
  git(root, 'bisect', 'reset');
  expect(await present(root)).toEqual([]);
});

/** Runs `operationMarkerPaths` against a shim git whose `rev-parse --absolute-git-dir` prints `output`; every other command is real git. */
async function withShimGitDir(root: string, output: string): Promise<string[] | null> {
  const shim = mkdtempSync(join(base, 'shim-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { env }).toString().trim();
  writeFileSync(join(shim, 'out'), output);
  writeFileSync(join(shim, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = --absolute-git-dir ] && { cat "${shim}/out"; exit 0; }; done\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  return withEnv({ PATH: `${shim}:${process.env.PATH}` }, () => operationMarkerPaths(root));
}

test('a git dir answer that is not one absolute, existing directory line reads as unknown (CRLF, trailing space, relative, missing, a file)', async () => {
  const root = repo('shimmed');
  const gitDir = join(root, '.git');
  writeFileSync(join(gitDir, 'MERGE_HEAD'), `${git(root, 'rev-parse', 'HEAD').trim()}\n`);
  expect(await withShimGitDir(root, `${gitDir}\n`)).toContain(join(gitDir, 'MERGE_HEAD'));
  for (const output of [`${gitDir}\r\n`, `${gitDir} \n`, '.git\n', `${join(base, 'missing-dir')}\n`, `${join(gitDir, 'MERGE_HEAD')}\n`, `${gitDir}`]) {
    expect(await withShimGitDir(root, output)).toBeNull();
  }
});

