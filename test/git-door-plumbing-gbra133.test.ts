/**
 * GBRA-133 G2 follow-up: the door commits by plumbing (src/core/persistence/git-door.ts), never through the checkout's
 * index. Protects:
 *   - the checkout's index keeps every entry but the published ones byte for byte, stat data included (red before: the
 *     porcelain `commit --only` refreshed the whole index, so a stale entry elsewhere was rewritten);
 *   - an unrelated staged path stays staged and out of the commit, a dirty or untracked file is untouched;
 *   - modes survive (an executable page, a sibling symlink and script), a removal drops its entry and an emptied tree;
 *   - a branch moved between build and update-ref is rebuilt once, a second move refuses and the write rolls back;
 *   - the message and trailers are the porcelain path's; detached HEAD and unborn branches refuse typed;
 *   - a root below the repository toplevel, a non-UTF-8 sibling name and two door commits at once.
 * Seams: `doorSeams.beforeUpdateRef` for the race; real repositories otherwise, and real engines for the rollback.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { commitGitTargets } from '../src/core/persistence/effect-git.ts';
import type { GitCommitNote } from '../src/core/persistence/effect-model.ts';
import { commitThroughDoor, doorSeams } from '../src/core/persistence/git-door.ts';
import { hashFile } from '../src/core/persistence/large-file.ts';
import { gitChildEnv } from '../src/core/git-env.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const env = gitChildEnv();
const raw = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
const git = (root: string, ...args: string[]) => raw(root, ...args).trim();
const lines = (text: string) => text.split('\n').filter(Boolean);
const OLD = new Date('2001-01-01T00:00:00Z');
const roots: string[] = [];

/** A repository on branch main whose files carry an old mtime, so no index entry is racily clean. */
function repo(files: Record<string, string>, sub = ''): string {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-door-plumbing-')));
  roots.push(top);
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'config', 'user.name', 'Example Writer'); git(top, 'config', 'user.email', 'writer@example.invalid');
  for (const [path, body] of Object.entries(files)) put(top, path, body);
  git(top, 'add', '-A'); git(top, 'commit', '-qm', 'seed');
  return sub ? join(top, sub) : top;
}
function put(root: string, path: string, body: string): string {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  utimesSync(file, OLD, OLD);
  return file;
}
/** Every index entry with its stat data (`ls-files --debug`), keyed by path. */
function indexEntries(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  let path = '';
  for (const line of lines(raw(root, 'ls-files', '--debug'))) {
    if (!/^\s/.test(line)) { path = line; entries.set(path, ''); } else entries.set(path, entries.get(path) + line + '\n');
  }
  return entries;
}
const door = (root: string, ...paths: string[]) => commitThroughDoor(root, paths.map(path => ({ path: join(root, path), planned: hashFile(join(root, path)) })));
/** A sandbox's git wrapper may append a co-author trailer to every `git commit` (never to commit-tree): both sides are read without it. */
const unshimmed = (message: string) => message.replace(/^Co-authored-by: .*\n/gm, '').replace(/\n+$/, '\n');
const refusal = (work: Promise<unknown>) => work.then(() => null, (error: { code?: string; message?: string }) => error);

