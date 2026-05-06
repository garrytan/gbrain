import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
}, 30_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
});

describe('sqlQueryForEngine', () => {
  test('runs parameterized tagged-template SQL against PGLite', async () => {
    const sql = sqlQueryForEngine(engine);
    const rows = await sql`SELECT ${'pglite'}::text AS engine, ${3}::int AS count`;
    expect(rows).toEqual([{ engine: 'pglite', count: 3 }]);
  });

  test('rejects postgres.js-style fragment/object values explicitly', async () => {
    const sql = sqlQueryForEngine(engine);
    await expect(
      sql`SELECT ${(Promise.resolve([]) as any)}::text AS bad`
    ).rejects.toThrow(/only supports scalar bind values/);
    await expect(
      sql`SELECT ${(['read', 'write'] as any)}::text[] AS bad`
    ).rejects.toThrow(/only supports scalar bind values/);
  });
});
