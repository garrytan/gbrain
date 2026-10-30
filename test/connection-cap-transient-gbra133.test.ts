/**
 * GBRA-133: a pooler's client cap is contention, not a failed write.
 * Supavisor answers a session-mode client over its cap with `(EMAXCONNSESSION) max clients reached in session mode` under its
 * own error code, not SQLSTATE 53300, so a managed write that met it was failed terminally (storage_error) and the sync drain
 * stopped blocked_by_failures. It is released like 53300 now; a write's own errors still fail.
 */
import { expect, test } from 'bun:test';
import { connectionCapFailure, transientDatabaseFailure } from '../src/core/persistence/coordinator.ts';

const poolerError = (message: string, code: string) => Object.assign(new Error(message), { code });

test('a pooler client cap under any code is transient contention', () => {
  const capped = [
    poolerError('(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 25', 'XX000'),
    poolerError('sorry, too many clients already', '53300'),
    poolerError('remaining connection slots are reserved for non-replication superuser connections', '53300'),
  ];
  for (const error of capped) {
    expect(connectionCapFailure(error)).toBe(true);
    expect(transientDatabaseFailure(error)).toBe(true);
  }
});

test("a write's own error is not a connection cap", () => {
  for (const error of [poolerError('duplicate key value violates unique constraint', '23505'), poolerError('internal error', 'XX000'), new Error('boom')]) {
    expect(connectionCapFailure(error)).toBe(false);
    expect(transientDatabaseFailure(error)).toBe(false);
  }
});
