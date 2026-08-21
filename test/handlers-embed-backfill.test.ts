/**
 * Tests for src/core/minions/handlers/embed-backfill.ts (v0.40 D2, D6).
 *
 * Validates the handler-side contract:
 *   - Happy path: embeds, returns 'success' with chunk + spend counts
 *   - D2 lock: second concurrent handler call returns 'already_in_progress'
 *   - D15.1 finally: lock ALWAYS releases (try/finally even on abort)
 *
 * Hermetic — uses injected embedFn via the underlying embedStaleForSource
 * test seam? No — the handler doesn't expose embedFn passthrough. Instead
 * we exercise the handler against a brain with zero stale chunks so no
 * actual embed call lands. That gives us a deterministic test of the lock
 * + budget + status branches without needing a fake gateway.
 *
 * The kill-resume contract is covered by test/embed-stale.test.ts at the
 * helper layer; the handler just routes through.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeEmbedBackfillHandler } from '../src/core/minions/handlers/embed-backfill.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Clean minion_jobs + lock rows. Preserve config (schema version + flags).
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id LIKE 'gbrain-embed-backfill:%'`);
});

/** Build a minimal MinionJobContext for testing. */
function fakeJob(data: Record<string, unknown>): MinionJobContext {
  const controller = new AbortController();
  return {
    id: 1,
    name: 'embed-backfill',
    data,
    attempts_made: 0,
    signal: controller.signal,
    deadlineAtMs: null,
    shutdownSignal: controller.signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
}

describe('embed-backfill handler — happy path', () => {
  test('zero stale chunks → success with embedded=0', async () => {
    const handler = makeEmbedBackfillHandler(engine);
    const result = await handler(fakeJob({ sourceId: 'default' }));
    expect(result).toMatchObject({
      status: 'success',
      sourceId: 'default',
      embedded: 0,
      chunksProcessed: 0,
      pagesProcessed: 0,
    });
  });

  test('throws when sourceId missing', async () => {
    const handler = makeEmbedBackfillHandler(engine);
    await expect(handler(fakeJob({}))).rejects.toThrow(/sourceId is required/);
  });

  test('throws when sourceId is empty string', async () => {
    const handler = makeEmbedBackfillHandler(engine);
    await expect(handler(fakeJob({ sourceId: '' }))).rejects.toThrow(/sourceId is required/);
  });
});

describe('embed-backfill handler — D2 lock contract', () => {
  test('IRON-RULE: second call returns already_in_progress when lock is held', async () => {
    // Hold the per-source lock externally
    const lock = await tryAcquireDbLock(engine, 'gbrain-embed-backfill:default', 60);
    expect(lock).not.toBeNull();

    try {
      const handler = makeEmbedBackfillHandler(engine);
      const result = await handler(fakeJob({ sourceId: 'default' }));
      expect(result).toMatchObject({
        status: 'already_in_progress',
        sourceId: 'default',
        embedded: 0,
        spentUsd: 0,
      });
    } finally {
      await lock?.release();
    }
  });

  test('different sources do not contend on each other locks', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other-src', 'other-src', '{"federated":true}') ON CONFLICT (id) DO NOTHING`,
    );
    const lockA = await tryAcquireDbLock(engine, 'gbrain-embed-backfill:default', 60);
    expect(lockA).not.toBeNull();
    try {
      // 'other-src' should still succeed
      const handler = makeEmbedBackfillHandler(engine);
      const result = await handler(fakeJob({ sourceId: 'other-src' }));
      expect(result.status).toBe('success');
    } finally {
      await lockA?.release();
    }
  });

  test('IRON-RULE: lock is released after handler completes (try/finally)', async () => {
    const handler = makeEmbedBackfillHandler(engine);
    await handler(fakeJob({ sourceId: 'default' }));

    // After handler returns, the lock row should NOT block a fresh acquire.
    const lock = await tryAcquireDbLock(engine, 'gbrain-embed-backfill:default', 60);
    expect(lock).not.toBeNull();
    await lock?.release();
  });

  test('IRON-RULE: lock released on throw (sourceId-missing path)', async () => {
    const handler = makeEmbedBackfillHandler(engine);
    try {
      await handler(fakeJob({})); // throws before lock is acquired
    } catch {
      // expected
    }
    // Lock was never acquired (throw happened in parseParams pre-lock),
    // so the row should be cleanly absent. Verify a fresh acquire works.
    const lock = await tryAcquireDbLock(engine, 'gbrain-embed-backfill:default', 60);
    expect(lock).not.toBeNull();
    await lock?.release();
  });
});

// ────────────────────────────────────────────────────────────────
// #4283 — honesty gates. The incident: a misconfigured worker NULLed
// 60,434 embeddings, embedded 0, spent $0, and reported success — 12 runs
// in a row. A run that embeds nothing while having work to do must FAIL
// the job (loud, retried, visible), never report success.
// ────────────────────────────────────────────────────────────────

describe('embed-backfill handler — #4283 honesty gates', () => {
  const drainBase = { pagesProcessed: 0, lastCursor: null, done: true, aborted: false };

  test('IRON-RULE: invalidated > 0 with embedded 0 → job FAILS instead of reporting success', async () => {
    const handler = makeEmbedBackfillHandler(engine, {
      runStale: async () => ({ ...drainBase, embedded: 0, chunksProcessed: 60434, invalidated: 60434 }),
    });
    await expect(handler(fakeJob({ sourceId: 'default' }))).rejects.toThrow(/refusing to report success/);
  });

  test('chunksProcessed > 0 with embedded 0 (every page log-skipped) also fails', async () => {
    const handler = makeEmbedBackfillHandler(engine, {
      runStale: async () => ({ ...drainBase, embedded: 0, chunksProcessed: 120, invalidated: 0 }),
    });
    await expect(handler(fakeJob({ sourceId: 'default' }))).rejects.toThrow(/embedded 0 of 120/);
  });

  test('lock is released after the honesty throw (next run can claim)', async () => {
    const handler = makeEmbedBackfillHandler(engine, {
      runStale: async () => ({ ...drainBase, embedded: 0, chunksProcessed: 10, invalidated: 10 }),
    });
    await expect(handler(fakeJob({ sourceId: 'default' }))).rejects.toThrow();
    const lock = await tryAcquireDbLock(engine, 'gbrain-embed-backfill:default', 60);
    expect(lock).not.toBeNull();
    await lock?.release();
  });

  test('aborted partial run with embedded 0 stays status=aborted (resumable, not a defect)', async () => {
    const handler = makeEmbedBackfillHandler(engine, {
      runStale: async () => ({ ...drainBase, embedded: 0, chunksProcessed: 5, invalidated: 5, done: false, aborted: true }),
    });
    const result = await handler(fakeJob({ sourceId: 'default' }));
    expect(result).toMatchObject({ status: 'aborted', embedded: 0, invalidated: 5 });
  });

  test('success carries invalidated + invalidationSkipped counts in the job result row', async () => {
    const handler = makeEmbedBackfillHandler(engine, {
      runStale: async () => ({
        ...drainBase, embedded: 7, chunksProcessed: 7, invalidated: 3,
        invalidationSkipped: 'embedder_probe_failed' as const,
      }),
    });
    const result = await handler(fakeJob({ sourceId: 'default' }));
    expect(result).toMatchObject({
      status: 'success',
      embedded: 7,
      invalidated: 3,
      invalidationSkipped: 'embedder_probe_failed',
    });
  });
});
