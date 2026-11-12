/**
 * A status-mode serve over PGLite wraps the engine in the degraded stand-in. After recovery the stand-in must
 * expose the live PGLite engine's own getters (`db`), or the sync lock sees no handle and throws
 * "Unknown engine kind for db-lock: pglite".
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';

import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { createDegradedEngine } from '../src/core/degraded-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let live: PGLiteEngine;

beforeAll(async () => {
  live = new PGLiteEngine();
  await live.connect({ engine: 'pglite' });
  await live.initSchema();
}, 60_000);

afterAll(async () => {
  await live?.disconnect();
});

test('a recovered degraded PGLite engine still takes a db lock', async () => {
  const engine = createDegradedEngine({
    initialError: new Error('startup failure'),
    reconnect: async () => live as unknown as BrainEngine,
    kind: 'pglite',
  });
  // The first call after the swap reports the recovery; later calls reach the live engine.
  await (engine as unknown as { getStats: () => Promise<unknown> }).getStats().catch(() => undefined);
  let outcome: { handle?: unknown; error?: string } = {};
  try {
    outcome = { handle: await tryAcquireDbLock(engine, 'degraded-pglite-lock-test') };
  } catch (error) {
    outcome = { error: error instanceof Error ? error.message : String(error) };
  }
  expect(outcome.error).toBeUndefined();
  expect(outcome.handle).toBeTruthy();
  await (outcome.handle as { release: () => Promise<void> }).release();
}, 60_000);
