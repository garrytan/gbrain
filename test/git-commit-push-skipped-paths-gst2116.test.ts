/**
 * GST-2116: `gbrain git commit-push` and the committed `scripts/brain-commit-push.sh` exited 0 while a path the caller
 * named was never committed. `git add -A` stages nothing and still exits 0 for a modified entry flagged assume-unchanged
 * or skip-worktree, and for a file inside an untracked nested repository, so the helper answered "nothing to commit" (or
 * pushed the other paths) and the write sat uncommitted with nothing in any log. Every named path git leaves out now
 * fails the run, after the other paths are committed: `writer_coordinator_required` for a page in a managed canonical
 * worktree (save it through put_page), `commit_paths_skipped` for anything else, each skipped path listed.
 * Seams: none; the real CLI and the rendered helper against temp repositories, a bare remote and a managed-root registry
 * under a temp GBRAIN_HOME. commit-push is DB-free, so there is no engine axis.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderCommitPushHelper } from '../src/core/brain-repo-durability.ts';
import { commitAndPush, commitPathsLocked } from '../src/core/git/commit-push.ts';
import { recordManagedRoots } from '../src/core/persistence/root-registry.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-skipped-paths-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const identity = { GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.invalid', GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'example@example.invalid' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const page = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;

interface Fixture { home: string; remote: string; brain: string }
type Kind = 'classic' | 'managed' | 'remoteless';

/** A brain checkout with two committed pages and a note; classic and managed ones track a bare remote. */
function fixture(name: string, kind: Kind): Fixture {
  const remote = join(dir, `${name}.git`), brain = join(dir, `${name}-brain`), home = join(dir, `${name}-home`);
  mkdirSync(home);
  if (kind === 'remoteless') {
    execFileSync('git', ['init', '-q', '-b', 'main', brain]);
  } else {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['clone', '-q', remote, brain], { stdio: 'ignore' });
    git(brain, 'checkout', '-q', '-b', 'main');
  }
  mkdirSync(join(brain, 'people'));
  writeFileSync(join(brain, 'people', 'alice-example.md'), page('Alice', 'First version.'));
  writeFileSync(join(brain, 'people', 'bob-example.md'), page('Bob', 'First version.'));
  writeFileSync(join(brain, 'notes.txt'), 'First note.\n');
  git(brain, 'add', '.'); git(brain, 'commit', '-qm', 'init');
  if (kind !== 'remoteless') git(brain, 'push', '-q', '-u', 'origin', 'main');
  if (kind === 'managed') withEnv({ GBRAIN_HOME: home }, () => { recordManagedRoots('00000000-0000-4000-8000-000000002116', [{ local_path: brain, source_id: 'source-a' }]); });
  return { home, remote, brain };
}

const head = (f: Fixture) => git(f.brain, 'rev-parse', 'HEAD');
const remoteTip = (f: Fixture) => git(f.remote, 'rev-parse', 'refs/heads/main');
const headBlob = (f: Fixture, path: string) => git(f.brain, 'show', `HEAD:${path}`);
const commitPush = (f: Fixture, ...paths: string[]) =>
  runCli(['git', 'commit-push', '--json', '--path', f.brain, '-m', 'write pages', '--', ...paths], { cwd: dir, home: f.home, env: identity });
/** Edit a committed file and flag it assume-unchanged, the way an indexer or editor plugin can leave it. */
const editHidden = (f: Fixture, path: string, flag: '--assume-unchanged' | '--skip-worktree' = '--assume-unchanged') => {
  writeFileSync(join(f.brain, path), page('Hidden', 'An edit git add does not see.'));
  git(f.brain, 'update-index', flag, '--', path);
};
/** A page written into an untracked nested clone inside the checkout: git add stages nothing for it and exits 0. */
const nestedPage = (f: Fixture, name: string) => {
  mkdirSync(join(f.brain, 'imports'), { recursive: true });
  execFileSync('git', ['init', '-q', join(f.brain, 'imports')]);
  writeFileSync(join(f.brain, 'imports', name), page('Carol', 'Written into a nested clone.'));
  return `imports/${name}`;
};
const envelope = (stdout: string) => JSON.parse(stdout) as { code: string; message: string; detail?: string; fix?: { next: string; argv?: string[] } };

