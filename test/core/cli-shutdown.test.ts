import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { disconnectEngineForCliExit } from '../../src/core/cli-shutdown.ts';
import {
  __registerDrainerForTest,
  type BackgroundWorkDrainer,
} from '../../src/core/background-work.ts';

describe('CLI shutdown helper', () => {
  test('drains unfinished background work and awaited aborts before engine.disconnect', async () => {
    const calls: string[] = [];
    const drainer: BackgroundWorkDrainer = {
      name: 'test-cli-shutdown-order',
      order: -100,
      drain: async () => {
        calls.push('drain');
        return { unfinished: 1 };
      },
      abort: async () => {
        calls.push('abort');
      },
    };
    const unregister = __registerDrainerForTest(drainer);
    const engine = {
      disconnect: async () => {
        calls.push('disconnect');
      },
    } as BrainEngine;

    try {
      await disconnectEngineForCliExit(engine, { timeoutMs: 25 });
      expect(calls).toEqual(['drain', 'abort', 'disconnect']);
    } finally {
      unregister();
    }
  });
});
