/**
 * #8662: `gbrain git commit-push` resolves its checkout from the working directory, so a wrapper that cd'd into some other
 * repository made it act there: a path outside that repository was refused as `commit_paths_invalid` with nothing saying
 * the checkout was the wrong one, and a path that also existed there was committed and pushed to it. On a host whose brain
 * records source checkouts, a checkout that is none of them (and carries no gbrain source marker) is now refused
 * `checkout_not_a_source`, naming the resolved path and the registered checkouts, before anything is staged.
 * Seams: none; the real CLI against temp repositories and a managed-root registry under a temp GBRAIN_HOME.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalFilesystemPath, recordManagedRoots } from '../src/core/persistence/root-registry.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-8662-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const identity = { GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.invalid', GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'example@example.invalid' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository with a pushed first commit and an uncommitted notes/a.md, like a code checkout a wrapper cd'd into. */
function otherRepo(name: string): string {
  const remote = join(dir, `${name}.git`), root = join(dir, name);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, root], { stdio: 'ignore' });
  git(root, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'code\n');
  git(root, 'add', 'README.md'); git(root, 'commit', '-qm', 'init'); git(root, 'push', '-q', 'origin', 'main');
  mkdirSync(join(root, 'notes'));
  writeFileSync(join(root, 'notes', 'a.md'), 'not a brain page\n');
  return root;
}

/** A GBRAIN_HOME whose managed-root registry records one brain checkout (source-a) with an uncommitted page. */
function brainHome(name: string): { home: string; brain: string } {
  const home = join(dir, `${name}-home`), brain = join(dir, `${name}-brain`);
  mkdirSync(join(brain, 'people'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', brain]);
  writeFileSync(join(brain, 'README.md'), 'brain\n');
  git(brain, 'add', 'README.md'); git(brain, 'commit', '-qm', 'init');
  writeFileSync(join(brain, 'people', 'alice-example.md'), '---\ntitle: Alice\n---\nA page.\n');
  withEnv({ GBRAIN_HOME: home }, () => { recordManagedRoots('00000000-0000-4000-8000-000000008662', [{ local_path: brain, source_id: 'source-a' }]); });
  return { home, brain };
}

const commitPush = (cwd: string, home: string, ...rest: string[]) => runCli(['git', 'commit-push', '--json', '-m', 'add page', ...rest], { cwd, home, env: identity });

test('a checkout that is not a registered source is refused checkout_not_a_source, naming it and the registered checkouts', async () => {
  const { home, brain } = brainHome('refused');
  const other = otherRepo('refused-code');
  const before = git(other, 'rev-parse', 'HEAD');
  for (const paths of [['notes/a.md'], [join(brain, 'people', 'alice-example.md')]]) {
    const result = await commitPush(other, home, '--', ...paths);
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout) as { code: string; message: string; fix?: { next: string; command?: string } };
    expect(envelope.code).toBe('checkout_not_a_source');
    expect(envelope.message).toContain(other);
    expect(envelope.message).toContain(canonicalFilesystemPath(brain));
    expect(envelope.fix?.next).toBe('tell_user_to_run');
    expect(envelope.fix?.command).toContain(`--path ${canonicalFilesystemPath(brain)}`);
  }
  expect(git(other, 'rev-parse', 'HEAD')).toBe(before);
  expect(git(other, 'status', '--porcelain')).toBe('?? notes/');
  // The fix and verify it prescribes run as given: a dry run of the named checkout, with no paths, writes nothing.
  const dry = await runCli(['git', 'commit-push', '--json', '--dry-run', '--path', canonicalFilesystemPath(brain)], { cwd: other, home, env: identity });
  expect(dry.exitCode).toBe(0);
  expect(JSON.parse(dry.stdout)).toMatchObject({ dry_run: true, paths: [] });
}, 60_000);

test('the registered checkout still commits, a gbrain source marker admits its checkout, and an explicit --path is not checked', async () => {
  const { home, brain } = brainHome('admitted');
  const result = await commitPush(dir, home, '--path', brain, '--', 'people/alice-example.md');
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'committed_local', paths: ['people/alice-example.md'] });
  expect(git(brain, 'log', '-1', '--format=%s')).toBe('add page');
  const marked = otherRepo('admitted-marked');
  git(marked, 'config', '--local', 'gbrain.sourceRoot', 'notes');
  const published = await commitPush(marked, home, '--', 'notes/a.md');
  expect(published.exitCode).toBe(0);
  expect(JSON.parse(published.stdout)).toMatchObject({ outcome: 'pushed', paths: ['notes/a.md'] });
  // A legacy source checkout hardened by gbrain (its committed helper calls commit-push from the checkout with no --path).
  for (const [name, mark] of [['admitted-clipath', (root: string) => git(root, 'config', '--local', 'gbrain.cliPath', '/usr/local/bin/gbrain')],
    ['admitted-helper', (root: string) => { mkdirSync(join(root, 'scripts')); writeFileSync(join(root, 'scripts', 'brain-commit-push.sh'), '#!/bin/sh\n'); }]] as const) {
    const hardened = otherRepo(name);
    mark(hardened);
    const committed = await commitPush(hardened, home, '--', 'notes/a.md');
    expect(committed.exitCode).toBe(0);
    expect(JSON.parse(committed.stdout)).toMatchObject({ outcome: 'pushed', paths: ['notes/a.md'] });
  }
  // An explicit --path names its checkout: a legacy source the managed-root record does not list still commits.
  const legacy = otherRepo('admitted-legacy');
  const named = await commitPush(dir, home, '--path', legacy, '--', 'notes/a.md');
  expect(named.exitCode).toBe(0);
  expect(JSON.parse(named.stdout)).toMatchObject({ outcome: 'pushed', paths: ['notes/a.md'] });
}, 60_000);

