/**
 * The door's per-write cost cut (src/core/persistence/git-door.ts, ignore-rules.ts). Protects:
 *   - once the checkout's ignore probe is cached, a new file no ignore rule could match commits without running
 *     check-ignore, the index is still staged by one git update-index, and the step deadline needs no rev-parse of its
 *     own; a file a rule could match still asks check-ignore (red before: every new file ran check-ignore, and every
 *     commit ran a separate rev-parse for the step deadline);
 *   - an ignored path is still refused, through a nested .gitignore, info/exclude and core.excludesFile, naming the rule;
 *   - an edit of a .gitignore between writes, and a publication that carries the .gitignore ignoring its sibling, are
 *     classified against the new rules;
 *   - a commit holds only its paths while other files are dirty, staged or untracked; removals and renames land, an
 *     executable keeps its bit, and `git status` afterwards shows only what it showed before;
 *   - the index entry the door stages is the oid hash-object returned for the bytes it committed, never a refresh of
 *     the work tree, so bytes changed after staging show as modified (the staged-oid check of the push scan relies on it);
 *   - external git commits made under the checkout writer lock (the lock every door caller holds) interleave with door
 *     commits without losing a commit or an index entry, and git status stays clean; raw git commits racing the door
 *     without that lock never lose a commit, a door refusal says whether its commit landed exactly when HEAD holds it,
 *     and the index differs from HEAD only by an outsider's staged path whose commit failed or by a door path whose
 *     commit is in HEAD but whose entry the race dropped (the door's update-index refused on index.lock, or git commit
 *     -- <path>, which reads the index before it takes index.lock, wrote over it; only the writer lock closes that).
 *   - on both engines, a strict page under a rule added mid-session is declared git_ignored (no file, no commit), a mixed
 *     page there on a non-durable checkout is database-only, and a durable mixed page still parks its Git effect as
 *     git_target_ignored.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { BrainEngine } from '../src/core/engine.ts';
import { gitChildEnv } from '../src/core/git-env.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { commitThroughDoor, doorSeams } from '../src/core/persistence/git-door.ts';
import { hashFile } from '../src/core/persistence/large-file.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { resetIgnoreCandidatesForTests } from '../src/core/persistence/ignore-rules.ts';
import { acquireNativeLock, type NativeLockHandle } from '../src/core/persistence/native-lock.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitChildEnv() }).trim();
const lines = (text: string) => text.split('\n').filter(Boolean);
const OLD = new Date('2001-01-01T00:00:00Z');
const roots: string[] = [];
afterEach(() => { delete doorSeams.beforeUpdateRef; resetIgnoreCandidatesForTests(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
/** Keeps the developer's global and system Git config and global ignore file out of the test: the filter reads what Git reads. */
const hermetic = (fn: () => unknown) => () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-git-config-')));
  roots.push(home);
  return withEnv({ XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }, async () => { await fn(); });
};

/** A repository on branch main whose files and index are at rest (no racily clean entry). */
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-door-cost-')));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  for (const [path, body] of Object.entries(files)) put(root, path, body);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
  return root;
}
function put(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
  utimesSync(join(root, path), OLD, OLD);
}
const door = (root: string, ...paths: string[]) => commitThroughDoor(root, paths.map(path => ({ path: join(root, path), planned: hashFile(join(root, path)) })));
const refusal = (work: Promise<unknown>) => work.then(() => null, (error: { code?: string; message?: string; suggestion?: string }) => error);
const changed = (root: string, commit: string) => lines(git(root, 'show', '--no-renames', '--name-only', '--format=', commit)).sort();

