import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { checkPostgresCancellationDriver } from '../src/commands/doctor/checks/postgres-cancellation.ts';

type Owner = { discard?: () => void; release(): void };
const engine = (reserve: () => Promise<Owner>) => ({ kind: 'postgres', sql: { reserve } }) as unknown as BrainEngine;

describe('doctor Postgres cancellation driver check', () => {
  test('stock driver fails with stable reason and actionable repair', async () => {
    let releases = 0;
    const result = await checkPostgresCancellationDriver(engine(async () => ({ release: () => { releases++; } })));
    expect(result?.status).toBe('fail');
    expect(result?.details?.reason_code).toBe('postgres_cancellation_unavailable');
    expect(result?.message).toContain('restart');
    expect(releases).toBe(1);
  });

  test('supported driver passes and releases the inspected owner', async () => {
    let releases = 0;
    const result = await checkPostgresCancellationDriver(engine(async () => ({ discard() {}, release: () => { releases++; } })));
    expect(result?.status).toBe('ok');
    expect(releases).toBe(1);
  });

  test('connection errors warn without disclosing the driver error', async () => {
    const result = await checkPostgresCancellationDriver(engine(async () => { throw new Error('postgres://fixture:GSTACK_EXAMPLE_NONCE@localhost/db'); }));
    expect(result?.status).toBe('warn');
    expect(JSON.stringify(result)).not.toContain('GSTACK_EXAMPLE_NONCE');
  });

  test('reservation timeout is transient and a late connection is released', async () => {
    let resolve!: (owner: Owner) => void;
    let releases = 0;
    const result = await checkPostgresCancellationDriver(engine(() => new Promise(done => { resolve = done; })), { timeoutMs: 10 });
    expect(result?.status).toBe('warn');
    resolve({ release: () => { releases++; } });
    await Promise.resolve();
    await Promise.resolve();
    expect(releases).toBe(1);
  });

  test('PGLite requires no driver inspection', async () => {
    expect(await checkPostgresCancellationDriver({ kind: 'pglite' } as BrainEngine)).toBeNull();
  });
});
