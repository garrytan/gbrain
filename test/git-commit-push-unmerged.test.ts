/**
 * commit-push refuses a named file that still has unresolved merge conflicts in the index (unmerged stage 1-3 entries,
 * as a stash pop that stopped on a conflict leaves them, with no MERGE_HEAD), before it stages anything.
 * Protects: the conflict markers never reach a commit or the remote, the other named paths are not committed either, and
 * the file stays unmerged for the person to resolve, on a plain checkout and on a managed canonical worktree.
 * Fails when: admitPaths stages the file with git add, which records it, markers and all, as resolved.
 * Seams: none; the real CLI against temp repositories, a bare remote and a managed-root registry under a temp GBRAIN_HOME.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordManagedRoots } from '../src/core/persistence/root-registry.ts';
import { commitPathsLocked, readPendingWriteThrough } from '../src/core/git/commit-push.ts';
import { assertNoUnmergedPaths } from '../src/core/git/skipped-paths.ts';
import { CODES } from '../src/core/error-registry.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-commit-unmerged-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const identity = { GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.invalid', GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'example@example.invalid' };
const git = (root: string, args: string[], input?: string) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const page = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;

interface Fixture { home: string; remote: string; brain: string }

/** A pushed checkout holding people/alice-example.md and notes/b.md; `managed` registers it as source-a's canonical worktree. */
function fixture(name: string, managed: boolean): Fixture {
  const remote = join(dir, `${name}.git`), brain = join(dir, `${name}-brain`), home = join(dir, `${name}-home`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, brain], { stdio: 'ignore' });
  git(brain, ['checkout', '-q', '-b', 'main']);
  mkdirSync(join(brain, 'people')); mkdirSync(join(brain, 'notes'));
  writeFileSync(join(brain, 'people', 'alice-example.md'), page('Alice', 'First version.'));
  writeFileSync(join(brain, 'notes', 'b.md'), page('B', 'First version.'));
  git(brain, ['add', '.']); git(brain, ['commit', '-qm', 'init']); git(brain, ['push', '-q', '-u', 'origin', 'main']);
  mkdirSync(home, { recursive: true });
  if (managed) withEnv({ GBRAIN_HOME: home }, () => { recordManagedRoots('00000000-0000-4000-8000-000000000911', [{ local_path: brain, source_id: 'source-a' }]); });
  return { home, remote, brain };
}

/** Leaves people/alice-example.md conflicted the way a stash pop that stopped on a conflict does: stages 1-3 in the index, markers in the file, no MERGE_HEAD. */
function conflict(f: Fixture): string {
  const path = 'people/alice-example.md';
  const blob = (text: string) => git(f.brain, ['hash-object', '-w', '--stdin'], text);
  const [base, ours, theirs] = [page('Alice', 'First version.'), page('Alice', 'Upstream edit.'), page('Alice', 'Local edit.')].map(blob);
  const marked = `---\ntitle: Alice\n---\n<<<<<<< Updated upstream\nUpstream edit.\n=======\nLocal edit.\n>>>>>>> Stashed changes\n`;
  writeFileSync(join(f.brain, path), marked);
  git(f.brain, ['update-index', '--index-info'], `0 ${'0'.repeat(40)}\t${path}\n100644 ${base} 1\t${path}\n100644 ${ours} 2\t${path}\n100644 ${theirs} 3\t${path}\n`);
  writeFileSync(join(f.brain, 'notes', 'b.md'), page('B', 'Second version.'));
  return path;
}

