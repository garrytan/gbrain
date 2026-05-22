/**
 * Lease-based rate limiter tests. Runs against PGLite in-memory.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  acquireLease,
  renewLease,
  releaseLease,
  renewLeaseWithBackoff,
} from '../src/core/minions/rate-leases.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let owner: number; // a minion_jobs.id to own leases (FK target)

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM subagent_rate_leases');
  await engine.executeRaw('DELETE FROM minion_jobs');
  const j = await queue.add('owner', {});
  owner = j.id;
});

describe('acquireLease / releaseLease', () => {
  test('single acquire under cap returns lease id', async () => {
    const r = await acquireLease(engine, 'anthropic:messages', owner, 2);
    expect(r.acquired).toBe(true);
    expect(r.leaseId).toBeGreaterThan(0);
    expect(r.activeCount).toBe(1);
  });

  test('acquires up to max_concurrent', async () => {
    const a = await acquireLease(engine, 'k', owner, 2);
    const b = await acquireLease(engine, 'k', owner, 2);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    expect(b.activeCount).toBe(2);
  });

  test('rejects beyond max_concurrent', async () => {
    await acquireLease(engine, 'k', owner, 2);
    await acquireLease(engine, 'k', owner, 2);
    const third = await acquireLease(engine, 'k', owner, 2);
    expect(third.acquired).toBe(false);
    expect(third.leaseId).toBeUndefined();
    expect(third.activeCount).toBe(2);
  });

  test('releaseLease frees a slot', async () => {
    const a = await acquireLease(engine, 'k', owner, 1);
    expect(a.acquired).toBe(true);
    const blocked = await acquireLease(engine, 'k', owner, 1);
    expect(blocked.acquired).toBe(false);

    await releaseLease(engine, a.leaseId!);

    const after = await acquireLease(engine, 'k', owner, 1);
    expect(after.acquired).toBe(true);
  });

  test('different keys have independent capacity', async () => {
    const a = await acquireLease(engine, 'k1', owner, 1);
    const b = await acquireLease(engine, 'k2', owner, 1);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
  });

  test('stale leases auto-prune on next acquire', async () => {
    const a = await acquireLease(engine, 'k', owner, 1, { ttlMs: 10 });
    expect(a.acquired).toBe(true);
    // Force the lease to be stale.
    await engine.executeRaw(
      `UPDATE subagent_rate_leases SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [a.leaseId!],
    );
    const b = await acquireLease(engine, 'k', owner, 1);
    expect(b.acquired).toBe(true);
    // Only the fresh lease should remain.
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM subagent_rate_leases WHERE key = $1`,
      ['k'],
    );
    expect(parseInt(rows[0]!.count, 10)).toBe(1);
  });

  test('owner job deletion cascades lease rows', async () => {
    const a = await acquireLease(engine, 'k', owner, 1);
    expect(a.acquired).toBe(true);
    await engine.executeRaw(`DELETE FROM minion_jobs WHERE id = $1`, [owner]);
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM subagent_rate_leases WHERE key = $1`,
      ['k'],
    );
    expect(parseInt(rows[0]!.count, 10)).toBe(0);
  });

  test('releaseLease on a missing id is a no-op (idempotent)', async () => {
    await expect(releaseLease(engine, 99_999)).resolves.toBeUndefined();
  });
});

describe('renewLease', () => {
  test('renewLease bumps expires_at and returns true', async () => {
    const a = await acquireLease(engine, 'k', owner, 1, { ttlMs: 50 });
    const before = await engine.executeRaw<{ expires_at: string }>(
      `SELECT expires_at FROM subagent_rate_leases WHERE id = $1`,
      [a.leaseId!],
    );
    await new Promise(r => setTimeout(r, 5));
    const ok = await renewLease(engine, a.leaseId!, 120_000);
    expect(ok).toBe(true);
    const after = await engine.executeRaw<{ expires_at: string }>(
      `SELECT expires_at FROM subagent_rate_leases WHERE id = $1`,
      [a.leaseId!],
    );
    expect(new Date(after[0]!.expires_at).getTime()).toBeGreaterThan(new Date(before[0]!.expires_at).getTime());
  });

  test('renewLease on a missing lease returns false', async () => {
    expect(await renewLease(engine, 99_999)).toBe(false);
  });
});

describe('renewLeaseWithBackoff', () => {
  test('returns true on live lease', async () => {
    const a = await acquireLease(engine, 'k', owner, 1);
    expect(await renewLeaseWithBackoff(engine, a.leaseId!)).toBe(true);
  });

  test('returns false on pruned lease (no retry loop)', async () => {
    const a = await acquireLease(engine, 'k', owner, 1);
    await releaseLease(engine, a.leaseId!);
    expect(await renewLeaseWithBackoff(engine, a.leaseId!)).toBe(false);
  });
});
