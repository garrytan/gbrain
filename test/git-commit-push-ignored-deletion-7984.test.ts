import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { withEnv } from './helpers/with-env.ts';

let root: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gbrain-7984-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test('publishes a named tracked deletion beneath a wildcard-ignored directory', () => withEnv({ GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, () => {
  const bare = join(root, 'remote.git');
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
  execFileSync('git', ['clone', '-q', bare, repo]);
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, '.gitignore'), '*\n');
  mkdirSync(join(repo, 'artifact'));
  writeFileSync(join(repo, 'artifact', 'tracked.bin'), 'tracked\n');
  git(repo, 'add', '-f', '.gitignore', 'artifact/tracked.bin');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'push', '-q', '-u', 'origin', 'main');

  rmSync(join(repo, 'artifact', 'tracked.bin'));
  git(repo, 'add', '-u', 'artifact/tracked.bin');
  let outcome: string | undefined;
  let error: unknown;
  try {
    outcome = commitAndPush({ repo, paths: ['artifact/tracked.bin'], message: 'remove artifact', cwd: repo }).outcome;
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeUndefined();
  expect(outcome).toBe('pushed');
  expect(git(bare, 'ls-tree', '-r', '--name-only', 'main')).toBe('.gitignore');
  expect(git(repo, 'status', '--porcelain')).toBe('');
}), 30_000);
