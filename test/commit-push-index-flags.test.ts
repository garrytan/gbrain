/**
 * Index flags around a refused or partial commit-push (persistence train 13 review, GST-2118 with #7984).
 *
 * Protects: a skip-worktree or assume-unchanged entry keeps its flag when commit-push refuses (a missing path, a
 * refusing pre-commit hook), so a later commit-push of the same directory never publishes a skip-worktree edit; and a
 * named directory whose tracked files are all skip-worktree still commits its new untracked files, reporting the flagged one
 * as skipped.
 * Fails when: the index restore rewrites entries from ls-files -s records (dropping their flags), or a directory whose
 * only tracked entries are skip-worktree reaches git add -u, which refuses it (commit_paths_invalid).
 * Seam: real Git against a local bare remote.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { withEnv } from './helpers/with-env.ts';

let root: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const publish = (repo: string, paths: string[]) => withEnv({ GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' },
  () => commitAndPush({ repo, paths, message: 'publish', cwd: repo }));
const flag = (repo: string, path: string) => git(repo, 'ls-files', '-v', '--', path).slice(0, 1);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gbrain-flags-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A pushed checkout with notes/a.md, priv/local.env and priv/b.md. */
function checkout(): { bare: string; repo: string } {
  const bare = join(root, 'remote.git'), repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, repo], { stdio: 'ignore' });
  git(repo, 'config', 'user.email', 'example@example.invalid'); git(repo, 'config', 'user.name', 'Example');
  mkdirSync(join(repo, 'notes')); mkdirSync(join(repo, 'priv'));
  writeFileSync(join(repo, 'notes', 'a.md'), 'a\n');
  writeFileSync(join(repo, 'priv', 'local.env'), 'TOKEN=placeholder\n');
  writeFileSync(join(repo, 'priv', 'b.md'), 'b\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'seed'); git(repo, 'push', '-q', '-u', 'origin', 'main');
  return { bare, repo };
}
const hide = (repo: string, mode: '--skip-worktree' | '--assume-unchanged') => {
  git(repo, 'update-index', mode, '--', 'priv/local.env');
  writeFileSync(join(repo, 'priv', 'local.env'), 'TOKEN=local-only-edit\n');
};
const remoteEnv = (bare: string) => git(bare, 'show', 'main:priv/local.env');

describe('commit-push keeps index flags', () => {
  for (const [mode, letter] of [['--skip-worktree', 'S'], ['--assume-unchanged', 'h']] as const) {
    test('a refused commit keeps ' + mode + ' on a named file and on a file under a named directory', async () => {
      const { bare, repo } = checkout();
      hide(repo, mode);
      writeFileSync(join(repo, 'priv', 'b.md'), 'b2\n');
      for (const paths of [['notes/a.md', 'priv/local.env', 'notes/missing.md'], ['priv', 'notes/missing.md']]) {
        await expect(publish(repo, paths)).rejects.toMatchObject({ code: 'commit_paths_invalid' });
        expect(flag(repo, 'priv/local.env')).toBe(letter);
      }
      expect(remoteEnv(bare)).toBe('TOKEN=placeholder');
    });
  }

  test('after a refusal, a retry of the named directory does not publish the skip-worktree edit', async () => {
    const { bare, repo } = checkout();
    hide(repo, '--skip-worktree');
    writeFileSync(join(repo, 'priv', 'b.md'), 'b2\n');
    await expect(publish(repo, ['priv', 'notes/missing.md'])).rejects.toMatchObject({ code: 'commit_paths_invalid' });
    await expect(publish(repo, ['priv'])).rejects.toMatchObject({ code: 'commit_paths_skipped' });
    expect(git(bare, 'show', 'main:priv/b.md')).toBe('b2');
    expect(remoteEnv(bare)).toBe('TOKEN=placeholder');
    expect(flag(repo, 'priv/local.env')).toBe('S');
  });

  test('a pre-commit hook refusal keeps skip-worktree, and a retry does not publish the hidden edit', async () => {
    const { bare, repo } = checkout();
    hide(repo, '--skip-worktree');
    writeFileSync(join(repo, 'priv', 'b.md'), 'b2\n');
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755);
    await expect(publish(repo, ['priv'])).rejects.toMatchObject({ code: 'git_unavailable' });
    expect(flag(repo, 'priv/local.env')).toBe('S');
    rmSync(hook);
    await expect(publish(repo, ['priv'])).rejects.toMatchObject({ code: 'commit_paths_skipped' });
    expect(git(bare, 'show', 'main:priv/b.md')).toBe('b2');
    expect(remoteEnv(bare)).toBe('TOKEN=placeholder');
  });

  test('a named directory whose tracked files are all skip-worktree commits its new files and reports the flagged one skipped', async () => {
    const { bare, repo } = checkout();
    git(repo, 'update-index', '--skip-worktree', '--', 'priv/b.md');
    hide(repo, '--skip-worktree');
    writeFileSync(join(repo, 'priv', 'new.md'), 'new\n');
    await expect(publish(repo, ['priv'])).rejects.toMatchObject({ code: 'commit_paths_skipped' });
    expect(git(bare, 'show', 'main:priv/new.md')).toBe('new');
    expect(remoteEnv(bare)).toBe('TOKEN=placeholder');
    expect(flag(repo, 'priv/local.env')).toBe('S');
  });
});
