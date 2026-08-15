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
 * Why this is safe vs the double-encode bug: this helper binds a JS **object**
 * (not a pre-stringified string) to each `$N::jsonb` position. postgres.js
 * `unsafe()` and PGLite both serialize a JS object to the jsonb wire type
 * correctly, so there is no double-encode.
 *
 * IMPORTANT (the #2339 distinction): positional binding is NOT universally safe.
 * Binding `JSON.stringify(x)` (a **string**) to a `$N::jsonb` position via
 * `unsafe()`/`executeRawDirect` DOES double-encode — the text→jsonb cast wraps
 * the already-JSON string into a jsonb *string scalar* (PGLite hides it; real
 * Postgres exposes it, and it broke every sync in #2339). The fixes are: pass a
 * raw object (this helper), or cast through `$N::text::jsonb` so the string is
 * parsed, never `$N::jsonb` + JSON.stringify. The legacy grep guard
 * (scripts/check-jsonb-pattern.sh) only caught the template-tag form; the
 * positional `$N::jsonb` + JSON.stringify form is caught by the AST guard
 * scripts/check-jsonb-params.mjs. This helper's `executeRawJsonb(...)` method-call
 * shape trips neither guard because it passes objects, which is correct.
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
  // jsonbParams hold JS objects (or null) that postgres.js / PGLite encode as
  // JSONB via the explicit `::jsonb` cast in the caller's SQL string. A
  // top-level ARRAY is rejected: postgres.js can bind a bare JS array as a
  // Postgres ARRAY literal rather than jsonb, which silently re-enters the
  // "malformed array literal" class gbrain#1861 exists to escape. Wrap arrays
  // in an object, e.g. `[{ rows: [...] }]` selected via
  // `jsonb_to_recordset(($N::jsonb)->'rows')`. This enforces at the call layer
  // the invariant the batch-insert methods rely on (codex #1861 P2a).
  for (const value of jsonbParams) {
    if (Array.isArray(value)) {
      throw new TypeError(
        'executeRawJsonb: a top-level array jsonb param can bind as a Postgres ' +
        'array literal (not jsonb) through postgres.js. Wrap it in an object — ' +
        "e.g. `[{ rows: [...] }]` with `jsonb_to_recordset(($N::jsonb)->'rows')`. " +
        '(gbrain#1861)',
      );
    }
  }
  const params: unknown[] = [...scalarParams, ...jsonbParams];
  return engine.executeRaw<R>(sql, params);
}
