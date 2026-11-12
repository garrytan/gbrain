/**
 * GST-2519 item 1: `gbrain git commit-push --untrack`.
 * Protects:
 *   - #7753 (ported unchanged from the wave 2 door): in an ordinary checkout `--untrack` removes exactly the named paths
 *     from the index and Git, keeps the files on disk, and leaves through the same commit lock and publish as an ordinary
 *     commit; a commit carrying anything else is taken back; the dry run refuses what the real run refuses.
 *   - In a managed canonical worktree it untracks only files under a storage.db_only dir that gbrain.yml at HEAD declares
 *     and .gitignore ignores (refused `untrack_not_db_only` otherwise, the index as it was), commits there and never
 *     pushes. Every page stays live with its content hash, with no hold, after a sync and a full sync, on strict and
 *     non-strict sources; `git revert` of the untrack commit brings the files back to Git with the pages still live.
 * Repo-less: commit-push needs a checkout; a directory that is not one refuses the same way with or without --untrack.
 * Seams: none; real repositories and bare remotes, the real CLI for the flags, managed sync on PGLite and Postgres.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { acquireCommitLock, commitAndPush, previewUntrack, untrackAdmitted } from '../src/core/git/commit-push.ts';
import { gitChildEnv } from '../src/core/git-env.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { commitFiles, drainEffects, page } from './helpers/label-repair.ts';
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


const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const D = 'sources/archive-example/', A = `${D}first-example`, B = `${D}sub/second-example`;
const D2 = 'sources/unignored-example/', C = `${D2}third-example`, PLAIN = 'notes/plain-example';
const syncAll = async (engine: BrainEngine, full = false) => {
  const result = await performManagedSync(engine, { ...OPTS, ...(full ? { full: true } : {}) });
  await drainEffects(engine);
  return result;
};
const strictSource = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const rows = async (engine: BrainEngine) => Object.fromEntries((await engine.executeRaw<{ slug: string; content_hash: string; deleted: boolean }>(
  "SELECT slug, content_hash, deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id='default' ORDER BY slug")).map(r => [r.slug, { hash: r.content_hash, deleted: r.deleted }]));
const holdCount = async (engine: BrainEngine) => (await readGitSourceHolds(engine, { sourceIds: ['default'] })).reduce((n, s) => n + s.count, 0);
const tip = (bare: string) => git(bare, 'rev-parse', 'HEAD');
const staged = (root: string) => git(root, 'ls-files', '-s');

/** A managed brain whose checkout declares D (ignored) and D2 (not ignored) under storage.db_only, tracks a page in each and one outside, and pushed to a bare origin. */
function declared({ root }: { root: string }): void {
  writeFileSync(join(root, '.gitignore'), `${D}\n`);
  writeFileSync(join(root, 'gbrain.yml'), `storage:\n  db_only:\n    - ${D}\n    - ${D2}\n`);
  durableGitRepo(root, ['.gitignore', 'gbrain.yml']);
  for (const slug of [A, B, C, PLAIN]) put(root, `${slug}.md`, page(slug, 'canary'));
  commitFiles(root, [A, B, C, PLAIN].map(slug => `${slug}.md`), 'pages, committed before their folders were declared db_only');
  const bare = join(dirname(root), 'origin.git');
  git(dirname(root), 'init', '-q', '--bare', bare);
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', '-u', 'origin', 'HEAD');
}
const bareOf = (root: string) => join(dirname(root), 'origin.git');

describe('GST-2519: a removal staged by hand (git rm --cached)', () => {
  test('the plain door names --untrack instead of a nested repository, and --untrack then commits the removal', () => {
    const { root, bare } = checkout({ 'arch/a.md': 'a\n', 'kept.md': 'kept\n' });
    put(root, '.gitignore', 'arch/\n'); git(root, 'add', '.gitignore'); git(root, 'commit', '-qm', 'ignore arch'); git(root, 'push', '-q');
    git(root, 'rm', '-q', '--cached', 'arch/a.md');
    const refused = refusalOf(() => commitAndPush({ repo: root, cwd: root, paths: ['arch/a.md'], message: 'm' })) as { code?: string; suggestion?: string; docs?: string };
    expect(refused.code).toBe('commit_paths_skipped');
    expect(refused.suggestion).toContain('gbrain git commit-push --untrack -m <msg> -- arch/a.md');
    expect(refused.docs).toBe('docs/guides/shared-checkout-git.md#untrack');
    expect(commitAndPush({ repo: root, cwd: root, paths: ['arch/a.md'], message: 'untrack arch', untrack: true }).outcome).toBe('pushed');
    expect(changed(bare!, 'main')).toEqual(['D', 'arch/a.md']);
    expect(readFileSync(join(root, 'arch/a.md'), 'utf8')).toBe('a\n');
    expect(status(root)).toEqual([]);
  });
});

describe('GST-2519: --untrack in a managed canonical worktree, with a page root below the checkout root', () => {
  test('the storage.db_only admission reads gbrain.yml and the slugs relative to the managed root', () => {
    const { root } = checkout({ 'brain/gbrain.yml': `storage:\n  db_only:\n    - ${D}\n`, [`brain/${A}.md`]: 'a\n', [`${A}.md`]: 'outside the managed root\n' });
    put(root, 'brain/.gitignore', `${D}\n`);
    put(root, '.gitignore', `${D}\n`);
    const managed = { root: join(root, 'brain'), evidence: 'test' };
    expect(untrackAdmitted(root, [`brain/${D.slice(0, -1)}`], managed)).toEqual([`brain/${A}.md`]);
    expect(refusalOf(() => untrackAdmitted(root, [`${A}.md`], managed)).code).toBe('untrack_not_db_only');
  });
});

