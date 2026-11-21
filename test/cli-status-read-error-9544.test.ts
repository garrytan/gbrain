import { expect, test } from 'bun:test';
import { postgresStatusReadError } from '../src/cli/postgres-status-read-error.ts';
import { GBrainError } from '../src/core/types.ts';
import { opError } from '../src/core/ops/contract.ts';
import { RemoteMcpError } from '../src/core/remote-mcp-error.ts';

for (const code of ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', '57P01', '57P02', '57P03', '08000', '08001', '08003', '08006']) {
  test(`status read classifies ${code} without exposing driver details`, () => {
    const error = Object.assign(new Error('synthetic private driver details'), { code });
    const result = postgresStatusReadError(error, 'postgres') as Error & { code: string; retryable: boolean };
    expect(result).toMatchObject({ code: 'database_error', retryable: true });
    expect(result.message).not.toContain(error.message);
    expect(postgresStatusReadError(error, 'pglite')).toBe(error);
    expect(postgresStatusReadError(error, null)).toBe(error);
  });
}

test('connect wrappers retain their typed cause and only a PostgreSQL connect socket ENOENT qualifies', () => {
  const cause = Object.assign(new Error('connect ENOENT /synthetic/.s.PGSQL.5432'), { code: 'ENOENT', syscall: 'connect' });
  const wrapped = new GBrainError('Cannot connect to database', 'redacted', 'inspect', undefined, { cause });
  expect(wrapped.cause).toBe(cause);
  expect(postgresStatusReadError(wrapped, 'postgres')).toMatchObject({ code: 'database_error', reason: 'socket_missing', retryable: true });
  for (const other of [
    Object.assign(new Error('connect ENOENT /synthetic/other.sock'), { code: 'ENOENT', syscall: 'connect' }),
    Object.assign(new Error('connect ENOENT /synthetic/.s.PGSQL.5432'), { code: 'ENOENT', syscall: 'open' }),
    Object.assign(new Error('missing file'), { code: 'ENOENT' }),
  ]) expect(postgresStatusReadError(other, 'postgres')).toBe(other);
});

test('authentication, query failures, arbitrary prose and existing refusal contracts are not retried', () => {
  const errors: unknown[] = ['connection closed', new Error('server closed the connection'),
    Object.assign(new RemoteMcpError('network', 'connection refused'), { code: 'ECONNREFUSED' }),
    ...['28P01', '42501', '57014', '55P03', '23505', '42601'].map(code => Object.assign(new Error('query refused'), { code })),
    opError('database_error', 'existing refusal', 'inspect', { retryable: false }),
  ];
  for (const error of errors) expect(postgresStatusReadError(error, 'postgres')).toBe(error);
});
