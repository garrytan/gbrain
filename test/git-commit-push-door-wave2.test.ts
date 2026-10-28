/**
 * GBRA-230 lane G: the commit-push door.
 * Protects:
 *   - #7752: `gbrain git commit-push --dry-run` runs the real run's path checks. On a non-cone sparse checkout a path
 *     outside the sparse-checkout definition refuses `commit_paths_invalid` with the real run's fix text, takes no lock
 *     and writes nothing (red before: the dry run exited 0 and listed the path the real run refuses). Cone mode and a
 *     checkout without sparse checkout keep answering what their real run does. The dry run also refuses what the real
 *     run refuses before staging: a path outside gbrain.sourceRoot (red before: exit 0), another writer's staged file
 *     under a named directory, a staged rename's other side outside the root; its envelope equals the real run's.
 *   - #7753: `--untrack` removes exactly the named paths from the index and Git, keeps the files on disk, and leaves
 *     through the same commit lock and publish as an ordinary commit; a commit carrying anything else is taken back.
 *   - #7793 item 2: the fix and verify commands printed for a staged file read each path literally.
 * Repo-less: commit-push needs a checkout; a directory that is not one refuses the same way with or without --untrack.
 * Seams: none; real repositories and a bare remote, the real CLI for the flags.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireCommitLock, commitAndPush } from '../src/core/git/commit-push.ts';
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

describe('#7753: --untrack keeps the files on disk', () => {
  test('removes only the named file from Git; other writers\' staged and unstaged files stay as they were', async () => {
    const { root, bare } = checkout({ 'gen/out.json': '{"generated":1}\n', 'notes/a.md': 'a v1\n', 'notes/b.md': 'b v1\n' });
    put(root, 'notes/a.md', 'a staged by another writer\n'); git(root, 'add', 'notes/a.md');
    put(root, 'notes/b.md', 'b half-written by another writer\n');
    const result = await cli(root, ['--untrack', '-m', 'untrack generated output', '--', 'gen/out.json']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'pushed', paths: ['gen/out.json'] });
    expect(changed(bare!, 'main')).toEqual(['D', 'gen/out.json']);
    expect(git(bare!, 'log', '-1', '--format=%s', 'main')).toBe('untrack generated output');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(git(bare!, 'rev-parse', 'main'));
    expect(readFileSync(join(root, 'gen/out.json'), 'utf8')).toBe('{"generated":1}\n');
    expect(status(root)).toEqual([' M notes/b.md', '?? gen/out.json', 'M  notes/a.md']);
  });

  test('a directory untracks every file Git holds under it; untracked files there are left alone', () => {
    const { root, bare } = checkout({ 'gen/a.json': 'a\n', 'gen/sub/b.json': 'b\n', 'general.md': 'decoy\n' });
    put(root, 'gen/scratch.tmp', 'never tracked\n');
    expect(commitAndPush({ repo: root, cwd: root, paths: ['gen'], message: 'untrack gen', untrack: true })).toMatchObject({ outcome: 'pushed', paths: ['gen'] });
    expect(changed(bare!, 'main')).toEqual(['D', 'gen/a.json', 'D', 'gen/sub/b.json']);
    expect(status(root)).toEqual(['?? gen/a.json', '?? gen/scratch.tmp', '?? gen/sub/b.json']);
    expect(git(bare!, 'show', 'main:general.md')).toBe('decoy');
  });

  test('a file already deleted on disk commits its deletion, like an ordinary commit of it', () => {
    const { root, bare } = checkout({ 'gone.md': 'gone\n' });
    unlinkSync(join(root, 'gone.md'));
    expect(commitAndPush({ repo: root, cwd: root, paths: ['gone.md'], message: 'untrack gone', untrack: true }).outcome).toBe('pushed');
    expect(changed(bare!, 'main')).toEqual(['D', 'gone.md']);
    expect(status(root)).toEqual([]);
  });

  test('a path Git does not hold, the whole checkout and a magic-looking name refuse before anything changes', () => {
    const { root, bare } = checkout({ 'notes/a.md': 'a\n', 'notes/b.md': 'b\n', 'kept.md': 'kept\n' });
    put(root, 'loose.md', 'never tracked\n');
    const head = git(root, 'rev-parse', 'HEAD');
    for (const paths of [['loose.md'], ['kept.md', 'loose.md'], ['notes/*.md'], [':(glob)notes/*.md'], ['.'], [root], []]) {
      expect(refusalOf(() => commitAndPush({ repo: root, cwd: root, paths, message: 'm', untrack: true })).code).toBe('commit_paths_invalid');
    }
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(bare!, 'rev-parse', 'main')).toBe(head);
    expect(git(root, 'ls-files').split('\n')).toEqual(['kept.md', 'notes/a.md', 'notes/b.md', 'seed.md']);
    expect(status(root)).toEqual(['?? loose.md']);
  });

  test('a file named with glob characters untracks alone, never the files its glob reading matches', () => {
    const { root, bare } = checkout({ '[ab].md': 'literal\n', 'a.md': 'a\n', 'b.md': 'b\n' });
    expect(commitAndPush({ repo: root, cwd: root, paths: ['[ab].md'], message: 'untrack literal', untrack: true }).outcome).toBe('pushed');
    expect(changed(bare!, 'main')).toEqual(['D', '[ab].md']);
    expect(git(root, 'ls-files').split('\n')).toEqual(['a.md', 'b.md', 'seed.md']);
  });

  test('a commit that changes anything beyond the named paths (a pre-commit hook staging a sibling) is taken back; the index is restored', () => {
    const { root, bare, hooks } = checkout({ 'gen/out.json': 'out\n', 'sibling.md': 'sibling v1\n' });
    put(root, 'sibling.md', 'sibling edited by another writer\n');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\ngit add -- sibling.md\n');
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    const head = git(root, 'rev-parse', 'HEAD');
    const refused = refusalOf(() => commitAndPush({ repo: root, cwd: root, paths: ['gen/out.json'], message: 'untrack', untrack: true }));
    expect(refused.code).toBe('git_unavailable');
    expect(refused.message).toContain('sibling.md');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(bare!, 'rev-parse', 'main')).toBe(head);
    expect(status(root)).toEqual([' M sibling.md']);
    expect(git(root, 'ls-files', '--', 'gen/out.json')).toBe('gen/out.json');
  });

  test('runs inside the checkout\'s commit lock: a held lock refuses commit_lock_busy and untracks nothing', async () => {
    const { root } = checkout({ 'gen/out.json': 'out\n' });
    const lock = acquireCommitLock(root, 0);
    try {
      const busy = await cli(root, ['--untrack', '-m', 'm', '--', 'gen/out.json'], { GBRAIN_COMMIT_LOCK_WAIT_SECONDS: '0' });
      expect(busy.exitCode).toBe(1);
      expect(JSON.parse(busy.stdout)).toMatchObject({ code: 'commit_lock_busy' });
    } finally { lock.release(); }
    expect(git(root, 'ls-files', '--', 'gen/out.json')).toBe('gen/out.json');
  });

  test('--dry-run --untrack previews without writing and refuses what the real run refuses, a sparse-excluded path included', async () => {
    const { root } = checkout({ 'gen/out.json': 'out\n', 'notes/b/two.md': 'two\n' });
    const head = git(root, 'rev-parse', 'HEAD');
    const index = indexBytes(root);
    const preview = await cli(root, ['--dry-run', '--untrack', '-m', 'm', '--', 'gen/out.json']);
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ dry_run: true, mode: 'untrack', paths: ['gen/out.json'] });
    put(root, 'loose.md', 'never tracked\n');
    const loose = await cli(root, ['--dry-run', '--untrack', '-m', 'm', '--', 'loose.md']);
    expect(loose.exitCode).toBe(1);
    expect(JSON.parse(loose.stdout)).toMatchObject({ code: 'commit_paths_invalid' });
    expect(indexBytes(root)).toBe(index);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);

    git(root, 'sparse-checkout', 'set', '--no-cone', '/gen/');
    const outside = await cli(root, ['--dry-run', '--untrack', '-m', 'm', '--', 'notes/b/two.md']);
    expect(outside.exitCode).toBe(1);
    const previewed = JSON.parse(outside.stdout) as { code: string; suggestion: string };
    expect(previewed).toMatchObject({ code: 'commit_paths_invalid', suggestion: expect.stringContaining('outside of your sparse-checkout definition') });
    const real = await cli(root, ['--untrack', '-m', 'm', '--', 'notes/b/two.md']);
    expect(JSON.parse(real.stdout)).toMatchObject({ code: 'commit_paths_invalid', suggestion: previewed.suggestion });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(commitAndPush({ repo: root, cwd: root, paths: ['gen/out.json'], message: 'untrack inside the sparse definition', untrack: true }).outcome).toBe('pushed');
    expect(changed(root)).toEqual(['D', 'gen/out.json']);
    expect(git(root, 'ls-files', '--', 'notes/b/two.md')).toBe('notes/b/two.md');
  });

  test('a checkout with no Git remote untracks locally (committed_local, no_remote)', () => {
    const { root } = checkout({ 'gen/out.json': 'out\n' }, false);
    const r = commitAndPush({ repo: root, cwd: root, paths: ['gen/out.json'], message: 'untrack', untrack: true });
    expect(r).toMatchObject({ outcome: 'committed_local', no_remote: true });
    expect(changed(root)).toEqual(['D', 'gen/out.json']);
    expect(status(root)).toEqual(['?? gen/out.json']);
  });

  test('flags that do not combine with --untrack refuse; a directory that is no checkout refuses as without --untrack', async () => {
    const { root } = checkout({ 'gen/out.json': 'out\n' });
    for (const args of [['--untrack', '--push-only'], ['--untrack', '--pull'], ['--untrack', '--pending', '-m', 'm']]) {
      const r = await cli(root, args);
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ code: 'commit_paths_invalid' });
    }
    const plain = scratch('repo-less');
    const without = await cli(plain, ['-m', 'm', '--', 'x.md']);
    const withUntrack = await cli(plain, ['--untrack', '-m', 'm', '--', 'x.md']);
    expect(withUntrack.exitCode).toBe(without.exitCode);
    expect(JSON.parse(withUntrack.stdout)).toEqual(JSON.parse(without.stdout));
    expect(git(root, 'ls-files', '--', 'gen/out.json')).toBe('gen/out.json');
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
