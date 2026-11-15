/**
 * GST-2767: a source whose registered path is a symlink to a subdirectory of its Git checkout (repo-a/brain, reached
 * as <dir>/source-a-link). A scheduled writer called `gbrain git commit-push --path <link> -- <link>/<folder>/<sub>/<year>`
 * with new and modified tracked files under that directory. The absolute pathspec spelled through the symlink was
 * refused as "outside the checkout", an empty `.git` left under the source path made every named directory report
 * `commit_paths_skipped` (not_staged) although git committed it, and the refusal named no reason a person could act on.
 * Every named path now resolves to its real place in the checkout, only a directory that is its own work tree counts as
 * a nested repository, and each skipped path carries its reason in the JSON detail, the message and the push log.
 * Seams: none; the real CLI against temp repositories, a bare remote and a managed-root registry under a temp GBRAIN_HOME.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordManagedRoots } from '../src/core/persistence/root-registry.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-symlinked-source-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const identity = { GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.invalid', GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'example@example.invalid' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const page = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;
const YEAR = 'notes/daily/2026';

interface Fixture { home: string; remote: string; repo: string; link: string }

/** repo-a with its brain under brain/, a page already committed under the year folder, and the source path a symlink to brain/. */
function fixture(name: string, kind: 'classic' | 'managed', linkAt: 'outside' | 'inside' = 'outside'): Fixture {
  const remote = join(dir, `${name}.git`), repo = join(dir, `${name}-repo-a`), home = join(dir, `${name}-home`);
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, repo], { stdio: 'ignore' });
  git(repo, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(repo, 'brain', YEAR), { recursive: true });
  writeFileSync(join(repo, 'brain', YEAR, 'alice-example.md'), page('Alice', 'First version.'));
  writeFileSync(join(repo, 'README.md'), 'Repository readme.\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init'); git(repo, 'push', '-q', '-u', 'origin', 'main');
  const link = linkAt === 'outside' ? join(dir, `${name}-source-a`) : join(repo, 'current');
  symlinkSync(join(repo, 'brain'), link);
  if (linkAt === 'inside') writeFileSync(join(repo, '.git', 'info', 'exclude'), 'current\n');
  if (kind === 'managed') withEnv({ GBRAIN_HOME: home }, () => { recordManagedRoots('00000000-0000-4000-8000-000000002767', [{ local_path: link, source_id: 'source-a' }]); });
  return { home, remote, repo, link };
}

/** A modified tracked page and a new one under the year folder, as the scheduled writer leaves them. */
function write(f: Fixture): void {
  writeFileSync(join(f.repo, 'brain', YEAR, 'alice-example.md'), page('Alice', 'Second version.'));
  writeFileSync(join(f.repo, 'brain', YEAR, 'bob-example.md'), page('Bob', 'New page.'));
}

const commitPush = (f: Fixture, ...paths: string[]) =>
  runCli(['git', 'commit-push', '--json', '--path', f.link, '-m', 'write pages', '--', ...paths], { cwd: dir, home: f.home, env: identity });
const committed = (f: Fixture, rev: string) => git(f.repo, 'ls-tree', '-r', '--name-only', rev, '--', `brain/${YEAR}`).split('\n');
const clean = (f: Fixture) => git(f.repo, 'status', '--porcelain', '--', 'brain');
const remoteTip = (f: Fixture) => git(f.remote, 'rev-parse', 'refs/heads/main');

for (const kind of ['classic', 'managed'] as const) {
  test(`${kind}: a directory pathspec spelled through the symlinked source path commits its new and modified files`, async () => {
    const f = fixture(`${kind}-dir-abs`, kind);
    write(f);
    const r = await commitPush(f, join(f.link, YEAR));
    expect(r.stderr + r.stdout).not.toContain('outside the checkout');
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { outcome: string; paths: string[]; repo: string };
    expect(out.paths).toEqual([`brain/${YEAR}`]);
    expect(out.repo).toBe(f.repo);
    expect(clean(f)).toBe('');
    expect(committed(f, 'HEAD')).toEqual([`brain/${YEAR}/alice-example.md`, `brain/${YEAR}/bob-example.md`]);
    if (kind === 'classic') expect(remoteTip(f)).toBe(git(f.repo, 'rev-parse', 'HEAD'));
  }, 60_000);

  test(`${kind}: file paths spelled through the symlinked source path, and the same paths relative to it, commit`, async () => {
    const f = fixture(`${kind}-files`, kind);
    write(f);
    const abs = await commitPush(f, join(f.link, YEAR, 'alice-example.md'), join(f.link, YEAR, 'bob-example.md'));
    expect(abs.exitCode).toBe(0);
    expect(clean(f)).toBe('');
    writeFileSync(join(f.repo, 'brain', YEAR, 'alice-example.md'), page('Alice', 'Third version.'));
    const rel = await commitPush(f, `${YEAR}/alice-example.md`);
    expect(rel.exitCode).toBe(0);
    expect(git(f.repo, 'show', `HEAD:brain/${YEAR}/alice-example.md`)).toContain('Third version.');
  }, 60_000);

  test(`${kind}: an empty .git left under the source path is not a nested repository; the directory commits and the run succeeds`, async () => {
    const f = fixture(`${kind}-stray-git`, kind);
    mkdirSync(join(f.repo, 'brain', '.git'));
    write(f);
    const r = await commitPush(f, YEAR);
    expect(r.stdout).not.toContain('commit_paths_skipped');
    expect(r.exitCode).toBe(0);
    expect(clean(f)).toBe('');
    expect(committed(f, 'HEAD')).toContain(`brain/${YEAR}/bob-example.md`);
  }, 60_000);
}

test('a symlink inside the checkout: a pathspec through it names the real directory instead of failing "beyond a symbolic link"', async () => {
  const f = fixture('inside-link', 'classic', 'inside');
  write(f);
  const r = await commitPush(f, join(f.link, YEAR));
  expect(r.stdout).not.toContain('beyond a symbolic link');
  expect(r.exitCode).toBe(0);
  expect(clean(f)).toBe('');
}, 60_000);

test('a real nested repository: each skipped path carries its reason in the JSON detail, the message and the push log', async () => {
  const f = fixture('nested', 'classic');
  write(f);
  execFileSync('git', ['init', '-q', join(f.repo, 'brain', 'imports')]);
  writeFileSync(join(f.repo, 'brain', 'imports', 'export.csv'), 'a,b\n');
  const r = await commitPush(f, YEAR, 'imports/export.csv');
  expect(r.exitCode).not.toBe(0);
  const e = JSON.parse(r.stdout) as { code: string; message: string; detail: string };
  expect(e.code).toBe('commit_paths_skipped');
  const detail = JSON.parse(e.detail) as { skipped: Array<{ path: string; reason: string; why: string }>; committed: string };
  expect(detail.skipped).toEqual([{ path: 'brain/imports/export.csv', reason: 'not_staged', why: expect.stringContaining('nested Git repository brain/imports') }]);
  expect(e.message).toContain('brain/imports/export.csv (not_staged: it sits inside the nested Git repository brain/imports');
  expect(committed(f, 'HEAD')).toContain(`brain/${YEAR}/bob-example.md`);
  const log = join(f.home, '.gbrain', 'brain-push.log');
  expect(existsSync(log)).toBe(true);
  const line = readFileSync(log, 'utf8').split('\n').find(l => l.includes('SKIPPED'));
  expect(line).toContain('brain/imports/export.csv (not_staged: it sits inside the nested Git repository brain/imports');
}, 60_000);
