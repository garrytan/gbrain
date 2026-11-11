/**
 * GST-2118: gbrain's own write-through commit (`commitPathsLocked`) and `gbrain git commit-push --pending` read
 * "is this file still uncommitted?" from `git status`, which is blind to an entry flagged assume-unchanged. A
 * write-through file with that flag was not committed, yet the pending ledger dropped it (so doctor `dirty_age`
 * never saw it and nothing retried it), and `--pending` answered nothing_to_commit with exit 0. A flagged file whose
 * bytes differ from HEAD now counts as uncommitted: the ledger keeps it, doctor reports it, and `--pending` fails
 * `commit_paths_skipped` naming it. Seams: none; real git in temp repositories, the real CLI for `--pending`.
 * DB-free, so there is no engine axis.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitWriteThroughFile } from '../src/core/brain-repo-durability.ts';
import { commitPathsLocked, notePending, pendingWriteThroughStillDirty, readPendingWriteThrough } from '../src/core/git/commit-push.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-pending-flagged-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const identity = { GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.invalid', GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'example@example.invalid' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } }).trim();
const page = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;

/** A brain checkout with two committed pages; `remote` gives it a bare upstream (`--pending` publishes, so it needs one). */
function fixture(name: string, remote = false): string {
  const brain = join(dir, name);
  if (remote) {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', `${brain}.git`]);
    execFileSync('git', ['clone', '-q', `${brain}.git`, brain], { stdio: 'ignore' });
    git(brain, 'checkout', '-q', '-b', 'main');
  } else {
    execFileSync('git', ['init', '-q', '-b', 'main', brain]);
  }
  mkdirSync(join(brain, 'people'));
  writeFileSync(join(brain, 'people', 'alice-example.md'), page('Alice', 'First version.'));
  writeFileSync(join(brain, 'people', 'bob-example.md'), page('Bob', 'First version.'));
  git(brain, 'add', '.'); git(brain, 'commit', '-qm', 'init');
  if (remote) git(brain, 'push', '-q', '-u', 'origin', 'main');
  return brain;
}
/** gbrain writes the page, but the entry is flagged assume-unchanged (an editor or indexer left it), so git add skips it. */
const writeFlagged = (brain: string, path: string) => {
  git(brain, 'update-index', '--assume-unchanged', '--', path);
  writeFileSync(join(brain, path), page('Hidden', 'A write-through edit git add does not see.'));
};
const headBlob = (brain: string, path: string) => git(brain, 'show', `HEAD:${path}`);
const ledger = (brain: string) => readPendingWriteThrough(brain).map(e => e.path);

test('a flagged write-through file is not committed and stays in the pending ledger, where doctor dirty_age sees it', async () => {
  const brain = fixture('locked-flagged');
  writeFlagged(brain, 'people/alice-example.md');
  const thrown = await withEnv(identity, async () => {
    try { commitPathsLocked(brain, [join(brain, 'people', 'alice-example.md')], 'gbrain: write-through people/alice-example', { lockWaitMs: 1000 }); } catch (e) { return e as { code?: string; detail?: string }; }
    return null;
  });
  expect(thrown?.code).toBe('commit_paths_skipped');
  expect(JSON.parse(thrown!.detail!).committed).toBeNull();
  expect(headBlob(brain, 'people/alice-example.md')).toContain('First version.');
  expect(ledger(brain)).toEqual(['people/alice-example.md']);
  expect(pendingWriteThroughStillDirty(brain).map(e => e.path)).toEqual(['people/alice-example.md']);
});

test('a later write-through commits an older flagged ledger entry beside its own file instead of settling it away', async () => {
  const brain = fixture('locked-settle');
  writeFlagged(brain, 'people/alice-example.md');
  notePending(brain, ['people/alice-example.md']);
  writeFileSync(join(brain, 'people', 'bob-example.md'), page('Bob', 'Second version.'));
  const sha = await withEnv(identity, async () => commitPathsLocked(brain, [join(brain, 'people', 'bob-example.md')], 'gbrain: write-through people/bob-example', { lockWaitMs: 1000 }));
  expect(sha).not.toBeNull();
  expect(headBlob(brain, 'people/bob-example.md')).toContain('Second version.');
  expect(headBlob(brain, 'people/alice-example.md')).toContain('A write-through edit git add does not see.');
  expect(ledger(brain)).toEqual([]);
});