test('classic: a modified assume-unchanged page fails commit_paths_skipped instead of nothing to commit, and nothing is pushed', async () => {
  const f = fixture('classic-assume', 'classic');
  const before = head(f);
  editHidden(f, 'people/alice-example.md');
  const r = await commitPush(f, 'people/alice-example.md');
  expect(r.exitCode).not.toBe(0);
  const e = envelope(r.stdout);
  expect(e.code).toBe('commit_paths_skipped');
  expect(e.message).toContain('people/alice-example.md');
  expect(e.fix?.next).toBe('ask_user');
  expect(e.fix?.argv).toEqual(['git', '-C', f.brain, 'update-index', '--no-assume-unchanged', '--', 'people/alice-example.md']);
  expect(head(f)).toBe(before);
  expect(remoteTip(f)).toBe(before);
}, 60_000);

test('classic: with one committable and one skipped path, the first is committed and pushed and the run still fails naming only the second', async () => {
  const f = fixture('classic-mixed', 'classic');
  writeFileSync(join(f.brain, 'people', 'bob-example.md'), page('Bob', 'Second version.'));
  const nested = nestedPage(f, 'carol-example.md');
  const r = await commitPush(f, nested, 'people/bob-example.md');
  expect(r.exitCode).not.toBe(0);
  const e = envelope(r.stdout);
  expect(e.code).toBe('commit_paths_skipped');
  expect(e.message).toContain(nested);
  expect(e.message).not.toContain('people/bob-example.md');
  expect(e.fix?.next).toBe('report');
  expect(headBlob(f, 'people/bob-example.md')).toContain('Second version.');
  expect(remoteTip(f)).toBe(head(f));
  const detail = JSON.parse(e.detail!) as { skipped: { path: string; reason: string }[]; committed: string; pushed: string };
  expect(detail.skipped).toEqual([{ path: nested, reason: 'not_staged' }]);
  expect(detail.committed).toBe(head(f));
  expect(detail.pushed).toBe(head(f));
  expect(readFileSync(join(f.home, '.gbrain', 'brain-push.log'), 'utf8')).toContain(`[push] ok main ${head(f).slice(0, 7)}`);
}, 60_000);

test('classic: a skip-worktree entry under a named directory and a page inside a nested repository both fail the run', async () => {
  const f = fixture('classic-dir', 'classic');
  const before = head(f);
  editHidden(f, 'people/bob-example.md', '--skip-worktree');
  nestedPage(f, 'carol-example.md');
  const r = await commitPush(f, 'people/', 'imports/carol-example.md');
  expect(r.exitCode).not.toBe(0);
  const e = envelope(r.stdout);
  expect(e.code).toBe('commit_paths_skipped');
  const detail = JSON.parse(e.detail!) as { skipped: { path: string; reason: string }[] };
  expect(detail.skipped).toEqual([{ path: 'imports/carol-example.md', reason: 'not_staged' }, { path: 'people/bob-example.md', reason: 'skip_worktree' }]);
  expect(head(f)).toBe(before);
}, 60_000);

test('classic: a named directory still commits with exit 0 beside a sparse skip-worktree entry and a file git ignores', async () => {
  const f = fixture('classic-ok', 'classic');
  git(f.brain, 'update-index', '--skip-worktree', '--', 'people/bob-example.md');
  rmSync(join(f.brain, 'people', 'bob-example.md'));
  writeFileSync(join(f.brain, '.git', 'info', 'exclude'), 'people/*.draft.md\n');
  writeFileSync(join(f.brain, 'people', 'carol-example.draft.md'), page('Carol', 'A draft git ignores.'));
  writeFileSync(join(f.brain, 'people', 'alice-example.md'), page('Alice', 'Second version.'));
  const r = await commitPush(f, 'people/');
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ outcome: 'pushed' });
  expect(headBlob(f, 'people/alice-example.md')).toContain('Second version.');
  expect(headBlob(f, 'people/bob-example.md')).toContain('First version.');
  expect(remoteTip(f)).toBe(head(f));
}, 60_000);