/** The git subcommands a door commit runs, read from a trace2 event log. */
async function traced(root: string, work: () => Promise<unknown>): Promise<string[]> {
  const log = `${root}-trace.jsonl`;
  roots.push(log);
  await withEnv({ GIT_TRACE2_EVENT: log }, work);
  return lines(readFileSync(log, 'utf8')).map(line => JSON.parse(line) as { event: string; sid: string; argv?: string[] })
    .filter(event => event.event === 'start' && !event.sid.includes('/'))
    .map(event => { const argv = event.argv!; for (let i = 1; i < argv.length; i++) { if (argv[i] === '-C' || argv[i] === '-c') { i++; continue; } if (!argv[i]!.startsWith('-')) return argv[i]!; } return '?'; });
}

describe('door write cost', () => {
  test('a new file no rule could match runs no check-ignore and one update-index; one a rule could match asks check-ignore', hermetic(async () => {
    const root = repo({ 'notes/a.md': 'a\n', '.gitignore': 'scratch/\nnotes/odd-*\n!notes/odd-kept.md\n' });
    put(root, 'notes/warm.md', 'warm\n');
    await door(root, 'notes/warm.md');
    put(root, 'notes/new.md', 'new\n');
    const plain = await traced(root, () => door(root, 'notes/new.md'));
    expect(plain.filter(cmd => ['check-ignore', 'update-index', 'config', 'var'].includes(cmd))).toEqual(['update-index']);
    expect(plain.filter(cmd => cmd === 'rev-parse')).toHaveLength(2);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(git(root, 'ls-files', '-s', '--', 'notes/new.md')).toBe(`100644 ${git(root, 'rev-parse', 'HEAD:notes/new.md')} 0\tnotes/new.md`);
    put(root, 'notes/odd-kept.md', 'odd\n');
    const asked = await traced(root, () => door(root, 'notes/odd-kept.md'));
    expect(asked.filter(cmd => cmd === 'check-ignore')).toHaveLength(1);
    expect(git(root, 'show', 'HEAD:notes/odd-kept.md')).toBe('odd');
    expect(git(root, 'status', '--porcelain')).toBe('');
  }));

  test('an ignored new file still refuses through a nested .gitignore, info/exclude and core.excludesFile, naming the rule', hermetic(async () => {
    const root = repo({ 'notes/a.md': 'a\n', 'notes/.gitignore': 'private-*\n' });
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'local/\n');
    const excludes = join(root, '.git', 'personal-excludes');
    writeFileSync(excludes, '*.draft.md\n');
    git(root, 'config', 'core.excludesFile', excludes);
    const head = git(root, 'rev-parse', 'HEAD');
    for (const [path, rule] of [['notes/private-x.md', 'notes/.gitignore:1: private-*'], ['local/x.md', '.git/info/exclude:1: local/'], ['notes/x.draft.md', `${excludes}:1: *.draft.md`]] as const) {
      put(root, path, 'x\n');
      expect(await refusal(door(root, path))).toMatchObject({ code: 'git_target_ignored', suggestion: expect.stringContaining(`Git ignores ${path} (${rule})`) });
      expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(root, 'ls-files', '--', path)).toBe('');
    }
  }));

  test('a .gitignore edited between writes, or carried by the same publication, is classified against its new rules', hermetic(async () => {
    const root = repo({ 'notes/a.md': 'a\n', '.gitignore': 'scratch/\n' });
    put(root, 'notes/later-1.md', 'one\n');
    await door(root, 'notes/later-1.md');
    put(root, '.gitignore', 'scratch/\nnotes/later-*\n');
    put(root, 'notes/later-2.md', 'two\n');
    expect(await refusal(door(root, 'notes/later-2.md'))).toMatchObject({ code: 'git_target_ignored', suggestion: expect.stringContaining('(.gitignore:2: notes/later-*)') });
    put(root, '.gitignore', 'scratch/\n');
    const commit = await door(root, 'notes/later-2.md');
    expect(changed(root, commit!)).toEqual(['notes/later-2.md']);
    const head = git(root, 'rev-parse', 'HEAD');
    put(root, '.gitignore', 'scratch/\nnotes/sibling.md\n');
    put(root, 'notes/sibling.md', 'sibling\n');
    expect(await refusal(door(root, '.gitignore', 'notes/sibling.md'))).toMatchObject({ code: 'git_target_ignored' });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  }));

  test('removals and renames commit exactly their paths while other files are dirty, staged or untracked; the bit survives', hermetic(async () => {
    const root = repo({ 'notes/a.md': 'a\n', 'notes/old.md': 'old\n', 'notes/gone.md': 'gone\n', 'bin/tool.md': 'tool\n', 'other/dirty.md': 'dirty\n', 'other/staged.md': 'staged\n' });
    chmodSync(join(root, 'bin/tool.md'), 0o755); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'executable');
    put(root, 'other/dirty.md', 'dirty, edited\n');
    put(root, 'other/staged.md', 'staged, edited\n'); git(root, 'add', 'other/staged.md');
    put(root, 'other/untracked.md', 'untracked\n');
    const before = git(root, 'status', '--porcelain');
    unlinkSync(join(root, 'notes/gone.md'));
    expect(changed(root, (await door(root, 'notes/gone.md'))!)).toEqual(['notes/gone.md']);
    mkdirSync(join(root, 'archive'));
    renameSync(join(root, 'notes/old.md'), join(root, 'archive/old.md'));
    renameSync(join(root, 'bin/tool.md'), join(root, 'bin/tool-renamed.md'));
    const rename = await door(root, 'notes/old.md', 'archive/old.md', 'bin/tool.md', 'bin/tool-renamed.md');
    expect(changed(root, rename!)).toEqual(['archive/old.md', 'bin/tool-renamed.md', 'bin/tool.md', 'notes/old.md']);
    expect(git(root, 'ls-tree', 'HEAD', 'bin/tool-renamed.md').split(' ')[0]).toBe('100755');
    expect(git(root, 'ls-files', '-s', '--', 'bin/tool-renamed.md').split(' ')[0]).toBe('100755');
    expect(git(root, 'status', '--porcelain')).toBe(before);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('other/staged.md');
    expect(git(root, 'show', 'HEAD:other/staged.md')).toBe('staged');
  }));

  test('the staged index entry is the hashed oid, not a refresh: bytes changed after staging show as modified', hermetic(async () => {
    const root = repo({ 'notes/a.md': 'a\n' });
    put(root, 'notes/a.md', 'hashed\n');
    put(root, 'notes/new.md', 'hashed new\n');
    const hashed = git(root, 'hash-object', '--', 'notes/a.md');
    doorSeams.beforeUpdateRef = () => { writeFileSync(join(root, 'notes/a.md'), 'rewritten after staging\n'); writeFileSync(join(root, 'notes/new.md'), 'rewritten new\n'); };
    const commit = await door(root, 'notes/a.md', 'notes/new.md');
    expect(git(root, 'rev-parse', `${commit}:notes/a.md`)).toBe(hashed);
    for (const path of ['notes/a.md', 'notes/new.md']) expect(git(root, 'ls-files', '-s', '--', path).split(' ')[1]).toBe(git(root, 'rev-parse', `${commit}:${path}`));
    expect(lines(git(root, 'status', '--porcelain')).map(line => line.trim()).sort()).toEqual(['M notes/a.md', 'M notes/new.md']);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
  }));

  test('external git commits under the checkout writer lock never lose a door commit or its index entry', hermetic(async () => {
    const root = repo({ 'notes/a.md': 'a\n' });
    const lockPath = `${root}-writer.lock`;
    roots.push(lockPath);
    const run = promisify(execFile);
    const underLock = async <T>(work: (lock: NativeLockHandle) => Promise<T>): Promise<T> => {
      const lock = await acquireNativeLock(lockPath, { timeoutMs: 30_000 });
      if (!lock) throw new Error('the checkout writer lock stayed busy for 30 s');
      try { return await work(lock); } finally { await lock.release(); }
    };
    const outsider = (async () => {
      for (let i = 0; i < 8; i++) {
        put(root, `outside/o${i}.md`, `outside ${i}\n`);
        await underLock(async () => {
          await run('git', ['-C', root, 'add', '--', `outside/o${i}.md`], { env: gitChildEnv(), timeout: 20_000 });
          await run('git', ['-C', root, 'commit', '-q', '-m', `outside ${i}`, '--', `outside/o${i}.md`], { env: gitChildEnv(), timeout: 20_000 });
        });
      }
    })();
    const commits: (string | null)[] = [];
    for (let i = 0; i < 8; i++) {
      put(root, `notes/d${i}.md`, `door ${i}\n`);
      commits.push(await underLock(lock => commitThroughDoor(root, [{ path: join(root, `notes/d${i}.md`), planned: hashFile(join(root, `notes/d${i}.md`)) }], lock)));
    }
    await outsider;
    expect(commits.every(commit => typeof commit === 'string')).toBe(true);
    git(root, 'fsck', '--no-progress', '--no-dangling');
    const paths = [...Array(8).keys()].flatMap(i => [`notes/d${i}.md`, `outside/o${i}.md`]).sort();
    expect(lines(git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).filter(path => path !== 'notes/a.md').sort()).toEqual(paths);
    expect(lines(git(root, 'ls-files')).filter(path => path !== 'notes/a.md').sort()).toEqual(paths);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }), 60_000);

  test('raw git commits racing door commits without the writer lock never lose a commit or corrupt the index', hermetic(async () => {
    const root = repo({ 'notes/a.md': 'a\n' });
    const run = promisify(execFile);
    const landed: string[] = [], external: string[] = [], refused: { path: string; message: string }[] = [];
    const outsider = (async () => {
      for (let i = 0; i < 8; i++) {
        put(root, `outside/o${i}.md`, `outside ${i}\n`);
        try {
          await run('git', ['-C', root, 'add', '--', `outside/o${i}.md`], { env: gitChildEnv(), timeout: 20_000 });
          await run('git', ['-C', root, 'commit', '-q', '-m', `outside ${i}`, '--', `outside/o${i}.md`], { env: gitChildEnv(), timeout: 20_000 });
          external.push(`outside/o${i}.md`);
        } catch { /* the door held index.lock or moved the branch; this commit is skipped */ }
      }
    })();
    for (let i = 0; i < 8; i++) {
      put(root, `notes/d${i}.md`, `door ${i}\n`);
      const outcome = await door(root, `notes/d${i}.md`).then(commit => commit, (error: { code?: string; message: string }) => error);
      if (typeof outcome === 'string') { landed.push(`notes/d${i}.md`); continue; }
      expect(outcome).toMatchObject({ code: expect.stringMatching(/^(git_unavailable|git_index_locked)$/) });
      refused.push({ path: `notes/d${i}.md`, message: outcome!.message });
    }
    await outsider;
    git(root, 'fsck', '--no-progress', '--no-dangling');
    const tree = new Set(lines(git(root, 'ls-tree', '-r', '--name-only', 'HEAD')));
    for (const path of [...landed, ...external]) expect(tree.has(path)).toBe(true);
    expect(landed.length).toBeGreaterThan(0);
    for (const { path, message } of refused) expect({ path, saysLanded: message.includes('landed, but the index') }).toEqual({ path, saysLanded: tree.has(path) });
    const inHead = [...landed, ...refused.map(({ path }) => path).filter(path => tree.has(path))];
    for (const change of lines(git(root, 'diff', '--cached', '--name-status', 'HEAD'))) {
      const [status, path] = change.split('\t');
      if (status === 'A') expect(path!.startsWith('outside/') && !external.includes(path!)).toBe(true);
      else expect({ status, doorCommitInHead: inHead.includes(path!) }).toEqual({ status: 'D', doorCommitInHead: true });
    }
  }), 60_000);
});