test('a flagged ledger entry git cannot hash is kept, and a later write-through still commits its own file', async () => {
  const brain = fixture('locked-unhashable');
  git(brain, 'update-index', '--assume-unchanged', '--', 'people/alice-example.md');
  rmSync(join(brain, 'people', 'alice-example.md'));
  mkdirSync(join(brain, 'people', 'alice-example.md'));
  writeFileSync(join(brain, 'people', 'alice-example.md', 'note.md'), page('Note', 'A directory where a page was.'));
  notePending(brain, ['people/alice-example.md']);
  writeFileSync(join(brain, 'people', 'bob-example.md'), page('Bob', 'Second version.'));
  const sha = await withEnv(identity, async () => commitPathsLocked(brain, [join(brain, 'people', 'bob-example.md')], 'gbrain: write-through people/bob-example', { lockWaitMs: 1000 }));
  expect(sha).not.toBeNull();
  expect(headBlob(brain, 'people/bob-example.md')).toContain('Second version.');
  expect(ledger(brain)).toEqual(['people/alice-example.md']);
  expect(pendingWriteThroughStillDirty(brain).map(e => e.path)).toEqual(['people/alice-example.md']);
});

test('a write-through to a skip-worktree file git add refuses stays in the ledger, and --pending reports it as skipped', async () => {
  const brain = fixture('locked-skip-worktree', true);
  git(brain, 'update-index', '--skip-worktree', '--', 'people/alice-example.md');
  writeFileSync(join(brain, 'people', 'alice-example.md'), page('Hidden', 'A write-through edit git add refuses.'));
  writeFileSync(join(brain, 'people', 'bob-example.md'), page('Bob', 'Second version.'));
  const thrown = await withEnv(identity, async () => {
    try { commitPathsLocked(brain, [join(brain, 'people', 'alice-example.md'), join(brain, 'people', 'bob-example.md')], 'gbrain: write-through', { lockWaitMs: 1000 }); } catch (e) { return e as { code?: string; detail?: string }; }
    return null;
  });
  expect(thrown?.code).toBe('commit_paths_skipped');
  expect(JSON.parse(thrown!.detail!).committed).toBe(git(brain, 'rev-parse', 'HEAD'));
  expect(headBlob(brain, 'people/bob-example.md')).toContain('Second version.');
  expect(headBlob(brain, 'people/alice-example.md')).toContain('First version.');
  expect(ledger(brain)).toEqual(['people/alice-example.md']);
  const r = await runCli(['git', 'commit-push', '--json', '--path', brain, '--pending'], { cwd: dir, home: join(dir, 'skip-home'), env: identity });
  expect(r.exitCode).not.toBe(0);
  const e = JSON.parse(r.stdout) as { code: string; message: string };
  expect(e.code).toBe('commit_paths_skipped');
  expect(e.message).toContain('people/alice-example.md');
  expect(ledger(brain)).toEqual(['people/alice-example.md']);
}, 60_000);

test('commit-push --pending fails commit_paths_skipped on a flagged pending file and keeps its ledger entry', async () => {
  const brain = fixture('pending-flagged', true);
  writeFlagged(brain, 'people/alice-example.md');
  notePending(brain, ['people/alice-example.md']);
  const before = git(brain, 'rev-parse', 'HEAD');
  const r = await runCli(['git', 'commit-push', '--json', '--path', brain, '--pending'], { cwd: dir, home: join(dir, 'pending-home'), env: identity });
  expect(r.exitCode).not.toBe(0);
  const e = JSON.parse(r.stdout) as { code: string; message: string };
  expect(e.code).toBe('commit_paths_skipped');
  expect(e.message).toContain('people/alice-example.md');
  expect(git(brain, 'rev-parse', 'HEAD')).toBe(before);
  expect(ledger(brain)).toEqual(['people/alice-example.md']);
}, 60_000);

