/**
 * REGRESSION (iron rule) for the per-phase job wrappers (makePhaseHandler in
 * jobs.ts) after the brain-dir resolver refactor:
 *
 *   1. a payload WITHOUT source_id still resolves the global sync.repo_path
 *      and takes the legacy `gbrain-cycle` lock exactly as before;
 *   2. a payload WITH source_id takes the per-source lock and the source's
 *      own checkout (new: the weekly facts job can never run under the
 *      legacy lock against the global checkout);
 *   3. a configured-but-absent global path is `no_brain_dir` (skip), not a
 *      "Directory not found" throw inside the phase (the root cause behind
 *      the 2026-08 cycle dead-letter storm on the Modal plane);
 *   4. an explicit repoPath that does not exist FAILS the job with the reason
 *      (never a worker crash, never a run against the worker's cwd).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { cycleLockIdFor } from '../src/core/cycle.ts';
import { GLOBAL_REPO_PATH_KEY } from '../src/core/brain-dir.ts';

const PHASE = 'recompute_emotional_weight'; // DB-only, cheap, lock-taking
const MISSING = '/nonexistent/gbrain-phase-handler-test/checkout';

let engine: PGLiteEngine;
let gbrainHome: string;
let checkout: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-phase-handler-home-'));
  checkout = mkdtempSync(join(tmpdir(), 'gbrain-phase-handler-checkout-'));
});
afterEach(() => {
  rmSync(gbrainHome, { recursive: true, force: true });
  rmSync(checkout, { recursive: true, force: true });
});

async function captureHandlers() {
  const handlers = new Map<string, (job: any) => Promise<any>>();
  const fakeWorker = { register(name: string, fn: (job: any) => Promise<any>) { handlers.set(name, fn); } };
  await registerBuiltinHandlers(fakeWorker as never, engine);
  const h = handlers.get(PHASE);
  if (!h) throw new Error(`${PHASE} handler not registered`);
  return h;
}

describe('makePhaseHandler: legacy payload (no source_id)', () => {
  test('resolves the global sync.repo_path and reports brain_dir_reason=global', async () => {
    await engine.setConfig(GLOBAL_REPO_PATH_KEY, checkout);
    const handler = await captureHandlers();
    const result = await withEnv({ GBRAIN_HOME: gbrainHome }, () => handler({ id: 1, data: {}, signal: undefined }));
    expect(result.phase).toBe(PHASE);
    expect(result.brain_dir_reason).toBe('global');
    expect(result.report.brain_dir).toBe(resolve(checkout));
    expect(result.report.status).not.toBe('skipped');
  });

  test('takes the LEGACY gbrain-cycle lock: a held legacy lock makes the run skip as cycle_already_running', async () => {
    await engine.setConfig(GLOBAL_REPO_PATH_KEY, checkout);
    const handler = await captureHandlers();
    const held = await tryAcquireDbLock(engine, cycleLockIdFor(undefined), 5);
    expect(held).not.toBeNull();
    try {
      const result = await withEnv({ GBRAIN_HOME: gbrainHome }, () => handler({ id: 2, data: {}, signal: undefined }));
      expect(result.report.status).toBe('skipped');
      expect(result.report.reason).toBe('cycle_already_running');
    } finally {
      await held!.release();
    }
  });

  test('a configured-but-absent global path is no_brain_dir, not a throw', async () => {
    await engine.setConfig(GLOBAL_REPO_PATH_KEY, MISSING);
    const handler = await captureHandlers();
    const result = await withEnv({ GBRAIN_HOME: gbrainHome }, () => handler({ id: 3, data: {}, signal: undefined }));
    expect(result.brain_dir_reason).toBe('global_missing');
    expect(result.report.brain_dir).toBeNull();
    // The DB-only phase still ran (no fail record, no throw).
    const rec = result.report.phases.find((p: any) => p.phase === PHASE);
    expect(rec).toBeTruthy();
    expect(rec.status).not.toBe('fail');
  });

  test('an explicit repoPath that does not exist fails the job with the reason', async () => {
    const handler = await captureHandlers();
    await expect(
      withEnv({ GBRAIN_HOME: gbrainHome }, () => handler({ id: 4, data: { repoPath: MISSING }, signal: undefined })),
    ).rejects.toThrow(/explicit_missing/);
  });
});

describe('makePhaseHandler: source-scoped payload (source_id)', () => {
  test('takes the per-source lock, so a held LEGACY lock does not block it; binds to the source checkout', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('wiki', 'wiki', $1)`, [checkout]);
    await engine.setConfig(GLOBAL_REPO_PATH_KEY, MISSING); // must be ignored for a scoped job
    const handler = await captureHandlers();
    const held = await tryAcquireDbLock(engine, cycleLockIdFor(undefined), 5);
    expect(held).not.toBeNull();
    try {
      const result = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
        handler({ id: 5, data: { source_id: 'wiki' }, signal: undefined }));
      expect(result.report.status).not.toBe('skipped');
      expect(result.brain_dir_reason).toBe('source_path');
      expect(result.report.brain_dir).toBe(resolve(checkout));
    } finally {
      await held!.release();
    }
  });

  test('a held per-source lock makes the scoped run skip', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('wiki', 'wiki', NULL)`);
    const handler = await captureHandlers();
    const held = await tryAcquireDbLock(engine, cycleLockIdFor('wiki'), 5);
    expect(held).not.toBeNull();
    try {
      const result = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
        handler({ id: 6, data: { source_id: 'wiki' }, signal: undefined }));
      expect(result.report.status).toBe('skipped');
      expect(result.report.reason).toBe('cycle_already_running');
    } finally {
      await held!.release();
    }
  });

  test('a malformed source_id fails the job before any cycle code runs', async () => {
    const handler = await captureHandlers();
    await expect(handler({ id: 7, data: { source_id: 'not valid!' }, signal: undefined })).rejects.toThrow(/invalid source_id/);
  });
});
