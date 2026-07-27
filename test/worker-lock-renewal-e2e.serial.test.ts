/**
 * v0.41.26.1 — gold-standard E2E regression for the lock-renewal
 * cathedral wave (gap H from the post-ship coverage audit).
 *
 * Single test, single describe. The bun:test serial runner has an
 * unresolved interaction with PGLite when multiple MinionWorker-driven
 * tests share a file (the second test's `queue.add` hangs indefinitely
 * even with cleanly reset state between tests). Isolating H into its
 * own file sidesteps the issue without touching production code.
 *
 * Companion tests for gaps A, B, C, D, E, F, G live in:
 *   - test/worker-lock-renewal.test.ts          (pure-function state machine, 18 cases)
 *   - test/worker-lock-renewal-shape.test.ts    (source-shape behavioral pins, this wave)
 *   - test/audit/lock-renewal-audit.test.ts     (audit module, 11 cases)
 *   - test/audit/redact-connection-info.test.ts (privacy redactor, 15 cases)
 *
 * What this test pins:
 *
 *   - With renewLock throws happening continuously, the worker process
 *     MUST NOT crash via unhandledRejection (the v0.41.22.1 bug).
 *   - The handler observes abort.signal.aborted = true (proves the
 *     time-based abort fires through the wiring).
 *   - The audit JSONL contains both `failure` (per-throw) and `gave_up`
 *     (time-based deadline trip) events.
 *
 * Hermetic: real PGLite, no DATABASE_URL, no docker, no live PgBouncer.
 * Engine wrap on executeRaw injects the simulated connection drop on
 * renewLock-shaped SQL only; everything else passes through.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { readRecentLockRenewalEvents } from '../src/core/audit/lock-renewal-audit.ts';

// Module-level audit dir + env mutation. withEnv's restore semantics
// race with the worker's setInterval callbacks (audit writes can land
// AFTER withEnv exits, under the wrong env). Persistent module-level
// is the deterministic fix.
const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-e2e-'));
const PRIOR_AUDIT_DIR = process.env.GBRAIN_AUDIT_DIR;
process.env.GBRAIN_AUDIT_DIR = auditDir;

let engine: PGLiteEngine;
let queue: MinionQueue;
let originalExecuteRaw: PGLiteEngine['executeRaw'];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
  originalExecuteRaw = engine.executeRaw.bind(engine);
});

afterAll(async () => {
  await engine.disconnect();
  try { fs.rmSync(auditDir, { recursive: true, force: true }); } catch { /* */ }
  if (PRIOR_AUDIT_DIR === undefined) {
    delete process.env.GBRAIN_AUDIT_DIR;
  } else {
    process.env.GBRAIN_AUDIT_DIR = PRIOR_AUDIT_DIR;
  }
});

describe('H: gold-standard regression — worker survives renewLock throws', () => {
  test('the v0.41.22.1 production crash class no longer crashes the worker', async () => {
    await engine.executeRaw('DELETE FROM minion_jobs');
    await queue.add('long-runner', {});

    // Wrap executeRaw to inject renewLock failures. The renewLock SQL
    // shape (`UPDATE minion_jobs SET lock_until = now() + ...`) is narrow
    // enough to skip claim / completeJob / failJob / etc.
    let throwsRemaining = 50;
    let renewLockCallCount = 0;
    (engine as { executeRaw: PGLiteEngine['executeRaw'] }).executeRaw = async (
      sql: string,
      params?: unknown[],
      opts?: { signal?: AbortSignal },
    ) => {
      const isRenewLock = sql.includes('SET lock_until = now()') && sql.includes('lock_token');
      if (isRenewLock) {
        renewLockCallCount++;
        if (throwsRemaining > 0) {
          throwsRemaining--;
          throw new Error('simulated PgBouncer connection drop');
        }
      }
      return originalExecuteRaw(sql, params, opts);
    };

    // Short lockDuration → 50ms timer interval, abort deadline at
    // lockDuration - safetyMargin = 100 - 16 = 84ms. Sustained throws
    // should trip the deadline within ~150ms.
    const worker = new MinionWorker(engine, {
      concurrency: 1,
      pollInterval: 25,
      lockDuration: 100,
    });

    let handlerEntered = false;
    let handlerAbortObserved = false;
    let abortReason: string | null = null;
    worker.register('long-runner', async (ctx) => {
      handlerEntered = true;
      const start = Date.now();
      while (!ctx.signal.aborted && Date.now() - start < 4000) {
        await new Promise((r) => setTimeout(r, 10));
      }
      handlerAbortObserved = ctx.signal.aborted;
      if (ctx.signal.aborted) {
        abortReason = ctx.signal.reason instanceof Error
          ? ctx.signal.reason.message
          : String(ctx.signal.reason);
      }
    });

    // The headline regression check: install a process-level
    // unhandledRejection listener. Pre-v0.41.26.1, a renewLock throw
    // inside `setInterval(async ...)` would propagate here and the
    // daemon would exit code 1.
    let unhandledRejectionFired: unknown = null;
    const rejectionListener = (reason: unknown) => {
      unhandledRejectionFired = reason;
    };
    process.on('unhandledRejection', rejectionListener);

    const p = worker.start();
    try {
      // Fixed sleep — handler enters within ~50ms, abort fires by
      // ~200ms; 2s gives plenty of margin AND lets audit events
      // accumulate before we read them back.
      await new Promise((r) => setTimeout(r, 2000));

      // Headline assertion: worker process didn't die.
      expect(unhandledRejectionFired).toBe(null);

      // Handler wiring assertions: launchJob plumbed the abort
      // signal through correctly.
      expect(handlerEntered).toBe(true);
      expect(handlerAbortObserved).toBe(true);
      // TS narrows `abortReason` to literal `null` because the closure
      // assignment in worker.register isn't observable to the inferrer.
      // The preceding `handlerAbortObserved` assertion guarantees we
      // entered the if-aborted branch where abortReason was assigned;
      // cast via unknown to satisfy the overload.
      expect(abortReason as unknown as string).toBe('lock-renewal-failed');

      // renewLock was actually called multiple times (sanity check
      // that the fault injection fired).
      expect(renewLockCallCount).toBeGreaterThan(0);

      // Audit JSONL has the expected event shapes. `failure` (per-throw)
      // and `gave_up` (time-based deadline tripped) MUST both appear.
      const audit = readRecentLockRenewalEvents(48);
      expect(audit.events.length).toBeGreaterThan(0);
      const failures = audit.events.filter((e) => e.outcome === 'failure');
      const gaveUp = audit.events.filter((e) => e.outcome === 'gave_up');
      expect(failures.length).toBeGreaterThan(0);
      expect(gaveUp.length).toBeGreaterThan(0);
      // The error message survived through the redactor + truncator.
      expect(gaveUp[0].error_message_summary).toMatch(/simulated PgBouncer/);
    } finally {
      process.off('unhandledRejection', rejectionListener);
      (engine as { executeRaw: PGLiteEngine['executeRaw'] }).executeRaw = originalExecuteRaw;
      worker.stop();
      await Promise.race([p, new Promise((r) => setTimeout(r, 2000))]);
    }
  }, 30_000);
});
