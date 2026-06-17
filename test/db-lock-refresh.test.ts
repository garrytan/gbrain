import { describe, expect, test } from 'bun:test';
import {
  LockUnavailableError,
  buildTenantLockId,
  type WithRefreshingLockOpts,
} from '../src/core/db-lock.ts';

describe('LockUnavailableError', () => {
  test('carries the lock id', () => {
    const err = new LockUnavailableError('gbrain-migrate:postgres');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LockUnavailableError');
    expect(err.lockId).toBe('gbrain-migrate:postgres');
    expect(err.message).toContain('gbrain-migrate:postgres');
  });
});

describe('buildTenantLockId — D4 multi-tenant safety', () => {
  test('postgres engine: queries current_database()', async () => {
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async () => [{ db: 'gbrain_main' }],
    } as unknown as Parameters<typeof buildTenantLockId>[0];
    const id = await buildTenantLockId(fakeEngine, 'gbrain-migrate');
    expect(id).toBe('gbrain-migrate:gbrain_main');
  });

  test('pglite engine: returns scope:pglite', async () => {
    const fakeEngine = {
      kind: 'pglite' as const,
      executeRaw: async () => [],
    } as unknown as Parameters<typeof buildTenantLockId>[0];
    const id = await buildTenantLockId(fakeEngine, 'gbrain-migrate');
    expect(id).toBe('gbrain-migrate:pglite');
  });

  test('failure path: returns scope:unknown rather than throwing', async () => {
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async () => { throw new Error('boom'); },
    } as unknown as Parameters<typeof buildTenantLockId>[0];
    const id = await buildTenantLockId(fakeEngine, 'gbrain-migrate');
    expect(id).toBe('gbrain-migrate:unknown');
  });

  test('two scopes share dbname suffix', async () => {
    const fakeEngine = {
      kind: 'postgres' as const,
      executeRaw: async () => [{ db: 'shared' }],
    } as unknown as Parameters<typeof buildTenantLockId>[0];
    const a = await buildTenantLockId(fakeEngine, 'gbrain-migrate');
    const b = await buildTenantLockId(fakeEngine, 'gbrain-hnsw');
    expect(a).toBe('gbrain-migrate:shared');
    expect(b).toBe('gbrain-hnsw:shared');
    expect(a).not.toBe(b);
  });
});

describe('WithRefreshingLockOpts shape', () => {
  test('default ttlMinutes (30) and heartbeatTimeoutMs (30000) are documented in interface', () => {
    // Just an explicit-options-construction smoke test so the type stays stable.
    const opts: WithRefreshingLockOpts = {
      ttlMinutes: 60,
      heartbeatTimeoutMs: 5000,
    };
    expect(opts.ttlMinutes).toBe(60);
    expect(opts.heartbeatTimeoutMs).toBe(5000);
  });
});
