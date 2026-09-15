/**
 * Dream per-phase publication safety: CHARACTERIZATION vs
 * NORMATIVE controls. gbrain 0.50.0.0. Synthetic PGLite + temp git
 * repo + deterministic fault seams only — NO live Dream, brain, private corpus,
 * service, scheduler, credential, or Signal. Test/fixture only.
 *
 *  - `describe('CHARACTERIZES …')` blocks record what the shipped code does today
 *    (they may pass on behaviour the report flags as risky — that is the point).
 *  - `describe('NORMATIVE …')` blocks assert the SAFE invariant, so they FAIL if
 *    the behaviour is unsafe. The global-freshness control passes against
 *    `globalMaintenanceMayStamp`: a fail-bearing partial no longer advances
 *    global freshness. The discriminating regression for that fix lives in
 *    `global-freshness-stamp-gate.serial.test.ts`.
 *
 * Serial: mock.module (embed) + process.env (GBRAIN_HOME) + method overrides.
 */

import { describe, test, expect, beforeAll, afterAll, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realEmbed from '../../src/commands/embed.ts';
import * as importFiles from '../../src/core/import-file.ts';

// Embed seam: make the embed (index) phase fail. Only the embed-failure cases use it.
mock.module('../../src/commands/embed.ts', () => ({
  ...realEmbed,
  runEmbedCore: async () => { throw new Error('synthetic embed failure (index phase)'); },
}));

const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
const { runCycle, deriveStatus, runPhaseLint, globalMaintenanceMayStamp } = await import('../../src/core/cycle.ts');
const { isGlobalMaintenanceStale } = await import('../../src/commands/autopilot-fanout.ts');
import type { PhaseResult, CycleReport } from '../../src/core/cycle.ts';

type Engine = InstanceType<typeof PGLiteEngine>;
let engine: Engine;
let gbrainHome: string;
let brainDir: string;
const PRIOR_HOME = process.env.GBRAIN_HOME;

const ZERO_TOTALS: CycleReport['totals'] = {
  lint_fixes: 0, backlinks_added: 0, pages_synced: 0, pages_extracted: 0, pages_embedded: 0,
  orphans_found: 0, transcripts_processed: 0, synth_pages_written: 0, patterns_written: 0,
  pages_emotional_weight_recomputed: 0, edges_resolved: 0, edges_ambiguous: 0,
  purged_sources_count: 0, purged_pages_count: 0, facts_consolidated: 0, consolidate_takes_written: 0,
  phantoms_redirected: 0, phantoms_ambiguous: 0, phantoms_skipped_drift: 0,
};
const pr = (phase: string, status: PhaseResult['status']): PhaseResult =>
  ({ phase: phase as PhaseResult['phase'], status, duration_ms: 1, summary: '', details: {} });
const stamp = async (id: string): Promise<string | null> =>
  (await engine.executeRaw<{ v: string | null }>(`SELECT config->>'last_full_cycle_at' AS v FROM sources WHERE id = $1`, [id]))[0]?.v ?? null;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

beforeAll(async () => {
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-dps-home-'));
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-dps-brain-'));
  process.env.GBRAIN_HOME = gbrainHome;
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('dps', 'dps') ON CONFLICT (id) DO NOTHING`);
}, 180_000);

afterAll(async () => {
  await engine.disconnect();
  if (PRIOR_HOME === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = PRIOR_HOME;
  rmSync(gbrainHome, { recursive: true, force: true });
  rmSync(brainDir, { recursive: true, force: true });
});

// ══════════ CHARACTERIZES current shipped behaviour ══════════
describe('CHARACTERIZES current shipped behaviour', () => {
  test('#1 completed cycle with a warn → deriveStatus=partial; report is valid', async () => {
    expect(deriveStatus([pr('lint', 'ok'), pr('orphans', 'warn')], ZERO_TOTALS)).toBe('partial');
    const report = await runCycle(engine, { brainDir, phases: [], sourceId: 'dps' });
    expect(report.schema_version).toBe('1');
  });

  test('#2 status aggregation: one fail among ok → partial; all fail → failed', () => {
    expect(deriveStatus([pr('lint', 'ok'), pr('embed', 'fail')], ZERO_TOTALS)).toBe('partial');
    expect(deriveStatus([pr('lint', 'fail')], ZERO_TOTALS)).toBe('failed');
  });

  test('#6c a partial cycle whose INDEX phase (embed) failed STILL stamps last_full_cycle_at (the risk)', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('dps-idx','dps-idx') ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('atoms/dps-idx-page', { type: 'note', title: 'P', compiled_truth: 'servable body', timeline: '' }, { sourceId: 'dps-idx' });
    const before = await stamp('dps-idx');
    const report = await runCycle(engine, { brainDir, sourceId: 'dps-idx', phases: ['lint', 'embed'] });
    const embed = report.phases.find((p) => p.phase === 'embed');
    const after = await stamp('dps-idx');
    // eslint-disable-next-line no-console
    console.log(`[dps #6c] status=${report.status} embed=${embed?.status} page_servable=${(await engine.getPage('atoms/dps-idx-page', { sourceId: 'dps-idx' })) !== null} stamp before=${before} after=${after}`);
    expect(embed?.status).toBe('fail');
    expect(report.status).toBe('partial');
    expect(after).not.toBe(before); // characterizes: the source is marked fresh despite the failed index phase
  });

  test('#4c published rows are not rolled back by a LATER failed cycle (pre-existing data)', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('dps-mw','dps-mw') ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('atoms/dps-mw-a', { type: 'note', title: 'A', compiled_truth: 'body a', timeline: '' }, { sourceId: 'dps-mw' });
    const report = await runCycle(engine, { brainDir, sourceId: 'dps-mw', phases: ['embed'] }); // embed seam throws → failed
    expect(report.status).toBe('failed');
    expect(await engine.getPage('atoms/dps-mw-a', { sourceId: 'dps-mw' })).not.toBeNull();
  });
});

