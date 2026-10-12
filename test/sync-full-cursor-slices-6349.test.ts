/**
 * #6349 (fix wave 15 P4.4, [R32]): a first sync, a `--full` tree walk or one commit whose change set alone exceeds the
 * cursor bound used to refuse forever (`request_too_large`, with `--exclude` as the only exit, which is not completion).
 * Discovery now cuts such a target into path slices ordered `(phase, path)`: every import slice, then bounded deletion
 * slices, pinned at one target. Each slice's checkpoint records `{ phase, after, head, target }` in the same transaction
 * instead of advancing `last_commit`, which moves only when the last slice settles. The bound is lowered through the
 * test seam. Synthetic content only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { drainManagedSync } from '../src/core/persistence/sync-drain.ts';
import { _setCursorBoundForTest } from '../src/core/persistence/sync-discovery.ts';
import { sliceEntries, SYNC_SLICE_OP } from '../src/core/persistence/sync-slices.ts';
import type { SyncEntry } from '../src/core/persistence/sync-discovery.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-slices-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
afterEach(() => _setCursorBoundForTest());

function repo() {
  const root = join(home, `r-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(root, 'notes'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (name: string, body = `A synthetic observation about ${name}.`) => writeFileSync(join(root, 'notes', `${name}.md`), `---\ntitle: ${name}\n---\n${body}\n`);
  const remove = (name: string) => unlinkSync(join(root, 'notes', `${name}.md`));
  const move = (from: string, to: string) => renameSync(join(root, 'notes', `${from}.md`), join(root, 'notes', `${to}.md`));
  const commit = (message: string) => { git('add', '-A'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message, '--allow-empty'); return git('rev-parse', 'HEAD'); };
  git('init', '-q');
  return { root, git, write, remove, move, commit };
}

const entry = (path: string, action: SyncEntry['action']): SyncEntry => ({ path, sourcePath: path, action, working: false });
const bound = (n: number) => (entries: readonly SyncEntry[]) => entries.length <= n;

describe('sliceEntries (phase, then code-unit path order)', () => {
  const all = [entry('b', 'import'), entry('a', 'import'), entry('d', 'delete'), entry('c', 'import'), entry('e', 'delete'), entry('f', 'delete')];
  test('imports first, then deletions, each cut to the bound; after names the last path committed', () => {
    const first = sliceEntries(all, null, bound(2));
    expect(first).toMatchObject({ phase: 'import', after: 'b', done: false });
    expect(first.entries.map(e => e.path)).toEqual(['a', 'b']);
    const second = sliceEntries(all, first, bound(2));
    expect(second).toMatchObject({ phase: 'import', after: 'c', done: false });
    const third = sliceEntries(all, second, bound(2));
    expect(third).toMatchObject({ phase: 'delete', after: 'e', done: false });
    expect(third.entries.map(e => e.path)).toEqual(['d', 'e']);
    const last = sliceEntries(all, third, bound(2));
    expect(last).toMatchObject({ phase: 'delete', after: 'f', done: true });
  });
  test('a target with no deletions is done with its last import slice; a cursor past every import moves to deletions', () => {
    expect(sliceEntries([entry('a', 'import'), entry('b', 'import')], { phase: 'import', after: 'a' }, bound(5))).toMatchObject({ phase: 'import', after: 'b', done: true });
    expect(sliceEntries(all, { phase: 'import', after: 'c' }, bound(5))).toMatchObject({ phase: 'delete', after: 'f', done: true });
  });
  test('an entry that alone exceeds the bound is still returned, so the caller can refuse it by name', () => {
    expect(sliceEntries([entry('big', 'import')], null, () => false).entries.map(e => e.path)).toEqual(['big']);
  });
});

describe('path-sliced managed sync on a real brain', () => {
  const engines: BrainEngine[] = [];
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (testBackends().includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
    if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } await closePostgres?.(); });

  async function managedSource(engine: BrainEngine, seed: (r: ReturnType<typeof repo>) => void = r => { r.write('base'); r.commit('base'); }) {
    // Each engine iteration starts at the real bound: the previous engine's lowered bound must not slice this fixture's seed sync.
    _setCursorBoundForTest();
    const r = repo();
    const id = `slc-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    seed(r);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, r.root]);
    await claimWorktree(engine, id, r.root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const opts = { sourceId: id, noPull: true, noEmbed: true, noExtract: true };
    const pages = async () => (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [id])).map(p => p.slug);
    const lastCommit = async () => (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [id]))[0]!.last_commit;
    const sliceRecords = async () => (await engine.executeRaw<{ n: string }>("SELECT COUNT(*)::text AS n FROM op_checkpoints WHERE op=$1 AND fingerprint LIKE $2", [SYNC_SLICE_OP, `${id}:%`]))[0]!.n;
    return { r, id, opts, pages, lastCommit, sliceRecords };
  }
  const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };

  test('a first sync above the bound completes over several import slices; last_commit lands only at the end and the slice record is gone', () => withEnv(env, async () => {
    for (const engine of engines) {
      const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      let head = '';
      const { opts, pages, lastCommit, sliceRecords } = await managedSource(engine, r => { for (const n of names) r.write(n); head = r.commit('seven at once'); });
      _setCursorBoundForTest({ entries: 3, bytes: 1024 ** 2 });
      const first = await drainManagedSync(engine, opts, false);
      expect(first.drain?.outcome).toBe('synced');
      expect(first.staged).toMatchObject({ target: head, head, slice: { phase: 'import', after: 'notes/c.md' } });
      expect(await lastCommit()).toBeNull();
      expect(await pages()).toEqual(['notes/a', 'notes/b', 'notes/c']);
      expect(await sliceRecords()).toBe('1');
      const result = await performSync(engine, { ...opts, drain: true });
      expect(result.drain?.outcome).toBe('synced');
      expect(result.staged).toBeUndefined();
      expect(await lastCommit()).toBe(head);
      expect(await pages()).toEqual(names.map(n => `notes/${n}`));
      expect(await sliceRecords()).toBe('0');
    }
  }), 300_000);

  test('deletions above the bound run in bounded slices after every import slice; a drain finishes the target', () => withEnv(env, async () => {
    for (const engine of engines) {
      const { r, opts, pages, lastCommit } = await managedSource(engine, r => { for (const n of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) r.write(n); r.commit('seven'); });
      expect((await drainManagedSync(engine, opts, false)).drain).toMatchObject({ outcome: 'synced' });
      const synced = await lastCommit();
      for (const n of ['b', 'c', 'd', 'e', 'f']) r.remove(n);
      r.write('a', 'Edited after the deletions.'); r.write('h');
      const head = r.commit('delete five, edit one, add one');
      _setCursorBoundForTest({ entries: 2, bytes: 1024 ** 2 });
      const full = { ...opts, full: true };
      const phases: string[] = [];
      for (let slice = 0; slice < 10; slice++) {
        const step = await drainManagedSync(engine, full, false);
        expect(step.drain?.outcome).toBe('synced');
        if (!step.staged) break;
        phases.push(`${step.staged.slice!.phase}:${step.staged.slice!.after}`);
        expect(await lastCommit()).toBe(synced);
      }
      // Imports (a, g, h: the tree walk re-screens every path, two per slice) precede the deletions (five, two per slice).
      expect(phases).toEqual(['import:notes/g.md', 'import:notes/h.md', 'delete:notes/c.md', 'delete:notes/e.md']);
      expect(await lastCommit()).toBe(head);
      expect(await pages()).toEqual(['notes/a', 'notes/g', 'notes/h']);
      expect((await engine.getPage('notes/a', { sourceId: opts.sourceId }))?.compiled_truth).toContain('Edited after the deletions.');
    }
  }), 300_000);

  test('a run stopped inside a slice resumes at the stored slice cursor with the pinned target; no page is skipped or duplicated', () => withEnv(env, async () => {
    for (const engine of engines) {
      const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      let head = '';
      const { r, opts, pages, lastCommit, sliceRecords, id } = await managedSource(engine, r => { for (const n of names) r.write(n); head = r.commit('seven at once'); });
      _setCursorBoundForTest({ entries: 3, bytes: 1024 ** 2 });
      // First slice committed whole; the second slice is aborted after its first page.
      expect((await drainManagedSync(engine, opts, false)).staged?.slice).toEqual({ phase: 'import', after: 'notes/c.md' });
      const abort = new AbortController();
      let committed = 0;
      const stopped = await drainManagedSync(engine, { ...opts, signal: abort.signal, onProgress: event => { if (event.phase === 'managed_sync.page_committed' && ++committed === 1) abort.abort(); } }, false);
      expect(stopped.drain?.outcome).not.toBe('synced');
      expect(await lastCommit()).toBeNull();
      expect(await sliceRecords()).toBe('1');
      // HEAD moves on while the sliced target is pending: the resume stays pinned at the sliced target.
      r.write('z'); const later = r.commit('after the pin');
      const resumed = await performSync(engine, { ...opts, drain: true });
      expect(resumed.drain?.outcome).toBe('synced');
      expect(await pages()).toEqual([...names, 'z'].map(n => `notes/${n}`));
      expect(await lastCommit()).toBe(later);
      expect(await sliceRecords()).toBe('0');
      const rows = await engine.executeRaw<{ slug: string; n: string }>('SELECT slug,COUNT(*)::text AS n FROM pages WHERE source_id=$1 GROUP BY slug HAVING COUNT(*)>1', [id]);
      expect(rows).toEqual([]);
      expect(head).not.toBe(later);
    }
  }), 300_000);

  test('a byte bound slices by path bytes; one commit above the entry bound is pinned and sliced instead of refused; a rename inside it keeps the page', () => withEnv(env, async () => {
    for (const engine of engines) {
      const { r, opts, pages, lastCommit, id } = await managedSource(engine, r => { r.write('base'); r.write('keep'); r.commit('base'); });
      expect((await drainManagedSync(engine, opts, false)).drain).toMatchObject({ outcome: 'synced' });
      const before = await lastCommit();
      const long = Array.from({ length: 6 }, (_, i) => `a-rather-long-synthetic-name-${i}-${'x'.repeat(40)}`);
      for (const n of long) r.write(n);
      r.move('keep', 'kept');
      const big = r.commit('seven paths in one commit, one a rename');
      r.write('tail'); const head = r.commit('one more');
      // Ample entries, but the serialized manifest of three long paths already exceeds the byte bound (one resolved entry is ~150 bytes).
      const one = Buffer.byteLength(JSON.stringify([{ path: `notes/${long[0]}.md`, sourcePath: `notes/${long[0]}.md`, action: 'import', working: false, pageId: null, revision: null }]));
      _setCursorBoundForTest({ entries: 100, bytes: Math.round(one * 2.5) });
      const first = await drainManagedSync(engine, opts, false);
      expect(first.drain?.outcome).toBe('synced');
      expect(first.staged).toMatchObject({ target: big, head, slice: { phase: 'import' } });
      // Path bytes cut the import phase short of its last entry: the slice ends on one of the long paths, not the whole set.
      expect(long.slice(0, 4).map(n => `notes/${n}.md`)).toContain(first.staged!.slice!.after ?? '');
      expect(await lastCommit()).toBe(before);
      const result = await performSync(engine, { ...opts, drain: true });
      expect(result.drain?.outcome).toBe('synced');
      expect(result.staged).toBeUndefined();
      expect(await lastCommit()).toBe(head);
      expect(await pages()).toEqual([...long.map(n => `notes/${n}`), 'notes/base', 'notes/kept', 'notes/tail'].sort());
      const kept = await engine.executeRaw<{ slug: string; deleted_at: string | null }>("SELECT slug,deleted_at FROM pages WHERE source_id=$1 AND slug IN ('notes/keep','notes/kept')", [id]);
      expect(kept).toEqual([{ slug: 'notes/kept', deleted_at: null }]);
    }
  }), 300_000);

  test('a single entry above the byte bound refuses by name with nothing written', () => withEnv(env, async () => {
    for (const engine of engines) {
      const { r, opts, pages, lastCommit } = await managedSource(engine, r => { r.write('base'); r.commit('base'); });
      expect((await drainManagedSync(engine, opts, false)).drain).toMatchObject({ outcome: 'synced' });
      const before = await lastCommit();
      r.write(`a${'y'.repeat(200)}`); r.write('small'); r.commit('one enormous path');
      _setCursorBoundForTest({ entries: 100, bytes: 200 });
      const refusal = await drainManagedSync(engine, opts, false).then(() => null, (error: { code?: string; message: string }) => error);
      expect(refusal).toMatchObject({ code: 'request_too_large' });
      expect(refusal!.message).toContain('One sync entry exceeds the bounded cursor size.');
      expect(await lastCommit()).toBe(before);
      expect(await pages()).toEqual(['notes/base']);
    }
  }), 300_000);
});
