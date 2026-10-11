/**
 * Wave 13: Git work must read and write only the checkout it was asked about,
 * whatever Git environment the process inherited.
 * Protects: the Git effect (`commitGitTargets`), the classic write-through commit
 * (`commitWriteThroughFile`) and git-remote probes build their env through
 * `gitChildEnv`, so an inherited environment naming another repository leaves
 * that repository's HEAD and index untouched.
 * Seams: none; real repositories, the variables set on process.env for the test.
 */
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitGitTargets } from '../src/core/persistence/effect-git.ts';
import { commitWriteThroughFile } from '../src/core/brain-repo-durability.ts';
import { isWorkingTreeDirty, detectDefaultBranch } from '../src/core/git-remote.ts';
import { gitChildEnv, GIT_LOCAL_ENV_VARS } from '../src/core/git-env.ts';
import { withEnv } from './helpers/with-env.ts';

const roots: string[] = [];
const clean = gitChildEnv();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: clean }).trim();
function repo(name: string, branch: string): string {
  const root = mkdtempSync(join(tmpdir(), `gbrain-git-env-${name}-`));
  roots.push(root);
  git(root, 'init', '-q', '-b', branch);
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  writeFileSync(join(root, 'a.md'), `${name} first\n`);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', `${name} seed`);
  return root;
}
const inherit = (other: string) => ({ GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, '.git', 'index') });
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const state = (root: string) => ({ head: git(root, 'rev-parse', 'HEAD'), index: readFileSync(join(root, '.git', 'index')).toString('base64'), status: git(root, 'status', '--porcelain') });

test('gitChildEnv drops every repository-locating variable and keeps transport ones', () => {
  const source = Object.fromEntries([...GIT_LOCAL_ENV_VARS.map(key => [key, 'x']), ['GIT_CONFIG_KEY_0', 'core.hooksPath'], ['GIT_CONFIG_VALUE_0', '/tmp/h'],
    ['GIT_SSH_COMMAND', 'ssh -i key'], ['GIT_ASKPASS', '/bin/askpass'], ['SSH_AUTH_SOCK', '/run/agent'], ['PATH', '/usr/bin']]);
  expect(gitChildEnv({ GIT_TERMINAL_PROMPT: '0' }, source)).toEqual({ GIT_SSH_COMMAND: 'ssh -i key', GIT_ASKPASS: '/bin/askpass', SSH_AUTH_SOCK: '/run/agent', PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0' });
});

test('the Git effect commits into its own root under an inherited Git environment naming another repository', async () => {
  const brain = repo('brain', 'main');
  const other = repo('other', 'trunk');
  writeFileSync(join(brain, 'a.md'), 'brain second\n');
  writeFileSync(join(other, 'a.md'), 'other uncommitted\n');
  const before = state(other);
  await withEnv(inherit(other), async () => {
    expect((await commitGitTargets(brain, ['a.md'])).get('a.md')).toEqual({ git: 'committed' });
  });
  expect(state(other)).toEqual(before);
  expect(git(brain, 'show', 'HEAD:a.md')).toBe('brain second');
  expect(git(brain, 'status', '--porcelain')).toBe('');
});

test('the classic write-through commit and git-remote probes stay on their own root', async () => {
  const brain = repo('brain', 'main');
  const other = repo('other', 'trunk');
  writeFileSync(join(brain, 'a.md'), 'brain second\n');
  writeFileSync(join(other, 'a.md'), 'other uncommitted\n');
  const before = state(other);
  await withEnv(inherit(other), async () => {
    expect(isWorkingTreeDirty(brain)).toBe(true);
    expect(detectDefaultBranch(brain)).toBe('main');
    expect(commitWriteThroughFile(brain, join(brain, 'a.md'), 'a')).toBe(true);
    expect(isWorkingTreeDirty(brain)).toBe(false);
  });
  expect(state(other)).toEqual(before);
  expect(git(brain, 'show', 'HEAD:a.md')).toBe('brain second');
});