// ══════════ NORMATIVE fail-on-unsafe controls ══════════
describe('NORMATIVE fail-on-unsafe controls', () => {
  test('#3 a phase that throws BEFORE its write → fail, ZERO rows written', async () => {
    const before = (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages`))[0].n;
    const result = await runPhaseLint('/definitely/nonexistent/brain/dir', false, engine);
    expect(result.status).toBe('fail');
    expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages`))[0].n).toBe(before);
  });

  test('#5 lock-steal between phases → partial, halts, and does NOT mark the source fresh', async () => {
    const PRIOR = process.env.GBRAIN_CYCLE_LOCK_REFRESH_MS;
    process.env.GBRAIN_CYCLE_LOCK_REFRESH_MS = '20';
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('dps-steal','dps-steal') ON CONFLICT (id) DO NOTHING`);
    const lockId = 'gbrain-cycle:dps-steal';
    const before = await stamp('dps-steal');
    let stole = false;
    try {
      const report = await runCycle(engine, {
        brainDir, sourceId: 'dps-steal', phases: ['lint', 'backlinks'],
        yieldBetweenPhases: async () => {
          if (stole) return; stole = true;
          await engine.executeRaw(`UPDATE gbrain_cycle_locks SET acquired_at = acquired_at + INTERVAL '1 millisecond', ttl_expires_at = NOW() + INTERVAL '5 minutes', last_refreshed_at = NOW() WHERE id = $1`, [lockId]);
          await new Promise((r) => setTimeout(r, 1_500));
        },
      });
      expect(report.status).toBe('partial');
      expect(report.reason).toBe('lock_stolen');
      expect(await stamp('dps-steal')).toBe(before); // SAFE: a stolen run must not mark fresh
    } finally {
      if (PRIOR === undefined) delete process.env.GBRAIN_CYCLE_LOCK_REFRESH_MS; else process.env.GBRAIN_CYCLE_LOCK_REFRESH_MS = PRIOR;
    }
  });

  test('#7 a stamp-emission failure is truthfully receipted (partial + stamp_write_failed)', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('dps-stamp','dps-stamp') ON CONFLICT (id) DO NOTHING`);
    const orig = engine.updateSourceConfig.bind(engine);
    (engine as unknown as { updateSourceConfig: unknown }).updateSourceConfig = async () => { throw new Error('synthetic stamp write failure'); };
    try {
      const report = await runCycle(engine, { brainDir, sourceId: 'dps-stamp', phases: ['lint'] });
      expect(report.status).toBe('partial');
      expect(report.reason).toBe('stamp_write_failed');
      expect(report.stamp_write_failed?.source_id).toBe('dps-stamp');
    } finally {
      (engine as unknown as { updateSourceConfig: typeof orig }).updateSourceConfig = orig;
    }
  });

  // #4 (DECISIVE) real same-phase mid-multi-write in the `sync` phase, interrupted
  // BETWEEN files via the shipped abort seam (the real mid-phase-stop class:
  // deadline / lock-steal / SIGINT). Write 1's transaction commits; the phase then
  // sees `signal.aborted` at the next file and stops before write 2. (A fault
  // *inside* a write instead deadlocks PGLite's non-reentrant transaction mutex —
  // sync.ts:3173 — which is a test artifact, not a publication-safety fact.)
  // Runs on a DEDICATED engine so a mid-phase interruption cannot poison the
  // shared connection. Two claims, kept distinct:
  //   • CHARACTERIZATION: the interrupted phase leaves exactly one page servable
  //     (no per-phase transaction spans the multi-write).
  //   • NORMATIVE (convergence evidence for sync): the next idempotent sync converges
  //     to BOTH pages (D4 invariant never advances last_commit on a partial sync).
  //     This assertion FAILS if sync does not self-heal.
  test('#4 real sync mid-write (abort between files): exactly one page servable; next sync converges', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-dps-sync-'));
    git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'sync-a.md'), '---\ntitle: A\ntype: note\n---\n\nbody a\n');
    writeFileSync(join(dir, 'sync-b.md'), '---\ntitle: B\ntype: note\n---\n\nbody b\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed');

    const e4 = new PGLiteEngine();
    await e4.connect({ database_url: '' });
    await e4.initSchema();
    const sid = 'dps-syncsrc';
    await e4.executeRaw(`INSERT INTO sources (id,name,local_path) VALUES ($1,$1,$2)`, [sid, dir]);

    // Interrupt BETWEEN files at the per-file boundary (the repo's own clean
    // technique — test/import-cancellation.serial.test.ts): let file 1 import
    // fully (its transaction commits), then abort so the loop stops before file 2.
    // A fault INSIDE a write deadlocks PGLite's non-reentrant tx mutex instead.
    const controller = new AbortController();
    const originalImport = importFiles.importFile;
    let calls = 0;
    const importSpy = spyOn(importFiles, 'importFile').mockImplementation(async (...args: Parameters<typeof importFiles.importFile>) => {
      const result = await originalImport(...args);
      if (++calls === 1) controller.abort();
      return result;
    });
    let syncStatus1 = 'unknown';
    let imported1 = -1;
    try {
      const r1 = await performSync(e4, { repoPath: dir, sourceId: sid, noPull: true, noEmbed: true, noExtract: true, concurrency: 1, signal: controller.signal });
      syncStatus1 = r1.status; imported1 = r1.filesImported ?? -1;
    } catch (e) { syncStatus1 = `throw:${e instanceof Error ? e.name : String(e)}`; }
    importSpy.mockRestore();

    const aMid = await e4.getPage('sync-a', { sourceId: sid });
    const bMid = await e4.getPage('sync-b', { sourceId: sid });
    const servableMid = [aMid, bMid].filter((p) => p !== null).length;
    const lastCommitMid = (await e4.executeRaw<{ last_commit: string | null }>(`SELECT last_commit FROM sources WHERE id = $1`, [sid]))[0]?.last_commit ?? null;
    // eslint-disable-next-line no-console
    console.log(`[dps #4] mid-phase (aborted after file 1): status=${syncStatus1} filesImported=${imported1} servable=${servableMid}/2 last_commit=${lastCommitMid}`);
    // CHARACTERIZATION (no per-phase transaction across the multi-write):
    expect(servableMid).toBe(1);
    expect(lastCommitMid).toBeNull(); // D4: anchor not advanced on partial → the convergence guarantee

    // NORMATIVE: the next idempotent sync converges (file 2 lands).
    const r2 = await performSync(e4, { repoPath: dir, sourceId: sid, noPull: true, noEmbed: true, noExtract: true });
    const aHeal = await e4.getPage('sync-a', { sourceId: sid });
    const bHeal = await e4.getPage('sync-b', { sourceId: sid });
    // eslint-disable-next-line no-console
    console.log(`[dps #4] after 2nd sync (status=${r2.status}): a_servable=${aHeal !== null} b_servable=${bHeal !== null}`);
    await e4.disconnect();
    rmSync(dir, { recursive: true, force: true });
    expect(aHeal).not.toBeNull();
    expect(bHeal).not.toBeNull(); // SAFE invariant: sync converges on retry (fails here if it does not)
  }, 90_000);

  // #6 (DECISIVE) grounded in a REAL partial cycle whose global INDEX phase
  // (embed) failed. `embed` is global-scoped (phase-scope.ts) so its only re-run
  // lane is autopilot global maintenance, whose handler gates the
  // `autopilot.last_global_at` stamp on `globalMaintenanceMayStamp`. A
  // fail-bearing partial no longer advances the stamp, so
  // `isGlobalMaintenanceStale` stays DUE and the failed embed re-runs next tick
  // instead of being deferred up to GLOBAL_FLOOR_MIN. This asserts the fixed
  // (safe) behaviour; the discriminating regression is in
  // `global-freshness-stamp-gate.serial.test.ts`.
  test('#6 NORMATIVE: an embed-failed partial leaves global maintenance DUE next tick', async () => {
    await engine.executeRaw(`INSERT INTO sources (id,name) VALUES ('dps-g6','dps-g6') ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('atoms/dps-g6', { type: 'note', title: 'G6', compiled_truth: 'servable body', timeline: '' }, { sourceId: 'dps-g6' });
    // A genuine PARTIAL (one ok phase + the failed index phase): the case the
    // global-maintenance stamp gate must withhold.
    const report = await runCycle(engine, { brainDir, sourceId: 'dps-g6', phases: ['lint', 'embed'] });
    expect(report.status).toBe('partial');

    // The REAL stamp gate the handler calls: a fail-bearing partial does NOT stamp.
    const mayStamp = globalMaintenanceMayStamp(report);
    const lastGlobalAt = mayStamp ? new Date().toISOString() : null;
    const nextTickSoonMs = Date.now() + 60_000; // a scheduled tick 1 min later

    // eslint-disable-next-line no-console
    console.log(`[dps #6] real status=${report.status} mayStamp=${mayStamp} gate_due_next_tick=${isGlobalMaintenanceStale(lastGlobalAt, nextTickSoonMs, 60)}`);
    expect(mayStamp).toBe(false);
    // SAFE invariant now HOLDS: maintenance stays DUE so the failed embed re-runs promptly.
    expect(isGlobalMaintenanceStale(lastGlobalAt, nextTickSoonMs, 60)).toBe(true);
  });
});

// Companion CHARACTERIZATION of the same scheduler fact (documents the measured defer).
describe('CHARACTERIZES the scenario-6 scheduler defer', () => {
  test('a fresh last_global_at makes global maintenance NOT due for up to 60 min (why withholding the stamp matters)', () => {
    const t = Date.now();
    expect(isGlobalMaintenanceStale(new Date(t).toISOString(), t + 60_000, 60)).toBe(false); // fresh → deferred
    expect(isGlobalMaintenanceStale(new Date(t).toISOString(), t + 61 * 60_000, 60)).toBe(true); // heals only after the floor
    // This is exactly why the fix withholds the stamp on a fail-bearing partial:
    // an advanced last_global_at defers re-dispatch up to the floor. A `failed`
    // OR fail-bearing-partial cycle no longer stamps, so it re-dispatches next tick.
  });
});
