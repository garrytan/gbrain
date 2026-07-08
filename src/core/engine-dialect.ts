/**
 * SQL dialect seam shared by SQLiteEngine and PgEngineBase (O1 first slice).
 *
 * A dialect describes only the rendering primitives the shared-sql modules
 * need to emit one behavior-identical SQL statement per engine. Execution
 * stays inside each engine behind the DialectQueryable adapter, so transport
 * concerns (postgres.js vs bun:sqlite, binding coercion, transactions) never
 * leak into shared SQL code.
 *
 * Deliberately minimal: primitives are added only when a shared-sql module
 * needs them, never speculatively.
 */

export interface SqlDialect {
  readonly name: 'postgres' | 'sqlite';
  /** Positional parameter placeholder for the given 1-based parameter index. */
  placeholder(index: number): string;
  /**
   * Placeholder for a JSON.stringify'd parameter destined for a JSON column
   * (adds the ::jsonb cast on Postgres; plain positional binding on SQLite).
   */
  jsonPlaceholder(index: number): string;
  /**
   * Whether INSERT ... RETURNING is used to read rows back in one round trip.
   * When false, shared SQL writes first and then selects the row back.
   */
  readonly supportsReturning: boolean;
  /**
   * Server-side "current timestamp" SQL expression, or null when the engine
   * manages timestamps client-side by binding ISO-8601 strings into explicit
   * created_at/updated_at columns (SQLite).
   */
  readonly serverNow: string | null;
}

export const postgresDialect: SqlDialect = {
  name: 'postgres',
  placeholder: (index: number) => `$${index}`,
  jsonPlaceholder: (index: number) => `$${index}::jsonb`,
  supportsReturning: true,
  serverNow: 'now()',
};

export const sqliteDialect: SqlDialect = {
  name: 'sqlite',
  placeholder: () => '?',
  jsonPlaceholder: () => '?',
  supportsReturning: false,
  serverNow: null,
};

/**
 * Minimal engine-provided executor for dialect-parameterized shared SQL.
 * `query` returns rows; `run` executes a statement whose rows are ignored.
 */
export interface DialectQueryable {
  readonly dialect: SqlDialect;
  query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params: unknown[]): Promise<void>;
}
