/**
 * The hot-memory cache watermark's SQL (`readFactCacheWatermark`, engine-sql/trust-withdrawals.ts), on both SQL engines.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: PostgresEngine and PGLiteEngine send the same statement text, byte for byte, with the same bound
 *    values, and that text matches the golden `sql-text/fact-cache-watermark.json`.
 *  - Regression: one engine drifting to its own copy of the statement, or a change to the text (a dropped table in
 *    the access digest, a lost source filter) that no parity case observes on an empty access table.
 *  - Why existing coverage misses it: the parity case (test/engine-parity/trust-withdrawals.test.ts) compares
 *    results, not text, and the W1 SQL-text goldens cover the W1 domains only.
 *  - Seams: the recording fake `sql` for PostgresEngine (test/helpers/fake-postgres-sql.ts, wire-exact text), and a
 *    wrap of the PGLite handle's `query` on a real in-memory PGLite. No database for Postgres.
 *  - Regenerate: GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/engine-sql-fact-cache-watermark.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { defineNormalizer, expectGolden } from './helpers/golden.ts';
import { makeEngineWithFake } from './helpers/postgres-engine-sql-cases.ts';

interface Sent { text: string; params: unknown[] }

const NORMALIZER = defineNormalizer<Sent>('fact-cache-watermark-sql-v1', (s) => ({ text: s.text, params: s.params }));
const ROW = { withdrawals: 2, latest_withdrawn_at: '2026-03-09T10:00:00.000000Z', access_rules: 'a:b' };

describe('readFactCacheWatermark SQL text', () => {
  let pglite: PGLiteEngine;
  beforeAll(async () => {
    pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();
  }, 120_000);
  afterAll(async () => { await pglite?.disconnect(); });

  async function postgresSent(): Promise<Sent> {
    const { engine, fake } = makeEngineWithFake([[/FROM fact_withdrawals WHERE source_id/, [ROW]]]);
    const row = await engine.readFactCacheWatermark('src-a');
    expect(row).toEqual(ROW);
    const statements = fake.trace.filter((t: { kind: string }) => t.kind === 'query') as Array<{ text: string; params: unknown[] }>;
    expect(statements.length).toBe(1);
    return { text: statements[0]!.text, params: statements[0]!.params };
  }

  async function pgliteSent(): Promise<Sent> {
    const db = (pglite as unknown as { _db: { query: (sql: string, params?: unknown[]) => Promise<unknown> } })._db;
    const original = db.query;
    const sent: Sent[] = [];
    db.query = function (this: unknown, sql: string, params?: unknown[]) {
      sent.push({ text: sql, params: [...(params ?? [])] });
      return original.call(db, sql, params);
    } as typeof db.query;
    try {
      const row = await pglite.readFactCacheWatermark('src-a');
      expect(row.withdrawals).toBe(0);
    } finally {
      db.query = original;
    }
    const watermark = sent.filter(s => s.text.includes('FROM fact_withdrawals WHERE source_id'));
    expect(watermark.length).toBe(1);
    return watermark[0]!;
  }

  test('PostgresEngine and PGLiteEngine send one identical statement, pinned by the golden', async () => {
    const pg = await postgresSent();
    const lite = await pgliteSent();
    expect(lite.text).toBe(pg.text);
    expect(lite.params).toEqual(pg.params);
    expect(pg.params).toEqual(['src-a']);
    expectGolden('sql-text/fact-cache-watermark', pg, NORMALIZER);
  });
});