for (const backend of testBackends()) describe(`[${backend}] GST-2519: --untrack in a managed canonical worktree`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  for (const mode of ['strict', 'non-strict'] as const) {
    test(`${mode} source: untracking a declared, ignored db_only dir keeps every page live with its bytes, commits locally, and git revert undoes it`, () => managedBrain(async ({ engine, root }) => {
      await syncAll(engine);
      if (mode === 'strict') await strictSource(engine);
      const before = await rows(engine);
      const pushed = tip(bareOf(root));
      const result = commitAndPush({ repo: root, cwd: root, paths: [D.slice(0, -1)], message: 'untrack the archive', untrack: true });
      expect(result).toMatchObject({ outcome: 'committed_local', managed: true, unpublished: 1 });
      expect(changed(root)).toEqual(['D', `${A}.md`, 'D', `${B}.md`]);
      expect(git(root, 'ls-files', '--', D)).toBe('');
      expect(readFileSync(join(root, `${A}.md`), 'utf8')).toBe(page(A, 'canary'));
      expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('');
      expect(tip(bareOf(root))).toBe(pushed);
      for (const full of [false, false, true]) {
        const synced = await syncAll(engine, full);
        expect(synced.deleted).toBe(0);
        expect(await rows(engine)).toEqual(before);
        expect(await holdCount(engine)).toBe(0);
      }
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'revert', '--no-edit', 'HEAD');
      expect(git(root, 'ls-files', '--', D).split('\n')).toEqual([`${A}.md`, `${B}.md`]);
      for (const full of [false, true]) {
        await syncAll(engine, full);
        expect(await rows(engine)).toEqual(before);
        expect(await holdCount(engine)).toBe(0);
      }
      expect(tip(bareOf(root))).toBe(pushed);
    }, { databaseUrl, setup: declared }), 180_000);
  }

  test('anything outside a declared, ignored db_only dir refuses untrack_not_db_only before the index changes; the dry run refuses the same', () => managedBrain(async ({ engine, root }) => {
    await syncAll(engine);
    await strictSource(engine);
    const before = await rows(engine);
    const head = git(root, 'rev-parse', 'HEAD');
    const index = staged(root);
    writeFileSync(join(root, 'gbrain.yml'), `storage:\n  db_only:\n    - ${D}\n    - ${D2}\n    - notes/\n`);
    writeFileSync(join(root, '.gitignore'), `${D}\nnotes/\n`);
    const cases: Array<[string[], string, string[]]> = [
      [[`${PLAIN}.md`], 'untrack_not_db_only', [`${PLAIN}.md`]],
      [[`${C}.md`], 'untrack_not_db_only', [`${C}.md`]],
      [[`${A}.md`, `${PLAIN}.md`], 'untrack_not_db_only', [`${PLAIN}.md`]],
      [[`${D}missing-example.md`], 'commit_paths_invalid', []],
    ];
    for (const [paths, code, refused] of cases) {
      const real = refusalOf(() => commitAndPush({ repo: root, cwd: root, paths, message: 'untrack', untrack: true })) as { code?: string; detail?: string; docs?: string };
      expect(real.code).toBe(code);
      if (refused.length) expect(JSON.parse(real.detail!)).toEqual({ paths: refused });
      if (refused.length) expect(real.docs).toBe('docs/guides/shared-checkout-git.md#untrack');
      expect(refusalOf(() => previewUntrack(root, paths)).code).toBe(code);
      expect(staged(root)).toBe(index);
      expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    }
    expect(refusalOf(() => commitAndPush({ repo: root, cwd: root, paths: [`${A}.md`], message: 'm', untrack: true, pending: true })).code).toBe('commit_paths_invalid');
    expect(refusalOf(() => previewUntrack(root, [`${A}.md`], { allowOutsideSourceRoot: true })).code).toBe('commit_paths_invalid');
    expect(previewUntrack(root, [D.slice(0, -1)])).toEqual([`${A}.md`, `${B}.md`]);
    expect(staged(root)).toBe(index);
    await syncAll(engine);
    expect(await rows(engine)).toEqual(before);
  }, { databaseUrl, setup: declared }), 180_000);

  test('a folder whose page slugs fall outside the declared spelling, or that only HEAD still declares, refuses; no page is deleted', () => managedBrain(async ({ engine, root }) => {
    const spaced = 'sources/Spaced Example/', slug = 'sources/spaced-example/one-example';
    writeFileSync(join(root, 'gbrain.yml'), `storage:\n  db_only:\n    - ${D}\n    - ${D2}\n    - ${spaced}\n`);
    writeFileSync(join(root, '.gitignore'), `${D}\n${spaced}\n`);
    put(root, `${spaced}one example.md`, page(slug, 'canary'));
    commitFiles(root, ['gbrain.yml', '.gitignore', `${spaced}one example.md`], 'a db_only folder spelled with a space');
    await syncAll(engine);
    await strictSource(engine);
    const before = await rows(engine);
    expect(before[slug]).toMatchObject({ deleted: false });
    expect(refusalOf(() => commitAndPush({ repo: root, cwd: root, paths: [spaced.slice(0, -1)], message: 'untrack', untrack: true })).code).toBe('untrack_not_db_only');
    writeFileSync(join(root, 'gbrain.yml'), `storage:\n  db_only:\n    - ${D2}\n`);
    expect(refusalOf(() => commitAndPush({ repo: root, cwd: root, paths: [D.slice(0, -1)], message: 'untrack', untrack: true })).code).toBe('untrack_not_db_only');
    expect(git(root, 'ls-files', '--', D).split('\n')).toEqual([`${A}.md`, `${B}.md`]);
    git(root, 'checkout', '--', 'gbrain.yml');
    await syncAll(engine);
    expect(await rows(engine)).toEqual(before);
  }, { databaseUrl, setup: declared }), 180_000);
});