test('managed: a page git skips fails writer_coordinator_required and points at put_page; nothing is committed', async () => {
  const f = fixture('managed-page', 'managed');
  const before = head(f);
  editHidden(f, 'people/alice-example.md');
  const r = await commitPush(f, 'people/alice-example.md');
  expect(r.exitCode).not.toBe(0);
  const e = envelope(r.stdout);
  expect(e.code).toBe('writer_coordinator_required');
  expect(e.message).toContain('people/alice-example.md');
  expect(r.stdout).toContain('put_page');
  expect(e.fix?.next).toBeDefined();
  expect(head(f)).toBe(before);
}, 60_000);

test('managed: a committable page is committed locally and a skipped file that is not a page fails commit_paths_skipped', async () => {
  const f = fixture('managed-mixed', 'managed');
  const before = head(f);
  writeFileSync(join(f.brain, 'people', 'bob-example.md'), page('Bob', 'Second version.'));
  mkdirSync(join(f.brain, 'imports'));
  execFileSync('git', ['init', '-q', join(f.brain, 'imports')]);
  writeFileSync(join(f.brain, 'imports', 'export.csv'), 'a,b\n');
  const r = await commitPush(f, 'people/bob-example.md', 'imports/export.csv');
  expect(r.exitCode).not.toBe(0);
  const e = envelope(r.stdout);
  expect(e.code).toBe('commit_paths_skipped');
  expect(e.message).toContain('imports/export.csv');
  expect(e.message).toContain('not pushed');
  expect(headBlob(f, 'people/bob-example.md')).toContain('Second version.');
  expect(remoteTip(f)).toBe(before);
}, 60_000);

test('remoteless: a skipped path fails commit_paths_skipped instead of nothing to commit', async () => {
  const f = fixture('remoteless', 'remoteless');
  const before = head(f);
  editHidden(f, 'people/alice-example.md');
  const r = await commitPush(f, 'people/alice-example.md');
  expect(r.exitCode).not.toBe(0);
  expect(envelope(r.stdout).code).toBe('commit_paths_skipped');
  expect(head(f)).toBe(before);
}, 60_000);

/** Run the rendered helper from the checkout; `cli` is recorded as gbrain.cliPath, otherwise no gbrain is reachable (the fallback). */
function helper(f: Fixture, cli: boolean, ...args: string[]) {
  mkdirSync(join(f.brain, 'scripts'), { recursive: true });
  const script = join(f.brain, 'scripts', 'brain-commit-push.sh');
  if (!existsSync(script)) {
    writeFileSync(script, renderCommitPushHelper()); chmodSync(script, 0o755);
    git(f.brain, 'update-index', '--add', '--cacheinfo', `100755,${git(f.brain, 'hash-object', '-w', script)},scripts/brain-commit-push.sh`);
    git(f.brain, 'commit', '-qm', 'helper', '--', 'scripts/brain-commit-push.sh');
  }
  if (f.remote && cli) git(f.brain, 'push', '-q', 'origin', 'main');
  if (cli) {
    const wrapper = join(f.home, 'gbrain');
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${join(import.meta.dir, '..', 'src', 'cli.ts')}" "$@"\n`); chmodSync(wrapper, 0o755);
    git(f.brain, 'config', '--local', 'gbrain.cliPath', wrapper);
  }
  return spawnSync('bash', [script, ...args], { cwd: f.brain, encoding: 'utf8', timeout: 60_000,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: f.home, GBRAIN_HOME: f.home, GBRAIN_SKIP_STARTUP_HOOKS: '1', ...identity } });
}

