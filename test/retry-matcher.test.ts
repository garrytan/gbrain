import { describe, expect, test } from 'bun:test';
import {
  isStatementTimeoutError,
  isLockTimeoutError,
  isRetryableConnError,
  isRetryableError,
} from '../src/core/retry-matcher.ts';

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe('isStatementTimeoutError', () => {
  test('matches SQLSTATE 57014', () => {
    expect(isStatementTimeoutError(pgError('57014', 'canceled'))).toBe(true);
  });

  test('matches the canceling-statement message', () => {
    expect(
      isStatementTimeoutError(new Error('canceling statement due to statement timeout'))
    ).toBe(true);
  });

  test('does not match other errors', () => {
    expect(isStatementTimeoutError(new Error('connection refused'))).toBe(false);
    expect(isStatementTimeoutError(pgError('08006', 'connection_failure'))).toBe(false);
  });
});

describe('isLockTimeoutError', () => {
  test('matches SQLSTATE 55P03', () => {
    expect(isLockTimeoutError(pgError('55P03', 'lock not available'))).toBe(true);
  });

  test('matches lock_not_available message', () => {
    expect(isLockTimeoutError(new Error('could not obtain lock on row'))).toBe(true);
  });

  test('does not match statement timeouts', () => {
    expect(isLockTimeoutError(pgError('57014', 'canceled'))).toBe(false);
  });
});

describe('isRetryableConnError', () => {
  test('matches Postgres class 08 codes', () => {
    expect(isRetryableConnError(pgError('08000', 'connection_exception'))).toBe(true);
    expect(isRetryableConnError(pgError('08003', 'connection_does_not_exist'))).toBe(true);
    expect(isRetryableConnError(pgError('08006', 'connection_failure'))).toBe(true);
  });

  test('matches connection-refused message', () => {
    expect(isRetryableConnError(new Error('connection refused'))).toBe(true);
  });

  test('matches ECONNRESET', () => {
    expect(isRetryableConnError(new Error('ECONNRESET'))).toBe(true);
  });

  test('matches database-starting-up', () => {
    expect(
      isRetryableConnError(new Error('the database system is starting up'))
    ).toBe(true);
  });

  test('does NOT match statement timeouts', () => {
    expect(isRetryableConnError(pgError('57014', 'canceled'))).toBe(false);
  });

  test('does NOT match lock timeouts', () => {
    expect(isRetryableConnError(pgError('55P03', 'lock'))).toBe(false);
  });

  test('does not match arbitrary errors', () => {
    expect(isRetryableConnError(new Error('something else'))).toBe(false);
  });

  // issue #1678: postgres.js's transaction-mode pooler reaps idle sockets and
  // throws errors carrying `code: 'CONNECTION_ENDED'` (a library code, not an
  // 08xxx SQLSTATE). Must be retryable via BOTH the code and the message form.
  test('matches CONNECTION_ENDED via code', () => {
    expect(isRetryableConnError(pgError('CONNECTION_ENDED', 'write CONNECTION_ENDED'))).toBe(true);
  });

  test('matches CONNECTION_ENDED via message even without the code', () => {
    expect(isRetryableConnError(new Error('write CONNECTION_ENDED localhost:6543'))).toBe(true);
  });

  // The getter self-heal throws a GBrainError whose `problem` field is
  // 'No database connection' — the existing typed-shape match must keep firing.
  test('matches the instance-pool-reaped GBrainError shape (problem field)', () => {
    const err = { problem: 'No database connection', message: 'instance pool torn down' };
    expect(isRetryableConnError(err)).toBe(true);
  });

  // #1794: Supavisor session-pool exhaustion (EMAXCONNSESSION) + Postgres
  // SQLSTATE 53300 too_many_connections. Transient under load — must retry so
  // the resumable-sync checkpoint write survives the spike instead of being
  // dropped (which is how #1794 lost 100% of progress).
  test('matches EMAXCONNSESSION via message', () => {
    expect(isRetryableConnError(new Error('EMAXCONNSESSION: max clients in session mode'))).toBe(true);
  });

  test('matches SQLSTATE 53300 too_many_connections via code', () => {
    expect(isRetryableConnError(pgError('53300', 'too many connections for role'))).toBe(true);
  });

  test('matches "too many clients already" message', () => {
    expect(isRetryableConnError(new Error('sorry, too many clients already'))).toBe(true);
  });

  test('matches reserved-slots message', () => {
    expect(
      isRetryableConnError(new Error('remaining connection slots are reserved for non-replication superuser connections'))
    ).toBe(true);
  });

  // 53300 must NOT accidentally widen to other 53xxx (e.g. 53400
  // configuration_limit_exceeded is not a transient pool blip).
  test('does NOT match unrelated 53xxx codes', () => {
    expect(isRetryableConnError(pgError('53400', 'configuration limit exceeded'))).toBe(false);
  });
});

describe('isRetryableError', () => {
  test('union: returns true for conn AND statement-timeout', () => {
    expect(isRetryableError(new Error('connection refused'))).toBe(true);
    expect(isRetryableError(pgError('57014', 'canceled'))).toBe(true);
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
  });

  test('still false for unrelated errors', () => {
    expect(isRetryableError(new Error('foreign key violation'))).toBe(false);
  });
});
