/**
 * The hot-memory cache identity's SQL, on both SQL engines: the watermark (`readFactCacheWatermark`) and the trust
 * policy generation (`readTrustGeneration`), both in engine-sql/trust-withdrawals.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: PostgresEngine and PGLiteEngine send the same statement text, byte for byte, with the same bound
 *    values, and that text matches the golden `sql-text/fact-cache-watermark.json` or
 *    `sql-text/trust-generation.json`. A generation read that finds no row throws (fail closed).
 *  - Regression: one engine drifting to its own copy of the statement, or a change to the text (a dropped table in
 *    the access digest, a lost source filter) that no parity case observes on an empty access table; a generation
 *    read that answers a default instead of throwing would let hot memory serve a cache no generation keys.
 *  - Why existing coverage misses it: the parity case (test/engine-parity/trust-withdrawals.test.ts) compares
 *    results, not text, and the W1 SQL-text goldens cover the W1 domains only.
 *  - Seams: the recording fake `sql` for PostgresEngine (test/helpers/fake-postgres-sql.ts, wire-exact text), and a
 *    wrap of the PGLite handle's `query` on a real in-memory PGLite. No database for Postgres.
 *  - Regenerate: GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/engine-sql-fact-cache-watermark.test.ts
 *  - Name: the file keeps the watermark's name; the generation joined it as the other half of the same identity.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { defineNormalizer, expectGolden } from './helpers/golden.ts';
import { makeEngineWithFake } from './helpers/postgres-engine-sql-cases.ts';

interface Sent { text: string; params: unknown[] }

const NORMALIZER = defineNormalizer<Sent>('fact-cache-watermark-sql-v1', (s) => ({ text: s.text, params: s.params }));
const GENERATION_NORMALIZER = defineNormalizer<Sent>('trust-generation-sql-v1', (s) => ({ text: s.text, params: s.params }));
const GENERATION = /FROM trust_policy_state WHERE id = 1/;
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

describe('readTrustGeneration SQL text', () => {
  let pglite: PGLiteEngine;
  beforeAll(async () => {
    pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();
  }, 120_000);
  afterAll(async () => { await pglite?.disconnect(); });

  async function postgresSent(): Promise<Sent> {
    const { engine, fake } = makeEngineWithFake([[GENERATION, [{ generation: '7' }]]]);
    expect(await engine.readTrustGeneration()).toBe('7');
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
      expect(await pglite.readTrustGeneration()).toMatch(/^\d+$/);
    } finally {
      db.query = original;
    }
    const reads = sent.filter(s => GENERATION.test(s.text));
    expect(reads.length).toBe(1);
    return reads[0]!;
  }

  test('PostgresEngine and PGLiteEngine send one identical statement, pinned by the golden', async () => {
    const pg = await postgresSent();
    const lite = await pgliteSent();
    expect(lite.text).toBe(pg.text);
    expect(lite.params).toEqual(pg.params);
    expect(pg.params).toEqual([]);
    expectGolden('sql-text/trust-generation', pg, GENERATION_NORMALIZER);
  });

  test('a brain with no generation row throws instead of answering a default', async () => {
    const { engine } = makeEngineWithFake([[GENERATION, []]]);
    await expect(engine.readTrustGeneration()).rejects.toThrow('trust generation unreadable: trust_policy_state has no row');
  });
});