test('helper without gbrain: a skipped path fails loudly instead of printing nothing to commit and exiting 0', () => {
  const f = fixture('helper-fallback', 'classic');
  editHidden(f, 'people/alice-example.md');
  const r = helper(f, false, 'write pages', 'people/alice-example.md');
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('commit_paths_skipped');
  expect(r.stderr).toContain('people/alice-example.md');
  expect(headBlob(f, 'people/alice-example.md')).toContain('First version.');
}, 60_000);

test('helper delegating to gbrain on a managed checkout: a skipped page exits non-zero with writer_coordinator_required', () => {
  const f = fixture('helper-managed', 'managed');
  // The helper refuses on the Git-metadata marker itself; without it (an owner claim or the registry marks the root) it hands over to gbrain.
  rmSync(join(f.brain, '.git', 'gbrain-managed.json'));
  editHidden(f, 'people/alice-example.md');
  const r = helper(f, true, 'write pages', 'people/alice-example.md');
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('writer_coordinator_required');
  expect(headBlob(f, 'people/alice-example.md')).toContain('First version.');
}, 90_000);

test('helper on a marked managed checkout refuses with the operator contract (code, why, fix, next)', () => {
  const f = fixture('helper-marker', 'classic');
  writeFileSync(join(f.brain, '.git', 'gbrain-managed.json'), '{}\n');
  writeFileSync(join(f.brain, 'people', 'alice-example.md'), page('Alice', 'Second version.'));
  const r = helper(f, false, 'write pages', 'people/alice-example.md');
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('Error [writer_coordinator_required]');
  expect(r.stderr).toContain('put_page');
  expect(r.stderr).toMatch(/^Why: /m);
  expect(r.stderr).toMatch(/^Next: /m);
  expect(headBlob(f, 'people/alice-example.md')).toContain('First version.');
}, 60_000);

test('classic: a named directory inside a nested repository fails instead of nothing to commit', async () => {
  const f = fixture('classic-nested-dir', 'classic');
  nestedPage(f, 'carol-example.md');
  mkdirSync(join(f.brain, 'imports', 'pages'));
  writeFileSync(join(f.brain, 'imports', 'pages', 'dave-example.md'), page('Dave', 'Under a nested clone.'));
  const r = await commitPush(f, 'imports/pages');
  expect(r.exitCode).not.toBe(0);
  expect(JSON.parse(envelope(r.stdout).detail!)).toMatchObject({ skipped: [{ path: 'imports/pages', reason: 'not_staged' }] });
}, 60_000);

test('classic: both flags get their own update-index step, since git clears only the first flag given', async () => {
  const f = fixture('classic-both-flags', 'classic');
  editHidden(f, 'people/alice-example.md');
  editHidden(f, 'people/bob-example.md', '--skip-worktree');
  const before = head(f);
  const r = await commitPush(f, 'people/');
  expect(r.exitCode).not.toBe(0);
  const e = envelope(r.stdout) as ReturnType<typeof envelope> & { fix: { then?: { argv: string[] } } };
  expect(e.fix.argv).toEqual(['git', '-C', f.brain, 'update-index', '--no-assume-unchanged', '--', 'people/alice-example.md']);
  expect(e.fix.then?.argv).toEqual(['git', '-C', f.brain, 'update-index', '--no-skip-worktree', '--', 'people/bob-example.md']);
  expect(head(f)).toBe(before);
}, 60_000);

