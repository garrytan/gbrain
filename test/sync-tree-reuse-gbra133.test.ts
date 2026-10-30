/**
 * GBRA-133 wave 4: `T` across passes (sync-tree-reuse.ts). A resident process keeps the tree listing its last pass read,
 * and the next pass at a new commit patches it with `git diff-tree` between the two commits instead of listing the whole
 * tree again.
 *   - Equivalence oracle: every reused listing equals a whole `readTreeLevel` of the same commit, across adds, edits,
 *     deletions, a mode change, a symlink, a gitlink, odd path names, a scope, unrelated history and a commit no longer
 *     in the repository; with GBRAIN_SYNC_LEVEL_REUSE_VERIFY=1 a listing that differs throws (forced probe: a corrupted
 *     kept listing).
 *   - Fail closed: switched off, another key, an entry a pass did not finish walking, an entry past its age, a diff
 *     larger than the bound, a scope with pathspec magic and a missing commit all read whole.
 *   - A managed pass on PGLite (and Postgres when DATABASE_URL is set) patches the listing on its next commit, imports
 *     the same pages, and reads whole under `sync.level_reuse false`.
 *   - #7358: a kept listing holds only its commit and tree. Its drop timer once closed over the reading function's scope
 *     (the previous entry and the pass's options), and a cleared timer keeps its callback, so a resident serve kept every
 *     pass it ran. Each read's loop yield and each managed pass's progress callback is collectable after the next pass,
 *     judged by one full collection made from a timer callback (`collected`; forced probe: a pointer left on the checking
 *     frame's stack).
 * Before: every pass listed the whole tree.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { readTreeLevel, type GitTreeEntry } from '../src/core/persistence/sync-git-stream.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { loopYield } from '../src/core/persistence/sync-yield.ts';
import { __resetTreeReuseForTests, LevelReuseMismatch, readTreeLevelReusing, TREE_REUSE_MAX_AGE_MS } from '../src/core/persistence/sync-tree-reuse.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message, '--allow-empty'); return git(root, 'rev-parse', 'HEAD'); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const KEY = ['source-a', 'incarnation-1'];
const sorted = (tree: Map<string, GitTreeEntry>) => [...tree].sort(([a], [b]) => (a < b ? -1 : 1));
/**
 * #7358: which of `refs` one full collection frees, the collection made from a timer callback. JSC scans the machine stack
 * conservatively: a collection made in the test's own continuation also keeps what the frames under it still hold, a pointer
 * into an earlier pass that no JS can reach (7 runs in about 1,950 on a 4-core machine). A timer callback runs once
 * those frames have returned, and anything JS still reaches (a timer, a cache, a closure) keeps a pass there as well.
 */
const collected = (refs: ReadonlyArray<WeakRef<object>>) => new Promise<boolean[]>(resolve => setTimeout(() => { Bun.gc(true); resolve(refs.map(ref => ref.deref() === undefined)); }, 0));

