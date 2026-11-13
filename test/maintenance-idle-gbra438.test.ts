/**
 * GBRA-438 PR 2: the idle runner a serve calls (src/core/maintenance/idle.ts)
 * and the PGLite CHECKPOINT step, on a repo-less brain; the Postgres arm also
 * runs two serves against one brain.
 *
 * 1. Protects: an idle run does nothing when maintenance.auto is false or
 *    upkeep is not due, records runner serve when it runs, hands its abort
 *    signal into the work item, ends a finished PGLite round with a
 *    CHECKPOINT step, and two serves sharing a brain run each global step
 *    once while the other reports cycle_already_running.
 * 2. Fails when: an idle run ignores maintenance.auto, reruns a round that is
 *    not due, drops the signal, skips the checkpoint on PGLite (or runs one on
 *    Postgres), or both serves run the global steps.
 * 3. Real seams: runCycle and the gbrain-cycle lease on PGLite and Postgres;
 *    the cycle seam only gates the first phase.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { runCycle, type CycleOpts } from '../src/core/cycle.ts';
import { MAINTENANCE_EMBED_LOCK_ID, readUpkeepRecord, runUnattendedMaintenance, unattendedPlan, type SafePhaseProviders } from '../src/core/maintenance/run.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import type { CycleReport } from '../src/core/cycle.ts';
import { runIdleUpkeep } from '../src/core/maintenance/idle.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { checkUnattendedMaintenance } from '../src/commands/doctor/checks/unattended-maintenance.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const KEYLESS: SafePhaseProviders = { embedding: false, decideConflict: false, fenceRepairModel: false, contentRepairModel: false };
const quiet = () => new AbortController().signal;

for (const kind of testBackends()) {
  describe(`idle upkeep (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let databaseUrl = '';

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close, databaseUrl } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
    });
    afterAll(async () => { await close(); });
    beforeEach(async () => {
      await engine.executeRaw("DELETE FROM config WHERE key LIKE 'maintenance.%' OR key = 'autopilot.last_global_at'");
      await engine.executeRaw('DELETE FROM pages');
    });

    test('one runner embeds at a time: while another holds the embed lock, a finished round skips embed as embed_running and spends nothing', async () => {
      const lock = (await tryAcquireDbLock(engine, MAINTENANCE_EMBED_LOCK_ID))!;
      try {
        const outcome = await runUnattendedMaintenance(engine, {
          runner: 'cli', providers: { ...KEYLESS, embedding: true }, cycle: async () => ({ status: 'ok', phases: [] }) as unknown as CycleReport,
        });
        expect(outcome.record?.steps).toContainEqual({ name: 'embed', scope: 'global', status: 'skipped', reason: 'embed_running' });
        expect(await engine.getConfig('maintenance.embed_spend')).toBeNull();
      } finally {
        await lock.release();
      }
    });

    test('maintenance.auto=false: nothing runs and nothing is recorded', async () => {
      await engine.setConfig('maintenance.auto', 'false');
      let cycles = 0;
      const outcome = await runIdleUpkeep(engine, { runner: 'serve', signal: quiet(), providers: KEYLESS, cycle: async (e, o) => { cycles++; return runCycle(e, o); } });
      expect(outcome).toBeNull();
      expect(cycles).toBe(0);
      expect(await readUpkeepRecord(engine)).toBeNull();
    });

    test('due: runs as runner serve; a second idle run is not due and does nothing', async () => {
      await engine.putPage('notes/alpha', { type: 'concept', title: 'Alpha', compiled_truth: 'Alpha relies on [[notes/beta]].' });
      const outcome = await runIdleUpkeep(engine, { runner: 'serve', signal: quiet(), providers: KEYLESS, budgetMs: 60_000 });
      expect(outcome).toMatchObject({ status: 'ran', record: { runner: 'serve', cursor: null } });
      expect((await readUpkeepRecord(engine))!.runner).toBe('serve');
      let cycles = 0;
      expect(await runIdleUpkeep(engine, { runner: 'serve', signal: quiet(), providers: KEYLESS, cycle: async (e, o) => { cycles++; return runCycle(e, o); } })).toBeNull();
      expect(cycles).toBe(0);
    });

    test(kind === 'pglite' ? 'a finished PGLite round ends with a CHECKPOINT step' : 'Postgres runs no CHECKPOINT step', async () => {
      const outcome = await runIdleUpkeep(engine, { runner: 'serve', signal: quiet(), providers: KEYLESS, budgetMs: 60_000 });
      const steps = outcome!.record!.steps;
      if (kind === 'pglite') expect(steps.at(-1)).toEqual({ name: 'checkpoint', scope: 'global', status: 'ok' });
      else expect(steps.map((s) => s.name)).not.toContain('checkpoint');
    });

    test('the abort signal reaches the work item: a request mid-item stops it and the round resumes later', async () => {
      const controller = new AbortController();
      let seen: AbortSignal | undefined;
      const outcome = await runIdleUpkeep(engine, {
        runner: 'serve', signal: controller.signal, providers: KEYLESS, budgetMs: 60_000,
        cycle: async (e, o: CycleOpts) => {
          seen = o.signal;
          setTimeout(() => controller.abort(), 10);
          await new Promise<void>((r) => o.signal!.addEventListener('abort', () => r()));
          return runCycle(e, o);
        },
      });
      expect(seen?.aborted).toBe(true);
      expect(outcome!.record!.cursor).not.toBeNull();
      expect(outcome!.record!.steps.map((s) => s.name)).not.toContain('checkpoint');
    });

    test('inside the extract phase: an abort mid-drain stops the repo-less stale link drain after one batch', async () => {
      for (let i = 0; i < 60; i++) await engine.putPage(`notes/p${i}`, { type: 'concept', title: `P${i}`, compiled_truth: `P${i} relies on [[notes/p${(i + 1) % 60}]].` });
      const controller = new AbortController();
      const list = engine.listStalePagesForExtraction.bind(engine);
      engine.listStalePagesForExtraction = (async (o: Parameters<typeof list>[0]) => { const rows = await list(o); controller.abort(); return rows; }) as typeof list;
      try {
        await runCycle(engine, { brainDir: null, pull: false, phases: ['extract'], stamp: 'none', sourceId: 'default', signal: controller.signal });
      } finally {
        engine.listStalePagesForExtraction = list;
      }
      const [{ n }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM links');
      expect(controller.signal.aborted).toBe(true);
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThanOrEqual(25);
    });

    test('inside extract_facts: the full page walk yields to timers, so an abort a timer trips stops it mid-walk', async () => {
      for (let i = 0; i < 120; i++) await engine.putPage(`walk/w${i}`, { type: 'concept', title: `W${i}`, compiled_truth: `W${i} is a plain page.` });
      const total = (await engine.getAllSlugs({ sourceId: 'default' })).size;
      const controller = new AbortController();
      const slugs = engine.getAllSlugs.bind(engine);
      engine.getAllSlugs = (async (o: Parameters<typeof slugs>[0]) => { const rows = await slugs(o); setTimeout(() => controller.abort(), 0); return rows; }) as typeof slugs;
      let scanned: number;
      try {
        scanned = (await runExtractFacts(engine, { sourceId: 'default', signal: controller.signal })).pagesScanned;
      } finally {
        engine.getAllSlugs = slugs;
      }
      expect(total).toBeGreaterThanOrEqual(120);
      expect(scanned).toBeLessThan(total);
      expect(scanned).toBeGreaterThan(0);
      expect(controller.signal.aborted).toBe(true);
    });

    test('an overdue doctor warn offers the opt-in schedule as the second option, consent persistent_install', async () => {
      const at = Date.now() - 72 * 60 * 60 * 1000;
      await engine.setConfig('maintenance.last_run', JSON.stringify({ at: new Date(at).toISOString(), runner: 'serve', status: 'ok', steps: [], held: [], cursor: null,
        next_due_at: new Date(at + 24 * 60 * 60 * 1000).toISOString(), consecutive_failures: [] }));
      const check = await checkUnattendedMaintenance(engine);
      expect(check).toMatchObject({ status: 'warn', fix: { argv: ['gbrain', 'maintain', '--unattended'], consent: [] },
        details: { alternative_fix: { argv: ['gbrain', 'maintain', '--schedule'], consent: ['persistent_install'], preview_argv: ['gbrain', 'maintain', '--schedule', '--dry-run'] } } });
      expect(check.message).toContain('add the opt-in schedule with gbrain maintain --schedule');
      await engine.setConfig('maintenance.last_run', JSON.stringify({ at: new Date().toISOString(), runner: 'serve', status: 'ok', steps: [], held: [], cursor: null,
        next_due_at: new Date(Date.now() + 1000).toISOString(), consecutive_failures: [] }));
      expect((await checkUnattendedMaintenance(engine)).details).not.toHaveProperty('alternative_fix');
    });

    if (kind === 'postgres') {
      test('two serves on one repo-less brain: one runs each global step, the other reports cycle_already_running', async () => {
        const second = new PostgresEngine();
        await second.connect({ database_url: databaseUrl, poolSize: 2 } as never);
        try {
          let reached!: () => void;
          const inside = new Promise<void>((r) => { reached = r; });
          let release!: () => void;
          const held = new Promise<void>((r) => { release = r; });
          let gated = false;
          const first = runIdleUpkeep(engine, {
            runner: 'serve', signal: quiet(), providers: KEYLESS, budgetMs: 60_000,
            cycle: (e, o) => runCycle(e, { ...o, onPhaseStart: async () => { if (!gated) { gated = true; reached(); await held; } } }),
          });
          await inside;
          const other = await runIdleUpkeep(second, { runner: 'serve', signal: quiet(), providers: KEYLESS, budgetMs: 60_000 });
          expect(other).toMatchObject({ status: 'skipped', exit: 0, code: 'cycle_already_running' });
          release();
          const ran = await first;
          expect(ran).toMatchObject({ status: 'ran', record: { runner: 'serve', cursor: null } });
          for (const phase of unattendedPlan(KEYLESS).global) {
            expect(ran!.record!.steps.filter((s) => s.name === phase).map((s) => s.scope)).toEqual(['global']);
          }
          expect(await runIdleUpkeep(second, { runner: 'serve', signal: quiet(), providers: KEYLESS })).toBeNull();
        } finally {
          await second.disconnect();
        }
      }, 120_000);
    }
  });
}
