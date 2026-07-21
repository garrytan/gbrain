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

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { hasLiveJobsWorker } from '../src/core/remediation/run.ts';
import { registerWorker } from '../src/core/minions/worker-registry.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let tmp: string;
let envHome: string | undefined;
let envAssume: string | undefined;

function stubEngine(activeCount: string | Error): BrainEngine {
  return {
    kind: 'postgres',
    executeRaw: async () => {
      if (activeCount instanceof Error) throw activeCount;
      return [{ count: activeCount }];
    },
  } as unknown as BrainEngine;
}

beforeEach(() => {
  envHome = process.env.GBRAIN_HOME;
  envAssume = process.env.GBRAIN_REMEDIATION_ASSUME_WORKER;
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-liveness-'));
  process.env.GBRAIN_HOME = tmp; // empty worker registry
  delete process.env.GBRAIN_REMEDIATION_ASSUME_WORKER;
});

afterEach(() => {
  if (envHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = envHome;
  if (envAssume === undefined) delete process.env.GBRAIN_REMEDIATION_ASSUME_WORKER;
  else process.env.GBRAIN_REMEDIATION_ASSUME_WORKER = envAssume;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('hasLiveJobsWorker (#2116)', () => {
  test('false when registry empty and no active locked jobs — the fix', async () => {
    expect(await hasLiveJobsWorker(stubEngine('0'))).toBe(false);
  });

  test('true when DB shows an active job with a live lock (busy remote worker)', async () => {
    expect(await hasLiveJobsWorker(stubEngine('2'))).toBe(true);
  });

  test('true when a local worker is registered (this-host ground truth)', async () => {
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

  test('GBRAIN_REMEDIATION_ASSUME_WORKER=1 skips the probe (remote idle worker)', async () => {
    process.env.GBRAIN_REMEDIATION_ASSUME_WORKER = '1';
    expect(await hasLiveJobsWorker(stubEngine(new Error('should not be called')))).toBe(true);
  });

  test('fails OPEN when the DB probe throws', async () => {
    expect(await hasLiveJobsWorker(stubEngine(new Error('relation minion_jobs missing')))).toBe(true);
  });
});
