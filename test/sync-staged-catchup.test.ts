/**
 * #6349 (P2.14): a managed source whose delta since its last synced commit exceeds the cursor bound used to refuse every
 * sync forever. Discovery now stages it: the furthest first-parent commit whose delta fits, found by a forward gallop that
 * verifies every candidate (a net delta is not monotone along history, so binary search has no valid predicate); a drain
 * then takes stage after stage to HEAD. One commit above the bound still refuses, naming that commit. The bound is
 * lowered through the test seam. Synthetic content only.
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
import { _setCursorBoundForTest, stagedSyncTarget } from '../src/core/persistence/sync-discovery.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-staged-'));
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

describe('stagedSyncTarget (forward gallop, every candidate verified)', () => {
  test('non-monotone history (add 2, add 2, delete 2, add 3) with bound 3: the walk lands past where binary search stops', () => {
    const r = repo();
    r.write('base'); const base = r.commit('base');
    r.write('a'); r.write('b'); const c1 = r.commit('add 2');
    r.write('c'); r.write('d'); const c2 = r.commit('add 2 more');
    r.remove('c'); r.remove('d'); const c3 = r.commit('delete 2');
    r.write('e'); r.write('f'); r.write('g'); const c4 = r.commit('add 3');
    const size = (commit: string) => r.git('diff', '--name-only', `${base}..${commit}`).split('\n').filter(Boolean).length;
    expect([c1, c2, c3, c4].map(size)).toEqual([2, 4, 2, 5]);
    const checked: string[] = [];
    const staged = stagedSyncTarget(r.root, base, c4, commit => { checked.push(commit); return size(commit) <= 3; });
    expect(staged).toEqual({ commit: c3, first: c1 });
    // A binary search over the same predicate checks c2 first, fails, and settles on c1.
    expect(checked).not.toContain(c2);
  });

  test('the first commit alone above the bound is reported oversized', () => {
    const r = repo();
    r.write('base'); const base = r.commit('base');
    for (const n of ['a', 'b', 'c', 'd']) r.write(n);
    const big = r.commit('add 4');
    r.write('e'); const head = r.commit('add 1');
    expect(stagedSyncTarget(r.root, base, head, commit => r.git('diff', '--name-only', `${base}..${commit}`).split('\n').filter(Boolean).length <= 3)).toEqual({ oversized: big });
  });
});

describe('staged managed catch-up on a real brain', () => {
  const engines: BrainEngine[] = [];
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (testBackends().includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
    if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } await closePostgres?.(); });

  async function managedSource(engine: BrainEngine) {
    const r = repo();
    const id = `stg-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    r.write('base'); r.commit('base');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, r.root]);
    await claimWorktree(engine, id, r.root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const opts = { sourceId: id, noPull: true, noEmbed: true, noExtract: true };
    expect((await drainManagedSync(engine, opts, false)).drain).toMatchObject({ outcome: 'synced' });
    const pages = async () => (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [id])).map(p => p.slug);
    const lastCommit = async () => (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [id]))[0]!.last_commit;
    return { r, id, opts, pages, lastCommit };
  }

  test('a backlog past the bound drains stage by stage to HEAD (renames, repeated paths, non-monotone history); the page set equals an unbounded sync', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    for (const engine of engines) {
      const { r, opts, pages, lastCommit, id } = await managedSource(engine);
      r.write('a'); r.write('b'); r.commit('add 2');
      r.write('c'); r.write('d'); r.commit('add 2 more');
      r.remove('c'); r.remove('d'); r.commit('delete 2');
      r.write('a', 'Edited once.'); r.move('b', 'b2'); r.commit('edit a, rename b');
      r.write('a', 'Edited twice.'); r.write('e'); r.commit('edit a again, add e');
      r.write('f'); r.write('g'); const head = r.commit('add 2 at the end');
      _setCursorBoundForTest({ entries: 3, bytes: 1024 ** 2 });
      const result = await performSync(engine, { ...opts, drain: true });
      expect(result.drain?.outcome).toBe('synced');
      expect(result.staged).toBeUndefined();
      expect(await lastCommit()).toBe(head);
      expect(await pages()).toEqual(['notes/a', 'notes/b2', 'notes/base', 'notes/e', 'notes/f', 'notes/g']);
      expect((await engine.getPage('notes/a', { sourceId: id }))?.compiled_truth).toContain('Edited twice.');
    }
  }), 300_000);

  test('a stage stopped mid-way resumes from its stored cursor; then the next stage reaches HEAD', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    for (const engine of engines) {
      const { r, opts, pages, lastCommit } = await managedSource(engine);
      r.write('a'); r.write('b'); const c1 = r.commit('add 2');
      r.write('c'); r.write('d'); const head = r.commit('add 2 more');
      _setCursorBoundForTest({ entries: 3, bytes: 1024 ** 2 });
      const abort = new AbortController();
      let committed = 0;
      const first = await drainManagedSync(engine, { ...opts, signal: abort.signal, onProgress: event => { if (event.phase === 'managed_sync.page_committed' && ++committed === 1) abort.abort(); } }, false);
      expect(first.drain?.outcome).not.toBe('synced');
      expect(first.toCommit).toBe(c1);
      const resumed = await drainManagedSync(engine, opts, false);
      expect(resumed).toMatchObject({ toCommit: c1, staged: { target: c1, head } });
      expect(await lastCommit()).toBe(c1);
      const finished = await drainManagedSync(engine, opts, false);
      expect(finished.staged).toBeUndefined();
      expect(await lastCommit()).toBe(head);
      expect(await pages()).toEqual(['notes/a', 'notes/b', 'notes/base', 'notes/c', 'notes/d']);
    }
  }), 300_000);

  test('the byte bound stages too, and one commit above the bound refuses naming it', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    for (const engine of engines) {
      const { r, opts, lastCommit } = await managedSource(engine);
      const before = await lastCommit();
      for (const n of ['p', 'q', 'r', 's']) r.write(n);
      const big = r.commit('add 4 in one commit');
      _setCursorBoundForTest({ entries: 3, bytes: 1024 ** 2 });
      const refusal = await drainManagedSync(engine, opts, false).then(() => null, (error: { code?: string; message: string; suggestion?: string }) => error);
      expect(refusal).toMatchObject({ code: 'request_too_large' });
      expect(refusal!.message).toContain('One commit exceeds the bounded cursor size.');
      expect(refusal!.suggestion).toContain(`Commit ${big.slice(0, 12)} alone changes 4 syncable entries`);
      expect(await lastCommit()).toBe(before);
      // The byte bound: ample entries, but only one entry's worth of bytes per stage.
      _setCursorBoundForTest({ entries: 100, bytes: 120 });
      r.git('reset', '-q', '--hard', before!);
      r.write('x'); const c1 = r.commit('x'); r.write('y'); r.commit('y');
      const staged = await drainManagedSync(engine, opts, false);
      expect(staged.staged?.target).toBe(c1);
    }
  }), 300_000);
});
