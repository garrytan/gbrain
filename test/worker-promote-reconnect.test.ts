import { describe, expect, test } from 'bun:test';
import { MinionWorker } from '../src/core/minions/worker.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function makeEngineWithReconnect(counter: { calls: number }, events: string[]): BrainEngine & { reconnect: () => Promise<void> } {
  return {
    kind: 'postgres',
    reconnect: async () => {
      counter.calls += 1;
      events.push('reconnect');
    },
  } as unknown as BrainEngine & { reconnect: () => Promise<void> };
}

describe('MinionWorker connection recovery', () => {
  test('reconnects after a retryable promoteDelayed connection error before continuing the poll loop', async () => {
    const reconnect = { calls: 0 };
    const events: string[] = [];
    const engine = makeEngineWithReconnect(reconnect, events);
    const worker = new MinionWorker(engine, {
      pollInterval: 1,
      stalledInterval: 60_000,
      healthCheckInterval: 0,
    });
    worker.register('noop', async () => ({ ok: true }));

    let promoted = false;
    let claimCalls = 0;
    (worker as unknown as { queue: {
      ensureSchema: () => Promise<void>;
      promoteDelayed: () => Promise<unknown[]>;
      claim: () => Promise<null>;
      handleStalled: () => Promise<{ requeued: unknown[]; dead: unknown[] }>;
      handleTimeouts: () => Promise<unknown[]>;
      handleWallClockTimeouts: () => Promise<unknown[]>;
    } }).queue = {
      ensureSchema: async () => {},
      promoteDelayed: async () => {
        if (!promoted) {
          promoted = true;
          throw new Error('No database connection: connect() has not been called');
        }
        return [];
      },
      claim: async () => {
        claimCalls += 1;
        events.push('claim');
        worker.stop();
        return null;
      },
      handleStalled: async () => ({ requeued: [], dead: [] }),
      handleTimeouts: async () => [],
      handleWallClockTimeouts: async () => [],
    };

    await worker.start();

    expect(claimCalls).toBe(1);
    expect(reconnect.calls).toBe(1);
    expect(events).toEqual(['reconnect', 'claim']);
  });
});
