/**
 * `search.keyword_statement_timeout_ms` (#6495): the per-statement bound the
 * Postgres engine sets (`statement_timeout`, transaction-local) around every
 * keyword, keyword-page, keyword-count, title and CJK search statement.
 * Integer milliseconds, default 8000, range 1000..60000; `config set` refuses
 * other values and a stored value outside the range reads as the default.
 *
 * The bound is an operator mitigation, never a request parameter: a remote
 * caller cannot widen it, and the cap keeps a broad keyword query from
 * holding a backend for minutes. It is resolved once per engine connection,
 * by the first keyword statement after connect (the file plane the engine
 * connected with, then the DB plane's `config` row), never by a request
 * parameter; connect itself issues no statement for it, so a borrower of an
 * in-flight pool still connects at once and a read-only command that never
 * searches reads nothing. `gbrain config set` therefore takes effect on the
 * next connection: the next CLI command, or a restart of the serving process. It
 * mitigates #6495 (a brain whose commonest terms cannot be ranked within the
 * bound) by letting the operator trade latency for coverage; ranking cost
 * stays proportional to the matching corpus, so a longer bound buys time,
 * not a faster statement. `countKeywordPages` keeps its own narrower
 * `timeoutMs` when a caller passes one.
 *
 * Postgres only: PGLite runs these statements with no statement timeout.
 */
export const KEYWORD_STATEMENT_TIMEOUT_KEY = 'search.keyword_statement_timeout_ms';
export const KEYWORD_STATEMENT_TIMEOUT_DEFAULT_MS = 8000;
export const KEYWORD_STATEMENT_TIMEOUT_MIN_MS = 1000;
export const KEYWORD_STATEMENT_TIMEOUT_MAX_MS = 60_000;

/** The configured milliseconds when `raw` is an integer in range, else undefined. */
export function keywordStatementTimeoutMs(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  return Number.isInteger(n) && n >= KEYWORD_STATEMENT_TIMEOUT_MIN_MS && n <= KEYWORD_STATEMENT_TIMEOUT_MAX_MS ? n : undefined;
}

/** File plane, then DB plane, then the default. */
export function resolveKeywordStatementTimeoutMs(fileValue: unknown, dbValue: unknown): number {
  return keywordStatementTimeoutMs(fileValue) ?? keywordStatementTimeoutMs(dbValue) ?? KEYWORD_STATEMENT_TIMEOUT_DEFAULT_MS;
}

/** `config set` refusal text, or null when the value is valid. */
export function keywordStatementTimeoutValueProblem(value: string): string | null {
  return keywordStatementTimeoutMs(value) !== undefined
    ? null
    : `${KEYWORD_STATEMENT_TIMEOUT_KEY} must be an integer number of milliseconds from ${KEYWORD_STATEMENT_TIMEOUT_MIN_MS} to ${KEYWORD_STATEMENT_TIMEOUT_MAX_MS} (got '${value}'). Nothing was written.`;
}

/**
 * The DB-plane read, with the key inlined instead of bound: a bound parameter
 * makes the driver describe the statement and record its type in the shared
 * pg-types cache, which is then written under `~/.gbrain/cache/pg-types/` at
 * exit, and read-only commands such as `gbrain graduate --plan` must not
 * write a byte (test/e2e/graduation-cli-zero-mutation-*.test.ts).
 */
// engine-sql-ok: one Postgres-only config-row read with the key inlined so the driver describes no parameter (pg-types cache); PGLite sets no statement timeout
export const KEYWORD_STATEMENT_TIMEOUT_CONFIG_SQL = `SELECT value FROM config WHERE key = '${KEYWORD_STATEMENT_TIMEOUT_KEY}'`;

/**
 * The `statement_timeout` setting value (`<ms>ms`) for one engine connection:
 * the file plane's value when set, else the DB plane's. A config table that
 * cannot be read yet (a fresh brain before its schema) yields the default.
 */
export async function loadKeywordStatementTimeout(
  reader: { executeRaw<T>(sql: string): Promise<T[]> },
  fileValue: unknown,
): Promise<string> {
  const fileMs = keywordStatementTimeoutMs(fileValue);
  if (fileMs !== undefined) return `${fileMs}ms`;
  const rows = await reader.executeRaw<{ value: string }>(KEYWORD_STATEMENT_TIMEOUT_CONFIG_SQL).catch(() => []);
  return `${resolveKeywordStatementTimeoutMs(undefined, rows[0]?.value)}ms`;
}
