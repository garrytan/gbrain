import { describe, expect, test } from 'bun:test';
import {
  LockReleaseFailedError,
  LockUnavailableError,
  buildTenantLockId,
  getLockReleaseFailure,
  withRefreshingLock,
  type WithRefreshingLockOpts,
} from '../src/core/db-lock.ts';
import { buildGBrainSyncErrorEnvelope } from '../src/commands/sync.ts';

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

  test('opt-in release failure is typed after successful work', async () => {
    const fakeEngine = {
      kind: 'pglite' as const,
      db: {
        query: async (sql: string) => {
          if (sql.includes('INSERT INTO gbrain_cycle_locks')) {
            return { rows: [{ id: 'gbrain-sync:preview' }] };
          }
          if (sql.includes('DELETE FROM gbrain_cycle_locks')) {
            throw new Error('injected release failure');
          }
          return { rows: [] };
        },
      },
      executeRawDirect: async () => [],
    } as unknown as Parameters<typeof withRefreshingLock>[0];

    await expect(
      withRefreshingLock(
        fakeEngine,
        'gbrain-sync:preview',
        async () => 'validated',
        { failOnReleaseError: true },
      ),
    ).rejects.toBeInstanceOf(LockReleaseFailedError);
  });

  test('release failure never replaces the original work error', async () => {
    const fakeEngine = {
      kind: 'pglite' as const,
      db: {
        query: async (sql: string) => {
          if (sql.includes('INSERT INTO gbrain_cycle_locks')) {
            return { rows: [{ id: 'gbrain-sync:preview' }] };
          }
          if (sql.includes('DELETE FROM gbrain_cycle_locks')) {
            throw new Error('injected release failure');
          }
          return { rows: [] };
        },
      },
      executeRawDirect: async () => [],
    } as unknown as Parameters<typeof withRefreshingLock>[0];
    const workError = new Error('original work failure');

    await expect(
      withRefreshingLock(
        fakeEngine,
        'gbrain-sync:preview',
        async () => {
          throw workError;
        },
        { failOnReleaseError: true },
      ),
    ).rejects.toBe(workError);
    expect(getLockReleaseFailure(workError)).toBeInstanceOf(
      LockReleaseFailedError,
    );
    expect(buildGBrainSyncErrorEnvelope(workError)).toMatchObject({
      result_kind: 'gbrain_sync_error',
      status: 'error',
      reason_code: 'lock_release_failed',
      state_changed: 'lock_only',
      observed: 'gbrain-sync:preview',
    });
  });
});
