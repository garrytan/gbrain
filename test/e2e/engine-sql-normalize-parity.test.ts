/**
 * Engine-sql row normalizer per-kind contract (refactor wave 1, A5).
 *
 * The same projection runs through each engine's executor; every declared
 * column kind must come back in one shape on PGLite, direct Postgres and
 * PgBouncer, while undeclared columns stay exactly as the driver decoded them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SqlExecutor } from '../../src/core/engine-sql/executor.ts';
import { compileRowNormalizer } from '../../src/core/engine-sql/normalize.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const backend = process.env.GBRAIN_TEST_BACKEND ?? 'postgres-direct';
const engineSql = (engine: BrainEngine) => (engine as unknown as { engineSql: SqlExecutor }).engineSql;

const PROJECTION = `
  SELECT '{"a": [1, "x"]}'::jsonb AS j,
         '{"a": 1}'::text AS j_text,
         9007199254740991::bigint AS big,
         count(*) AS n,
         '2026-03-08T10:30:45.123Z'::timestamptz AS ts,
         '2026-03-08T10:30:45.123Z'::timestamptz::text AS ts_text,
         '[1,2.5,-3]'::vector AS v,
         ARRAY['a', 'b,c', 'd"e']::text[] AS arr,
         NULL::text[] AS arr_null,
         'kept'::text AS untouched
    FROM (SELECT 1) one`;

const normalize = compileRowNormalizer({
  j: 'jsonb', j_text: 'jsonb', big: 'bigint', n: 'bigint', ts: 'date', ts_text: 'date', v: 'vector', arr: 'text[]', arr_null: 'text[]',
});

function defineContract(name: string, getEngine: () => BrainEngine) {
  test(`${name}: every declared kind normalizes to one shape`, async () => {
    const res = await engineSql(getEngine()).query(PROJECTION);
    const row = normalize(res.rows[0]);
    expect(row.j).toEqual({ a: [1, 'x'] });
    expect(row.j_text).toEqual({ a: 1 });
    expect(row.big).toBe(9007199254740991);
    expect(row.n).toBe(1);
    expect(row.ts).toEqual(new Date('2026-03-08T10:30:45.123Z'));
    expect((row.ts_text as Date).getTime()).toBe(new Date('2026-03-08T10:30:45.123Z').getTime());
    expect(row.v).toBeInstanceOf(Float32Array);
    expect([...(row.v as Float32Array)]).toEqual([1, 2.5, -3]);
    expect(row.arr).toEqual(['a', 'b,c', 'd"e']);
    expect(row.arr_null).toBeNull();
    expect(row.untouched).toBe('kept');
  });
}

describe('engine-sql normalizer on PGLite', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); });
  defineContract('pglite', () => engine);
});

(hasDatabase() ? describe : describe.skip)(`engine-sql normalizer on ${backend}`, () => {
  let engine: BrainEngine;
  beforeAll(async () => { engine = await setupDB(); }, 120_000);
  afterAll(async () => { await teardownDB(); });
  defineContract(backend, () => engine);
});
