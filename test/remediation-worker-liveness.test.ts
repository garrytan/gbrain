/**
 * issue #2116 — `onboard --auto` / `doctor --remediate` submitted remediation
 * jobs with no worker-liveness pre-flight: with workers quiesced, every step
 * burned its full (est_seconds + 60) timeout and aborted silently.
 *
 * hasLiveJobsWorker is the pre-flight runRemediation now runs before the
 * Postgres step loop. Signals: local worker registry (ground truth on this
 * host) OR a DB proxy (any active job with a live lock — a busy worker on
 * another host). GBRAIN_REMEDIATION_ASSUME_WORKER=1 is the escape hatch for
 * an idle remote worker; probe failures fail OPEN.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { withEnv } from './helpers/with-env.ts';
import { hasLiveJobsWorker } from '../src/core/remediation/run.ts';
import { registerWorker } from '../src/core/minions/worker-registry.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function stubEngine(activeCount: string | Error): BrainEngine {
  return {
    kind: 'postgres',
    executeRaw: async () => {
      if (activeCount instanceof Error) throw activeCount;
      return [{ count: activeCount }];
    },
  } as unknown as BrainEngine;
}

/** Fresh empty GBRAIN_HOME (empty worker registry) + no assume-worker escape
 * hatch, restored via withEnv. Tmp dir is intentionally leaked (OS reaps),
 * same as test/helpers/with-env.ts emptyHome(). */
function inEmptyHome<T>(
  fn: () => T | Promise<T>,
  extra: Record<string, string | undefined> = {},
): Promise<T> {
  const tmp = mkdtempSync(join(tmpdir(), 'gbrain-liveness-'));
  return withEnv(
    { GBRAIN_HOME: tmp, GBRAIN_REMEDIATION_ASSUME_WORKER: undefined, ...extra },
    fn,
  );
}

describe('hasLiveJobsWorker (#2116)', () => {
  test('false when registry empty and no active locked jobs — the fix', async () => {
    await inEmptyHome(async () => {
      expect(await hasLiveJobsWorker(stubEngine('0'))).toBe(false);
    });
  });

  test('true when DB shows an active job with a live lock (busy remote worker)', async () => {
    await inEmptyHome(async () => {
      expect(await hasLiveJobsWorker(stubEngine('2'))).toBe(true);
    });
  });

  test('true when a local worker is registered (this-host ground truth)', async () => {
    await inEmptyHome(async () => {
      const cleanup = registerWorker({
        pid: process.pid,
        queue: 'default',
        nice_requested: null,
        nice_effective: null,
        started_at: Date.now(),
      });
      try {
        expect(await hasLiveJobsWorker(stubEngine('0'))).toBe(true);
      } finally {
        cleanup();
      }
    });
  });

  test('GBRAIN_REMEDIATION_ASSUME_WORKER=1 skips the probe (remote idle worker)', async () => {
    await inEmptyHome(
      async () => {
        expect(await hasLiveJobsWorker(stubEngine(new Error('should not be called')))).toBe(true);
      },
      { GBRAIN_REMEDIATION_ASSUME_WORKER: '1' },
    );
  });

  test('fails OPEN when the DB probe throws', async () => {
    await inEmptyHome(async () => {
      expect(await hasLiveJobsWorker(stubEngine(new Error('relation minion_jobs missing')))).toBe(true);
    });
  });
});