test('a host whose brain records no source checkout commits in any checkout as before', async () => {
  const other = otherRepo('unregistered-code');
  const result = await commitPush(other, join(dir, 'empty-home'), '--', 'notes/a.md');
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'pushed', paths: ['notes/a.md'] });
}, 60_000);

test('GST-1623: a repository that only encloses a registered checkout is refused; a registered subdirectory of the checkout admits it', async () => {
  const outer = otherRepo('enclosing-code');
  const home = join(dir, 'enclosing-home'), brain = join(outer, 'brain');
  mkdirSync(join(brain, 'people'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', brain]);
  writeFileSync(join(brain, 'README.md'), 'brain\n');
  git(brain, 'add', 'README.md'); git(brain, 'commit', '-qm', 'init');
  withEnv({ GBRAIN_HOME: home }, () => { recordManagedRoots('00000000-0000-4000-8000-000000001623', [{ local_path: brain, source_id: 'source-a' }]); });
  const before = git(outer, 'rev-parse', 'HEAD');
  const refused = await commitPush(outer, home, '--', 'notes/a.md');
  expect(refused.exitCode).toBe(1);
  expect((JSON.parse(refused.stdout) as { code: string }).code).toBe('checkout_not_a_source');
  expect(git(outer, 'rev-parse', 'HEAD')).toBe(before);
  const tracked = otherRepo('subdir-source');
  const subHome = join(dir, 'subdir-home');
  withEnv({ GBRAIN_HOME: subHome }, () => { recordManagedRoots('00000000-0000-4000-8000-000000001624', [{ local_path: join(tracked, 'notes'), source_id: 'source-a' }]); });
  git(tracked, 'add', 'notes/a.md'); git(tracked, 'commit', '-qm', 'track notes');
  writeFileSync(join(tracked, 'notes', 'a.md'), 'an edited page\n');
  const admitted = await commitPush(tracked, subHome, '--', 'notes/a.md');
  expect(admitted.exitCode).toBe(0);
  expect(JSON.parse(admitted.stdout)).toMatchObject({ outcome: 'committed_local', paths: ['notes/a.md'] });
}, 60_000);

test('GST-1623: a stale gbrain-managed.json an older gbrain left in the enclosing repository does not admit it', async () => {
  const outer = otherRepo('stale-marker-code');
  const home = join(dir, 'stale-marker-home'), brain = join(outer, 'brain');
  mkdirSync(join(brain, 'people'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', brain]);
  writeFileSync(join(brain, 'README.md'), 'brain\n');
  git(brain, 'add', 'README.md'); git(brain, 'commit', '-qm', 'init');
  withEnv({ GBRAIN_HOME: home }, () => { recordManagedRoots('00000000-0000-4000-8000-000000001625', [{ local_path: brain, source_id: 'source-a' }]); });
  // The marker gbrain before #7988 wrote into an enclosing repository for a root it does not track (filesystem-guard.ts: stale).
  writeFileSync(join(outer, '.git', 'gbrain-managed.json'), JSON.stringify({ root: canonicalFilesystemPath(brain) }));
  const before = git(outer, 'rev-parse', 'HEAD');
  const refused = await commitPush(outer, home, '--', 'notes/a.md');
  expect(refused.exitCode).toBe(1);
  expect((JSON.parse(refused.stdout) as { code: string }).code).toBe('checkout_not_a_source');
  expect(git(outer, 'rev-parse', 'HEAD')).toBe(before);
  expect(git(outer, 'diff', '--cached', '--name-only')).toBe('');
}, 60_000);

test('GST-1623: a managed-root registry that cannot be listed is refused with a typed error, not a raw one', async () => {
  const other = otherRepo('registry-unreadable');
  const home = join(dir, 'registry-unreadable-home');
  mkdirSync(join(home, '.gbrain', 'persistence'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'persistence', 'managed-roots'), 'not a directory\n');
  const before = git(other, 'rev-parse', 'HEAD');
  const result = await commitPush(other, home, '--', 'notes/a.md');
  expect(result.exitCode).toBe(1);
  const envelope = JSON.parse(result.stdout) as { code: string; message: string; suggestion?: string };
  expect(envelope.code).toBe('writer_coordinator_required');
  expect(envelope.message).toContain('cannot be listed');
  expect(git(other, 'rev-parse', 'HEAD')).toBe(before);
}, 60_000);

