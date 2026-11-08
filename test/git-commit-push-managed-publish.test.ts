/**
 * GST-1923: on a managed canonical worktree, `gbrain git commit-push` committed the named paths and stopped. A commit that
 * already existed (a script's bare commit, or one an earlier call made) answered "nothing to commit", exit 0, pushed
 * nothing and logged `ok-already-on-remote`, while a sibling clone kept pushing the same branch, so the checkout sat
 * diverged until something else published it. It now publishes the commits the upstream lacks the way
 * `--push-only --keep-checkout` does: the remote is merged in memory (never a rebase or force), a conflict refuses, and
 * the checkout never moves. A checkout already on its upstream stays a no-op.
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

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-gst1923-')));
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
  withEnv({ GBRAIN_HOME: home }, () => { recordManagedRoots('00000000-0000-4000-8000-000000001923', [{ local_path: brain, source_id: 'source-a' }]); });
  return { home, remote, brain, sibling };
}

const remoteTip = (f: Fixture) => execFileSync('git', ['-C', f.remote, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim();
const onRemote = (f: Fixture, sha: string) => { try { execFileSync('git', ['-C', f.remote, 'merge-base', '--is-ancestor', sha, 'refs/heads/main']); return true; } catch { return false; } };
const siblingPush = (f: Fixture, file: string, body: string) => {
  mkdirSync(join(f.sibling, 'notes'), { recursive: true });
  writeFileSync(join(f.sibling, file), body);
  git(f.sibling, 'add', file); git(f.sibling, 'commit', '-qm', `sibling: ${file}`); git(f.sibling, 'pull', '-q', '--no-rebase', 'origin', 'main'); git(f.sibling, 'push', '-q', 'origin', 'main');
  return git(f.sibling, 'rev-parse', 'HEAD');
};
const commitPush = (f: Fixture, ...rest: string[]) => runCli(['git', 'commit-push', '--json', '--path', f.brain, '-m', 'add page', ...rest], { cwd: dir, home: f.home, env: identity });
const pushLog = (f: Fixture) => { try { return readFileSync(join(f.home, '.gbrain', 'brain-push.log'), 'utf8'); } catch { return ''; } };

test('a commit that already exists is published merged with a moved remote, not reported as nothing to commit', async () => {
  const f = fixture('stranded');
  const before = remoteTip(f);
  const theirs = siblingPush(f, 'notes/sibling.md', 'From the sibling clone.\n');
  mkdirSync(join(f.brain, 'companies'));
  writeFileSync(join(f.brain, 'companies', 'acme-example.md'), page('Acme', 'Ingested.'));
  writeFileSync(join(f.brain, 'people', 'bob-example.md'), page('Bob', 'Ingested.'));
  git(f.brain, 'add', 'companies/acme-example.md', 'people/bob-example.md'); git(f.brain, 'commit', '-qm', 'ingest: two pages');
  const ours = git(f.brain, 'rev-parse', 'HEAD');
  const result = await commitPush(f, '--', 'companies/acme-example.md');
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'pushed', committed: null, integrated: 1, checkout: 'unchanged', paths: ['companies/acme-example.md'] });
  expect(onRemote(f, ours)).toBe(true);
  expect(onRemote(f, theirs)).toBe(true);
  expect(onRemote(f, before)).toBe(true);
  expect(git(f.remote, 'rev-list', '--parents', '-n', '1', 'refs/heads/main').split(' ')).toHaveLength(3);
  expect(git(f.brain, 'rev-parse', 'HEAD')).toBe(ours);
  expect(git(f.brain, 'status', '--porcelain')).toBe('');
  expect(pushLog(f)).toContain('[push] ok-after-merge main');
  expect(pushLog(f)).not.toContain('ok-already-on-remote');
}, 60_000);

test('a new commit is published at once, and a repeat call on a checkout its upstream already holds pushes nothing', async () => {
  const f = fixture('fresh');
  writeFileSync(join(f.brain, 'people', 'carol-example.md'), page('Carol', 'New page.'));
  const first = await commitPush(f, '--', 'people/carol-example.md');
  expect(first.exitCode).toBe(0);
  const published = JSON.parse(first.stdout) as { outcome: string; committed: string };
  expect(published).toMatchObject({ outcome: 'pushed', integrated: 0, checkout: 'unchanged', paths: ['people/carol-example.md'] });
  expect(published.committed).toBe(git(f.brain, 'rev-parse', 'HEAD'));
  expect(remoteTip(f)).toBe(published.committed);
  const again = await commitPush(f, '--', 'people/carol-example.md');
  expect(again.exitCode).toBe(0);
  expect(JSON.parse(again.stdout)).toMatchObject({ outcome: 'nothing_to_commit', committed: null });
  expect(remoteTip(f)).toBe(published.committed);
}, 60_000);

test('a file both sides changed refuses integrate_conflict, naming the local commit; nothing is pushed or moved', async () => {
  const f = fixture('conflict');
  siblingPush(f, 'people/alice-example.md', page('Alice', 'The sibling version.'));
  const before = remoteTip(f);
  writeFileSync(join(f.brain, 'people', 'alice-example.md'), page('Alice', 'This machine\'s version.'));
  const result = await commitPush(f, '--', 'people/alice-example.md');
  expect(result.exitCode).toBe(1);
  const envelope = JSON.parse(result.stdout) as { code: string; message: string };
  const local = git(f.brain, 'rev-parse', 'HEAD');
  expect(envelope.code).toBe('integrate_conflict');
  expect(envelope.message).toStartWith(`Committed ${local.slice(0, 7)} locally; publishing it did not finish.`);
  expect(git(f.brain, 'log', '-1', '--format=%s')).toBe('add page');
  expect(remoteTip(f)).toBe(before);
  expect(pushLog(f)).toContain('[push] CONFLICT, NEEDS ATTENTION: main');
}, 60_000);