test('helper without gbrain: a non-ASCII flagged path, a nested-repository file beside a committable page, and a clean flagged symlink', () => {
  const f = fixture('helper-fallback-edges', 'classic');
  const accented = 'people/jos\u00e9-example.md';
  writeFileSync(join(f.brain, accented), page('Jose', 'First version.'));
  symlinkSync('alice-example.md', join(f.brain, 'people', 'link-example.md'));
  git(f.brain, 'add', '--', accented, 'people/link-example.md'); git(f.brain, 'commit', '-qm', 'more'); git(f.brain, 'push', '-q', 'origin', 'main');
  git(f.brain, 'update-index', '--assume-unchanged', '--', 'people/link-example.md');
  const clean = helper(f, false, 'write pages', 'people/link-example.md');
  expect(clean.status).toBe(4);
  expect(clean.stderr).not.toContain('commit_paths_skipped');
  editHidden(f, accented);
  const accentedRun = helper(f, false, 'write pages', accented);
  expect(accentedRun.status).not.toBe(0);
  expect(accentedRun.stderr).toContain(accented);
  writeFileSync(join(f.brain, 'people', 'bob-example.md'), page('Bob', 'Second version.'));
  const nested = nestedPage(f, 'carol-example.md');
  const mixed = helper(f, false, 'write pages', 'people/bob-example.md', nested);
  expect(mixed.status).not.toBe(0);
  expect(mixed.stderr).toContain('commit_paths_skipped');
  expect(mixed.stderr).toContain(nested);
  expect(headBlob(f, 'people/bob-example.md')).toContain('Second version.');
  expect(remoteTip(f)).not.toBe(head(f));
}, 90_000);

test('write-through: commitPathsLocked fails commit_paths_skipped for a nested-repository file instead of returning the commit', () => {
  const f = fixture('locked-nested', 'classic');
  writeFileSync(join(f.brain, 'people', 'bob-example.md'), page('Bob', 'Second version.'));
  const nested = nestedPage(f, 'carol-example.md');
  let failure: { code?: string; message?: string } | undefined;
  withEnv({ GBRAIN_HOME: f.home, ...identity }, () => {
    try { commitPathsLocked(f.brain, [join(f.brain, 'people', 'bob-example.md'), join(f.brain, nested)], 'gbrain: write-through', { lockWaitMs: 2_000 }); }
    catch (e) { failure = e as { code?: string; message?: string }; }
  });
  expect(failure?.code).toBe('commit_paths_skipped');
  expect(failure?.message).toContain(nested);
  expect(failure?.message).toContain('not pushed');
  expect(headBlob(f, 'people/bob-example.md')).toContain('Second version.');
}, 60_000);

test('classic: a skipped path still fails commit_paths_skipped when the push fails, and the push log records the local-only commit', async () => {
  const f = fixture('classic-skip-pushfail', 'classic');
  writeFileSync(join(f.brain, 'people', 'bob-example.md'), page('Bob', 'Second version.'));
  const nested = nestedPage(f, 'carol-example.md');
  git(f.brain, 'remote', 'set-url', 'origin', join(dir, 'missing.git'));
  const r = await commitPush(f, 'people/bob-example.md', nested);
  expect(r.exitCode).not.toBe(0);
  const e = envelope(r.stdout);
  expect(e.code).toBe('commit_paths_skipped');
  expect(e.message).toContain(nested);
  expect(e.message).toContain('not pushed');
  const detail = JSON.parse(e.detail!) as { committed: string; pushed?: string; publish?: { code: string } };
  expect(detail.committed).toBe(head(f));
  expect(detail.pushed).toBeUndefined();
  expect(detail.publish?.code).toBe('push_unconfirmed');
  expect(headBlob(f, 'people/bob-example.md')).toContain('Second version.');
  expect(readFileSync(join(f.home, '.gbrain', 'brain-push.log'), 'utf8')).toContain('LOCAL-ONLY, NEEDS ATTENTION: main');
}, 60_000);

test('helper without gbrain: a skipped path is still named when nothing is pushed', () => {
  const f = fixture('helper-pushfail', 'classic');
  writeFileSync(join(f.brain, 'people', 'bob-example.md'), page('Bob', 'Second version.'));
  const nested = nestedPage(f, 'carol-example.md');
  git(f.brain, 'remote', 'set-url', 'origin', join(dir, 'missing.git'));
  const r = helper(f, false, 'write pages', 'people/bob-example.md', nested);
  expect(r.status).toBe(4);
  expect(r.stderr).toContain('NOT PUSHED');
  expect(r.stderr).toContain('commit_paths_skipped');
  expect(r.stderr).toContain(nested);
  expect(headBlob(f, 'people/bob-example.md')).toContain('Second version.');
}, 60_000);

