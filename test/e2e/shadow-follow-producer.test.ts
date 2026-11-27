/**
 * Postgres twin of test/shadow-follow-producer.test.ts: the follow producer (src/shadow/follow.ts) over a real
 * Postgres primary, where the pre-reads run as typed parameterised queries and a transaction is a real BEGIN/COMMIT.
 *
 * Protects: a committed transaction publishes one batch after COMMIT; a rolled-back one and a rolled-back savepoint
 * publish nothing for the undone work; a delete carries the keys of the rows it removed; raw SQL write targets reach
 * the batch; a failed write publishes relation-level.
 * Regression it catches: a pre-read query Postgres rejects (the item silently degrades to relation-level), and a
 * batch published before the commit lands.
 * Needs DATABASE_URL; skips without it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { Invalidation } from '../../src/shadow/invalidations.ts';
import { hasDatabase } from './helpers.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { publicationConcurrency, tryAcquirePublicationCapacity } from '../../src/core/persistence/pool-capacity.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { busyPreReadIsRelationLevel, driverFragmentStaysAFragment, driverWriteSurvivesFailedPreRead, writesKeepOrderBesideNestedTransaction, nestedFollowedWritesStayInTheirSavepoint, finishedNestedIsNotBusy, heldCallKeepsItsContext, heldCallRollsBackWithItsTransaction, outerWriteSurvivesNestedRollback, sampledSiblingDoesNotWaitForItself, unawaitedFollowedWriteCommits, syncThrowRollsBackHeldWrite, failedPreReadKeepsSiblingWrites, failedPreReadKeepsTransaction, followHarness, PAGE, restoreFollowProbes } from '../helpers/follow-producer.ts';

const d = hasDatabase() ? describe : describe.skip;

let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let engine: PostgresEngine;
let close: () => Promise<void>;

const rows = (items: Invalidation[], relation: string) => items.filter((i) => i.kind === 'rows' && i.relation === relation) as Extract<Invalidation, { kind: 'rows' }>[];

d('shadow follow producer on Postgres', () => {
  beforeAll(async () => { template = await persistencePostgresTemplate(process.env.DATABASE_URL!); }, 120_000);
  afterAll(async () => { await template.dispose(); });
  beforeEach(async () => { ({ engine, close } = await template.clone()); }, 60_000);
  afterEach(async () => { restoreFollowProbes(); await close(); });

  test('a transaction publishes one batch after commit with the rows it touched', async () => {
    const h = followHarness(engine);
    let inside = -1;
    await h.engine.transaction(async (tx) => {
      await tx.putPage('people/alice', PAGE('Alice'));
      await tx.putPage('companies/acme', PAGE('Acme'));
      await tx.addLink('people/alice', 'companies/acme', 'works at', 'works_at');
      await tx.addTag('people/alice', 'team');
      await tx.insertFact({ fact: 'Alice likes tea', entity_slug: 'people/alice', source: 'mcp:remember' }, { source_id: 'default' });
      inside = h.batches.length;
    });
    expect(inside).toBe(0);
    expect(h.batches).toHaveLength(1);
    const items = h.batches[0]!.items;
    const alice = String((await engine.getPage('people/alice'))!.id);
    const acme = String((await engine.getPage('companies/acme'))!.id);
    expect(rows(items, 'links').map((i) => i.selector)).toEqual([{ from_page_id: alice, to_page_id: acme }]);
    expect(rows(items, 'tags').map((i) => i.selector)).toEqual([{ page_id: alice, tag: 'team' }]);
    expect(rows(items, 'facts')).toHaveLength(1);
    expect(items.filter((i) => i.kind !== 'rows')).toEqual([]);
  }, 60_000);

  test('a transaction\'s sql handle keys the publication counter the same with shadow on as off', async () => {
    // pool-capacity.ts ordinaryPool keys an in-process counter on tx.sql, which shadow mode replaces with a view inside a
    // transaction. The view must be one object per transaction and pass options through, or the counter splits.
    const measure = (e: BrainEngine) => e.transaction(async (tx) => {
      const sql = (tx as unknown as { sql: unknown }).sql;
      const held: Array<() => void> = [];
      for (let release = tryAcquirePublicationCapacity(tx); release && held.length < 20; release = tryAcquirePublicationCapacity(tx)) held.push(release);
      let nestedShares = true;
      await tx.transaction(async (inner) => { nestedShares = (inner as unknown as { sql: unknown }).sql === sql; });
      held.forEach((release) => release());
      return { stable: (tx as unknown as { sql: unknown }).sql === sql, concurrency: publicationConcurrency(tx), acquired: held.length, nestedShares };
    });
    const off = await measure(engine);
    const on = await measure(followHarness(engine).engine);
    expect(off.acquired).toBeGreaterThan(0);
    expect(on).toEqual(off);
  }, 60_000);
  test('a failed pre-read does not abort the transaction around it', async () => { await failedPreReadKeepsTransaction(engine); }, 60_000);
  test('a failed pre-read does not undo sibling writes of the transaction that were in flight around it (pipelined)', async () => { await failedPreReadKeepsSiblingWrites(engine); }, 60_000);
  test('a pre-read waits for a running nested transaction, whose own followed write never waits for it: both commit with no stall', async () => { await busyPreReadIsRelationLevel(engine); }, 60_000);
  test('a callback that throws at once rolls back the write a pre-read held (it is sent before the ROLLBACK)', async () => { await syncThrowRollsBackHeldWrite(engine); }, 60_000);
  test('with write sampling on too, a call the sampler held does not wait for itself when it is let go', async () => { await sampledSiblingDoesNotWaitForItself(engine); }, 60_000);
  test('a followed write the callback did not await is sent before the COMMIT and commits', async () => { await unawaitedFollowedWriteCommits(engine); }, 60_000);
  test('followed writes inside a nested transaction stay in its savepoint and never wait on it', async () => { await nestedFollowedWritesStayInTheirSavepoint(engine); }, 60_000);
  test('writes keep their submission order beside a running nested transaction', async () => { await writesKeepOrderBesideNestedTransaction(engine); }, 60_000);
  test('a driver-handle write survives a failed shadow pre-read and reaches the follower', async () => { await driverWriteSurvivesFailedPreRead(engine); }, 60_000);
  test('a driver query fragment is never sent on its own, and a query keeps .values()', async () => { await driverFragmentStaysAFragment(engine); }, 60_000);
  test('a call held behind a slow pre-read is rolled back with its transaction when the callback fails', async () => { await heldCallRollsBackWithItsTransaction(engine); }, 60_000);
  test('a write sent while a nested transaction runs is not undone by that nested rollback', async () => { await outerWriteSurvivesNestedRollback(engine); }, 60_000);
  test("a call held behind a pre-read keeps its own caller's context (a stored legacy slug spelling)", async () => { await heldCallKeepsItsContext(engine); }, 60_000);
  test('a nested transaction already awaited does not make the next followed write busy', async () => { await finishedNestedIsNotBusy(engine); }, 60_000);

  test('a rolled-back transaction and a rolled-back savepoint publish nothing for the undone work', async () => {
    const h = followHarness(engine);
    await expect(h.engine.transaction(async (tx) => {
      await tx.putPage('people/bob', PAGE('Bob'));
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(h.batches).toEqual([]);
    await h.engine.transaction(async (tx) => {
      await tx.putPage('people/cara', PAGE('Cara'));
      await tx.transaction(async (inner) => {
        await inner.putPage('people/dave', PAGE('Dave'));
        throw new Error('inner abort');
      }).catch(() => {});
    });
    expect(h.batches).toHaveLength(1);
    expect(rows(h.batches[0]!.items, 'pages').map((i) => i.selector.slug)).toEqual(['people/cara']);
  }, 60_000);

  test('deletePage and removeTag carry the keys of the rows they removed', async () => {
    await engine.putPage('people/erin', PAGE('Erin'));
    await engine.addTag('people/erin', 'vip');
    const erin = String((await engine.getPage('people/erin'))!.id);
    const [tag] = await engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM tags WHERE page_id = $1::bigint', [erin]);
    const h = followHarness(engine);
    await h.engine.removeTag('people/erin', 'vip');
    await h.engine.deletePage('people/erin');
    expect(rows(h.batches[0]!.items, 'tags')[0]!.before_keys).toEqual([[tag!.id]]);
    expect(rows(h.batches[1]!.items, 'pages')[0]!.before_keys).toEqual([[erin]]);
  }, 60_000);

  test('raw SQL write targets reach the batch and a failed write publishes relation-level', async () => {
    const h = followHarness(engine);
    await h.engine.executeRaw(`INSERT INTO config (key, value) VALUES ('follow_probe', '1') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    expect(h.batches[0]!.items).toEqual([{ kind: 'relation', relation: 'config', reason: 'raw_sql' }]);
    await expect(h.engine.putPage('', PAGE('Nobody'))).rejects.toThrow(/Invalid slug/);
    expect(h.batches[1]!.items).toEqual([{ kind: 'relation', relation: 'pages', reason: 'write_rejected' }, { kind: 'relation', relation: 'config', reason: 'write_rejected' }]);
  }, 60_000);
});
