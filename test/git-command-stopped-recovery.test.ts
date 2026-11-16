/**
 * A git child that gbrain stops (its time limit or a signal) after this change throws git_command_stopped instead of
 * returning exit -1. Two recovery paths keyed on the old outcome must still see it.
 * Protects: a write-through commit whose git child was stopped keeps its page in the pending write-through ledger
 * (so the next write-through and `--pending` retry it and doctor dirty_age reports it), and a push URL whose ls-remote is
 * stopped after the local commit still ends in push_unconfirmed (exit 4, the commit is durable locally; `--push-only`).
 * Fails when: PENDING_NOTED leaves out git_command_stopped, or a remote call in pushBase or remoteContains omits returnStopped.
 * Seams: none; real git in temp repositories. A pre-commit hook and an upload-pack wrapper kill their parent git with
 * SIGKILL, the way the out-of-memory killer would. DB-free, so there is no engine axis.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitPathsLocked, readPendingWriteThrough } from '../src/core/git/commit-push.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-git-stopped-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const identity = { GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.invalid', GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'example@example.invalid' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const page = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;

/** A script that SIGKILLs the nearest git process above it (a shell may sit between, and git may run as git.real). */
function killer(name: string): string {
  const file = join(dir, name);
  writeFileSync(file, [
    '#!/bin/sh',
    'p=$$',
    'while [ "$p" -gt 1 ]; do',
    '  p=$(ps -o ppid= -p "$p" | tr -d " ")',
    '  case "$(ps -o comm= -p "$p")" in *git*) kill -9 "$p"; exit 1;; esac',
    'done',
    'exit 1',
    '',
  ].join('\n'));
  chmodSync(file, 0o755);
  return file;
}

test('a write-through commit whose git child is killed stays in the pending ledger', async () => {
  const brain = join(dir, 'write-through');
  execFileSync('git', ['init', '-q', '-b', 'main', brain]);
  mkdirSync(join(brain, 'people'));
  writeFileSync(join(brain, 'people', 'alice-example.md'), page('Alice', 'First version.'));
  git(brain, 'add', '.'); git(brain, 'commit', '-qm', 'init');
  const hooks = join(brain, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\nexec ${killer('kill-commit.sh')}\n`);
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  writeFileSync(join(brain, 'people', 'alice-example.md'), page('Alice', 'A write-through edit.'));

  const thrown = await withEnv(identity, async () => {
    try { commitPathsLocked(brain, [join(brain, 'people', 'alice-example.md')], 'gbrain: write-through people/alice-example', { lockWaitMs: 1000 }); } catch (e) { return e as { code?: string; reason?: string }; }
    return null;
  });
  expect(thrown).toMatchObject({ code: 'git_command_stopped', reason: 'signal' });
  expect(readPendingWriteThrough(brain).map(e => e.path)).toContain('people/alice-example.md');
}, 60_000);

test('a push URL whose ls-remote is killed after the local commit reports push_unconfirmed, exit 4', async () => {
  const first = join(dir, 'first.git'), second = join(dir, 'second.git'), brain = join(dir, 'push-brain'), home = join(dir, 'home');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', first]);
  execFileSync('git', ['clone', '-q', first, brain], { stdio: 'ignore' });
  git(brain, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(brain, 'a.md'), page('A', 'First version.'));
  git(brain, 'add', '.'); git(brain, 'commit', '-qm', 'init'); git(brain, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', '--bare', first, second], { stdio: 'ignore' });
  git(brain, 'remote', 'set-url', '--add', '--push', 'origin', first);
  git(brain, 'remote', 'set-url', '--add', '--push', 'origin', `file://${second}`);
  git(brain, 'config', `remote.file://${second}.uploadpack`, killer('kill-upload-pack.sh'));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(brain, 'a.md'), page('A', 'Second version.'));
  const head = git(brain, 'rev-parse', 'HEAD');

  const result = await runCli(['git', 'commit-push', '--json', '--path', brain, '-m', 'save page', '--', 'a.md'], { cwd: dir, home, env: { ...identity, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' } });
  expect(JSON.parse(result.stdout).code).toBe('push_unconfirmed');
  expect(result.exitCode).toBe(4);
  expect(git(brain, 'rev-parse', 'HEAD')).not.toBe(head);
  expect(git(brain, 'show', 'HEAD:a.md')).toBe(page('A', 'Second version.').trim());
}, 60_000);
