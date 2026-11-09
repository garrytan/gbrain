/**
 * GBRA-230 lane G: the commit-push door.
 * Protects:
 *   - #7752: `gbrain git commit-push --dry-run` runs the real run's path checks. On a non-cone sparse checkout a path
 *     outside the sparse-checkout definition refuses `commit_paths_invalid` with the real run's fix text, takes no lock
 *     and writes nothing (red before: the dry run exited 0 and listed the path the real run refuses). Cone mode and a
 *     checkout without sparse checkout keep answering what their real run does. The dry run also refuses what the real
 *     run refuses before staging: a path outside gbrain.sourceRoot (red before: exit 0), another writer's staged file
 *     under a named directory, a staged rename's other side outside the root; its envelope equals the real run's.
 *   - #7984: a tracked file deleted or modified under a wildcard ignore (`*`), the deletion on disk only or already
 *     staged, commits and pushes through the door (master's staging since 68da83db4f), and the dry run agrees: a named
 *     ignored new file, or a path that matches nothing, refuses in both runs, and a refusal leaves the index as it was.
 *     (#7753's --untrack cases live in test/git-commit-push-untrack-gst2519.test.ts.)
 *   - #7793 item 2: the fix and verify commands printed for a staged file read each path literally.
 * Repo-less: commit-push needs a checkout, so nothing here reaches a brain without one.
 * Seams: none; real repositories and a bare remote, the real CLI for the flags.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { commitThroughDoor } from '../src/core/persistence/git-door.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { gitChildEnv } from '../src/core/git-env.ts';
import { runCli } from './helpers/cli-spawn.ts';

const env = gitChildEnv();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const dirs: string[] = [];
const scratch = (name: string) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), `gbrain-door2-${name}-`))); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function put(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

/** A checkout on main with `files` committed, its own core.hooksPath, and (unless `remote` is false) a bare origin it pushed to. */
function checkout(files: Record<string, string>, remote = true): { root: string; bare: string | null; hooks: string } {
  const dir = scratch('repo');
  const root = join(dir, 'work');
  const hooks = join(dir, 'hooks');
  git(dir, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  git(root, 'config', 'core.hooksPath', hooks);
  for (const [path, body] of Object.entries({ 'seed.md': 'seed\n', ...files })) put(root, path, body);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
  if (!remote) return { root, bare: null, hooks };
  const bare = join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return { root, bare, hooks };
}

const cli = (root: string, args: string[], extra: Record<string, string> = {}) =>
  runCli(['git', 'commit-push', '--path', root, '--json', ...args], { home: scratch('home'), env: { GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1', ...extra } });
const status = (root: string) => execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', env }).split('\n').filter(Boolean).sort();
const changed = (root: string, rev = 'HEAD') => git(root, 'diff-tree', '-r', '--no-commit-id', '--no-renames', '--name-status', '-z', rev).split('\0').filter(Boolean);
const refusalOf = (fn: () => unknown): { code?: string; message?: string; fix?: { argv: string[] } } => {
  try { fn(); } catch (e) { return e as { code?: string; message?: string }; }
  throw new Error('expected a refusal');
};
const indexBytes = (root: string) => readFileSync(join(root, '.git', 'index')).toString('base64');

describe('#7752: --dry-run runs the real run\'s path checks', () => {
  /** notes/a and notes/b committed, then a sparse checkout of notes/a only, and a new file in each. */
  function sparse(cone: boolean): { root: string; bare: string } {
    const { root, bare } = checkout({ 'notes/a/one.md': 'one\n', 'notes/b/two.md': 'two\n' });
    if (cone) git(root, 'sparse-checkout', 'set', '--cone', 'notes/a');
    else git(root, 'sparse-checkout', 'set', '--no-cone', '/notes/a/');
    put(root, 'notes/b/new.md', 'outside the sparse definition\n');
    put(root, 'notes/a/new.md', 'inside the sparse definition\n');
    return { root, bare: bare! };
  }

  for (const cone of [false, true]) {
    test(`${cone ? 'cone' : 'non-cone'} sparse checkout: a path outside the definition refuses like the real run; no lock, nothing written`, async () => {
      const { root, bare } = sparse(cone);
      const head = git(root, 'rev-parse', 'HEAD');
      const index = indexBytes(root);
      const preview = await cli(root, ['--dry-run', '-m', 'test', '--', 'notes/b/new.md']);
      expect(preview.exitCode).toBe(1);
      const previewed = JSON.parse(preview.stdout) as { code: string; message: string; suggestion: string };
      expect(previewed.code).toBe('commit_paths_invalid');
      expect(previewed.suggestion).toContain('outside of your sparse-checkout definition');
      expect(existsSync(join(root, '.git', 'brain-commit.lock'))).toBe(false);
      expect(indexBytes(root)).toBe(index);
      expect(git(root, 'rev-parse', 'HEAD')).toBe(head);

      const real = await cli(root, ['-m', 'test', '--', 'notes/b/new.md']);
      expect(real.exitCode).toBe(1);
      expect(JSON.parse(real.stdout)).toMatchObject({ code: 'commit_paths_invalid', message: previewed.message, suggestion: previewed.suggestion });
      expect(git(bare, 'rev-parse', 'main')).toBe(head);

      const inside = await cli(root, ['--dry-run', '-m', 'test', '--', 'notes/a/new.md']);
      expect(inside.exitCode).toBe(0);
      expect(JSON.parse(inside.stdout)).toMatchObject({ dry_run: true, mode: 'commit-push', paths: ['notes/a/new.md'] });
      expect((await cli(root, ['-m', 'test', '--', 'notes/a/new.md'])).exitCode).toBe(0);
      expect(git(bare, 'show', 'main:notes/a/new.md')).toBe('inside the sparse definition');
    });
  }

  test('a checkout without sparse checkout: the dry run lists the path and the real run commits it; a held index lock does not stop the preview', async () => {
    const { root, bare } = checkout({});
    put(root, 'notes/b/new.md', 'new\n');
    writeFileSync(join(root, '.git', 'index.lock'), '');
    const preview = await cli(root, ['--dry-run', '-m', 'test', '--', 'notes/b/new.md']);
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ dry_run: true, paths: ['notes/b/new.md'] });
    unlinkSync(join(root, '.git', 'index.lock'));
    expect(status(root)).toEqual(['?? notes/b/new.md']);
    expect((await cli(root, ['-m', 'test', '--', 'notes/b/new.md'])).exitCode).toBe(0);
    expect(git(bare!, 'show', 'main:notes/b/new.md')).toBe('new');
  });
});

describe('#7752: the dry run refuses what the real run refuses before staging (source roots, staged files, rename partners)', () => {
  /** A checkout whose source root (git config gbrain.sourceRoot) is brain/, with x.md outside it. */
  function rooted(): { root: string; bare: string } {
    const { root, bare } = checkout({ 'x.md': 'outside v1\n', 'brain/page.md': 'page v1\n' });
    git(root, 'config', '--add', 'gbrain.sourceRoot', 'brain');
    return { root, bare: bare! };
  }
  const envelope = async (root: string, args: string[]) => { const r = await cli(root, args); return { exit: r.exitCode, body: JSON.parse(r.stdout) as Record<string, unknown> }; };

  test('a path outside the source root, in commit and --untrack modes: the dry-run envelope equals the real run\'s; --allow-outside-source-root lifts both', async () => {
    const { root, bare } = rooted();
    put(root, 'x.md', 'outside edit\n');
    const head = git(root, 'rev-parse', 'HEAD');
    for (const mode of [[], ['--untrack']]) {
      const preview = await envelope(root, ['--dry-run', ...mode, '-m', 'm', '--', 'x.md']);
      expect(preview).toMatchObject({ exit: 1, body: { code: 'commit_outside_source_root' } });
      expect(await envelope(root, [...mode, '-m', 'm', '--', 'x.md'])).toEqual(preview);
    }
    expect(git(bare, 'rev-parse', 'main')).toBe(head);
    expect(status(root)).toEqual([' M x.md']);
    expect(await envelope(root, ['--dry-run', '--allow-outside-source-root', '-m', 'm', '--', 'x.md'])).toMatchObject({ exit: 0, body: { dry_run: true, paths: ['x.md'] } });
    expect((await envelope(root, ['--allow-outside-source-root', '-m', 'm', '--', 'x.md'])).exit).toBe(0);
    expect(git(bare, 'show', 'main:x.md')).toBe('outside edit');
  });

  test('a staged rename whose other side is outside the source root, and a file another writer staged under a named directory', async () => {
    const { root } = rooted();
    git(root, 'mv', 'x.md', 'brain/x.md');
    const rename = await envelope(root, ['--dry-run', '-m', 'm', '--', 'brain/x.md']);
    expect(rename).toMatchObject({ exit: 1, body: { code: 'commit_outside_source_root', message: expect.stringContaining('A staged rename would commit x.md') } });
    expect(await envelope(root, ['-m', 'm', '--', 'brain/x.md'])).toEqual(rename);
    expect(status(root)).toEqual(['R  x.md -> brain/x.md']);

    git(root, 'mv', 'brain/x.md', 'x.md');
    put(root, 'brain/theirs.md', 'staged by another writer\n'); git(root, 'add', 'brain/theirs.md');
    put(root, 'brain/page.md', 'mine\n');
    const swept = await envelope(root, ['--dry-run', '-m', 'm', '--', 'brain']);
    expect(swept).toMatchObject({ exit: 1, body: { code: 'commit_prestaged_paths' } });
    expect(await envelope(root, ['-m', 'm', '--', 'brain'])).toEqual(swept);
    expect(status(root)).toEqual([' M brain/page.md', 'A  brain/theirs.md']);
  });
});

describe('#7793 item 2: printed fix and verify commands read each path literally', () => {
  test('commit-push\'s commit_prestaged_paths fix unstages only the swept files, not the files their glob or magic reading names', () => {
    const { root } = checkout({ 'daily/a.md': 'a\n', 'daily/b.md': 'b\n', 'd/theirs.md': 'decoy\n' });
    put(root, 'daily/[ab].md', 'staged by another writer\n');
    put(root, ':d/theirs.md', 'staged by another writer\n');
    put(root, 'daily/a.md', 'a staged\n'); put(root, 'daily/b.md', 'b staged\n'); put(root, 'd/theirs.md', 'decoy staged\n');
    git(root, 'add', '--', ':(literal)daily/[ab].md', ':(literal):d/theirs.md', 'daily/a.md', 'daily/b.md', 'd/theirs.md');
    const refused = refusalOf(() => commitAndPush({ repo: root, cwd: root, paths: ['daily', ':d', 'daily/a.md', 'daily/b.md'], message: 'm' }));
    expect(refused.code).toBe('commit_prestaged_paths');
    const [cmd, ...args] = refused.fix!.argv;
    execFileSync(cmd, args, { env, stdio: 'ignore' });
    expect(status(root)).toEqual(['?? :d/theirs.md', '?? daily/[ab].md', 'M  d/theirs.md', 'M  daily/a.md', 'M  daily/b.md']);
  });

  test('the door\'s git_index_conflict fix unstages only the targets, and its verify reads only the targets', async () => {
    const { root } = checkout({ 'notes/[ab].md': 'literal\n', 'notes/a.md': 'a\n', ':lead.md': 'colon\n', 'lead.md': 'decoy\n' }, false);
    for (const path of ['notes/[ab].md', 'notes/a.md', ':lead.md', 'lead.md']) put(root, path, `${path} staged\n`);
    git(root, 'add', '-A');
    for (const path of ['notes/[ab].md', ':lead.md']) put(root, path, `${path} door\n`);
    const error = await commitThroughDoor(root, ['notes/[ab].md', ':lead.md'].map(path => ({ path: join(root, path), planned: sha256(`${path} door\n`) })))
      .then(() => null, (e: { code?: string; fix?: { argv: string[]; verify: { argv: string[] } } }) => e);
    expect(error?.code).toBe('git_index_conflict');
    const run = (argv: string[]) => execFileSync(argv[0], argv.slice(1), { env, encoding: 'utf8' }).trim();
    expect(run(error!.fix!.verify.argv).split('\n').sort()).toEqual([':lead.md', 'notes/[ab].md']);
    run(error!.fix!.argv);
    expect(run(error!.fix!.verify.argv)).toBe('');
    expect(status(root)).toEqual([' M :lead.md', ' M notes/[ab].md', 'M  lead.md', 'M  notes/a.md']);
  });
});

describe('#7984: a tracked deletion or modification under a wildcard ignore publishes; ignored new files still refuse', () => {
  /** art/x.txt and art/y.txt committed, then a committed .gitignore that ignores everything but itself. */
  function ignoredAll(): { root: string; bare: string } {
    const { root, bare } = checkout({ 'art/x.txt': 'x\n', 'art/y.txt': 'y\n' });
    put(root, '.gitignore', '*\n!.gitignore\n');
    git(root, 'add', '.gitignore'); git(root, 'commit', '-qm', 'ignore everything'); git(root, 'push', '-q', 'origin', 'main');
    return { root, bare: bare! };
  }

  for (const staged of [false, true]) {
    test(`a deletion ${staged ? 'already staged' : 'on disk only'}: the dry run and the real run agree, and the commit carries only the deletion`, async () => {
      const { root, bare } = ignoredAll();
      if (staged) git(root, 'rm', '-q', 'art/x.txt'); else unlinkSync(join(root, 'art/x.txt'));
      const before = indexBytes(root);
      const preview = await cli(root, ['--dry-run', '-m', 'drop x', '--', 'art/x.txt']);
      expect(preview.exitCode).toBe(0);
      expect(indexBytes(root)).toBe(before);
      const run = await cli(root, ['-m', 'drop x', '--', 'art/x.txt']);
      expect(run.exitCode).toBe(0);
      expect(changed(bare, 'main')).toEqual(['D', 'art/x.txt']);
      expect(git(root, 'rev-parse', 'HEAD')).toBe(git(bare, 'rev-parse', 'main'));
      expect(git(bare, 'show', 'main:art/y.txt')).toBe('y');
      expect(status(root)).toEqual([]);
    });
  }

  test('a tracked modification: the dry run and the real run agree, and the commit carries only the modification', async () => {
    const { root, bare } = ignoredAll();
    put(root, 'art/y.txt', 'y edited\n');
    put(root, 'art/new.txt', 'ignored and untracked\n');
    const before = indexBytes(root);
    const preview = await cli(root, ['--dry-run', '-m', 'edit y', '--', 'art/y.txt']);
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ dry_run: true, paths: ['art/y.txt'] });
    expect(indexBytes(root)).toBe(before);
    expect((await cli(root, ['-m', 'edit y', '--', 'art/y.txt'])).exitCode).toBe(0);
    expect(changed(bare, 'main')).toEqual(['M', 'art/y.txt']);
    expect(git(bare, 'show', 'main:art/y.txt')).toBe('y edited');
    expect(git(root, 'ls-files').split('\n')).toEqual(['.gitignore', 'art/x.txt', 'art/y.txt', 'seed.md']);
    expect(status(root)).toEqual([]);
  });

  test('an ignored new file named beside the deletion refuses in both runs; the index, HEAD and remote stay as they were', async () => {
    const { root, bare } = ignoredAll();
    unlinkSync(join(root, 'art/x.txt'));
    put(root, 'art/new.txt', 'ignored and untracked\n');
    const head = git(root, 'rev-parse', 'HEAD');
    const before = git(root, 'ls-files', '-s');
    for (const paths of [['art/new.txt'], ['art/x.txt', 'art/new.txt']]) {
      const preview = await cli(root, ['--dry-run', '-m', 'm', '--', ...paths]);
      const run = await cli(root, ['-m', 'm', '--', ...paths]);
      expect(preview.exitCode).toBe(1);
      expect(JSON.parse(preview.stdout)).toMatchObject({ code: 'commit_paths_invalid' });
      expect(JSON.parse(run.stdout)).toEqual(JSON.parse(preview.stdout));
      expect(git(root, 'ls-files', '-s')).toBe(before);
      expect(status(root)).toEqual([' D art/x.txt']);
    }
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(bare, 'rev-parse', 'main')).toBe(head);
    expect(git(root, 'ls-files').split('\n')).toEqual(['.gitignore', 'art/x.txt', 'art/y.txt', 'seed.md']);
  });

  test('a path that is not on disk, staged or in the last commit refuses before anything changes', async () => {
    const { root, bare } = ignoredAll();
    const head = git(root, 'rev-parse', 'HEAD');
    for (const mode of [['--dry-run'], []]) {
      const r = await cli(root, [...mode, '-m', 'm', '--', 'art/never.txt']);
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ code: 'commit_paths_invalid' });
    }
    expect(git(bare, 'rev-parse', 'main')).toBe(head);
    expect(status(root)).toEqual([]);
  });
});
