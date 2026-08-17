/**
 * W0 fix-wave (Tier-1 #1, D5.6 abort-determinism) — end-to-end lock-steal
 * abort through runCycle.
 *
 * A cycle whose lock row is stolen mid-run must:
 *   1. detect the steal via the background refresher (fenced refresh → false),
 *   2. stop at the next phase boundary (no further phases run),
 *   3. return a STRUCTURED partial report (reason 'lock_stolen') instead of
 *      throwing — completed phases' results are present (their DB writes are
 *      durable, persisted-and-resumable),
 *   4. leave the successor's lock row intact (release is fenced).
 *
 * Serial: mutates GBRAIN_HOME + GBRAIN_CYCLE_LOCK_REFRESH_MS.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle } from '../src/core/cycle.ts';

let engine: PGLiteEngine;
let gbrainHome: string;
let brainDir: string;
const PRIOR_HOME = process.env.GBRAIN_HOME;
const PRIOR_REFRESH = process.env.GBRAIN_CYCLE_LOCK_REFRESH_MS;

beforeAll(async () => {
  // GBRAIN_HOME isolation so the PGLite file lock doesn't touch the real
  // ~/.gbrain/cycle.lock (same pattern as cycle-pglite-lock-ordering).
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-steal-home-'));
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-steal-brain-'));
  process.env.GBRAIN_HOME = gbrainHome;
  // Deterministic fast refresher: 20ms tick against the 200ms in-test sleep.
  process.env.GBRAIN_CYCLE_LOCK_REFRESH_MS = '20';
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  if (PRIOR_HOME === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = PRIOR_HOME;
  if (PRIOR_REFRESH === undefined) delete process.env.GBRAIN_CYCLE_LOCK_REFRESH_MS; else process.env.GBRAIN_CYCLE_LOCK_REFRESH_MS = PRIOR_REFRESH;
  rmSync(gbrainHome, { recursive: true, force: true });
  rmSync(brainDir, { recursive: true, force: true });
});

test('mid-run steal → structured partial report, no further phases, successor row intact', async () => {
  const lockId = 'gbrain-cycle:stealtest';
  let stole = false;

  const report = await runCycle(engine, {
    brainDir,
    sourceId: 'stealtest',
    phases: ['lint', 'backlinks'],
    yieldBetweenPhases: async () => {
      if (stole) return;
      stole = true;
      // Simulate a successor taking the row: new acquisition identity.
      await engine.executeRaw(
        `UPDATE gbrain_cycle_locks
            SET acquired_at = acquired_at + INTERVAL '1 millisecond',
                ttl_expires_at = NOW() + INTERVAL '5 minutes',
                last_refreshed_at = NOW()
          WHERE id = $1`,
        [lockId],
      );
      // Give the 20ms refresher a 1.5s window (75 nominal ticks) to observe
      // the steal — sized for shard-load timer starvation, the flake class
      // db-lock-fencing.test.ts documents (a 200ms window ≈ 10 ticks proved
      // too tight under a loaded suite).
      await new Promise(r => setTimeout(r, 1_500));
    },
  });

  expect(report.status).toBe('partial');
  expect(report.reason).toBe('lock_stolen');
  // lint completed before the steal; backlinks must never have started.
  expect(report.phases.map(p => p.phase)).toEqual(['lint']);

  // The fenced release must NOT have deleted the successor's row.
  const rows = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM gbrain_cycle_locks WHERE id = $1`,
    [lockId],
  );
  expect(rows.length).toBe(1);
  // Cleanup for other suites.
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [lockId]);
});

test('steal-free cycle still completes and releases normally (regression guard)', async () => {
  const report = await runCycle(engine, {
    brainDir,
    sourceId: 'stealtest2',
    phases: ['lint', 'backlinks'],
  });
  expect(report.status === 'ok' || report.status === 'clean' || report.status === 'partial').toBe(true);
  expect(report.reason).not.toBe('lock_stolen');
  expect(report.phases.map(p => p.phase)).toEqual(['lint', 'backlinks']);
  const rows = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM gbrain_cycle_locks WHERE id = $1`,
    ['gbrain-cycle:stealtest2'],
  );
  expect(rows.length).toBe(0);
});

test("source '__all__' on a lock-free phase selection does not throw (regression guard)", async () => {
  // `__all__` is the span-every-source sentinel and deliberately FAILS strict
  // source-id validation (source-id.ts) so it can never leak into lock ids.
  // A lock-free selection acquires no lock at all, so runCycle must never
  // evaluate cycleLockIdFor(opts.sourceId) for it — an unconditional
  // evaluation crashed `gbrain dream --phase orphans --source __all__` with
  // an uncaught `Invalid source_id`.
  const report = await runCycle(engine, {
    brainDir,
    sourceId: '__all__',
    phases: ['orphans'],
  });
  expect(report.phases.map(p => p.phase)).toEqual(['orphans']);
  expect(report.reason).not.toBe('lock_stolen');
});