afterEach(() => {
  doorSeams.beforeUpdateRef = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('G2 plumbing door commit', () => {
  test('the checkout\'s index keeps every other entry byte for byte, stat data included', async () => {
    const root = repo({ 'notes/a.md': 'a\n', 'notes/b.md': 'b\n', 'other/c.md': 'c\n' });
    // Same bytes, newer mtime: other/c.md's index entry is stale until something refreshes the whole index.
    utimesSync(join(root, 'other/c.md'), new Date('2002-01-01T00:00:00Z'), new Date('2002-01-01T00:00:00Z'));
    const before = indexEntries(root);
    put(root, 'notes/a.md', 'a, second revision\n');
    const commit = await door(root, 'notes/a.md');
    const after = indexEntries(root);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(commit!);
    before.delete('notes/a.md'); after.delete('notes/a.md');
    expect(after).toEqual(before);
    expect(git(root, 'ls-files', '-s', '--', 'notes/a.md')).toContain(git(root, 'rev-parse', 'HEAD:notes/a.md'));
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('an unrelated staged path stays staged and out of the commit; dirty and untracked files are untouched', async () => {
    const root = repo({ 'notes/a.md': 'a\n', 'notes/staged.md': 'staged\n', 'other/c.md': 'c\n' });
    put(root, 'notes/staged.md', 'staged, second revision\n');
    git(root, 'add', '--', 'notes/staged.md');
    put(root, 'other/c.md', 'c, edited by hand\n');
    put(root, 'scratch.txt', 'untracked\n');
    put(root, 'notes/a.md', 'a, second revision\n');
    put(root, 'notes/new.md', 'new page\n');
    const commit = await door(root, 'notes/a.md', 'notes/new.md');
    expect(lines(git(root, 'show', '--name-only', '--format=', commit!)).sort()).toEqual(['notes/a.md', 'notes/new.md']);
    expect(lines(git(root, 'diff', '--cached', '--name-only'))).toEqual(['notes/staged.md']);
    expect(git(root, 'show', ':notes/staged.md')).toBe('staged, second revision');
    expect(lines(git(root, 'diff', '--name-only'))).toEqual(['other/c.md']);
    expect(readFileSync(join(root, 'other/c.md'), 'utf8')).toBe('c, edited by hand\n');
    expect(git(root, 'status', '--porcelain', '--', 'scratch.txt')).toBe('?? scratch.txt');
    expect(git(root, 'status', '--porcelain', '--', 'notes/a.md', 'notes/new.md')).toBe('');
  });

  test('an executable page keeps its bit; a sibling symlink and script keep theirs', async () => {
    const root = repo({ 'notes/a.md': 'a\n' });
    put(root, 'notes/run.md', 'run\n'); chmodSync(join(root, 'notes/run.md'), 0o755);
    symlinkSync('run.md', join(root, 'notes/link.md'));
    put(root, 'tools/script.sh', '#!/bin/sh\n'); chmodSync(join(root, 'tools/script.sh'), 0o755);
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'modes');
    const seeded = git(root, 'ls-tree', '-r', 'HEAD');
    put(root, 'notes/run.md', 'run, second revision\n');
    put(root, 'notes/door.md', 'door\n');
    await door(root, 'notes/run.md', 'notes/door.md');
    const tree = new Map(lines(git(root, 'ls-tree', '-r', 'HEAD')).map(line => [line.split('\t')[1]!, line.split('\t')[0]!.split(' ')]));
    expect(tree.get('notes/run.md')![0]).toBe('100755');
    expect(tree.get('notes/door.md')![0]).toBe('100644');
    const old = new Map(lines(seeded).map(line => [line.split('\t')[1]!, line.split('\t')[0]!]));
    expect(tree.get('notes/link.md')!.join(' ')).toBe(old.get('notes/link.md')!);
    expect(tree.get('notes/link.md')![0]).toBe('120000');
    expect(tree.get('tools/script.sh')!.join(' ')).toBe(old.get('tools/script.sh')!);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('a removal drops its entry, and a directory it empties leaves the tree', async () => {
    const root = repo({ 'notes/a.md': 'a\n', 'notes/gone.md': 'gone\n', 'deep/only/x.md': 'x\n' });
    unlinkSync(join(root, 'notes/gone.md'));
    rmSync(join(root, 'deep'), { recursive: true });
    const commit = await door(root, 'notes/gone.md', 'deep/only/x.md');
    expect(lines(git(root, 'ls-tree', '-r', '--name-only', commit!))).toEqual(['notes/a.md']);
    expect(git(root, 'ls-files')).toBe('notes/a.md');
    expect(git(root, 'status', '--porcelain')).toBe('');
    // Removing what HEAD no longer holds commits nothing and returns HEAD.
    expect(await door(root, 'notes/gone.md')).toBe(commit);
  });

  test('a branch moved before update-ref is rebuilt once on the new HEAD', async () => {
    const root = repo({ 'notes/a.md': 'a\n', 'other/c.md': 'c\n' });
    let human = '';
    doorSeams.beforeUpdateRef = (_root, attempt) => {
      if (attempt) return;
      put(root, 'other/c.md', 'c, committed by hand\n');
      git(root, 'add', '--', 'other/c.md'); git(root, 'commit', '-qm', 'a commit made in the checkout');
      human = git(root, 'rev-parse', 'HEAD');
    };
    put(root, 'notes/a.md', 'a, second revision\n');
    const commit = await door(root, 'notes/a.md');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(commit!);
    expect(git(root, 'rev-parse', 'HEAD^')).toBe(human);
    expect(git(root, 'show', 'HEAD:other/c.md')).toBe('c, committed by hand');
    expect(git(root, 'show', 'HEAD:notes/a.md')).toBe('a, second revision');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('a branch that moves again refuses; Git and the index keep the other commits', async () => {
    const root = repo({ 'notes/a.md': 'a\n' });
    const seed = git(root, 'rev-parse', 'HEAD:notes/a.md');
    let moves = 0;
    doorSeams.beforeUpdateRef = () => { moves++; git(root, 'commit', '-q', '--allow-empty', '-m', 'moved'); };
    put(root, 'notes/a.md', 'a, second revision\n');
    const error = await refusal(door(root, 'notes/a.md'));
    expect(error).toMatchObject({ code: 'git_unavailable' });
    expect(moves).toBe(2);
    expect(git(root, 'log', '-1', '--format=%s')).toBe('moved');
    expect(git(root, 'rev-parse', 'HEAD:notes/a.md')).toBe(seed);
    expect(git(root, 'ls-files', '-s', '--', 'notes/a.md')).toContain(seed);
  });

  test('the message and trailers are the porcelain path\'s, alone and in a group', async () => {
    const seed = { 'notes/a.md': 'a\n', 'notes/b.md': 'b\n', 'notes/c.md': 'c\n' };
    const notes: Record<string, GitCommitNote> = {
      'notes/a.md': { subject: 'gbrain: repair notes/a.md  ', line: 'notes/a.md (invalid_fence)', trailer: 'gbrain-repair: invalid_fence deterministic high' },
      'notes/b.md': { subject: 'gbrain: repair notes/b.md', line: 'notes/b.md (frontmatter_slug_conflict)', trailer: 'gbrain-repair: frontmatter_slug_conflict deterministic high' },
    };
    for (const paths of [['notes/a.md'], ['notes/c.md'], ['notes/a.md', 'notes/b.md', 'notes/c.md']]) {
      const porcelain = repo(seed), plumbing = repo(seed);
      for (const root of [porcelain, plumbing]) for (const path of paths) put(root, path, path + ', second revision\n');
      const outcomes = await commitGitTargets(porcelain, paths, undefined, new Map(paths.flatMap(path => notes[path] ? [[path, notes[path]!] as const] : [])));
      expect([...outcomes.values()].every(outcome => !(outcome instanceof Error) && outcome.git === 'committed')).toBe(true);
      await commitThroughDoor(plumbing, paths.map(path => ({ path: join(plumbing, path), planned: hashFile(join(plumbing, path)), note: notes[path] })));
      for (const format of ['%B', '%(trailers:only)', '%an <%ae>']) expect(unshimmed(raw(plumbing, 'log', '-1', '--format=' + format))).toBe(unshimmed(raw(porcelain, 'log', '-1', '--format=' + format)));
      expect(git(plumbing, 'rev-parse', 'HEAD^{tree}')).toBe(git(porcelain, 'rev-parse', 'HEAD^{tree}'));
      expect(git(plumbing, 'reflog', '-1', '--format=%gs')).toBe(git(porcelain, 'reflog', '-1', '--format=%gs'));
    }
  });

  test('new names land where Git sorts them: the tree equals the porcelain commit\'s', async () => {
    const seed = { 'notes/x.md': 'x\n', 'notes/x/inner.md': 'inner\n', 'notes/x-y/inner.md': 'inner\n', 'notes/z.md': 'z\n', 'top.md': 'top\n' };
    const added = ['notes/x.a.md', 'notes/x0.md', 'notes/x/new.md', 'notes/w.md', 'notes/zz.md', 'notes/x-.md', 'fresh/dir/page.md', 'a.md'];
    const porcelain = repo(seed), plumbing = repo(seed);
    for (const root of [porcelain, plumbing]) { for (const path of added) put(root, path, path + '\n'); unlinkSync(join(root, 'notes/z.md')); }
    const paths = [...added, 'notes/z.md'];
    await commitGitTargets(porcelain, paths);
    await door(plumbing, ...paths);
    expect(git(plumbing, 'rev-parse', 'HEAD^{tree}')).toBe(git(porcelain, 'rev-parse', 'HEAD^{tree}'));
    expect(git(plumbing, 'fsck', '--no-dangling', '--strict')).toBe('');
  });

  test('a detached HEAD and an unborn branch refuse typed and commit nothing', async () => {
    const detached = repo({ 'notes/a.md': 'a\n' });
    git(detached, 'checkout', '-q', '--detach');
    const head = git(detached, 'rev-parse', 'HEAD');
    put(detached, 'notes/a.md', 'a, second revision\n');
    expect(await refusal(door(detached, 'notes/a.md'))).toMatchObject({ code: 'git_detached_head' });
    expect(git(detached, 'rev-parse', 'HEAD')).toBe(head);
    const unborn = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-door-plumbing-')));
    roots.push(unborn);
    git(unborn, 'init', '-q', '-b', 'main');
    put(unborn, 'notes/a.md', 'a\n');
    expect(await refusal(door(unborn, 'notes/a.md'))).toMatchObject({ code: 'git_branch_unborn' });
  });

  test('a root below the toplevel commits at its prefix; an ignored new file refuses unless a later rule un-ignores it', async () => {
    const root = repo({ 'brain/notes/a.md': 'a\n', '.gitignore': 'brain/notes/ig*.md\n!brain/notes/ig-kept.md\n', 'README.md': 'top\n' }, 'brain');
    const top = dirname(root);
    put(root, 'notes/a.md', 'a, second revision\n');
    put(root, 'notes/ig-kept.md', 'kept\n');
    const commit = await door(root, 'notes/a.md', 'notes/ig-kept.md');
    expect(lines(git(top, 'show', '--name-only', '--format=', commit!)).sort()).toEqual(['brain/notes/a.md', 'brain/notes/ig-kept.md']);
    expect(git(top, 'status', '--porcelain')).toBe('');
    put(root, 'notes/ignored.md', 'ignored\n');
    const error = await refusal(door(root, 'notes/ignored.md'));
    expect(error).toMatchObject({ code: 'git_target_ignored' });
    expect(error?.message).toContain('notes/ignored.md');
    expect(git(top, 'rev-parse', 'HEAD')).toBe(commit!);
    expect(git(top, 'ls-files', '--', 'brain/notes/ignored.md')).toBe('');
  });

  test('a sibling whose name is not UTF-8 is carried over unchanged', async () => {
    const root = repo({ 'notes/a.md': 'a\n' });
    writeFileSync(Buffer.concat([Buffer.from(join(root, 'notes') + '/'), Buffer.from([0x6e, 0xe9, 0x2e, 0x6d, 0x64])]), 'latin-1 name\n');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'latin-1 sibling');
    put(root, 'notes/a.md', 'a, second revision\n');
    await door(root, 'notes/a.md');
    expect(lines(git(root, 'diff', '--name-only', 'HEAD^', 'HEAD'))).toEqual(['notes/a.md']);
    expect(git(root, 'rev-parse', 'HEAD^:notes') === git(root, 'rev-parse', 'HEAD:notes')).toBe(false);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('two door commits of one checkout at once both land, each holding its own file', async () => {
    const root = repo({ 'notes/a.md': 'a\n' });
    put(root, 'notes/one.md', 'one\n'); put(root, 'notes/two.md', 'two\n');
    const [one, two] = await Promise.all([door(root, 'notes/one.md'), door(root, 'notes/two.md')]);
    expect(new Set([one, two]).size).toBe(2);
    expect(git(root, 'show', one + ':notes/one.md')).toBe('one');
    expect(git(root, 'show', two + ':notes/two.md')).toBe('two');
    expect(git(root, 'rev-list', '--count', 'HEAD')).toBe('3');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });
});

const putPage = operations.find(op => op.name === 'put_page')!;
const page = (title: string, body: string) => '---\ntype: note\ntitle: ' + title + '\n---\n\n' + body + '\n';
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const write = (ctx: OperationContext, slug: string, content: string, requestId = randomUUID(), expectedRevision?: string) =>
  putPage.handler(ctx, { slug, content, request_id: requestId, wait_ms: 30_000, ...(expectedRevision ? { expected_revision: expectedRevision } : {}) }) as Promise<Record<string, any>>;
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

for (const backend of testBackends()) describe(`[${backend}] G2 plumbing: a raced branch rolls the write back`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a branch that keeps moving refuses the commit; the file and the row keep the prior revision', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const first = await write(ctx, 'notes/raced', page('Raced', 'First revision.'));
    expect(first).toMatchObject({ state: 'committed' });
    const prior = readFileSync(join(root, 'notes/raced.md'), 'utf8');
    let moves = 0;
    doorSeams.beforeUpdateRef = () => { moves++; git(root, 'commit', '-q', '--allow-empty', '-m', 'moved by hand'); };
    const requestId = randomUUID();
    const result = await write(ctx, 'notes/raced', page('Raced', 'Second revision.'), requestId, first.revision).then(value => value, (error: { code?: string }) => ({ thrown: error.code }));
    doorSeams.beforeUpdateRef = undefined;
    expect(result).not.toMatchObject({ state: 'committed' });
    expect(moves).toBeGreaterThanOrEqual(2);
    expect(readFileSync(join(root, 'notes/raced.md'), 'utf8')).toBe(prior);
    expect(git(root, 'show', 'HEAD:notes/raced.md')).toContain('First revision.');
    expect(git(root, 'status', '--porcelain', '--', 'notes/raced.md')).toBe('');
    const [receipt] = await engine.executeRaw<{ state: string; error_code: string | null }>('SELECT state, error_code FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    expect(receipt).toMatchObject({ state: 'failed', error_code: 'git_unavailable' });
    const [row] = await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE source_id='default' AND slug='notes/raced'");
    expect(row!.compiled_truth).toContain('First revision.');
  }, { databaseUrl, setup }), 120_000);
});
