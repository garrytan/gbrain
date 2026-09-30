import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { OwnerProcessingState } from '../src/core/minions/processing-state.ts';
import { guardAutopilotEngine } from '../src/commands/autopilot.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

afterEach(async () => {
  delete (engine as unknown as Record<string, unknown>).executeRaw;
  await engine.executeRaw('DELETE FROM minion_jobs');
});

async function withOwner(fn: (state: OwnerProcessingState) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-txn-fence-'));
  try {
    await withEnv({ GBRAIN_HOME: root, HOME: root }, async () => {
      const state = new OwnerProcessingState('autopilot', 'default');
      try { await fn(state); } finally { state.close(); }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function pauseAfter(fragment: string): { reached: Promise<void>; release: () => void } {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const raw = PGLiteEngine.prototype.executeRaw;
  Object.defineProperty(engine, 'executeRaw', {
    configurable: true,
    value: async function (this: PGLiteEngine, sql: string, ...rest: unknown[]) {
      const rows = await Reflect.apply(raw, this, [sql, ...rest]);
      if (sql.includes(fragment)) { entered(); await released; }
      return rows;
    },
  });
  return { reached, release };
}

async function jobCount(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_jobs');
  return Number(rows[0]?.n ?? 0);
}

describe('guardAutopilotEngine transaction fence', () => {
  test('block latched after the in-transaction idempotency lookup rolls back the dispatch', async () => withOwner(async (state) => {
    const pause = pauseAfter('WHERE idempotency_key = $1');
    const pending = new MinionQueue(guardAutopilotEngine(engine, state)).add('sync', { sourceId: 'default' }, {
      queue: 'default', idempotency_key: 'fence-after-lookup', maxWaiting: 1,
    });
    await pause.reached;
    state.block('postgres_cancellation_unavailable');
    pause.release();
    await expect(pending).rejects.toThrow('configuration-blocked');
    expect(await jobCount()).toBe(0);
  }));

  test('block latched after the in-transaction insert still rolls back the dispatch', async () => withOwner(async (state) => {
    const pause = pauseAfter('INSERT INTO minion_jobs');
    const pending = new MinionQueue(guardAutopilotEngine(engine, state)).add('sync', { sourceId: 'default' }, {
      queue: 'default', idempotency_key: 'fence-after-insert', maxWaiting: 1,
    });
    await pause.reached;
    state.block('postgres_cancellation_unavailable');
    pause.release();
    await expect(pending).rejects.toThrow('configuration-blocked');
    expect(await jobCount()).toBe(0);
  }));

  test('transactionDirect callback that finishes after blocking rolls back', async () => withOwner(async (state) => {
    const guarded = guardAutopilotEngine(engine, state);
    const pending = guarded.transactionDirect(async (tx) => {
      await tx.executeRaw(`INSERT INTO minion_jobs (name, submission_authority) VALUES ('fence-direct', '{}'::jsonb)`);
      state.block('postgres_cancellation_unavailable');
      return 'done';
    });
    await expect(pending).rejects.toThrow('configuration-blocked');
    expect(await jobCount()).toBe(0);
  }));

  test('nested transactions inherit the guard', async () => withOwner(async (state) => {
    const guarded = guardAutopilotEngine(engine, state);
    let innerRan = false;
    const pending = guarded.transaction(async (tx) => {
      state.block('postgres_cancellation_unavailable');
      return tx.transaction(async () => { innerRan = true; });
    });
    await expect(pending).rejects.toThrow('configuration-blocked');
    expect(innerRan).toBe(false);
  }));

  test('work committed before blocking persists and later dispatch is refused', async () => withOwner(async (state) => {
    const queue = new MinionQueue(guardAutopilotEngine(engine, state));
    const job = await queue.add('sync', { sourceId: 'default' }, { queue: 'default', idempotency_key: 'fence-committed', maxWaiting: 1 });
    state.block('postgres_cancellation_unavailable');
    const rows = await engine.executeRaw<{ id: number; status: string }>('SELECT id, status FROM minion_jobs');
    expect(rows).toEqual([{ id: job.id, status: 'waiting' }]);
    await expect(queue.add('sync', { sourceId: 'other' }, { queue: 'default', idempotency_key: 'fence-refused', maxWaiting: 1 }))
      .rejects.toThrow('configuration-blocked');
    expect(await jobCount()).toBe(1);
  }));

  test('healthy owner dispatches and runs nested direct transactions', async () => withOwner(async (state) => {
    const guarded = guardAutopilotEngine(engine, state);
    const job = await new MinionQueue(guarded).add('sync', { sourceId: 'default' }, { queue: 'default', idempotency_key: 'fence-healthy', maxWaiting: 1 });
    expect(job.status).toBe('waiting');
    const inner = await guarded.transactionDirect(async (tx) => {
      await tx.executeRaw(`INSERT INTO minion_jobs (name, submission_authority) VALUES ('fence-nested', '{}'::jsonb)`);
      return tx.transaction(async (nested) => (await nested.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_jobs'))[0].n);
    });
    expect(Number(inner)).toBe(2);
    expect(await jobCount()).toBe(2);
    expect(state.blocked).toBe(false);
  }));
});