test('classic: a named assume-unchanged gitlink beside a committed page leaves the commit standing, with no reversal staged', async () => {
  const f = fixture('gitlink', 'classic');
  const sub = join(f.brain, 'vendor');
  execFileSync('git', ['init', '-q', '-b', 'main', sub]);
  writeFileSync(join(sub, 'README'), 'nested\n');
  git(sub, 'add', '.'); git(sub, 'commit', '-qm', 'nested');
  git(f.brain, 'add', 'vendor'); git(f.brain, 'commit', '-qm', 'gitlink'); git(f.brain, 'push', '-q');
  git(f.brain, 'update-index', '--assume-unchanged', '--', 'vendor');
  writeFileSync(join(f.brain, 'people', 'alice-example.md'), page('Alice', 'Second version.'));
  const r = await commitPush(f, 'people/alice-example.md', 'vendor');
  expect(r.stdout).not.toContain('git_unavailable');
  expect(r.exitCode).toBe(0);
  expect(headBlob(f, 'people/alice-example.md')).toContain('Second version.');
  expect(remoteTip(f)).toBe(head(f));
  expect(git(f.brain, 'diff', '--cached', '--name-only')).toBe('');
}, 60_000);

test('managed: the put_page fix names the managed source in both the CLI argv and the MCP arguments', async () => {
  const f = fixture('managed-source', 'managed');
  const path = nestedPage(f, 'carol-example.md');
  const r = await commitPush(f, path);
  expect(r.exitCode).not.toBe(0);
  const e = JSON.parse(r.stdout) as { code: string; fix?: { argv?: string[] } };
  expect(e.code).toBe('writer_coordinator_required');
  const argv = e.fix?.argv ?? [];
  expect(argv.slice(0, 2)).toEqual(['gbrain', 'put']);
  expect(argv.indexOf('--source-id')).toBeGreaterThan(1);
  expect(argv[argv.indexOf('--source-id') + 1]).toBe('source-a');
  const thrown = await withEnv({ GBRAIN_HOME: f.home }, () => {
    try { commitAndPush({ repo: f.brain, paths: [path], message: 'write pages', cwd: f.brain }); } catch (err) { return err as { code?: string; fix?: { mcp?: { tool: string; arguments: Record<string, unknown> } } }; }
    return null;
  });
  expect(thrown?.code).toBe('writer_coordinator_required');
  expect(thrown?.fix?.mcp?.tool).toBe('put_page');
  expect(thrown?.fix?.mcp?.arguments.source_id).toBe('source-a');
}, 60_000);

test('classic: a file another writer adds or edits under a named directory just after the commit is not reported as skipped', async () => {
  const f = fixture('classic-race', 'classic');
  writeFileSync(join(f.brain, 'people', 'alice-example.md'), page('Alice', 'Second version.'));
  // Stands in for a writer that lands between the commit and the skipped-path check: it adds a page and edits the one just committed.
  const hook = join(f.brain, '.git', 'hooks', 'post-commit');
  writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' '---' 'title: Dave' '---' 'Written after the commit.' > people/dave-example.md\nprintf 'A later edit.\\n' >> people/alice-example.md\n`);
  chmodSync(hook, 0o755);
  const r = await commitPush(f, 'people/');
  expect({ code: r.exitCode, stdout: r.stdout }).toMatchObject({ code: 0 });
  expect(JSON.parse(r.stdout)).toMatchObject({ outcome: 'pushed' });
  expect(headBlob(f, 'people/alice-example.md')).toBe(page('Alice', 'Second version.').trim());
  expect(git(f.brain, 'ls-files', '--others', '--', 'people/')).toBe('people/dave-example.md');
  expect(remoteTip(f)).toBe(head(f));
}, 60_000);
