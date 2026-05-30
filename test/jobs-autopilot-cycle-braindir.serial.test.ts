/**
 * v0.41.30.0 (T2) — the Minions `autopilot-cycle` handler runs on a
 * checkout-less brain.
 *
 * Pre-fix jobs.ts defaulted repoPath to cwd `'.'` when no repo was configured,
 * then fed that into runCycle — so a queued cycle (what `gbrain remote ping`
 * triggers) on a checkout-less postgres brain ran filesystem phases against the
 * worker's cwd instead of skipping them. Now it passes `null`, so the handler
 * follows the same no_brain_dir contract as `gbrain dream`.
 *
 * Drives the REAL handler (captured from registerBuiltinHandlers) — not a
 * source-grep — so a future refactor that reintroduces the '.' fallback fails
 * here. PGLite in-memory.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** Capture registered handlers via a minimal fake worker. */
async function captureHandlers(): Promise<Map<string, (job: any) => Promise<any>>> {
  const handlers = new Map<string, (job: any) => Promise<any>>();
  const fakeWorker = { register(name: string, fn: (job: any) => Promise<any>) { handlers.set(name, fn); } };
  await registerBuiltinHandlers(fakeWorker as never, engine);
  return handlers;
}

describe('jobs autopilot-cycle handler — no repo configured', () => {
  test('feeds null brainDir → filesystem phases skip (no_brain_dir), DB phases run', async () => {
    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-cycle');
    expect(handler).toBeTruthy();

    // No sync.repo_path config on a fresh brain, no repoPath in job data →
    // the handler must pass null (not cwd '.') to runCycle.
    const result = await handler!({
      data: { phases: ['lint', 'resolve_symbol_edges'] },
      signal: undefined,
    });

    const report = result.report;
    expect(report.brain_dir).toBeNull();
    const lint = report.phases.find((p: any) => p.phase === 'lint');
    expect(lint?.status).toBe('skipped');
    expect(lint?.details?.reason).toBe('no_brain_dir');
    const rse = report.phases.find((p: any) => p.phase === 'resolve_symbol_edges');
    expect(rse).toBeTruthy();
    expect(rse?.details?.reason).not.toBe('no_brain_dir');
    expect(rse?.status).not.toBe('fail');
  });
});
