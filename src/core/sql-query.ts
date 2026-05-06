import type { BrainEngine } from './engine.ts';
import type { SqlQuery, SqlValue } from './oauth-provider.ts';

/**
 * Build a minimal tagged-template SQL adapter over the active BrainEngine.
 *
 * OAuth/admin code only needs scalar positional parameters plus returned rows.
 * This is not a postgres.js compatibility layer: nested fragments, sql.json,
 * sql.unsafe, sql.begin, and direct JS array binding are intentionally outside
 * the contract. Using BrainEngine.executeRaw keeps the path engine-aware:
 * Postgres goes through the connected postgres.js client, while PGLite goes
 * through its embedded query API.
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
    'Use fixed SQL with scalar params, or add an explicit cross-engine helper.',
  );
}