for (const managed of [false, true]) {
  test(`a named file with unresolved conflicts is refused before staging, and nothing is committed (${managed ? 'managed canonical worktree' : 'plain checkout'})`, async () => {
    const f = fixture(managed ? 'managed' : 'plain', managed);
    const path = conflict(f);
    const head = git(f.brain, ['rev-parse', 'HEAD']), tip = git(f.remote, ['rev-parse', 'refs/heads/main']);
    const unmerged = git(f.brain, ['ls-files', '-u', '--', path]);
    expect(unmerged.split('\n')).toHaveLength(3);

    const result = await runCli(['git', 'commit-push', '--json', '--path', f.brain, '-m', 'save pages', '--', path, 'notes/b.md'], { cwd: dir, home: f.home, env: identity });
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.code).toBe('commit_paths_unmerged');
    expect(envelope.message).toContain(path);
    expect(envelope.fix).toMatchObject({ next: 'ask_user', verify: { argv: ['git', '-C', f.brain, 'ls-files', '-u', '--', `:(literal)${path}`] } });
    for (const advice of [envelope.suggestion, envelope.fix.user_message, CODES.commit_paths_unmerged.suggestion]) {
      expect(advice).not.toMatch(/--ours|--theirs/);
      expect(advice).toContain('both');
    }

    expect(git(f.brain, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(f.remote, ['rev-parse', 'refs/heads/main'])).toBe(tip);
    expect(git(f.brain, ['ls-files', '-u', '--', path])).toBe(unmerged);
    expect(git(f.brain, ['diff', '--cached', '--name-only', '--', 'notes/b.md'])).toBe('');
  }, 60_000);
}


test('a write-through file left unmerged is refused and kept in the pending ledger, so it is retried and doctor reports it', async () => {
  const f = fixture('write-through', false);
  const path = conflict(f);
  const thrown = await withEnv({ ...identity, GBRAIN_HOME: f.home }, async () => {
    try { commitPathsLocked(f.brain, [join(f.brain, path)], 'gbrain: write-through people/alice-example', { lockWaitMs: 1000 }); } catch (e) { return e as { code?: string }; }
    return null;
  });
  expect(thrown).toMatchObject({ code: 'commit_paths_unmerged' });
  expect(readPendingWriteThrough(f.brain).map(e => e.path)).toContain(path);
  expect(git(f.brain, ['ls-files', '-u', '--', path]).split('\n')).toHaveLength(3);
}, 60_000);

test('an unmerged file in the pending ledger does not hold back the other pending files a later write-through sweeps', async () => {
  const f = fixture('sweep-past-conflict', false);
  const path = conflict(f);
  await withEnv({ ...identity, GBRAIN_HOME: f.home }, async () => {
    expect(() => commitPathsLocked(f.brain, [join(f.brain, path), join(f.brain, 'notes', 'b.md')], 'gbrain: write-through two pages', { lockWaitMs: 1000 }))
      .toThrow(expect.objectContaining({ code: 'commit_paths_unmerged' }));
    expect(readPendingWriteThrough(f.brain).map(e => e.path).sort()).toEqual(['notes/b.md', path]);
    writeFileSync(join(f.brain, 'notes', 'c.md'), page('C', 'New page.'));
    expect(commitPathsLocked(f.brain, [join(f.brain, 'notes', 'c.md')], 'gbrain: write-through notes/c', { lockWaitMs: 1000 })).toBeTruthy();
  });
  expect(git(f.brain, ['show', '--name-only', '--format=', 'HEAD']).split('\n').sort()).toEqual(['notes/b.md', 'notes/c.md']);
  expect(git(f.brain, ['ls-files', '-u', '--', path]).split('\n')).toHaveLength(3);
  expect(readPendingWriteThrough(f.brain).map(e => e.path)).toContain(path);
}, 60_000);

test('a failing unmerged-path check refuses instead of reading as no conflicts', () => {
  const f = fixture('unreadable-index', false);
  writeFileSync(join(f.brain, '.git', 'index'), 'not an index');
  let thrown: { code?: string; message?: string } | null = null;
  try { assertNoUnmergedPaths(f.brain, ['people/alice-example.md']); } catch (e) { thrown = e as { code?: string; message?: string }; }
  expect(thrown).toMatchObject({ code: 'git_unavailable' });
  expect(thrown!.message).toContain('ls-files');
}, 60_000);