test('page write-through end to end: a flagged page is reported not committed, nothing is undone, the ledger keeps it, and the next write-through commits it', async () => {
  const brain = fixture('write-through-flagged');
  const alice = join(brain, 'people', 'alice-example.md');
  writeFlagged(brain, 'people/alice-example.md');
  const before = git(brain, 'rev-parse', 'HEAD');
  const first = await withEnv(identity, async () => commitWriteThroughFile(brain, alice, 'people/alice-example'));
  expect(first).toBe(false);
  expect(git(brain, 'rev-parse', 'HEAD')).toBe(before);
  expect(git(brain, 'diff', '--cached', '--name-only')).toBe('');
  expect(readFileSync(alice, 'utf8')).toContain('A write-through edit git add does not see.');
  expect(ledger(brain)).toEqual(['people/alice-example.md']);
  expect(pendingWriteThroughStillDirty(brain).map(e => e.path)).toEqual(['people/alice-example.md']);
  writeFileSync(join(brain, 'people', 'bob-example.md'), page('Bob', 'Second version.'));
  const next = await withEnv(identity, async () => commitWriteThroughFile(brain, join(brain, 'people', 'bob-example.md'), 'people/bob-example'));
  expect(next).toBe(true);
  expect(headBlob(brain, 'people/bob-example.md')).toContain('Second version.');
  expect(headBlob(brain, 'people/alice-example.md')).toContain('A write-through edit git add does not see.');
  expect(git(brain, 'diff', '--cached', '--name-only')).toBe('');
  expect(ledger(brain)).toEqual([]);
});

test('a skip-worktree file left in the ledger does not fail a later write-through of another page', async () => {
  const brain = fixture('skip-later');
  git(brain, 'update-index', '--skip-worktree', '--', 'people/alice-example.md');
  writeFileSync(join(brain, 'people', 'alice-example.md'), page('Hidden', 'A write-through edit git add refuses.'));
  notePending(brain, ['people/alice-example.md']);
  writeFileSync(join(brain, 'people', 'bob-example.md'), page('Bob', 'Second version.'));
  const sha = await withEnv(identity, async () => commitPathsLocked(brain, [join(brain, 'people', 'bob-example.md')], 'w', { lockWaitMs: 1000 }));
  expect(sha).toBe(git(brain, 'rev-parse', 'HEAD').trim());
  expect(headBlob(brain, 'people/bob-example.md')).toContain('Second version.');
  expect(ledger(brain)).toEqual(['people/alice-example.md']);
});

test('a file flagged both skip-worktree and assume-unchanged does not stop other pending pages from committing', async () => {
  const brain = fixture('both-flags');
  git(brain, 'update-index', '--skip-worktree', '--', 'people/alice-example.md');
  git(brain, 'update-index', '--assume-unchanged', '--', 'people/alice-example.md');
  expect(git(brain, 'ls-files', '-v', '--', 'people/alice-example.md')).toStartWith('s ');
  writeFileSync(join(brain, 'people', 'alice-example.md'), page('Hidden', 'A write-through edit git add refuses.'));
  writeFileSync(join(brain, 'people', 'bob-example.md'), page('Bob', 'A pending edit.'));
  notePending(brain, ['people/alice-example.md', 'people/bob-example.md']);
  writeFileSync(join(brain, 'people', 'carol-example.md'), page('Carol', 'New page.'));
  await withEnv(identity, async () => commitPathsLocked(brain, [join(brain, 'people', 'carol-example.md')], 'w', { lockWaitMs: 1000 }));
  expect(headBlob(brain, 'people/carol-example.md')).toContain('New page.');
  expect(headBlob(brain, 'people/bob-example.md')).toContain('A pending edit.');
  expect(git(brain, 'diff', '--cached', '--name-only').trim()).toBe('');
  expect(ledger(brain)).toEqual(['people/alice-example.md']);
});

test('control: an ordinary pending file is committed by --pending and the ledger settles empty', async () => {
  const brain = fixture('pending-ok', true);
  writeFileSync(join(brain, 'people', 'alice-example.md'), page('Alice', 'Second version.'));
  notePending(brain, ['people/alice-example.md']);
  const r = await runCli(['git', 'commit-push', '--json', '--path', brain, '--pending'], { cwd: dir, home: join(dir, 'ok-home'), env: identity });
  expect(r.exitCode).toBe(0);
  expect(headBlob(brain, 'people/alice-example.md')).toContain('Second version.');
  expect(ledger(brain)).toEqual([]);
}, 60_000);
