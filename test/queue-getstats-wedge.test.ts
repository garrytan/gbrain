/**
 * issue #1801 fix #3 — MinionQueue.getStats() exposes a QUEUE-SCOPED wedge
 * block (the data behind the `jobs stats` WEDGED line). active_healthy counts
 * only live-lock active rows; the block is scoped to one queue so a healthy
 * worker on another queue can't mask a wedged one (Codex #14).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

async function seed(
  q: string,
  name: string,
  status: string,
  extra: { lockUntilSql?: string; updatedAtSql?: string } = {},
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO minion_jobs (name, queue, status, lock_until, updated_at)
     VALUES ($1, $2, $3, ${extra.lockUntilSql ?? 'NULL'}, ${extra.updatedAtSql ?? 'now()'})`,
    [name, q, status],
  );
}

describe('issue #1801 — getStats wedge block', () => {
  it('reports the wedge signature for the requested queue', async () => {
    await seed('default', 'cycle', 'waiting');
    await seed('default', 'cycle', 'active', { lockUntilSql: "now() - interval '1 min'" }); // expired
    await seed('default', 'cycle', 'completed', { updatedAtSql: "now() - interval '20 min'" });

    const stats = await queue.getStats({ queue: 'default' });
    expect(stats.wedge.queue).toBe('default');
    expect(stats.wedge.active_healthy).toBe(0); // expired lock not counted
    expect(stats.wedge.waiting).toBe(1);
    expect(stats.wedge.minutes_since_completion).not.toBeNull();
    expect(stats.wedge.minutes_since_completion!).toBeGreaterThanOrEqual(15);
  });

  it('counts a live-lock active row as healthy', async () => {
    await seed('default', 'cycle', 'active', { lockUntilSql: "now() + interval '5 min'" });
    const stats = await queue.getStats({ queue: 'default' });
    expect(stats.wedge.active_healthy).toBe(1);
  });

  it('is queue-scoped — other queues do not bleed into the wedge block', async () => {
    await seed('other', 'cycle', 'waiting');
    const stats = await queue.getStats({ queue: 'default' });
    expect(stats.wedge.waiting).toBe(0); // nothing in 'default'
  });

  it('defaults the wedge queue to "default" when unspecified', async () => {
    await seed('default', 'cycle', 'waiting');
    const stats = await queue.getStats();
    expect(stats.wedge.queue).toBe('default');
    expect(stats.wedge.waiting).toBe(1);
  });
});
