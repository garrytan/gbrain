import { describe, expect, test } from 'bun:test';
import {
  awaitPendingLastRetrievedWrites,
  bumpLastRetrievedAt,
  _resetTrackRetrievalCacheForTests,
} from '../src/core/last-retrieved.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('last_retrieved_at write-back draining', () => {
  test('awaitPendingLastRetrievedWrites waits for fire-and-forget bumps', async () => {
    _resetTrackRetrievalCacheForTests();
    let executed = false;
    const engine = {
      getConfig: async () => undefined,
      executeRaw: async () => {
        await delay(25);
        executed = true;
      },
    } as unknown as BrainEngine;

    bumpLastRetrievedAt(engine, [1, 2]);
    expect(executed).toBe(false);

    await awaitPendingLastRetrievedWrites();
    expect(executed).toBe(true);
  });

  test('disabled tracking bumps drain without executing update', async () => {
    _resetTrackRetrievalCacheForTests();
    let executed = false;
    const engine = {
      getConfig: async () => 'false',
      executeRaw: async () => {
        executed = true;
      },
    } as unknown as BrainEngine;

    bumpLastRetrievedAt(engine, [1]);
    await awaitPendingLastRetrievedWrites();
    expect(executed).toBe(false);
  });
});
