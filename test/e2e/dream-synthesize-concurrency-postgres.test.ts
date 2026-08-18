/**
 * #4194 — inline-drain bounded concurrency under REAL Postgres.
 *
 * The PGLite unit lane (test/cycle-synthesize-inline-concurrency.test.ts)
 * pins loop semantics; this lane pins what PGLite cannot: FOR UPDATE
 * SKIP LOCKED claim fencing under genuinely concurrent drain loops (no
 * double-claims, no lost children) and the lease ceiling staying the
 * effective limiter when it is LOWER than the drain concurrency.
 *
 * DATABASE_URL-gated: self-skips without a real Postgres.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { runSubagentsInline } from '../../src/core/cycle/inline-drain.ts';
import type { MinionHandler } from '../../src/core/minions/types.ts';
import { RateLeaseUnavailableError } from '../../src/core/minions/handlers/subagent.ts';
import { acquireLease, releaseLease } from '../../src/core/minions/rate-leases.ts';

const describePg = hasDatabase() ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let queueSeq = 0;

describePg('#4194 inline drain concurrency — Postgres', () => {
  beforeAll(async () => {
    await setupDB();
  }, 90_000);

  afterAll(async () => {
    await teardownDB();
  }, 30_000);

  async function seed(queue: MinionQueue, queueName: string, count: number): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const job = await queue.add(
        'subagent',
        { prompt: `pg child ${i}` },
        { queue: queueName },
        { allowProtectedSubmit: true },
      );
      ids.push(job.id);
    }
    return ids;
  }

  test('N=4 loops: overlap observed, every child exactly-once, all complete', async () => {
    const engine = getEngine();
    const queue = new MinionQueue(engine);
    const queueName = `dream-inline-pg-${++queueSeq}`;
    const ids = await seed(queue, queueName, 8);

    let inFlight = 0;
    let maxInFlight = 0;
    const executions = new Map<number, number>();
    const handler: MinionHandler = async (ctx) => {
      executions.set(ctx.id, (executions.get(ctx.id) ?? 0) + 1);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(150);
      inFlight--;
      return { ok: true };
    };

    await runSubagentsInline(engine, queue, queueName, undefined, handler, 30_000, 4);

    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    // SKIP LOCKED fencing: no child ran twice, none was missed.
    expect(executions.size).toBe(8);
    for (const [, count] of executions) expect(count).toBe(1);
    const rows = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM minion_jobs WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    expect(rows.every(r => r.status === 'completed')).toBe(true);
  }, 60_000);

  test('lease cap BELOW drain concurrency stays the effective API ceiling', async () => {
    const engine = getEngine();
    const queue = new MinionQueue(engine);
    const queueName = `dream-inline-pg-${++queueSeq}`;
    const ids = await seed(queue, queueName, 6);

    const LEASE_KEY = `test:chat-${queueSeq}`;
    const CAP = 2;
    let inLease = 0;
    let maxInLease = 0;
    // Handler mimics the per-turn permit: acquire → provider call → release.
    // Lease-full throws RateLeaseUnavailableError, which the drain requeues
    // WITHOUT burning an attempt — so all children still finish.
    const handler: MinionHandler = async (ctx) => {
      const lease = await acquireLease(engine, LEASE_KEY, ctx.id, CAP, { ttlMs: 30_000 });
      if (!lease.acquired) throw new RateLeaseUnavailableError(LEASE_KEY, lease.activeCount, lease.maxConcurrent);
      inLease++;
      maxInLease = Math.max(maxInLease, inLease);
      try {
        await sleep(120);
        return { ok: true };
      } finally {
        inLease--;
        await releaseLease(engine, lease.leaseId!).catch(() => {});
      }
    };

    await runSubagentsInline(engine, queue, queueName, undefined, handler, 30_000, 4);

    expect(maxInLease).toBeLessThanOrEqual(CAP);
    const rows = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM minion_jobs WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    expect(rows.every(r => r.status === 'completed')).toBe(true);
  }, 90_000);
});
