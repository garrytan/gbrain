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
import { getLastPushOutcome } from '../src/core/brain-repo-durability.ts';
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

/** The stray `.git` shapes a source folder is left with that git itself ignores: a file, and a directory whose HEAD is broken. */
const strays: Array<[string, (at: string) => void]> = [
  ['a .git file pointing nowhere', at => writeFileSync(at, 'gitdir: /nonexistent/example.git\n')],
  ['a .git directory with a broken HEAD', at => { mkdirSync(join(at, 'objects'), { recursive: true }); mkdirSync(join(at, 'refs')); writeFileSync(join(at, 'HEAD'), 'not a ref\n'); }],
];
for (const [shape, make] of strays) {
  test(`${shape} under the source path and under the named folder: the folder's files commit and nothing is skipped`, async () => {
    const f = fixture(`stray-${shape.split(' ').slice(1, 3).join('-').replace(/[^a-z-]/g, '')}`, 'managed');
    make(join(f.repo, 'brain', '.git'));
    make(join(f.repo, 'brain', 'notes', '.git'));
    write(f);
    const r = await commitPush(f, join(f.link, YEAR));
    expect(r.stdout).not.toContain('commit_paths_skipped');
    expect(r.exitCode).toBe(0);
    expect(git(f.repo, 'status', '--porcelain', '--', `brain/${YEAR}`)).toBe('');
    expect(committed(f, 'HEAD')).toEqual([`brain/${YEAR}/alice-example.md`, `brain/${YEAR}/bob-example.md`]);
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
  expect((await withEnv({ GBRAIN_HOME: f.home }, () => getLastPushOutcome('main'))).status).toBe('needs_attention');
}, 60_000);

const dryRun = (f: Fixture, ...paths: string[]) =>
  runCli(['git', 'commit-push', '--json', '--dry-run', '--path', f.link, '-m', 'write pages', '--', ...paths], { cwd: dir, home: f.home, env: identity });
const pushLog = (f: Fixture) => { const log = join(f.home, '.gbrain', 'brain-push.log'); return existsSync(log) ? readFileSync(log, 'utf8') : ''; };
interface Refusal { code: string; message: string; detail: string; why?: string; fix?: { argv?: string[]; next?: string } }
const skippedOf = (x: Refusal) => (JSON.parse(x.detail) as { skipped: Array<{ path: string; reason: string; why: string }> }).skipped;

for (const kind of ['classic', 'managed'] as const) {
  test(kind + ': the field report shape, a stray .git above the named folder on a run with nothing new, succeeds and never hints at a staged removal', async () => {
    const f = fixture(kind + '-field-quiet', kind);
    mkdirSync(join(f.repo, 'brain', 'notes', '.git'));
    const dry = await dryRun(f, join(f.link, YEAR));
    const r = await commitPush(f, join(f.link, YEAR));
    for (const out of [dry.stdout + dry.stderr, r.stdout + r.stderr]) {
      expect(out).not.toContain('commit_paths_skipped');
      expect(out).not.toContain('staged for removal');
    }
    expect(dry.exitCode).toBe(0);
    expect(r.exitCode).toBe(0);
    expect((JSON.parse(r.stdout) as { outcome: string }).outcome).toBe('nothing_to_commit');
    expect(pushLog(f)).not.toContain('SKIPPED');
    expect(committed(f, 'HEAD')).toEqual(['brain/' + YEAR + '/alice-example.md']);
    expect(clean(f)).toBe('');
  }, 60_000);

  test(kind + ': a named folder whose tracked file is staged for removal and still on disk is refused as staged_for_removal, the dry run says the same, and nothing is re-added or removed', async () => {
    const f = fixture(kind + '-staged-removal', kind);
    git(f.repo, 'rm', '-q', '-r', '--cached', '--', 'brain/' + YEAR);
    writeFileSync(join(f.repo, 'brain', YEAR, 'alice-example.md'), page('Alice', 'Second version.'));
    const head = git(f.repo, 'rev-parse', 'HEAD'), tip = remoteTip(f);
    const dry = await dryRun(f, join(f.link, YEAR));
    expect(pushLog(f)).not.toContain('SKIPPED');
    const r = await commitPush(f, join(f.link, YEAR));
    for (const x of [dry, r]) {
      expect(x.exitCode).toBe(1);
      const e = JSON.parse(x.stdout) as Refusal;
      expect(e.code).toBe('commit_paths_skipped');
      expect(skippedOf(e)).toEqual([{ path: 'brain/' + YEAR + '/alice-example.md', reason: 'staged_for_removal', why: expect.stringContaining('staged for removal') }]);
      expect(e.message).toContain('staged for removal');
      expect(JSON.stringify(e)).toContain('commit-push --untrack');
      expect(JSON.stringify(e)).toContain('restore --staged');
      expect(e.why).toBeTruthy();
      expect(e.fix?.next).toBe('ask_user');
      expect((JSON.parse(e.detail) as { dry_run?: boolean }).dry_run).toBe(x === dry ? true : undefined);
    }
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(remoteTip(f)).toBe(tip);
    expect(git(f.repo, 'diff', '--cached', '--name-status', '--', 'brain')).toBe('D\tbrain/' + YEAR + '/alice-example.md');
    const line = pushLog(f).split('\n').find(l => l.includes('SKIPPED'));
    expect(line).toContain('brain/' + YEAR + '/alice-example.md (staged_for_removal: the index holds it as staged for removal');
  }, 60_000);
}

test('the dry run reports the same skipped path and reason as the real run for a file inside a real nested repository, and writes no push-log line', async () => {
  const f = fixture('nested-dry', 'classic');
  execFileSync('git', ['init', '-q', join(f.repo, 'brain', 'imports')]);
  writeFileSync(join(f.repo, 'brain', 'imports', 'export.csv'), 'a,b\n');
  const dry = await dryRun(f, 'imports/export.csv');
  expect(dry.exitCode).toBe(1);
  expect(pushLog(f)).not.toContain('SKIPPED');
  const r = await commitPush(f, 'imports/export.csv');
  const d = JSON.parse(dry.stdout) as Refusal, e = JSON.parse(r.stdout) as Refusal;
  expect(d.code).toBe(e.code);
  expect(skippedOf(d)).toEqual(skippedOf(e));
  expect(skippedOf(d)).toEqual([{ path: 'brain/imports/export.csv', reason: 'not_staged', why: expect.stringContaining('nested Git repository brain/imports') }]);
  expect(d.message).not.toContain('staged for removal');
}, 60_000);

/** The source folder's own .git is a link to the repository's .git (repo-a/brain/.git -> ../.git), made on purpose. */
for (const kind of ['classic', 'managed'] as const) {
  for (const via of ['link', 'real', 'repo'] as const) {
    for (const change of [false, true]) {
      test(kind + ', path via ' + via + ', ' + (change ? 'a new and an edited page' : 'nothing new') + ': a .git linked to the repository\'s own .git commits the pages at their place in the tree and reports nothing skipped', async () => {
        const f = fixture(kind + '-gitlink-' + via + '-' + change, kind);
        symlinkSync('../.git', join(f.repo, 'brain', '.git'));
        if (change) write(f);
        const at = via === 'link' ? f.link : via === 'real' ? join(f.repo, 'brain') : f.repo;
        const named = via === 'repo' ? join(f.repo, 'brain', YEAR) : join(at, YEAR);
        const head = git(f.repo, 'rev-parse', 'HEAD');
        const dry = await runCli(['git', 'commit-push', '--json', '--dry-run', '--path', at, '-m', 'write pages', '--', named], { cwd: dir, home: f.home, env: identity });
        const r = await runCli(['git', 'commit-push', '--json', '--path', at, '-m', 'write pages', '--', named], { cwd: dir, home: f.home, env: identity });
        for (const x of [dry, r]) {
          expect(x.stdout).not.toContain('commit_paths_skipped');
          expect(x.stdout).not.toContain('staged for removal');
          expect(x.exitCode).toBe(0);
        }
        const out = JSON.parse(r.stdout) as { outcome: string; repo: string; paths: string[] };
        expect(out.repo).toBe(f.repo);
        expect(out.paths).toEqual(['brain/' + YEAR]);
        expect(git(f.repo, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')).toEqual(['README.md', ...committed(f, 'HEAD')]);
        expect(git(f.repo, 'status', '--porcelain')).toBe('');
        if (!change) {
          expect(out.outcome).toBe('nothing_to_commit');
          expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head);
          expect(committed(f, 'HEAD')).toEqual(['brain/' + YEAR + '/alice-example.md']);
          return;
        }
        expect(committed(f, 'HEAD')).toEqual(['brain/' + YEAR + '/alice-example.md', 'brain/' + YEAR + '/bob-example.md']);
        expect(git(f.repo, 'show', 'HEAD:brain/' + YEAR + '/alice-example.md')).toContain('Second version.');
        if (kind === 'classic') expect(remoteTip(f)).toBe(git(f.repo, 'rev-parse', 'HEAD'));
      }, 60_000);
    }
  }
}

test('a nested repository git refuses to open for its ownership still counts as nested, so the folder is reported skipped, never as committed', async () => {
  const { nestedRepositoryOf } = await import('../src/core/git/skipped-paths.ts');
  const f = fixture('nested-dubious', 'classic');
  execFileSync('git', ['init', '-q', join(f.repo, 'brain', 'imports')]);
  mkdirSync(join(f.repo, 'brain', 'imports', 'sub'));
  writeFileSync(join(f.repo, 'brain', 'imports', 'sub', 'export.csv'), 'a,b\n');
  const nested = await withEnv({ GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' }, () => nestedRepositoryOf(f.repo, 'brain/imports/sub'));
  expect(nested).toBe('brain/imports');
  expect(nestedRepositoryOf(f.repo, 'brain/' + YEAR)).toBeNull();
  symlinkSync('../.git', join(f.repo, 'brain', '.git'));
  expect(nestedRepositoryOf(f.repo, 'brain/' + YEAR)).toBeNull();
  expect(nestedRepositoryOf(f.repo, 'brain/imports/sub')).toBe('brain/imports');
});

test('a FIFO or other special file where a nested .git keeps HEAD is never read, so the check returns at once instead of blocking under the commit lock', async () => {
  const { nestedRepositoryOf } = await import('../src/core/git/skipped-paths.ts');
  const f = fixture('nested-fifo', 'classic');
  mkdirSync(join(f.repo, 'brain', 'notes', '.git', 'objects'), { recursive: true });
  mkdirSync(join(f.repo, 'brain', 'notes', '.git', 'refs'));
  execFileSync('mkfifo', [join(f.repo, 'brain', 'notes', '.git', 'HEAD')]);
  expect(nestedRepositoryOf(f.repo, 'brain/' + YEAR)).toBeNull();
}, 10_000);
