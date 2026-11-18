/**
 * applyLinkTemporalRows on Postgres keeps its statements in order when the
 * caller holds no transaction.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: one call replaces the origin's derived transitions: the DELETE
 *    of the old rows runs before the INSERT of the new ones, so after every
 *    call the origin has exactly the rows it sent.
 *  - Regression: the statements are pipelined, which keeps their order only on
 *    one connection. Called on the pool engine, they went to several
 *    connections, the DELETE sometimes ran last, and the origin lost every
 *    dated transition (an entity card then shows no "since" or "ended").
 *  - Why existing coverage misses it: the production caller (derived-links)
 *    runs inside a transaction, PGLite runs the statements one at a time, and
 *    test/engine-parity/link-temporal.test.ts hit the race only sometimes.
 *  - Seam: a second client holds a row lock on the origin's current
 *    transitions for a moment, so a DELETE sent on its own connection waits
 *    while the INSERT on another finds the old rows and does nothing. On one
 *    connection the INSERT waits behind the DELETE, as it must.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const databaseUrl = process.env.DATABASE_URL;
const ALICE = 'people/alice-example';
const ACME = 'companies/acme-example';

if (!databaseUrl) {
  test.skip('link temporal apply order skipped (DATABASE_URL unset)', () => {});
} else {
  let engine: PostgresEngine;
  let close: () => Promise<void>;
  let url: string;
  beforeAll(async () => {
    ({ engine, close, databaseUrl: url } = await isolatedPersistencePostgres(databaseUrl, 'instance', 8));
    await engine.putPage(ACME, { type: 'company', title: 'Acme', compiled_truth: 'Acme.' });
    await engine.putPage(ALICE, { type: 'person', title: 'Alice', compiled_truth: 'Alice.' });
  }, 120_000);
  afterAll(async () => { await close(); });

  test('a call outside a transaction replaces the transitions even when the old rows are briefly locked', async () => {
    const [alice] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = $1`, [ALICE]);
    const pageId = Number(alice!.id);
    const transitions = [
      { from_slug: ALICE, to_slug: ACME, link_type: 'works_at', kind: 'start' as const, occurred_on: '2019-02-01', date_precision: 'day', producer: 'timeline', line_hash: 'h1' },
      { from_slug: ALICE, to_slug: ACME, link_type: 'works_at', kind: 'end' as const, occurred_on: '2025-03-01', date_precision: 'day', producer: 'timeline', line_hash: 'h2' },
    ];
    const input = { pageId, sourceId: 'default', tenseRows: [], transitions, explicitTargets: [] };
    const count = async () => Number((await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM link_transitions WHERE origin_page_id = $1`, [pageId]))[0]!.n);
    await engine.applyLinkTemporalRows(input);
    expect(await count()).toBe(2);

    const locker = postgres(url, { max: 1, prepare: false });
    try {
      let locked!: () => void;
      const lockHeld = new Promise<void>(resolve => { locked = resolve; });
      const hold = locker.begin(async (sql) => {
        await sql`SELECT id FROM link_transitions WHERE origin_page_id = ${pageId} FOR UPDATE`;
        locked();
        await sql`SELECT pg_sleep(0.5)`;
      });
      await lockHeld;
      await engine.applyLinkTemporalRows(input);
      await hold;
    } finally {
      await locker.end();
    }
    expect(await count()).toBe(2);
  }, 120_000);
}
