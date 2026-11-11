/**
 * #7984: `gbrain git commit-push -- <path>` publishes a tracked file's deletion under a wildcard-ignored directory.
 *
 * Protects: a named tracked path is staged as a tracked path (`git add -u`), so its deletion commits and pushes whether
 * or not it was already staged, with the ignore policy left as it is; visible untracked files still go through
 * `git add -A`. Only the named paths are committed, and a named path that matches nothing, or only an ignored
 * untracked file, is still refused `commit_paths_invalid` with the index unchanged.
 * Fails when: the named paths go through one `git add -A` again: Git refuses a pathspec that now matches only an
 * ignored path (`commit_paths_invalid`) and the approved deletion never leaves the checkout.
 * Seam: real Git against a local bare remote.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { withEnv } from './helpers/with-env.ts';

let root: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const status = (cwd: string) => execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' }).replace(/\n$/, '');
const publish = (repo: string, paths: string[]) => withEnv({ GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' },
  () => commitAndPush({ repo, paths, message: 'remove artifacts', cwd: repo }));

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gbrain-7984-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A pushed checkout whose `.gitignore` ignores everything (`*`), with force-tracked files under artifact/. */
function ignoredCheckout(): { bare: string; repo: string } {
  const bare = join(root, 'remote.git'), repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, repo], { stdio: 'ignore' });
  git(repo, 'config', 'user.email', 'example@example.invalid'); git(repo, 'config', 'user.name', 'Example');
  writeFileSync(join(repo, '.gitignore'), '*\n');
  mkdirSync(join(repo, 'artifact'));
  for (const name of ['a.bin', 'b.bin', 'c.bin']) writeFileSync(join(repo, 'artifact', name), `${name}\n`);
  git(repo, 'add', '-f', '.gitignore', 'artifact/a.bin', 'artifact/b.bin', 'artifact/c.bin');
  git(repo, 'commit', '-qm', 'seed'); git(repo, 'push', '-q', '-u', 'origin', 'main');
  return { bare, repo };
}
const remoteFiles = (bare: string) => git(bare, 'ls-tree', '-r', '--name-only', 'main').split('\n');

describe('commit-push: tracked deletions under a wildcard ignore (#7984)', () => {
  test('a staged deletion publishes, and only the named path is committed', async () => {
    const { bare, repo } = ignoredCheckout();
    rmSync(join(repo, 'artifact', 'a.bin')); git(repo, 'add', '-u', '--', 'artifact/a.bin');
    rmSync(join(repo, 'artifact', 'b.bin')); git(repo, 'add', '-u', '--', 'artifact/b.bin');
    expect((await publish(repo, ['artifact/a.bin'])).outcome).toBe('pushed');
    expect(remoteFiles(bare)).toEqual(['.gitignore', 'artifact/b.bin', 'artifact/c.bin']);
    expect(status(repo)).toBe('D  artifact/b.bin');
  });

  test('an unstaged deletion publishes too', async () => {
    const { bare, repo } = ignoredCheckout();
    rmSync(join(repo, 'artifact', 'a.bin'));
    expect((await publish(repo, ['artifact/a.bin'])).outcome).toBe('pushed');
    expect(remoteFiles(bare)).toEqual(['.gitignore', 'artifact/b.bin', 'artifact/c.bin']);
    expect(status(repo)).toBe('');
  });

  test('a path that matches nothing, or only an ignored untracked file, is still refused with the index unchanged', async () => {
    const { bare, repo } = ignoredCheckout();
    rmSync(join(repo, 'artifact', 'a.bin')); git(repo, 'add', '-u', '--', 'artifact/a.bin');
    writeFileSync(join(repo, 'artifact', 'new.bin'), 'ignored\n');
    for (const paths of [['artifact/a.bin', 'artifact/missing.bin'], ['artifact/a.bin', 'artifact/new.bin']]) {
      await expect(publish(repo, paths)).rejects.toMatchObject({ code: 'commit_paths_invalid' });
      expect(status(repo)).toBe('D  artifact/a.bin');
    }
    expect(remoteFiles(bare)).toEqual(['.gitignore', 'artifact/a.bin', 'artifact/b.bin', 'artifact/c.bin']);
  });

  test('a named skip-worktree file beside a tracked deletion: the deletion publishes and the flagged file is reported skipped (GST-2118)', async () => {
    const { bare, repo } = ignoredCheckout();
    rmSync(join(repo, 'artifact', 'a.bin'));
    git(repo, 'update-index', '--skip-worktree', '--', 'artifact/b.bin');
    writeFileSync(join(repo, 'artifact', 'b.bin'), 'edited\n');
    await expect(publish(repo, ['artifact/a.bin', 'artifact/b.bin'])).rejects.toMatchObject({ code: 'commit_paths_skipped' });
    expect(remoteFiles(bare)).toEqual(['.gitignore', 'artifact/b.bin', 'artifact/c.bin']);
    expect(git(bare, 'show', 'main:artifact/b.bin')).toBe('b.bin');
  });
});
