/**
 * commit-push on a checkout whose index listing is larger than Node's default 1 MiB child-output limit.
 * Protects: naming a folder that holds most of a large checkout commits and pushes, because every git read on the commit
 * path takes its whole output; and a git child that is stopped (its time limit, or a signal) reports git_command_stopped
 * with its reason, never git_unavailable and never a cut-off listing used as the answer.
 * Fails when: the runner keeps the default output limit (git is killed with ENOBUFS and reported as "git ls-files -v
 * failed: exit -1"), or a stopped child returns its partial output.
 * Seams: none; real git, a generated index of 15,000 tracked files with long names, and a local bare remote.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git as run } from '../src/core/git/git-run.ts';
import { runCli } from './helpers/cli-spawn.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-large-index-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const identity = { GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.invalid', GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'example@example.invalid',
  GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', maxBuffer: Infinity, stdio: ['ignore', 'pipe', 'pipe'] });
const FILES = 15_000;
const remote = join(dir, 'remote.git'), brain = join(dir, 'brain'), home = join(dir, 'home');

beforeAll(() => {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', brain]);
  for (let i = 0; i < FILES; i++) {
    const shard = join(brain, 'archive', `shard-${String(i % 50).padStart(2, '0')}`);
    if (i < 50) mkdirSync(shard, { recursive: true });
    writeFileSync(join(shard, `a-page-with-a-long-generated-name-so-the-index-listing-grows-quickly-${String(i).padStart(6, '0')}.md`), '');
  }
  git(brain, 'add', '-A'); git(brain, 'commit', '-qm', 'seed');
  git(brain, 'remote', 'add', 'origin', remote); git(brain, 'push', '-q', '-u', 'origin', 'main');
  mkdirSync(home, { recursive: true });
}, 120_000);

const commitPush = (...paths: string[]) =>
  runCli(['git', 'commit-push', '--json', '--path', brain, '-m', 'save pages', '--', ...paths], { cwd: dir, home, env: identity });

describe('a checkout whose index listing passes 1 MiB', () => {
  test('the listing under the named folder is over the old limit', () => {
    expect(git(brain, 'ls-files', '-v', '-z', '--', 'archive').length).toBeGreaterThan(1024 * 1024);
  });

  test('naming a folder that holds most of the checkout commits and pushes it', async () => {
    writeFileSync(join(brain, 'archive', 'shard-07', 'new-page.md'), 'New page.\n');
    writeFileSync(join(brain, 'archive', 'shard-03', `a-page-with-a-long-generated-name-so-the-index-listing-grows-quickly-${'3'.padStart(6, '0')}.md`), 'Edited.\n');
    const result = await commitPush('archive');
    expect(result.stderr).not.toContain('git_unavailable');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'pushed', paths: ['archive'] });
    expect(git(remote, 'show', 'main:archive/shard-07/new-page.md')).toBe('New page.\n');
    expect(git(brain, 'status', '--porcelain', '--', 'archive')).toBe('');
  }, 120_000);

  test('a single file in it commits and pushes too', async () => {
    writeFileSync(join(brain, 'archive', 'shard-07', 'new-page.md'), 'Second version.\n');
    const result = await commitPush('archive/shard-07/new-page.md');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).outcome).toBe('pushed');
    expect(git(remote, 'show', 'main:archive/shard-07/new-page.md')).toBe('Second version.\n');
  }, 120_000);
});

describe('a git child that does not exit on its own', () => {
  const slow = ['-c', 'alias.slow=!sleep 5', 'slow'];
  const killed = ['-c', 'alias.die=!kill -9 $PPID', 'die'];

  test('a child past its time limit is git_command_stopped (timeout), not git_unavailable', () => {
    let error: any;
    try { run(brain, slow, { timeoutMs: 300 }); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 'git_command_stopped', reason: 'timeout' });
    expect(error.message).toContain('did not finish');
  });

  test('a child killed from outside is git_command_stopped (signal)', () => {
    let error: any;
    try { run(brain, killed); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 'git_command_stopped', reason: 'signal' });
    expect(error.message).toContain('SIGKILL');
  });

  test('a remote call can take the stop as its result instead', () => {
    expect(run(brain, slow, { timeoutMs: 300, returnStopped: true }).stopped).toMatchObject({ reason: 'timeout' });
  });
});
