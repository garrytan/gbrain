/**
 * #6349 (fix wave 15 P4.4, [R32]): a first sync, a `--full` tree walk or one commit whose change set alone exceeds the
 * cursor bound used to refuse forever (`request_too_large`, with `--exclude` as the only exit, which is not completion).
 * Discovery now cuts such a target into path slices ordered `(phase, path)`: every import slice, then bounded deletion
 * slices, pinned at one target. Each slice's checkpoint records `{ phase, after, head, target }` in the same transaction
 * instead of advancing `last_commit`, which moves only when the last slice settles. The bound is lowered through the
 * test seam. #6712 PR 4b: only the dry run's discovery still slices (`sliceEntries`); a source's writes run by the live pass,
 * whose bounded runs the real-brain test below covers. Synthetic content only.
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
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { _setCursorBoundForTest } from '../src/core/persistence/sync-discovery.ts';
import { sliceEntries, SYNC_SLICE_OP } from '../src/core/persistence/sync-slices.ts';
import type { SyncEntry } from '../src/core/persistence/sync-discovery.ts';
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

// #6712 PR 4b: a non-company source syncs by the live pass, which batches candidates per round (`PASS_BATCH_MAX`) and keeps
// no path-slice record; the cursor's path slices are left only to the dry run's discovery (`sliceEntries` above). What the
// slices protected, completion of a target too large for one run with `last_commit` moving only at the end, holds for
// passes bounded to a few pages per run.
describe('a pass-bounded first sync and deletion backlog on a real brain', () => {
  const engines: BrainEngine[] = [];
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (testBackends().includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
    if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } await closePostgres?.(); });

  test('runs bounded to two pages complete a first sync and then a deletion backlog; last_commit moves only on the converging run, and no slice record is written', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    for (const engine of engines) {
      const r = repo();
      const id = `slc-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      for (const name of names) r.write(name);
      const first = r.commit('seven at once');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, r.root]);
      await claimWorktree(engine, id, r.root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const opts = { sourceId: id, noPull: true, noEmbed: true, noExtract: true };
      const pages = async () => (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [id])).map(p => p.slug);
      const lastCommit = async () => (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [id]))[0]!.last_commit;
      const sliceRecords = async () => (await engine.executeRaw<{ n: string }>("SELECT COUNT(*)::text AS n FROM op_checkpoints WHERE op=$1 AND fingerprint LIKE $2", [SYNC_SLICE_OP, `${id}:%`]))[0]!.n;
      const drain = async (before: string | null) => {
        const statuses: string[] = [];
        for (let run = 0; run < 12; run++) {
          const result = await performManagedSync(engine, opts, { maxPages: 2, maxMs: 60_000 });
          statuses.push(result.status);
          if (result.status !== 'partial') break;
          expect(await lastCommit()).toBe(before);
        }
        return statuses;
      };
      const firstRuns = await drain(null);
      expect(firstRuns.length).toBeGreaterThan(2);
      expect(firstRuns.at(-1)).toBe('first_sync');
      expect(await lastCommit()).toBe(first);
      expect(await pages()).toEqual(names.map(name => `notes/${name}`));
      for (const name of ['a', 'b', 'c', 'd', 'e']) r.remove(name);
      const second = r.commit('delete five');
      const deleteRuns = await drain(first);
      expect(deleteRuns.length).toBeGreaterThan(1);
      expect(deleteRuns.at(-1)).toBe('synced');
      expect(await lastCommit()).toBe(second);
      expect(await pages()).toEqual(['notes/f', 'notes/g']);
      expect(await sliceRecords()).toBe('0');
    }
  }), 300_000);
});
