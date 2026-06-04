/**
 * Typed retry-eligible-error predicates (v0.30.1, finding C4).
 *
 * Three v0.30.1 sites need to decide whether to retry on a given error:
 *   - db.ts:connectWithRetry (existing — auth, conn-refused, ECONNRESET)
 *   - migrate.ts retry wrapper (statement_timeout 57014 + conn-reset)
 *   - backfill-base.ts adaptive retry (statement_timeout 57014 + conn drop)
 *
 * Before this module these predicates lived inline at each site and drifted
 * over time. One source of truth here; new call sites import the typed
 * helper instead of pattern-matching the same regexes again.
 */

const CONN_PATTERNS = [
  /password authentication failed/i,
  /connection refused/i,
  /the database system is starting up/i,
  /Connection terminated unexpectedly/i,
  /ECONNRESET/i,
  /connection.*closed/i,
  /server closed the connection/i,
  /could not connect to server/i,
  // v0.41.2.1: gbrain's own GBrainError thrown by getConnection() when
  // the singleton pool was nulled (engine.disconnect mid-cycle, or
  // postgres.js's auto-recovery between queries). Matches the literal
  // message shape from PR #1416's reported batch-loss incident.
  /No database connection/i,
  // v0.42.5.0 (issue #1678): postgres.js throws errors carrying
  // `code: 'CONNECTION_ENDED'` (a LIBRARY code, not an 08xxx SQLSTATE) when a
  // transaction-mode pooler reaps an idle socket between queries. Without an
  // explicit match it was only accidentally caught by /connection.*closed/i.
  // Match the message form too for wrappers that fold the code into the text.
  /CONNECTION_ENDED/i,
];

interface PgError {
  code?: string;
  message?: string;
  cause?: unknown;
  // v0.41.2.1: gbrain's GBrainError uses `problem` (typed) + `detail` so
  // callers can switch on the engine-state class without string matching.
  problem?: string;
}

function getCode(err: unknown): string | undefined {
  if (err && typeof err === 'object') {
    const code = (err as PgError).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function getMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const msg = (err as PgError).message;
    if (typeof msg === 'string') return msg;
  }
  return String(err ?? '');
}

/**
 * SQLSTATE 57014: query_canceled / statement_timeout.
 * Postgres signals this when a statement exceeds `statement_timeout`.
 */
export function isStatementTimeoutError(err: unknown): boolean {
  if (getCode(err) === '57014') return true;
  const msg = getMessage(err);
  return /statement_timeout|canceling statement due to statement timeout/i.test(msg);
}

/**
 * SQLSTATE 55P03: lock_not_available.
 * Postgres signals this when `lock_timeout` or `NOWAIT` would block.
 */
export function isLockTimeoutError(err: unknown): boolean {
  if (getCode(err) === '55P03') return true;
  const msg = getMessage(err);
  return /lock_not_available|could not obtain lock/i.test(msg);
}

/**
 * Connection-level errors that are typically transient: TCP resets,
 * pooler restarts, server-starting-up, auth race during DNS failover.
 * Distinguish from statement_timeout / lock_timeout via the dedicated
 * predicates above.
 */
export function isRetryableConnError(err: unknown): boolean {
  // Statement / lock timeouts are NOT connection errors. Callers that
  // want to retry on those use isStatementTimeoutError / isLockTimeoutError
  // explicitly so they can apply different backoff (e.g. backfill halves
  // batch size on stmt timeout but reconnects on conn drop).
  if (isStatementTimeoutError(err) || isLockTimeoutError(err)) return false;
  const code = getCode(err);
  // Postgres connection-level codes:
  //   08000 connection_exception
  //   08003 connection_does_not_exist
  //   08006 connection_failure
  //   08001 sqlclient_unable_to_establish_sqlconnection
  //   08004 sqlserver_rejected_establishment_of_sqlconnection
  if (code && /^08/.test(code)) return true;
  // v0.42.5.0 (issue #1678): postgres.js's library-level connection-ended
  // code. Not an 08xxx SQLSTATE, so the /^08/ test above misses it.
  if (code === 'CONNECTION_ENDED') return true;
  // v0.41.2.1: typed-shape match for gbrain's own GBrainError
  // (problem === 'No database connection'). Avoids brittle string match
  // when the error wrapper is gbrain-internal.
  if (
    err && typeof err === 'object' &&
    (err as PgError).problem === 'No database connection'
  ) {
    return true;
  }
  const msg = getMessage(err);
  return CONN_PATTERNS.some(p => p.test(msg));
}

/**
 * issue #1685 (CODEX #8): is this error specifically a POOLER REAP — postgres.js's
 * library-level `CONNECTION_ENDED` code (the transaction-mode pooler dropping an
 * idle socket between ticks)? Narrower than `isRetryableConnError`, which also
 * matches 08xxx SQLSTATEs, network blips, and auth races. Used by
 * `PostgresEngine.reconnect()` to label the pool-recovery audit honestly so a
 * generic reconnect isn't mis-recorded as a reap.
 */
export function isConnectionEndedError(err: unknown): boolean {
  const code = getCode(err);
  if (code === 'CONNECTION_ENDED') return true;
  const msg = getMessage(err);
  return /CONNECTION_ENDED/i.test(msg);
}

/**
 * Convenience: is this error retryable for ANY reason (connection drop OR
 * statement timeout)? Backfill uses this — callers that need finer-grained
 * dispatch (different backoff per kind) call the dedicated predicates.
 */
export function isRetryableError(err: unknown): boolean {
  return isRetryableConnError(err) || isStatementTimeoutError(err);
}
