/**
 * Global-maintenance freshness stamp gate.
 *
 * A global-maintenance cycle must NOT advance `autopilot.last_global_at` when a
 * required phase failed (any attempted phase with status `fail`), so the failed
 * phase re-dispatches next tick instead of being deferred up to
 * GLOBAL_FLOOR_MIN. Warn-only partials and completed runs still stamp.
 *
 * DISCRIMINATION: the behavioral case (A) drives the REAL
 * `autopilot-global-maintenance` handler and asserts the stamp is withheld on a
 * fail-bearing partial. Revert the fix and it flips (the handler's old guard
 * stamps every {ok,clean,partial}):
 *   bash scripts/check-test-discriminates.sh \
 *     test/cycle/global-freshness-stamp-gate.serial.test.ts src/commands/jobs.ts
 *
 * Serial: mock.module (embed) is process-wide.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbed from '../../src/commands/embed.ts';

// The failing required phase: embed throws whenever it reaches runEmbedCore.
mock.module('../../src/commands/embed.ts', () => ({
  ...realEmbed,
  runEmbedCore: async () => { throw new Error('synthetic embed failure (required global phase)'); },
}));

const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
const { registerBuiltinHandlers } = await import('../../src/commands/jobs.ts');
const { LAST_GLOBAL_AT_KEY, globalMaintenanceMayStamp } = await import('../../src/core/cycle.ts');
const { resetPgliteState } = await import('../helpers/reset-pglite.ts');
import type { CycleReport, PhaseResult } from '../../src/core/cycle.ts';

type Engine = InstanceType<typeof PGLiteEngine>;
let engine: Engine;

async function globalMaintenanceHandler() {
  const handlers = new Map<string, (job: unknown) => Promise<{ report: CycleReport }>>();
  const fakeWorker = { register(name: string, fn: (job: unknown) => Promise<{ report: CycleReport }>) { handlers.set(name, fn); } };
  await registerBuiltinHandlers(fakeWorker as never, engine);
  const h = handlers.get('autopilot-global-maintenance');
  if (!h) throw new Error('autopilot-global-maintenance handler not registered');
  return h;
}

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({ database_url: '' }); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

// ── Behavioral: drives the real handler (the discriminating cases) ──
describe('autopilot-global-maintenance stamp gate (behavioral)', () => {
  test('A · fail-bearing partial (required embed phase failed) does NOT stamp last_global_at', async () => {
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
    const repoPath = mkdtempSync(join(tmpdir(), 'gfg-fail-'));
    // Seed an un-embedded page so the embed phase actually reaches runEmbedCore.
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ($1,$2,$3)`, ['repo-a', 'repo-a', repoPath]);
    await engine.putPage('atoms/gfg-a', { type: 'note', title: 'A', compiled_truth: 'body', timeline: '' }, { sourceId: 'repo-a' });

    const handler = await globalMaintenanceHandler();
    // orphans (global) succeeds; embed (global) throws → a fail-bearing partial.
    const result = await handler({ id: 7001, data: { phases: ['orphans', 'embed'], repoPath }, signal: undefined });
    const embed = result.report.phases.find((p) => p.phase === 'embed');
    // eslint-disable-next-line no-console
    console.log(`[gfg A] status=${result.report.status} embed=${embed?.status} last_global_at=${await engine.getConfig(LAST_GLOBAL_AT_KEY)}`);
    expect(embed?.status).toBe('fail');
    expect(result.report.status).toBe('partial');
    // The fix: freshness is withheld, so the dispatch gate stays due next tick.
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
  }, 60_000);

  test('B · a completed run with no failed phase still stamps last_global_at', async () => {
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
    const repoPath = mkdtempSync(join(tmpdir(), 'gfg-ok-'));
    const handler = await globalMaintenanceHandler();
    // orphans only (no embed) → no failed phase → status ok/clean/partial(warn).
    const result = await handler({ id: 7002, data: { phases: ['orphans'], repoPath }, signal: undefined });
    // eslint-disable-next-line no-console
    console.log(`[gfg B] status=${result.report.status} last_global_at=${await engine.getConfig(LAST_GLOBAL_AT_KEY)}`);
    expect(result.report.phases.some((p) => p.status === 'fail')).toBe(false);
    expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).not.toBeNull();
  }, 60_000);
});

// ── Predicate truth table (the single source of truth the handler calls) ──
describe('globalMaintenanceMayStamp (predicate)', () => {
  const mk = (status: CycleReport['status'], phaseStatuses: PhaseResult['status'][]): Pick<CycleReport, 'status' | 'phases'> => ({
    status,
    phases: phaseStatuses.map((s, i) => ({ phase: `p${i}` as PhaseResult['phase'], status: s, duration_ms: 0, summary: '', details: {} })),
  });
  test('completed and warn-only partials stamp; any failed phase (or failed/skipped run) does not', () => {
    expect(globalMaintenanceMayStamp(mk('ok', ['ok', 'ok']))).toBe(true);
    expect(globalMaintenanceMayStamp(mk('clean', []))).toBe(true);
    expect(globalMaintenanceMayStamp(mk('partial', ['ok', 'warn']))).toBe(true);   // warn-only partial still stamps
    expect(globalMaintenanceMayStamp(mk('partial', ['ok', 'fail']))).toBe(false);  // fail-bearing partial does not
    expect(globalMaintenanceMayStamp(mk('partial', ['warn', 'fail']))).toBe(false);
    expect(globalMaintenanceMayStamp(mk('failed', ['fail', 'fail']))).toBe(false);
    expect(globalMaintenanceMayStamp(mk('skipped', []))).toBe(false);
  });
});