describe('readTreeLevelReusing: T across passes', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'gbra133-tree-reuse-'));
    git(root, 'init', '-q');
    mkdirSync(join(root, 'brain/notes'), { recursive: true });
    for (let i = 0; i < 40; i++) writeFileSync(join(root, `brain/notes/n${i}.md`), note(`n${i}`, `body ${i}`));
    writeFileSync(join(root, 'brain/notes/with space.md'), 'a');
    writeFileSync(join(root, 'brain/notes/ünïcødé.md'), 'b');
    writeFileSync(join(root, 'outside.md'), 'c');
    commit(root, 'first');
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });
  afterEach(() => { __resetTreeReuseForTests(); setSystemTime(); });

  /** One pass's read of `T`: the reused listing, checked against a whole read, then kept as a finished pass keeps it. */
  async function pass(scope: string, opts: { allowed?: boolean; key?: string[]; keep?: boolean } = {}) {
    const head = git(root, 'rev-parse', 'HEAD');
    const got = await readTreeLevelReusing(root, head, scope, { key: opts.key ?? KEY, allowed: opts.allowed ?? true });
    expect(sorted(got.tree)).toEqual(sorted(await readTreeLevel(root, head, scope)));
    if (opts.keep !== false) got.keep();
    return got;
  }

  test('patches adds, edits, deletions, mode changes, a symlink, a gitlink and odd names; equal to a whole read every time', async () => {
    for (const scope of ['', 'brain']) {
      __resetTreeReuseForTests();
      expect((await pass(scope)).reuse).toBe('read');
      expect((await pass(scope)).reuse).toBe('same');
      writeFileSync(join(root, 'brain/notes/n1.md'), 'edited');
      unlinkSync(join(root, 'brain/notes/n2.md'));
      writeFileSync(join(root, 'brain/notes/added.md'), 'new');
      chmodSync(join(root, 'brain/notes/n3.md'), 0o755);
      unlinkSync(join(root, 'brain/notes/n4.md'));
      symlinkSync('n5.md', join(root, 'brain/notes/n4.md'));
      writeFileSync(join(root, 'brain/notes/new\nline.md'), 'nl');
      writeFileSync(join(root, 'outside.md'), 'changed outside the scope');
      git(root, 'add', '-A');
      git(root, 'update-index', '--add', '--cacheinfo', `160000,${git(root, 'rev-parse', 'HEAD')},brain/vendored`);
      git(root, 'commit', '-qm', `edits under ${scope || 'the root'}`);
      expect(git(root, 'ls-tree', 'HEAD', 'brain/vendored')).toStartWith('160000 commit');
      expect((await pass(scope)).reuse).toBe('patched');
      // Back to the first commit's contents: every change undone, the gitlink and the symlink removed.
      git(root, 'revert', '--no-edit', 'HEAD');
      expect((await pass(scope)).reuse).toBe('patched');
    }
  }, 60_000);

  test('unrelated history and a commit Git no longer has', async () => {
    expect((await pass('brain')).reuse).toBe('read');
    const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(root, 'checkout', '-q', '--orphan', 'unrelated');
    git(root, 'rm', '-rq', '--cached', '.');
    for (const f of ['brain/notes/n0.md', 'brain/notes/n7.md']) git(root, 'add', f);
    git(root, 'commit', '-qm', 'orphan');
    expect((await pass('brain')).reuse).toBe('patched');
    // The kept commit leaves the repository: the diff fails and the tree is read whole.
    const orphan = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-qf', branch);
    git(root, 'branch', '-qD', 'unrelated');
    git(root, 'reflog', 'expire', '--expire=now', '--all');
    git(root, 'gc', '-q', '--prune=now');
    expect(() => git(root, 'cat-file', '-e', orphan)).toThrow();
    expect((await pass('brain')).reuse).toBe('read');
  }, 60_000);

  test('fails closed: off, another key, an unfinished walk, past its age, a large diff, pathspec magic', async () => {
    expect((await pass('brain', { allowed: false })).reuse).toBe('read');
    expect((await pass('brain')).reuse).toBe('read');
    // A read with reuse off neither uses nor drops the kept listing.
    expect((await pass('brain', { allowed: false })).reuse).toBe('read');
    expect((await pass('brain')).reuse).toBe('same');
    expect((await pass('brain', { key: ['source-b', 'incarnation-1'] })).reuse).toBe('read');
    expect((await pass('brain', { key: ['source-a', 'incarnation-2'] })).reuse).toBe('read');
    // A pass that took the listing and did not walk it to the end keeps nothing.
    expect((await pass('brain', { keep: false })).reuse).toBe('same');
    expect((await pass('brain')).reuse).toBe('read');
    setSystemTime(new Date(Date.now() + TREE_REUSE_MAX_AGE_MS + 1_000));
    expect((await pass('brain')).reuse).toBe('read');
    setSystemTime();
    mkdirSync(join(root, 'brain/bulk'), { recursive: true });
    for (let i = 0; i < 2_100; i++) writeFileSync(join(root, `brain/bulk/b${i}.md`), String(i));
    commit(root, 'bulk');
    expect((await pass('brain')).reuse).toBe('read');
    expect((await pass('brain/bulk/b1*')).reuse).toBe('read');
    expect((await pass('brain/bulk/b1*')).reuse).toBe('read');
  }, 120_000);

  test('#7358: a kept listing holds only its commit and tree; the options and loop yield of every earlier read are collectable', async () => {
    const refs: Array<WeakRef<object>> = [];
    const read = async () => {
      const shared = loopYield();
      refs.push(new WeakRef(shared));
      const got = await readTreeLevelReusing(root, git(root, 'rev-parse', 'HEAD'), 'brain', { key: KEY, allowed: true, shared });
      got.keep();
      return got.reuse;
    };
    expect(await read()).toBe('read');
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(root, 'brain/notes/n12.md'), `collectable probe ${i}`);
      commit(root, `collectable probe ${i}`);
      expect(await read()).toBe('patched');
    }
    // The newest may still be reachable from its own stream's timers until they fire; every earlier one must be gone.
    expect(await collected(refs.slice(0, -1))).toEqual([true, true, true]);
  });

  test('#7358 (forced probe): a pass held only by the checking frame\'s stack is collected; one a timer holds is not', async () => {
    const pass = (refs: Array<WeakRef<object>>) => { const options = { onProgress: () => {} }; refs.push(new WeakRef(options.onProgress)); return options; };
    const onStack: Array<WeakRef<object>> = [];
    // Never read again: only this frame's stack slot holds it, as a frame left a pointer into an earlier pass.
    const left = pass(onStack);
    expect(await collected(onStack)).toEqual([true]);
    const heldByTimer: Array<WeakRef<object>> = [];
    const held = pass(heldByTimer);
    const timer = setTimeout(() => held.onProgress(), 60_000);
    timer.unref();
    expect(await collected(heldByTimer)).toEqual([false]);
    clearTimeout(timer);
  });

  test('the oracle: GBRAIN_SYNC_LEVEL_REUSE_VERIFY=1 throws when a kept listing differs from a whole read (forced probe)', async () => {
    await withEnv({ GBRAIN_SYNC_LEVEL_REUSE_VERIFY: '1' }, async () => {
      const first = await pass('brain');
      writeFileSync(join(root, 'brain/notes/n9.md'), 'edited for the oracle');
      commit(root, 'oracle edit');
      expect((await pass('brain')).reuse).toBe('patched');
      // Corrupt the kept listing (what a wrong patch would leave): the next reuse must not hand it out.
      const kept = await readTreeLevelReusing(root, git(root, 'rev-parse', 'HEAD'), 'brain', { key: KEY, allowed: true });
      kept.tree.delete('brain/notes/n10.md');
      kept.keep();
      writeFileSync(join(root, 'brain/notes/n11.md'), 'edited again');
      commit(root, 'oracle edit 2');
      const error = await readTreeLevelReusing(root, git(root, 'rev-parse', 'HEAD'), 'brain', { key: KEY, allowed: true }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(LevelReuseMismatch);
      expect((error as LevelReuseMismatch).code).toBe('level_reuse_mismatch');
      // The corrupt listing is gone: the next read is whole.
      expect((await pass('brain')).reuse).toBe('read');
      expect(first.reuse).toBe('read');
    });
  }, 60_000);
});

