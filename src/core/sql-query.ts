import type { BrainEngine } from './engine.ts';

/**
 * Minimal tagged SQL function used by OAuth/admin/auth infrastructure.
 *
 * This is deliberately narrower than postgres.js's `sql` tag: values must be
 * scalar bind parameters only. It does not support nested SQL fragments,
 * sql.json(), sql.unsafe(), sql.begin(), or direct JS array binding. JSONB
 * writes go through the separate `executeRawJsonb` helper below.
 *
 * The narrow surface is the feature: every call site in auth.ts /
 * serve-http.ts / mcp/http-transport.ts / files.ts answers "do you support
 * X?" with "no, and that's the contract." That keeps the adapter from
 * drifting into a partial postgres.js clone (codex finding #7 from the
 * v0.31 plan review).
 */
export type SqlValue = string | number | bigint | boolean | Date | null;
export type SqlQuery = (strings: TemplateStringsArray, ...values: SqlValue[]) => Promise<Record<string, unknown>[]>;

/**
 * Build a minimal tagged-template SQL adapter over the active BrainEngine.
 *
 * OAuth/admin code only needs scalar positional parameters plus returned rows.
 * Using BrainEngine.executeRaw keeps the path engine-aware: Postgres goes
 * through the connected postgres.js client (`unsafe(sql, params)`), while
 * PGLite goes through its embedded `db.query(sql, params)`.
 *
 * The v0.12.0 double-encode bug class does NOT apply here because
 * executeRaw uses positional binding, not the postgres.js template tag's
 * auto-stringify path that caused the original silent-data-loss incident.
 */
export function sqlQueryForEngine(engine: BrainEngine): SqlQuery {
  return async (strings: TemplateStringsArray, ...values: SqlValue[]) => {
    for (const value of values) {
      assertSqlValue(value);
    }
    const query = strings.reduce((acc, str, i) => {
      return acc + str + (i < values.length ? `$${i + 1}` : '');
    }, '');
    return engine.executeRaw(query, values);
  };
}

function assertSqlValue(value: unknown): asserts value is SqlValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    value instanceof Date
  ) {
    return;
  }

  const kind = Array.isArray(value)
    ? 'array'
    : value && typeof (value as { then?: unknown }).then === 'function'
      ? 'promise'
      : typeof value;
  throw new TypeError(
    `sqlQueryForEngine only supports scalar bind values; got ${kind}. ` +
    'Use fixed SQL with scalar params, or executeRawJsonb for JSONB writes.',
  );
}

/**
 * Cross-engine JSONB write helper. Composes a parametrized SQL string with
 * explicit `$N::jsonb` casts for the JSONB positions and passes the JSONB
 * values as JS objects through `engine.executeRaw`. Both the postgres.js
 * `unsafe(sql, params)` path (via PostgresEngine) and PGLite's
 * `db.query(sql, params)` accept objects for `$N::jsonb` positions and
 * round-trip them with `jsonb_typeof = 'object'` (verified by
 * test/e2e/auth-permissions.test.ts:67 on Postgres and test/sql-query.test.ts
 * on PGLite).
 *
 * Why this exists separately from SqlQuery: the SqlQuery contract is
 * deliberately scalar-only. JSONB columns are rare enough across the
 * auth/admin surface that a focused helper preserves the contract without
 * forcing every call site to remember which positions hold JSONB.
 *
 * Why this is safe vs the v0.12.0 double-encode bug: the bug was specific
 * to postgres.js's template-tag auto-stringify path interacting with
 * sql.json() — not to positional binding through `unsafe()`. JS objects
 * passed as positional params reach the wire protocol with the correct
 * type oid (jsonb when cast in the SQL string), so there is no double-
 * encode. The CI guard (scripts/check-jsonb-pattern.sh) doesn't fire
 * because the source pattern is a method call (`executeRawJsonb(...)`),
 * not the banned literal-template-tag interpolation pattern with
 * JSON.stringify cast to jsonb.
 *
 * Usage:
 *   await executeRawJsonb(
 *     engine,
 *     `INSERT INTO access_tokens (name, token_hash, permissions)
 *      VALUES ($1, $2, $3::jsonb)`,
 *     [name, hash],
 *     [{ takes_holders: ['world', 'garry'] }],
 *   );
 *
 * The SQL string MUST already contain the `$N::jsonb` casts; the helper
 * does NOT rewrite or inject them. Scalar params come first ($1..$N), then
 * JSONB params ($N+1..$N+M). Matching the call-site convention to scalars-
 * before-JSONB simplifies argument order and matches how the existing
 * call sites we're migrating are shaped.
 */
export async function executeRawJsonb<R = Record<string, unknown>>(
  engine: BrainEngine,
  sql: string,
  scalarParams: SqlValue[],
  jsonbParams: unknown[],
): Promise<R[]> {
  for (const value of scalarParams) {
    assertSqlValue(value);
  }
  // jsonbParams are explicitly NOT validated as scalar — they're meant to
  // hold JS objects/arrays that postgres.js / PGLite will encode as JSONB
  // via the explicit ::jsonb cast in the caller's SQL string.
  const params: unknown[] = [...scalarParams, ...jsonbParams];
  return engine.executeRaw<R>(sql, params);
}
