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
