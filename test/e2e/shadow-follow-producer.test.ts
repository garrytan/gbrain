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
import { busyPreReadIsRelationLevel, syncThrowRollsBackHeldWrite, failedPreReadKeepsSiblingWrites, failedPreReadKeepsTransaction, followHarness, PAGE, restoreFollowProbes } from '../helpers/follow-producer.ts';

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

  test('a failed pre-read does not abort the transaction around it', async () => { await failedPreReadKeepsTransaction(engine); }, 60_000);
  test('a failed pre-read does not undo sibling writes of the transaction that were in flight around it (pipelined)', async () => { await failedPreReadKeepsSiblingWrites(engine); }, 60_000);
  test('a pre-read never waits for a running nested transaction: the write is relation-level (pre_read_busy) and every write commits', async () => { await busyPreReadIsRelationLevel(engine); }, 60_000);
  test('a callback that throws at once rolls back the write a pre-read held (it is sent before the ROLLBACK)', async () => { await syncThrowRollsBackHeldWrite(engine); }, 60_000);

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
