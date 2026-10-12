/**
 * PR #6400 (b): `gbrain projections drain` looped forever on one queue row
 * whose revision no longer matched the live page, because the rebuild counted
 * an untouched "superseded" row as progress and never consumed it.
 *
 * Protects: a stale-revision row under the live incarnation is re-keyed to the
 * live `knowledge_revision` under the page guard and rebuilt in the same pass
 * (a page already projected has its row deleted instead); the repair is a
 * compare-and-set on the exact (source_incarnation, slug, revision) it
 * observed, so a newer row the `pages` trigger queued meanwhile survives;
 * another worker completing the job and a deleted/recreated page are no-ops;
 * a page that keeps raising PageRevisionConflictError is deferred by
 * `updated_at`, reported once in `failed[]`, and the drain terminates.
 * Fails when: the drain runs past the iteration cap on one stale row, the
 * `--limit 5` run counts the same row five times, a stale repair overwrites
 * a newer queued revision, or a hot page is reported more than once.
 * Seams: an engine proxy around `transaction` (the probe's iteration cap and
 * the concurrent-write races). PGLite always; Postgres when DATABASE_URL is
 * set (test/e2e/projections-drain-stale-row-6400-postgres.test.ts).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PageRevisionConflictError } from '../src/core/page-state/types.ts';
import { drainProjections, projectionBacklog, rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let sourceSeq = 0;

beforeAll(async () => {
  if (backends.includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

interface JobRow { slug: string; revision: string; reason: string }
const jobs = (engine: BrainEngine, sourceId: string) => engine.executeRaw<JobRow>(
  `SELECT j.slug, j.revision::text AS revision, j.reason FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation WHERE s.id=$1 ORDER BY j.slug`, [sourceId]);
const liveRevision = async (engine: BrainEngine, sourceId: string, slug: string) =>
  (await engine.executeRaw<{ r: string }>('SELECT knowledge_revision::text AS r FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]!.r;

/** One source with `pages` unprojected pages, each queued at its live revision. */
async function backlog(engine: BrainEngine, pages: number): Promise<string> {
  await engine.executeRaw('DELETE FROM page_projection_jobs');
  const sourceId = `stale-${++sourceSeq}`;
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  for (let i = 0; i < pages; i++) {
    await engine.putPage(`notes/n-${i}`, { type: 'note', title: `Note ${i}`, compiled_truth: `Example note ${i} about a sample topic.` }, { sourceId });
  }
  await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE source_id=$1', [sourceId]);
  await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
    SELECT s.incarnation,p.slug,p.knowledge_revision,'test_backlog' FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.source_id=$1
    ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason,updated_at=now()`, [sourceId]);
  return sourceId;
}

/** An engine whose `transaction` runs `before` first (a concurrent writer) and refuses after `cap` calls (the probe's bound). */
function raced(engine: BrainEngine, opts: { cap?: number; before?: (n: number) => Promise<void> } = {}) {
  const transaction = engine.transaction.bind(engine);
  const state = { transactions: 0 };
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'transaction') return async <T>(run: (tx: BrainEngine) => Promise<T>) => {
      state.transactions++;
      if (opts.cap !== undefined && state.transactions > opts.cap) throw new Error(`drain iteration cap of ${opts.cap} transactions reached`);
      await opts.before?.(state.transactions);
      return transaction(run);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { engine: proxy, state };
}

test('an unlimited drain over one stale-revision row re-keys it to the live revision, rebuilds it once and terminates', async () => {
  for (const engine of engines) {
    const sourceId = await backlog(engine, 1);
    await engine.executeRaw('UPDATE page_projection_jobs SET revision=gen_random_uuid()');
    const bounded = raced(engine, { cap: 50 });
    const result = await drainProjections(bounded.engine);
    expect(result).toMatchObject({ rebuilt: 1, superseded: 0, failed: [], remaining: 0, limited: false });
    expect(bounded.state.transactions).toBeLessThan(50);
    expect(await jobs(engine, sourceId)).toEqual([]);
    const [page] = await engine.executeRaw<{ projected: boolean }>('SELECT text_projection_revision=knowledge_revision AS projected FROM pages WHERE source_id=$1', [sourceId]);
    expect(page!.projected).toBe(true);
  }
}, 120_000);

test('--limit 5 over one stale row tries it once, never five times', async () => {
  for (const engine of engines) {
    await backlog(engine, 1);
    await engine.executeRaw('UPDATE page_projection_jobs SET revision=gen_random_uuid()');
    expect(await drainProjections(engine, { limit: 5 })).toEqual({ rebuilt: 1, superseded: 0, failed: [], remaining: 0, limited: false });
  }
}, 120_000);

test('a stale row on a page that is already projected is deleted, not rebuilt', async () => {
  for (const engine of engines) {
    const sourceId = await backlog(engine, 1);
    await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision WHERE source_id=$1', [sourceId]);
    // The pages trigger clears the queue on a projected page; re-seed the legacy row under a stale revision.
    await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
      SELECT s.incarnation,'notes/n-0',gen_random_uuid(),'legacy' FROM sources s WHERE s.id=$1`, [sourceId]);
    const bounded = raced(engine, { cap: 50 });
    expect(await drainProjections(bounded.engine)).toMatchObject({ rebuilt: 0, superseded: 1, failed: [], remaining: 0 });
    expect(await jobs(engine, sourceId)).toEqual([]);
  }
}, 120_000);

