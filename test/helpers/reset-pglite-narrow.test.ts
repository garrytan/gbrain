/**
 * resetPgliteStateNarrow: truncates ONLY the named tables, validates names,
 * re-seeds the default source only when 'sources' is listed.
 *
 * Uses the canonical PGLite block from docs/TESTING.md (one engine per file
 * in beforeAll, resetPgliteState in beforeEach, disconnect in afterAll) —
 * import depths adjusted for this file living in test/helpers/ rather than
 * test/. Scratch tables (narrow_a / narrow_b) keep the assertions independent
 * of the gbrain schema; the full reset wipes their rows between tests.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState, resetPgliteStateNarrow } from './reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `CREATE TABLE IF NOT EXISTS narrow_a (id serial PRIMARY KEY, v text)`,
  );
  await engine.executeRaw(
    `CREATE TABLE IF NOT EXISTS narrow_b (id serial PRIMARY KEY, v text)`,
  );
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function count(table: 'narrow_a' | 'narrow_b' | 'sources'): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return rows[0].n;
}

describe('resetPgliteStateNarrow', () => {
  test('truncates only the named tables; unlisted tables survive', async () => {
    await engine.executeRaw(`INSERT INTO narrow_a (v) VALUES ('a1')`);
    await engine.executeRaw(`INSERT INTO narrow_b (v) VALUES ('b1')`);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('extra', 'extra', '{}'::jsonb)`,
    );

    await resetPgliteStateNarrow(engine, ['narrow_a']);

    expect(await count('narrow_a')).toBe(0);
    expect(await count('narrow_b')).toBe(1); // unlisted: survives
    expect(await count('sources')).toBe(2); // default + extra: untouched
  });

  test('RESTART IDENTITY: serial restarts for listed tables only', async () => {
    await engine.executeRaw(`INSERT INTO narrow_a (v) VALUES ('a1'), ('a2')`);
    await resetPgliteStateNarrow(engine, ['narrow_a']);
    await engine.executeRaw(`INSERT INTO narrow_a (v) VALUES ('fresh')`);
    const rows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM narrow_a`,
    );
    expect(rows.map(r => r.id)).toEqual([1]);
  });

  test("re-seeds the default source row when 'sources' is listed", async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('extra', 'extra', '{}'::jsonb)`,
    );
    await resetPgliteStateNarrow(engine, ['sources']);
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources ORDER BY id`,
    );
    expect(rows.map(r => r.id)).toEqual(['default']);
  });

  test("does not touch sources when 'sources' is not listed", async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('extra', 'extra', '{}'::jsonb)`,
    );
    await resetPgliteStateNarrow(engine, ['narrow_a']);
    expect(await count('sources')).toBe(2);
  });

  test('rejects invalid table names before any SQL runs', async () => {
    await engine.executeRaw(`INSERT INTO narrow_a (v) VALUES ('survivor')`);
    const bad = [
      'Pages', // uppercase
      'pages"; DROP TABLE pages;--', // injection shape
      'narrow-a', // hyphen
      '', // empty
      '1pages', // leading digit
    ];
    for (const name of bad) {
      await expect(resetPgliteStateNarrow(engine, ['narrow_a', name])).rejects.toThrow(
        'invalid table name',
      );
    }
    // A rejected list truncates nothing, including its valid entries.
    expect(await count('narrow_a')).toBe(1);
  });

  test('rejects preserved infrastructure tables', async () => {
    await expect(resetPgliteStateNarrow(engine, ['schema_version'])).rejects.toThrow(
      'preserved infrastructure table',
    );
    await expect(
      resetPgliteStateNarrow(engine, ['page_generation_clock']),
    ).rejects.toThrow('preserved infrastructure table');
  });

  test('rejects an empty table list (no default)', async () => {
    await expect(resetPgliteStateNarrow(engine, [])).rejects.toThrow('non-empty');
  });
});
