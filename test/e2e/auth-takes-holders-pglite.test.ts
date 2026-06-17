/**
 * E2E for the v0.31 auth/admin SQL routing wave: full takes-holders
 * round-trip on PGLite, in-memory, no DATABASE_URL gate.
 *
 * Mirrors test/e2e/auth-permissions.test.ts (which exercises the Postgres
 * path) so JSONB shape parity is proven for both engines (Codex finding
 * #1 from the v0.31 plan review).
 *
 * The path under test is the one auth.ts and src/mcp/http-transport.ts
 * actually run after migration:
 *   1. Token create with takes-holders → executeRawJsonb writes a JSONB object
 *   2. validateToken-shaped read → SELECT permissions; jsonb_typeof = 'object'
 *   3. Permissions update → executeRawJsonb again (UPDATE)
 *   4. mcp_request_log.params write → executeRawJsonb (the serve-http flow)
 *   5. Migration v45 normalizer → seed a string-shaped row, run the
 *      UPDATE, assert it's lifted to an object
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { sqlQueryForEngine, executeRawJsonb } from '../../src/core/sql-query.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
});

describe('auth takes-holders + mcp_request_log JSONB on PGLite (v0.31)', () => {
  test('access_tokens.permissions: create + read returns a real JSONB object', async () => {
    const sql = sqlQueryForEngine(engine);
    const name = `tok-create-${Math.random().toString(36).slice(2, 8)}`;
    const hash = `hash-${name}`;
    const permissions = { takes_holders: ['world', 'garry'] };

    // The exact shape auth.ts:create uses post-migration.
    await executeRawJsonb(
      engine,
      `INSERT INTO access_tokens (name, token_hash, permissions)
       VALUES ($1, $2, $3::jsonb)`,
      [name, hash],
      [permissions],
    );

    // The exact shape http-transport.ts:validateToken uses to read it back.
    const rows = await sql`
      SELECT permissions FROM access_tokens
      WHERE token_hash = ${hash}
    `;
    const perms = (rows[0] as { permissions?: { takes_holders?: unknown } }).permissions;
    expect(perms).toBeDefined();
    expect(Array.isArray(perms?.takes_holders)).toBe(true);
    expect(perms?.takes_holders).toEqual(['world', 'garry']);

    // Defense in depth: the JSONB-text representation must be an object,
    // not a JSON-encoded string. Codex finding #9 — assert the contract.
    const typed = await engine.executeRaw<{ kind: string; first_holder: string }>(
      `SELECT jsonb_typeof(permissions) AS kind,
              permissions->'takes_holders'->>0 AS first_holder
       FROM access_tokens WHERE token_hash = $1`,
      [hash],
    );
    expect(typed[0].kind).toBe('object');
    expect(typed[0].first_holder).toBe('world');
  });

  test('access_tokens.permissions: UPDATE preserves JSONB object shape', async () => {
    const sql = sqlQueryForEngine(engine);
    const name = `tok-update-${Math.random().toString(36).slice(2, 8)}`;
    const hash = `hash-${name}`;

    // Seed with default ['world'].
    await executeRawJsonb(
      engine,
      `INSERT INTO access_tokens (name, token_hash, permissions)
       VALUES ($1, $2, $3::jsonb)`,
      [name, hash],
      [{ takes_holders: ['world'] }],
    );

    // The exact shape auth.ts:permissions uses (set-takes-holders).
    const result = await executeRawJsonb(
      engine,
      `UPDATE access_tokens
          SET permissions = $2::jsonb
          WHERE name = $1
          RETURNING id`,
      [name],
      [{ takes_holders: ['world', 'garry', 'brain'] }],
    );
    expect(result).toHaveLength(1);

    const rows = await sql`
      SELECT permissions FROM access_tokens
      WHERE token_hash = ${hash}
    `;
    const perms = (rows[0] as { permissions: { takes_holders: string[] } }).permissions;
    expect(perms.takes_holders).toEqual(['world', 'garry', 'brain']);
  });

  test('mcp_request_log.params: object writes round-trip as JSONB object', async () => {
    // The serve-http.ts INSERT shape after the v0.31 migration.
    const summary = { redacted: true, declared_keys: ['query', 'limit'], approx_bytes: 1024 };
    await executeRawJsonb(
      engine,
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      ['test-token', 'test-agent', 'tools/call:query', 12, 'success'],
      [summary],
    );

    const rows = await engine.executeRaw<{
      kind: string;
      redacted: boolean;
      bytes: number;
      first_key: string;
    }>(
      `SELECT jsonb_typeof(params) AS kind,
              (params->>'redacted')::boolean AS redacted,
              (params->>'approx_bytes')::int AS bytes,
              params->'declared_keys'->>0 AS first_key
       FROM mcp_request_log
       WHERE operation = $1`,
      ['tools/call:query'],
    );
    expect(rows[0].kind).toBe('object');
    expect(rows[0].redacted).toBe(true);
    expect(rows[0].bytes).toBe(1024);
    expect(rows[0].first_key).toBe('query');
  });

  test('mcp_request_log.params: NULL writes (no params) round-trip as SQL NULL', async () => {
    // tools/list and scope-rejected paths write NULL params. Must not
    // be encoded as the string "null".
    await executeRawJsonb(
      engine,
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      ['test-token', 'test-agent', 'tools/list', 5, 'success'],
      [null],
    );

    const rows = await engine.executeRaw<{ is_null: boolean }>(
      `SELECT (params IS NULL) AS is_null FROM mcp_request_log
       WHERE operation = 'tools/list'`,
    );
    expect(rows[0].is_null).toBe(true);
  });

  test('migration v45 normalizer: lifts pre-v0.31 string-shaped rows to objects', async () => {
    // Seed a row in the broken pre-v0.31 shape: a JSON-encoded object
    // stored as a string-typed JSONB. This is what postgres.js's loose
    // template-tag typing produced when `${JSON.stringify(obj)}` was
    // bound to a JSONB column without sql.json().
    const broken = JSON.stringify({ legacy: 'shape', op: 'search' });
    await engine.executeRaw(
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params)
       VALUES ($1, $2, $3, $4, $5, to_jsonb($6::text))`,
      ['legacy-token', 'legacy-agent', 'tools/call:legacy', 8, 'success', broken],
    );
    // Confirm the seed produced the broken shape (jsonb_typeof = 'string').
    const before = await engine.executeRaw<{ kind: string }>(
      `SELECT jsonb_typeof(params) AS kind FROM mcp_request_log
       WHERE operation = 'tools/call:legacy'`,
    );
    expect(before[0].kind).toBe('string');

    // Run the migration v45 SQL exactly as it lives in src/core/migrate.ts.
    await engine.executeRaw(`
      UPDATE mcp_request_log
        SET params = (params #>> '{}')::jsonb
        WHERE jsonb_typeof(params) = 'string'
          AND params #>> '{}' LIKE '{%'
    `);

    // After: real object, ->> reads the values.
    const after = await engine.executeRaw<{ kind: string; legacy: string; op: string }>(
      `SELECT jsonb_typeof(params) AS kind,
              params->>'legacy' AS legacy,
              params->>'op' AS op
       FROM mcp_request_log
       WHERE operation = 'tools/call:legacy'`,
    );
    expect(after[0].kind).toBe('object');
    expect(after[0].legacy).toBe('shape');
    expect(after[0].op).toBe('search');
  });

  test('migration v45 normalizer: idempotent — re-running on already-fixed rows is a no-op', async () => {
    // Run the migration a second time. The WHERE jsonb_typeof = 'string'
    // guard means already-object rows are skipped, so this should leave
    // the legacy row unchanged.
    await engine.executeRaw(`
      UPDATE mcp_request_log
        SET params = (params #>> '{}')::jsonb
        WHERE jsonb_typeof(params) = 'string'
          AND params #>> '{}' LIKE '{%'
    `);
    const after = await engine.executeRaw<{ kind: string; legacy: string }>(
      `SELECT jsonb_typeof(params) AS kind, params->>'legacy' AS legacy
       FROM mcp_request_log WHERE operation = 'tools/call:legacy'`,
    );
    expect(after[0].kind).toBe('object');
    expect(after[0].legacy).toBe('shape');
  });
});
