/** #8307: a resident queue census must release its connection before a pages lock lifts. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { BrainEngine } from '../../src/core/engine.ts';
import { rebuildPendingSegmentedProjections } from '../../src/core/page-body/projection.ts';
import { runResidentProjectionInvocation } from '../../src/core/persistence/consumer.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';

let engine: BrainEngine;
let lockPool: ReturnType<typeof postgres>;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!hasDatabase()) return;
  const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 1);
  engine = fixture.engine; close = fixture.close;
  lockPool = postgres(fixture.databaseUrl, { max: 1, prepare: false });
  await engine.putPage('notes/healthy', { type: 'note', title: 'Healthy sibling', compiled_truth: 'Synthetic recovery evidence.' });
  await engine.executeRaw("UPDATE pages SET text_projection_revision=NULL WHERE slug='notes/healthy'");
  await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
    SELECT s.incarnation,p.slug,p.knowledge_revision,'canonical_change' FROM pages p JOIN sources s ON s.id=p.source_id
    WHERE p.slug='notes/healthy' ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision`);
}, 120_000);
afterAll(async () => { await lockPool?.end(); await close?.(); });

describe.skipIf(!hasDatabase())('#8307 resident projection read budget (Postgres)', () => {
  test('a saturated one-slot pool ends the listing wait without releasing the holder, then remains usable', async () => {
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let released = false;
    const holder = engine.transaction(async tx => {
      await tx.executeRaw('SELECT 1');
      locked.resolve();
      await release.promise;
      released = true;
    });
    await locked.promise;
    const safety = setTimeout(() => release.resolve(), 5_000);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(rebuildPendingSegmentedProjections(engine, 100, { deadlineMs: 100 })).rejects.toMatchObject({ name: 'ProjectionListingDeadlineError' });
        expect(released).toBe(false);
      }
    } finally { clearTimeout(safety); release.resolve(); await holder; }
    expect(await engine.executeRaw('SELECT 1 AS usable', [], { timeoutMs: 500 })).toEqual([{ usable: 1 }]);
  }, 30_000);

  test('the resident does not swallow unrelated census errors or continue to inline reads', async () => {
    const original = engine.executeRaw;
    try {
      for (const code of ['42501', 'XX000', 'CONNECTION_CLOSED']) {
        const failure = Object.assign(new Error('Synthetic queue read failure'), { code });
        let censuses = 0;
        engine.executeRaw = async function (this: BrainEngine, sql, params, opts) {
          if (sql.includes('j.source_incarnation::text AS source_incarnation')) { censuses++; throw failure; }
          return original.call(this, sql, params, opts) as never;
        };
        await expect(runResidentProjectionInvocation(engine, '00000000-0000-0000-0000-000000000000', [])).rejects.toBe(failure);
        expect(censuses).toBe(1);
      }
    } finally { engine.executeRaw = original; }
  });

  test('repeated lock timeouts finish while the lock is still held, leave the queue unchanged, and recover', async () => {
    const before = await engine.executeRaw('SELECT * FROM page_projection_jobs ORDER BY slug');
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let released = false;
    const holder = lockPool.begin(async tx => {
      await tx.unsafe('LOCK TABLE pages IN ACCESS EXCLUSIVE MODE');
      locked.resolve();
      await release.promise;
      released = true;
    });
    await locked.promise;
    let settledBeforeRelease = false;
    const safety = setTimeout(() => release.resolve(), 5_000);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(rebuildPendingSegmentedProjections(engine, 100, { deadlineMs: 100 })).rejects.toMatchObject({ name: 'ProjectionListingDeadlineError' });
        // Prove that the sole ordinary connection was returned, while pages is still locked.
        expect(await engine.executeRaw('SELECT 1 AS usable', [], { timeoutMs: 500 })).toEqual([{ usable: 1 }]);
        expect(released).toBe(false);
      }
      // A resident invocation must not start its inline census after the segmented census spends the budget.
      expect(await runResidentProjectionInvocation(engine, '00000000-0000-0000-0000-000000000000', [])).toEqual({ rebuilt: 0, superseded: 0 });
      settledBeforeRelease = !released;
    } finally {
      clearTimeout(safety); release.resolve(); await holder;
    }
    expect(settledBeforeRelease).toBe(true);
    expect(await engine.executeRaw('SELECT * FROM page_projection_jobs ORDER BY slug')).toEqual(before);
    expect(await runResidentProjectionInvocation(engine, '00000000-0000-0000-0000-000000000000', [])).toEqual({ rebuilt: 1, superseded: 0 });
    expect(await engine.executeRaw("SELECT 1 FROM page_projection_jobs WHERE slug='notes/healthy'")).toEqual([]);
    const [page] = await engine.executeRaw<{ sealed: boolean }>("SELECT text_projection_revision=knowledge_revision AS sealed FROM pages WHERE slug='notes/healthy'");
    expect(page.sealed).toBe(true);
  }, 30_000);
});
