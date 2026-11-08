/**
 * On a managed canonical worktree, `gbrain git commit-push` commits only the named paths and never pushes: the
 * persistence owner publishes. A commit that already existed (a script's bare commit, or one an earlier call made)
 * used to answer "nothing to commit; origin/main at -", exit 0, and log `[push] ok-already-on-remote`, which the
 * push-log reader counts as a push that landed, while the branch sat ahead of (or diverged from) its upstream. It now
 * reports how many commits the upstream lacks as last fetched, says nothing was pushed, and writes no push-log line.
 * Seams: none; the real CLI against temp repositories, a bare remote, a sibling clone and a managed-root registry under
 * a temp GBRAIN_HOME.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordManagedRoots } from '../src/core/persistence/root-registry.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-managed-unpublished-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const identity = { GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.invalid', GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'example@example.invalid' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const page = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;

interface Fixture { home: string; remote: string; brain: string; sibling: string }

/** A bare remote, the managed brain checkout (registered for source-a) and a sibling clone that pushes the same branch. */
function fixture(name: string): Fixture {
  const remote = join(dir, `${name}.git`), brain = join(dir, `${name}-brain`), sibling = join(dir, `${name}-sibling`), home = join(dir, `${name}-home`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, brain], { stdio: 'ignore' });
  git(brain, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(brain, 'people'));
  writeFileSync(join(brain, 'people', 'alice-example.md'), page('Alice', 'First version.'));
  git(brain, 'add', '.'); git(brain, 'commit', '-qm', 'init'); git(brain, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', '-b', 'main', remote, sibling], { stdio: 'ignore' });
  withEnv({ GBRAIN_HOME: home }, () => { recordManagedRoots('00000000-0000-4000-8000-000000000386', [{ local_path: brain, source_id: 'source-a' }]); });
  return { home, remote, brain, sibling };
}

const remoteTip = (f: Fixture) => git(f.remote, 'rev-parse', 'refs/heads/main');
const siblingPush = (f: Fixture) => {
  mkdirSync(join(f.sibling, 'notes'), { recursive: true });
  writeFileSync(join(f.sibling, 'notes', 'sibling.md'), 'From the sibling clone.\n');
  git(f.sibling, 'add', 'notes/sibling.md'); git(f.sibling, 'commit', '-qm', 'sibling'); git(f.sibling, 'push', '-q', 'origin', 'main');
};
const commitPush = (f: Fixture, json: boolean, ...paths: string[]) =>
  runCli(['git', 'commit-push', ...(json ? ['--json'] : []), '--path', f.brain, '-m', 'add page', '--', ...paths], { cwd: dir, home: f.home, env: identity });
const pushLog = (f: Fixture) => { try { return readFileSync(join(f.home, '.gbrain', 'brain-push.log'), 'utf8'); } catch { return ''; } };

test('a commit that already exists is reported as not on the upstream, not as nothing to commit already on the remote', async () => {
  const f = fixture('stranded');
  siblingPush(f);
  git(f.brain, 'fetch', '-q', 'origin');
  const before = remoteTip(f);
  mkdirSync(join(f.brain, 'companies'));
  writeFileSync(join(f.brain, 'companies', 'acme-example.md'), page('Acme', 'Ingested.'));
  git(f.brain, 'add', 'companies/acme-example.md'); git(f.brain, 'commit', '-qm', 'ingest: one page');
  const ours = git(f.brain, 'rev-parse', 'HEAD');

  const result = await commitPush(f, true, 'companies/acme-example.md');
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'nothing_to_commit', committed: null, managed: true, unpublished: 1, remote: 'origin', branch: 'main' });
  const text = await commitPush(f, false, 'companies/acme-example.md');
  expect(text.exitCode).toBe(0);
  expect(text.stdout).toContain('nothing to commit; not pushed: 1 commit(s) on main are not on origin/main as last fetched');
  expect(pushLog(f)).toBe('');
  expect(remoteTip(f)).toBe(before);
  expect(git(f.brain, 'rev-parse', 'HEAD')).toBe(ours);
}, 60_000);

test('a new commit counts itself among the commits the upstream lacks; a checkout on its upstream says so', async () => {
  const f = fixture('fresh');
  const insync = await commitPush(f, false, 'people/alice-example.md');
  expect(insync.exitCode).toBe(0);
  expect(insync.stdout).toContain('nothing to commit; not pushed: main is on origin/main as last fetched');

  writeFileSync(join(f.brain, 'people', 'carol-example.md'), page('Carol', 'New page.'));
  const result = await commitPush(f, true, 'people/carol-example.md');
  expect(result.exitCode).toBe(0);
  const body = JSON.parse(result.stdout) as { committed: string };
  expect(body).toMatchObject({ outcome: 'committed_local', managed: true, unpublished: 1, paths: ['people/carol-example.md'] });
  expect(body.committed).toBe(git(f.brain, 'rev-parse', 'HEAD'));
  expect(remoteTip(f)).not.toBe(body.committed);
  expect(pushLog(f)).toBe('');
}, 60_000);

test('a branch with no upstream reports no upstream instead of a count', async () => {
  const f = fixture('noupstream');
  git(f.brain, 'branch', '--unset-upstream');
  writeFileSync(join(f.brain, 'people', 'dave-example.md'), page('Dave', 'New page.'));
  const result = await commitPush(f, true, 'people/dave-example.md');
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'committed_local', managed: true, unpublished: null, upstream: null });
  const text = await commitPush(f, false, 'people/dave-example.md');
  expect(text.stdout).toContain('nothing to commit; not pushed: main has no upstream');
  expect(text.stdout).not.toContain('origin/main');
}, 60_000);

test('an upstream whose fetched ref cannot be read reports an unknown count, never a number', async () => {
  const f = fixture('unread');
  git(f.brain, 'update-ref', '-d', 'refs/remotes/origin/main');
  const result = await commitPush(f, true, 'people/alice-example.md');
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'nothing_to_commit', managed: true, unpublished: null, upstream: 'origin/main' });
  const text = await commitPush(f, false, 'people/alice-example.md');
  expect(text.stdout).toContain('nothing to commit; not pushed: an unknown number of commit(s) on main may not be on origin/main as last fetched');
  expect(pushLog(f)).toBe('');
}, 60_000);

test('the message names the upstream the count used when it differs from the branch name', async () => {
  const f = fixture('renamed');
  git(f.brain, 'push', '-q', 'origin', 'main:trunk');
  git(f.brain, 'fetch', '-q', 'origin');
  git(f.brain, 'branch', '-q', '--set-upstream-to', 'origin/trunk');
  const insync = await commitPush(f, false, 'people/alice-example.md');
  expect(insync.exitCode).toBe(0);
  expect(insync.stdout).toContain('nothing to commit; not pushed: main is on origin/trunk as last fetched');
}, 60_000);