const putPage = operations.find(op => op.name === 'put_page')!;
const page = (title: string, body: string) => '---\ntype: note\ntitle: ' + title + '\n---\n\n' + body + '\n';
const write = (ctx: OperationContext, slug: string) => putPage.handler(ctx, { slug, content: page(slug, `Body of ${slug}.`), request_id: randomUUID(), wait_ms: 30_000 }) as Promise<Record<string, any>>;
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const reason = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ reason: string | null }>(
  "SELECT database_only_reason AS reason FROM pages WHERE source_id='default' AND slug=$1 AND deleted_at IS NULL", [slug]))[0]?.reason;
const ignoreLater = (root: string, rule: string) => { writeFileSync(join(root, '.gitignore'), rule); git(root, '-c', 'commit.gpgsign=false', 'commit', '-qam', 'ignore rule'); };
const durable = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const plain = ({ root }: { root: string }) => {
  writeFileSync(join(root, '.gitignore'), '\n');
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  git(root, 'add', '.gitignore'); git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial');
};

for (const backend of testBackends()) describe(`[${backend}] door write cost: ignore rules edited mid-session`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('strict: a page under a rule added mid-session is declared git_ignored; after the rule goes a new page commits', hermetic(() => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    expect(await write(ctx, 'notes/before')).toMatchObject({ state: 'committed' });
    expect(git(root, 'log', '--format=%H', '--', 'notes/before.md')).not.toBe('');
    ignoreLater(root, 'notes/later-*\n');
    const head = git(root, 'rev-parse', 'HEAD');
    expect(await write(ctx, 'notes/later-one')).toMatchObject({ state: 'committed' });
    expect(existsSync(join(root, 'notes/later-one.md'))).toBe(false);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await reason(engine, 'notes/later-one')).toBe('git_ignored');
    ignoreLater(root, '\n');
    expect(await write(ctx, 'notes/later-two')).toMatchObject({ state: 'committed' });
    expect(git(root, 'show', 'HEAD:notes/later-two.md')).toContain('Body of notes/later-two.');
    expect(await reason(engine, 'notes/later-two')).toBeNull();
  }, { databaseUrl, setup: durable })), 120_000);

  test('mixed, not durable: a new page under a rule added mid-session is database-only', hermetic(() => managedBrain(async ({ engine, ctx, root }) => {
    expect(await write(ctx, 'notes/before')).toMatchObject({ state: 'committed' });
    expect(existsSync(join(root, 'notes/before.md'))).toBe(true);
    ignoreLater(root, 'notes/later-*\n');
    expect(await write(ctx, 'notes/later-one')).toMatchObject({ state: 'committed' });
    expect(existsSync(join(root, 'notes/later-one.md'))).toBe(false);
    const [row] = await engine.executeRaw<{ path: string | null }>("SELECT source_path AS path FROM pages WHERE source_id='default' AND slug='notes/later-one'");
    expect(row?.path ?? null).toBeNull();
  }, { databaseUrl, setup: plain })), 120_000);

  test('mixed, durable: a page under a rule added mid-session still parks its Git effect as git_target_ignored', hermetic(() => managedBrain(async ({ engine, ctx, root }) => {
    expect(await write(ctx, 'notes/before')).toMatchObject({ state: 'committed' });
    ignoreLater(root, 'notes/later-*\n');
    expect(await write(ctx, 'notes/later-one')).toMatchObject({ state: 'committed' });
    expect(existsSync(join(root, 'notes/later-one.md'))).toBe(true);
    const parked = async () => (await engine.executeRaw<{ code: string | null }>(
      "SELECT e.data->'parked'->0->>'error_code' AS code FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE r.slug='notes/later-one' AND e.kind='git' AND e.state='failed' AND e.error_code='targets_parked'"))[0]?.code;
    await waitFor(async () => { await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 10 }); return (await parked()) !== undefined; },
      { timeoutMs: 30_000, label: 'the Git effect parks' });
    expect(await parked()).toBe('git_target_ignored');
    expect(git(root, 'ls-files', '--', 'notes/later-one.md')).toBe('');
  }, { databaseUrl, setup: durable })), 120_000);
});
