/**
 * seed-pglite tests — exercises the SQL replay primitive that powers the
 * upgrade-from-v0.18 scenario. Pure PGLite in-memory; no real DB needed.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { seedPglite, seedPgliteFromFile, _internal } from '../src/core/claw-test/seed-pglite.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'seed-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('splitStatements', () => {
  const split = _internal.splitStatements;

  test('splits on semicolons', () => {
    expect(split('CREATE TABLE a(x int); INSERT INTO a VALUES (1);').length).toBe(2);
  });

  test('respects single-quoted strings', () => {
    const sql = "INSERT INTO t VALUES ('a;b'); INSERT INTO t VALUES ('c');";
    const stmts = split(sql);
    expect(stmts.length).toBe(2);
    expect(stmts[0]).toContain("'a;b'");
  });

  test('respects -- line comments', () => {
    const sql = "-- a comment with ; semicolon\nCREATE TABLE x(id int);";
    const stmts = split(sql);
    expect(stmts.length).toBe(1);
  });

  test('handles escaped quotes (doubled apostrophe)', () => {
    const sql = "INSERT INTO t VALUES ('it''s ok');";
    const stmts = split(sql);
    expect(stmts.length).toBe(1);
    expect(stmts[0]).toContain("it''s ok");
  });

  test('returns empty list for empty input', () => {
    expect(split('').length).toBe(0);
    expect(split('   \n').length).toBe(0);
  });
});

describe('seedPglite', () => {
  test('replays a SQL dump into a fresh PGLite database', async () => {
    const dbPath = join(tmp, 'brain.pglite');
    const sql = `
      CREATE TABLE seeded(id INT PRIMARY KEY, name TEXT);
      INSERT INTO seeded(id, name) VALUES (1, 'alice');
      INSERT INTO seeded(id, name) VALUES (2, 'bob');
    `;
    await seedPglite({ dbPath, sql });

    // Re-open the seeded database and verify content survived.
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ engine: 'pglite', database_path: dbPath });
      const rows: any = await (engine as any).db.query('SELECT id, name FROM seeded ORDER BY id');
      expect(rows.rows).toEqual([
        { id: 1, name: 'alice' },
        { id: 2, name: 'bob' },
      ]);
    } finally {
      await engine.disconnect();
    }
  }, 30_000);

  test('throws with a useful message when SQL is invalid', async () => {
    const dbPath = join(tmp, 'bad.pglite');
    const sql = 'INVALID SQL HERE;';
    await expect(seedPglite({ dbPath, sql })).rejects.toThrow(/SQL execution failed/);
  }, 30_000);

  test('creates parent directories when needed', async () => {
    const dbPath = join(tmp, 'nested', 'deeper', 'brain.pglite');
    await seedPglite({ dbPath, sql: 'CREATE TABLE x(y int);' });
    // No throw means the dir was created.
    expect(true).toBe(true);
  }, 30_000);

  test('empty SQL is a no-op (just creates the .pglite)', async () => {
    const dbPath = join(tmp, 'empty.pglite');
    await seedPglite({ dbPath, sql: '' });
    // Verify the database is openable but empty.
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ engine: 'pglite', database_path: dbPath });
      const r: any = await (engine as any).db.query("SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_schema='public'");
      expect(r.rows[0].c).toBe(0);
    } finally {
      await engine.disconnect();
    }
  }, 30_000);
});

describe('seedPgliteFromFile', () => {
  test('reads SQL from disk and replays', async () => {
    const sqlPath = join(tmp, 'dump.sql');
    const dbPath = join(tmp, 'brain.pglite');
    writeFileSync(sqlPath, 'CREATE TABLE z(id int); INSERT INTO z VALUES (42);');
    await seedPgliteFromFile({ dbPath, sqlPath });
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ engine: 'pglite', database_path: dbPath });
      const r: any = await (engine as any).db.query('SELECT id FROM z');
      expect(r.rows).toEqual([{ id: 42 }]);
    } finally {
      await engine.disconnect();
    }
  }, 30_000);

  test('throws on missing SQL file', async () => {
    await expect(seedPgliteFromFile({
      dbPath: join(tmp, 'x.pglite'),
      sqlPath: join(tmp, 'nope.sql'),
    })).rejects.toThrow(/seed SQL not found/);
  });
});