for (const backend of testBackends()) describe(`[${backend}] GBRA-133: a managed pass reuses T across passes`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const name of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${name}.md`), note(name, `The body of ${name}.`));
    commit(root, 'notes');
  };
  afterEach(() => { installFaultHook(undefined); __resetTreeReuseForTests(); });
  const live = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string; body: string }>(
    "SELECT slug, compiled_truth AS body FROM pages WHERE source_id='default' AND deleted_at IS NULL AND slug LIKE 'notes/%' ORDER BY slug")).map(row => [row.slug, row.body.trim()]);

  test('the next commit patches the last pass\'s listing; sync.level_reuse false reads it whole; pages match either way', () => withEnv({ GBRAIN_SYNC_LEVEL_REUSE_VERIFY: '1' }, () => managedBrain(async ({ engine, root }) => {
    const reuse: string[] = [];
    installFaultHook((point, detail) => {
      if (point !== 'sync:level_read' || detail.round !== 1) return;
      const shadow = detail.level?.shadow as { treeReuse?: string } | undefined;
      reuse.push(shadow?.treeReuse ?? 'none');
    });
    await performManagedSync(engine, OPTS);
    writeFileSync(join(root, 'notes/a.md'), note('a', 'The edited body of a.'));
    unlinkSync(join(root, 'notes/b.md'));
    writeFileSync(join(root, 'notes/d.md'), note('d', 'The body of d.'));
    commit(root, 'edit a, drop b, add d');
    await performManagedSync(engine, OPTS);
    expect(reuse.at(-1)).toBe('patched');
    expect(await live(engine)).toEqual([['notes/a', 'The edited body of a.'], ['notes/c', 'The body of c.'], ['notes/d', 'The body of d.']]);

    await engine.setConfig('sync.level_reuse', 'false');
    writeFileSync(join(root, 'notes/c.md'), note('c', 'The edited body of c.'));
    commit(root, 'edit c');
    await performManagedSync(engine, OPTS);
    expect(reuse.at(-1)).toBe('read');
    expect(await live(engine)).toEqual([['notes/a', 'The edited body of a.'], ['notes/c', 'The edited body of c.'], ['notes/d', 'The body of d.']]);

    await engine.setConfig('sync.level_reuse', 'true');
    writeFileSync(join(root, 'notes/e.md'), note('e', 'The body of e.'));
    commit(root, 'add e');
    await performManagedSync(engine, OPTS);
    expect(reuse.at(-1)).toBe('patched');
    expect((await live(engine)).map(([slug]) => slug)).toEqual(['notes/a', 'notes/c', 'notes/d', 'notes/e']);
  }, { databaseUrl, setup })), 300_000);

  test('#7358: the kept listing holds none of its pass; every earlier pass of the process is collectable', () => managedBrain(async ({ engine, root }) => {
    const refs: Array<WeakRef<object>> = [];
    const sync = async () => {
      const onProgress = () => {};
      refs.push(new WeakRef(onProgress));
      return (await performManagedSync(engine, { ...OPTS, onProgress })).status;
    };
    expect(await sync()).toBe('first_sync');
    for (const name of ['a', 'b', 'c']) {
      writeFileSync(join(root, `notes/${name}.md`), note(name, `The edited body of ${name}.`));
      commit(root, `edit ${name}`);
      expect(await sync()).toBe('synced');
    }
    // The newest may still be reachable from its own stream's timers until they fire; every earlier one must be gone.
    expect(await collected(refs.slice(0, -1))).toEqual([true, true, true]);
  }, { databaseUrl, setup }), 300_000);
});
