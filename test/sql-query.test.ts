import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sqlQueryForEngine, executeRawJsonb } from '../src/core/sql-query.ts';

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

  test('rejects postgres.js-style fragment / object values explicitly', async () => {
    const sql = sqlQueryForEngine(engine);
    await expect(
      sql`SELECT ${(Promise.resolve([]) as any)}::text AS bad`
    ).rejects.toThrow(/only supports scalar bind values/);
    await expect(
      sql`SELECT ${(['read', 'write'] as any)}::text[] AS bad`
    ).rejects.toThrow(/only supports scalar bind values/);
    await expect(
      sql`SELECT ${({ takes_holders: ['world'] } as any)}::jsonb AS bad`
    ).rejects.toThrow(/only supports scalar bind values/);
  });
});

describe('executeRawJsonb (D1 wave / v0.31)', () => {
  test('round-trips an object as JSONB on PGLite (jsonb_typeof = object, ->>  reads value)', async () => {
    // Verifies the cross-engine JSONB write helper produces a real Postgres
    // JSONB object — not a quoted JSON string. Codex's plan-review #9 said
    // "use the actual JSONB contract, not string-grep for backslash-quote",
    // and that's what this asserts: jsonb_typeof + ->>.
    const tableName = `t_jsonb_${Math.random().toString(36).slice(2, 10)}`;
    await engine.executeRaw(`CREATE TEMP TABLE ${tableName} (j jsonb)`);
    try {
      await executeRawJsonb(
        engine,
        `INSERT INTO ${tableName} (j) VALUES ($1::jsonb)`,
        [],
        [{ k: 'v', n: 42 }],
      );
      const rows = await engine.executeRaw<{ kind: string; k: string; n: number }>(
        `SELECT jsonb_typeof(j) AS kind, j->>'k' AS k, (j->>'n')::int AS n FROM ${tableName}`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('object');
      expect(rows[0].k).toBe('v');
      expect(rows[0].n).toBe(42);
    } finally {
      await engine.executeRaw(`DROP TABLE ${tableName}`);
    }
  });

  test('takes-holders shape: object preserved, ->> returns the encoded array, NOT a double-encoded string (v0.12.0 regression guard)', async () => {
    // The v0.12.0 silent-data-loss bug stored `${JSON.stringify(perms)}::jsonb`
    // as a JSON string-of-an-object, so `permissions->>'takes_holders'`
    // would return a string with backslashes instead of the array.
    // Post-fix: real JSONB object, ->> on the array key returns the
    // pretty-printed JSON of the array (because jsonb -> array -> ->> is
    // the array as a text), and jsonb_typeof on the parent stays 'object'.
    const tableName = `t_perms_${Math.random().toString(36).slice(2, 10)}`;
    await engine.executeRaw(
      `CREATE TEMP TABLE ${tableName} (id serial PRIMARY KEY, permissions jsonb)`,
    );
    try {
      const perms = { takes_holders: ['world', 'garry'] };
      await executeRawJsonb(
        engine,
        `INSERT INTO ${tableName} (permissions) VALUES ($1::jsonb)`,
        [],
        [perms],
      );
      const rows = await engine.executeRaw<{
        outer_kind: string;
        holders_kind: string;
        first_holder: string;
        text_form: string;
      }>(
        `SELECT
           jsonb_typeof(permissions) AS outer_kind,
           jsonb_typeof(permissions->'takes_holders') AS holders_kind,
           permissions->'takes_holders'->>0 AS first_holder,
           permissions::text AS text_form
         FROM ${tableName}`,
      );
      expect(rows).toHaveLength(1);
      // The parent JSONB is an object; the takes_holders child is an array.
      // Pre-fix this would be 'string' / 'string' (string-of-object).
      expect(rows[0].outer_kind).toBe('object');
      expect(rows[0].holders_kind).toBe('array');
      expect(rows[0].first_holder).toBe('world');
      // Defense in depth: the text representation must NOT contain
      // backslash-quote sequences, which is what double-encoded JSONB
      // looked like in the v0.12.0 incident (e.g. `"{\"takes_holders\":...}"`).
      expect(rows[0].text_form).not.toContain('\\"');
      // And the text representation should look like a normal JSON object
      // — starts with `{`, not `"{`.
      expect(rows[0].text_form.startsWith('{')).toBe(true);
    } finally {
      await engine.executeRaw(`DROP TABLE ${tableName}`);
    }
  });

  test('null jsonb value stores NULL, not the string "null"', async () => {
    // serve-http.ts sometimes inserts NULL params (e.g. tools/list, scope-
    // rejected paths). The helper must accept null without trying to
    // encode it as the string "null" or rejecting it.
    const tableName = `t_jnull_${Math.random().toString(36).slice(2, 10)}`;
    await engine.executeRaw(`CREATE TEMP TABLE ${tableName} (j jsonb)`);
    try {
      await executeRawJsonb(
        engine,
        `INSERT INTO ${tableName} (j) VALUES ($1::jsonb)`,
        [],
        [null],
      );
      const rows = await engine.executeRaw<{ kind: string | null; is_null: boolean }>(
        `SELECT jsonb_typeof(j) AS kind, (j IS NULL) AS is_null FROM ${tableName}`,
      );
      expect(rows[0].is_null).toBe(true);
      // jsonb_typeof on SQL NULL returns NULL.
      expect(rows[0].kind).toBeNull();
    } finally {
      await engine.executeRaw(`DROP TABLE ${tableName}`);
    }
  });

  test('mixes scalar params and jsonb params in positional order', async () => {
    // Real call shape: scalars first ($1..$N), JSONB params next
    // ($N+1..$N+M). Mirrors the auth.ts `INSERT INTO access_tokens
    // (name, token_hash, permissions) VALUES ($1, $2, $3::jsonb)` pattern.
    const tableName = `t_mix_${Math.random().toString(36).slice(2, 10)}`;
    await engine.executeRaw(
      `CREATE TEMP TABLE ${tableName} (name text, weight int, payload jsonb)`,
    );
    try {
      await executeRawJsonb(
        engine,
        `INSERT INTO ${tableName} (name, weight, payload) VALUES ($1, $2, $3::jsonb)`,
        ['alice', 7],
        [{ tags: ['a', 'b'] }],
      );
      const rows = await engine.executeRaw<{ name: string; weight: number; first_tag: string }>(
        `SELECT name, weight, payload->'tags'->>0 AS first_tag FROM ${tableName}`,
      );
      expect(rows).toEqual([{ name: 'alice', weight: 7, first_tag: 'a' }]);
    } finally {
      await engine.executeRaw(`DROP TABLE ${tableName}`);
    }
  });

  test('rejects non-scalar values in scalarParams (defense in depth)', async () => {
    // The scalar position validator should fire even when a misuse passes
    // an object via scalarParams instead of jsonbParams. Catches the
    // cross-up-the-positions footgun loud at the helper boundary.
    await expect(
      executeRawJsonb(
        engine,
        `SELECT $1::text AS bad`,
        [{ object: 'in scalar position' } as any],
        [],
      ),
    ).rejects.toThrow(/only supports scalar bind values/);
  });
});
