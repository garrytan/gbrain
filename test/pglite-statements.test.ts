import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { PgliteStatementCache } from '../src/core/pglite-statements.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

describe('PGLite named statement cache', () => {
  let raw: PGlite;
  let db: PGlite;
  let cache: PgliteStatementCache;

  beforeAll(async () => {
    raw = new PGlite();
    cache = new PgliteStatementCache(raw, 2);
    db = cache.attach(raw, false);
    await raw.exec(`CREATE TABLE items (id int PRIMARY KEY, label text, meta jsonb, tags text[], seen timestamptz, ok boolean, ref uuid)`);
  }, 30_000);

  afterAll(async () => { await raw?.close(); });

  test('prepared executions return exactly what PGlite query returns', async () => {
    const insert = 'INSERT INTO items VALUES ($1,$2,$3,$4,$5,$6,$7)';
    for (let id = 1; id <= 4; id++) {
      const params = [id, id === 2 ? null : `item-${id}`, { id, nested: [id] }, ['a', `b${id}`],
        new Date(Date.UTC(2026, 0, id)), id % 2 === 0, `00000000-0000-0000-0000-00000000000${id}`];
      const cached = await db.query(insert, params);
      expect(cached.affectedRows).toBe(1);
    }
    const select = 'SELECT * FROM items WHERE id >= $1 ORDER BY id';
    const expected = await raw.query(select, [1]);
    for (let run = 0; run < 3; run++) {
      const actual = await db.query(select, [1]);
      expect(actual.rows).toEqual(expected.rows);
      expect(actual.fields).toEqual(expected.fields);
      expect(actual.affectedRows).toBe(expected.affectedRows);
    }
    for (let run = 0; run < 3; run++) {
      expect((await db.query('UPDATE items SET ok = NOT ok WHERE id > $1', [2])).affectedRows).toBe(2);
      expect(await db.query('SELECT id FROM items WHERE id = $1', [99])).toEqual({ rows: [], fields: [{ name: 'id', dataTypeID: 23 }], affectedRows: 0 });
    }
  });

  test('eviction and shape-changing DDL keep results current', async () => {
    const select = 'SELECT * FROM items WHERE id = $1';
    for (let run = 0; run < 3; run++) await db.query(select, [1]);
    await db.query('ALTER TABLE items ADD COLUMN extra int DEFAULT 7');
    expect((await db.query<{ extra: number }>(select, [1])).rows[0].extra).toBe(7);
    for (let run = 0; run < 3; run++) await db.query(select, [1]);
    // DDL the prefix check cannot see: PostgreSQL rejects the cached shape and the query is re-prepared.
    await raw.exec(`CREATE FUNCTION widen() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ALTER TABLE items ADD COLUMN wider int DEFAULT 9; END $$`);
    await raw.query('SELECT widen()');
    expect((await db.query<{ wider: number }>(select, [1])).rows[0].wider).toBe(9);
    for (const id of [1, 2, 3, 4, 1, 2]) await db.query(`SELECT label FROM items WHERE id = $1 AND ${id} > 0`, [id]);
    expect((await db.query<{ label: string }>(select, [3])).rows[0].label).toBe('item-3');
  });

  test('errors keep PGlite fields, and transactions roll back and continue', async () => {
    const insert = 'INSERT INTO items(id,label) VALUES ($1,$2)';
    await db.query(insert, [10, 'ten']);
    await db.query(insert, [11, 'eleven']);
    const error = await db.query(insert, [10, 'again']).catch(caught => caught);
    expect(error.code).toBe('23505');
    expect(error.query).toBe(insert);
    await expect(raw.transaction(async handle => {
      const tx = cache.attach(handle, true);
      for (let run = 0; run < 3; run++) await tx.query('UPDATE items SET label=$2 WHERE id=$1', [11, `tx-${run}`]);
      await tx.query(insert, [10, 'duplicate']);
    })).rejects.toMatchObject({ code: '23505' });
    expect((await db.query('SELECT label FROM items WHERE id=$1', [11])).rows).toEqual([{ label: 'eleven' }]);
    await raw.transaction(async handle => {
      const tx = cache.attach(handle, true);
      for (let run = 0; run < 3; run++) await tx.query('UPDATE items SET label=$2 WHERE id=$1', [11, `committed-${run}`]);
    });
    expect((await db.query('SELECT label FROM items WHERE id=$1', [11])).rows).toEqual([{ label: 'committed-2' }]);
  });
});

describe('PGLite engine statement cache lifecycle', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); }, 60_000);
  afterAll(async () => { await engine?.disconnect(); });

  test('a disconnected engine releases its PGLite instance with the statement cache', async () => {
    await engine.executeRaw('SELECT 1');
    await engine.executeRaw('SELECT 1');
    expect((engine as unknown as { _statements: unknown })._statements).not.toBeNull();
    await engine.disconnect();
    expect((engine as unknown as { _statements: unknown })._statements).toBeNull();
  });
});