test('a stale repair racing a newer canonical write leaves the trigger-queued row intact (compare-and-set)', async () => {
  for (const engine of engines) {
    const sourceId = await backlog(engine, 1);
    await engine.executeRaw('UPDATE page_projection_jobs SET revision=gen_random_uuid()');
    // Between the listing and the guard, a canonical write bumps knowledge_revision: the trigger replaces the queue row.
    const race = raced(engine, { before: async n => {
      if (n === 1) await engine.putPage('notes/n-0', { type: 'note', title: 'Note 0 (edited)', compiled_truth: 'Edited example note about a sample topic.' }, { sourceId });
    } });
    const result = await rebuildPendingPageProjections(race.engine, 100, { notAfter: (await engine.executeRaw<{ t: string }>('SELECT now()::text AS t'))[0]!.t });
    expect(result).toEqual({ rebuilt: 0, superseded: 1 });
    const queued = await jobs(engine, sourceId);
    expect(queued).toEqual([{ slug: 'notes/n-0', revision: await liveRevision(engine, sourceId, 'notes/n-0'), reason: 'canonical_change' }]);
    // The newer row is live work: the next drain rebuilds it.
    expect(await drainProjections(engine)).toMatchObject({ rebuilt: 1, superseded: 0, remaining: 0 });
  }
}, 120_000);

test('another worker completing the job and a deleted-then-recreated page are no-ops that terminate', async () => {
  for (const engine of engines) {
    const sourceId = await backlog(engine, 2);
    await engine.executeRaw("UPDATE page_projection_jobs SET revision=gen_random_uuid() WHERE slug='notes/n-0'");
    const race = raced(engine, { before: async n => {
      // n-0: another worker rebuilds it (the row is consumed) before this worker's guard.
      if (n === 1) expect(await rebuildPendingPageProjections(engine, 100)).toMatchObject({ rebuilt: 2 });
    } });
    expect(await rebuildPendingPageProjections(race.engine, 100)).toEqual({ rebuilt: 0, superseded: 2 });
    expect(await jobs(engine, sourceId)).toEqual([]);

    const recreated = await backlog(engine, 1);
    const incarnation = (await engine.executeRaw<{ i: string }>('SELECT incarnation::text AS i FROM sources WHERE id=$1', [recreated]))[0]!.i;
    const recreate = raced(engine, { before: async n => {
      if (n !== 1) return;
      await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [recreated]);
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [recreated]);
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [recreated]);
      await engine.putPage('notes/n-0', { type: 'note', title: 'Note 0 again', compiled_truth: 'Recreated example note about a sample topic.' }, { sourceId: recreated });
    } });
    const bounded = raced(recreate.engine, { cap: 50 });
    const result = await drainProjections(bounded.engine);
    expect(result).toMatchObject({ rebuilt: 0, failed: [], limited: false });
    expect((await engine.executeRaw<{ i: string }>('SELECT incarnation::text AS i FROM sources WHERE id=$1', [recreated]))[0]!.i).not.toBe(incarnation);
    // The recreated page's own row (queued after the run start) is the only work left, for the next run.
    expect(await jobs(engine, recreated)).toEqual([{ slug: 'notes/n-0', revision: await liveRevision(engine, recreated, 'notes/n-0'), reason: 'canonical_change' }]);
    expect(await drainProjections(engine)).toMatchObject({ rebuilt: 1, remaining: 0 });
  }
}, 120_000);

test('a page that keeps raising PageRevisionConflictError is deferred, reported once in failed[], and the drain terminates', async () => {
  for (const engine of engines) {
    const sourceId = await backlog(engine, 3);
    const transaction = engine.transaction.bind(engine);
    // Every second read of notes/n-1 is the install's revision check: the page moved under it every time.
    let n1Attempts = 0;
    const conflicting = new Proxy(engine, { get(target, key) {
      if (key === 'transaction') return async <T>(run: (tx: BrainEngine) => Promise<T>) => transaction(async tx => {
        const probe = new Proxy(tx, { get(t, k) {
          if (k === 'readPageSnapshot') return async (slug: string, opts: unknown) => {
            const snapshot = await t.readPageSnapshot(slug, opts as never);
            if (slug === 'notes/n-1' && snapshot && ++n1Attempts % 2 === 0) throw new PageRevisionConflictError(snapshot.revision, 'ffffffff-ffff-4fff-8fff-ffffffffffff');
            return snapshot;
          };
          const value = Reflect.get(t, k, t); return typeof value === 'function' ? value.bind(t) : value;
        } });
        return run(probe as BrainEngine);
      });
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const bounded = raced(conflicting, { cap: 60 });
    const before = (await engine.executeRaw<{ at: string }>("SELECT updated_at::text AS at FROM page_projection_jobs WHERE slug='notes/n-1'"))[0]!.at;
    const result = await drainProjections(bounded.engine);
    expect(result).toMatchObject({ rebuilt: 2, superseded: 0, remaining: 1, limited: false });
    expect(result.failed).toEqual([expect.objectContaining({ source_id: sourceId, slug: 'notes/n-1', reason: expect.stringContaining('revision_conflict') })]);
    const [row] = await engine.executeRaw<{ reason: string; at: string }>("SELECT reason, updated_at::text AS at FROM page_projection_jobs WHERE slug='notes/n-1'");
    expect(row!.reason).toBe('test_backlog');
    expect(row!.at).not.toBe(before);
    expect((await projectionBacklog(engine)).failed).toBe(0);
  }
}, 120_000);
