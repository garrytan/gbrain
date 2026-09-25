import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { checkPostgresCancellationDriver } from '../src/commands/doctor.ts';

type Owner = { discard?: () => void; release: () => void };

function fakePostgresEngine(reserve: () => Promise<Owner>): BrainEngine {
  return { kind: 'postgres', sql: { reserve } } as unknown as BrainEngine;
}

describe('postgres_cancellation_driver', () => {
  test('fails when the reserved owner lacks discard and releases it', async () => {
    let released = false;
    const check = await checkPostgresCancellationDriver(fakePostgresEngine(async () => ({ release: () => { released = true; } })));

    expect(check?.name).toBe('postgres_cancellation_driver');
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('signalled queries fail');
    expect(check?.message).toContain('/health returns 503');
    expect(check?.message).toContain('INSTALL_FOR_AGENTS.md');
    expect(check?.message).toContain('#5466');
    expect(released).toBe(true);
  });

  test('passes when the reserved owner has discard', async () => {
    let released = false;
    const check = await checkPostgresCancellationDriver(fakePostgresEngine(async () => ({ discard() {}, release: () => { released = true; } })));

    expect(check?.status).toBe('ok');
    expect(released).toBe(true);
  });

  test('warns instead of hanging when no connection can be reserved in time, and releases a late one', async () => {
    let released = false;
    let deliver: (owner: Owner) => void = () => {};
    const late = new Promise<Owner>(resolve => { deliver = resolve; });
    const check = await checkPostgresCancellationDriver(fakePostgresEngine(() => late), { timeoutMs: 20 });

    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('within 20 ms');
    deliver({ discard() {}, release: () => { released = true; } });
    await late; await Promise.resolve();
    expect(released).toBe(true);
  });

  test('skips non-Postgres engines', async () => {
    expect(await checkPostgresCancellationDriver({ kind: 'pglite' } as BrainEngine)).toBeNull();
  });
});
