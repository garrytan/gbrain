/**
 * #6803 C2/C3/C6: doctor reads that stay bounded (PGLite, and Postgres via testBackends;
 * test/e2e/doctor-entry-deadline-postgres.test.ts runs the Postgres arm, which the E2E backend
 * matrix runs again through transaction-mode PgBouncer).
 *
 * - The cheap incident checks (CHEAP_INCIDENT_CHECKS, keyed by check name) run before the first full scan.
 * - Under an overall deadline eaten by slow full scans, the cheap incident checks still report.
 * - Postgres: a two-statement entry over its 300 ms budget leaves no backend running 1 s later, its
 *   post-expiry statement is refused, and a cancel the check caught still reports reason budget.
 * - Postgres: a locked config read does not outlive the run's deadline.
 * - Postgres: entry A running out of time mid-forecast never makes entry B report a counter-only ok, and
 *   the run forecasts once.
 * - The frontmatter scan stops at its entry's deadline and names the source it did not finish, not unknown.
 * - --only X --budget-ms N gives X the whole N; the budget-unknown fix names --budget-ms above the time taken,
 *   and running it completes the check (scaled down: 200 ms entry budget, 600 ms statements).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildChecks, type Check } from '../src/commands/doctor.ts';
import { CHEAP_INCIDENT_CHECKS, DOCTOR_CHECK_REGISTRY, runDoctorRegistry } from '../src/commands/doctor/registry.ts';
import { connectionGateEntry } from '../src/commands/doctor/checks/db-connection.ts';
import { frontmatterEntry } from '../src/commands/doctor/checks/content-quality.ts';
import { persistenceCapacityEntry } from '../src/commands/doctor/checks/ops-sections.ts';
import { startDoctorDeadline } from '../src/commands/doctor/budget.ts';
import type { DoctorContext, DoctorEntry } from '../src/commands/doctor/context.ts';
import { StatementDeadlineError, deadlineBoundEngine, withStatementDeadline } from '../src/core/statement-deadline.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const ENTRY_BUDGET = 'doctor.entry_budget_ms';
const noProgress = new Proxy({}, { get: () => () => undefined }) as DoctorContext['progress'];

function ctxFor(engine: BrainEngine, args: string[]): DoctorContext {
  return {
    engine, args, jsonOutput: true, fastMode: false, doFix: false, dryRun: false, scope: 'brain', orphanRatioSourceId: undefined,
    progress: noProgress, skillsDirResolution: { dir: null, source: 'none' }, skillsDir: null, autoFixReport: null, schemaVersion: 0,
    connectionFailed: false, only: null, tier: 'standard', deadline: startDoctorDeadline(args),
  };
}

/**
 * The engine with executeRaw delayed for statements matching `slow›, and statements matching `count› counted.
 * `settled()` resolves once every delayed statement has finished, so none outlives its test.
 */
function instrumented(engine: BrainEngine, opts: { slow?: { match: RegExp; ms: number }; count?: RegExp } = {}): BrainEngine & { counted: number; settled: () => Promise<void> } {
  const state = { counted: 0, delayed: new Set<Promise<unknown>>() };
  return new Proxy(engine, {
    get(target, key) {
      if (key === 'counted') return state.counted;
      if (key === 'settled') return async () => { await Promise.allSettled([...state.delayed]); };
      if (key === 'executeRaw') {
        return (sql: string, params?: unknown[], o?: unknown) => {
          if (opts.count?.test(sql)) state.counted++;
          if (!opts.slow?.match.test(sql)) return target.executeRaw(sql, params, o as never);
          const run = new Promise((r) => setTimeout(r, opts.slow!.ms)).then(() => target.executeRaw(sql, params, o as never));
          state.delayed.add(run);
          void run.finally(() => state.delayed.delete(run)).catch(() => undefined);
          return run;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as BrainEngine & { counted: number; settled: () => Promise<void> };
}

const byName = (checks: Check[], name: string) => checks.find((c) => c.name === name);

/** A second connection holding ACCESS EXCLUSIVE on `table› for `holdMs›. */
async function lockTable(url: string, table: string, holdMs: number): Promise<{ release: () => Promise<void> }> {
  const locker = postgres(url, { max: 1, prepare: false });
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => { locked = resolve; });
  const held = locker.begin(async (sql) => {
    await sql.unsafe(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    locked();
    await new Promise((r) => setTimeout(r, holdMs));
  });
  await isLocked;
  return { release: async () => { await held.catch(() => undefined); await locker.end(); } };
}

test('C2: every entry that emits a cheap incident check runs before the first full scan', () => {
  const gate = DOCTOR_CHECK_REGISTRY.indexOf(connectionGateEntry);
  const after = DOCTOR_CHECK_REGISTRY.slice(gate + 1);
  const cheap = (e: DoctorEntry) => e.emits.some((n) => CHEAP_INCIDENT_CHECKS.has(n));
  const firstScan = after.findIndex((e) => e.tier !== 'ops' && !cheap(e));
  expect(firstScan).toBeGreaterThan(0);
  expect(after.slice(firstScan).filter(cheap).map((e) => e.name)).toEqual([]);
  const emitted = new Set(DOCTOR_CHECK_REGISTRY.flatMap((e) => e.emits));
  expect([...CHEAP_INCIDENT_CHECKS].filter((n) => !emitted.has(n))).toEqual([]);
});

for (const kind of testBackends()) {
  describe(`#6803 doctor deadlines (${kind})`, () => {
    let engine: BrainEngine;
    let databaseUrl = '';
    let close: () => Promise<void> = async () => undefined;
    const scratch = mkdtempSync(join(tmpdir(), 'gbrain-6803-deadline-'));

    beforeAll(async () => {
      if (kind === 'pglite') {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      } else {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine; databaseUrl = pg.databaseUrl; close = pg.close;
      }
    }, 120_000);
    afterAll(async () => {
      await close();
      rmSync(scratch, { recursive: true, force: true });
    });
    const withEntryBudget = async <T>(ms: number | null, run: () => Promise<T>): Promise<T> => {
      if (ms === null) await engine.executeRaw('DELETE FROM config WHERE key=$1', [ENTRY_BUDGET]);
      else await engine.setConfig(ENTRY_BUDGET, String(ms));
      try { return await run(); } finally { await engine.executeRaw('DELETE FROM config WHERE key=$1', [ENTRY_BUDGET]); }
    };

    test('under an overall deadline the slow full scans eat, the cheap incident checks still report', async () => {
      const slowScans = instrumented(engine, { slow: { match: /format_type|jsonb_typeof|pg_indexes|octet_length\(compiled_truth/i, ms: 3_000 } });
      const args = ['--json', '--scope=brain', '--budget-ms', '2500'];
      const checks = await buildChecks(slowScans, args, undefined, undefined, startDoctorDeadline(args));
      const lag = byName(checks, 'links_extraction_lag');
      expect(lag).toBeDefined();
      expect(lag!.details?.health, JSON.stringify(lag)).not.toBe('unknown');
      expect(byName(checks, 'persistence_capacity')?.details?.health).not.toBe('unknown');
      // The run did hit its deadline: some later check is unknown for the overall budget.
      expect(checks.some((c) => c.details?.reason === 'budget' && c.details?.limit === 'overall')).toBe(true);
    }, 60_000);

    test('--only X --budget-ms N gives X the whole N; the budget fix names a larger --budget-ms and running it completes the check', async () => {
      const slow = instrumented(engine, { slow: { match: /FROM persistence_counters/, ms: 600 } });
      await withEntryBudget(200, async () => {
        const capped = byName(await buildChecks(slow, ['--json', '--scope=brain', '--only', 'persistence_capacity']), 'persistence_capacity')!;
        expect(capped.details).toMatchObject({ health: 'unknown', reason: 'budget', limit: 'entry', budget_ms: 200 });
        const argv = capped.fix!.argv!;
        const n = Number(argv[argv.indexOf('--budget-ms') + 1]);
        expect(argv.slice(0, 4)).toEqual(['gbrain', 'doctor', '--only', 'persistence_capacity']);
        expect(n).toBeGreaterThan(capped.elapsed_ms!);
        expect(capped.fix!.actor).toBe('agent');
        const rerunArgs = [...argv.slice(2), '--scope=brain'];
        const rerun = byName(await buildChecks(slow, rerunArgs, undefined, undefined, startDoctorDeadline(rerunArgs)), 'persistence_capacity')!;
        expect(rerun.details?.health, JSON.stringify(rerun)).not.toBe('unknown');
        expect(rerun.details?.reason).toBeUndefined();
      });
    }, 60_000);

    test('the frontmatter scan stops at its entry deadline and names the source it did not finish', async () => {
      // The source's page-count read (which the scan races against its deadline before walking) is held past
      // the entry deadline, so the deadline always lands inside the scan whatever the runner's disk speed.
      // A scan still on its own 30 s timeout would wait the count out, walk every file and report clean.
      const root = join(scratch, 'fm-example');
      mkdirSync(root, { recursive: true });
      for (let i = 0; i < 200; i++) writeFileSync(join(root, `note-${i}.md`), `---\ntitle: Note ${i}\n---\n\nBody ${i}.\n`);
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2) ON CONFLICT (id) DO UPDATE SET local_path=EXCLUDED.local_path', ['fm-example', root]);
      const slowCount = instrumented(engine, { slow: { match: /SELECT COUNT\(\*\)::text AS n FROM pages WHERE source_id/, ms: 1_500 } });
      try {
        await withEntryBudget(600, async () => {
          const started = Date.now();
          const checks = await runDoctorRegistry(ctxFor(slowCount, ['--json', '--scope=brain']), [connectionGateEntry, frontmatterEntry]);
          const fm = byName(checks, 'frontmatter_integrity')!;
          expect(fm.details?.health, JSON.stringify(fm)).not.toBe('unknown');
          expect(fm.message).toMatch(/partial|NOT SCANNED/i);
          expect(fm.message).toContain('fm-example: NOT SCANNED');
          expect(Date.now() - started).toBeLessThan(600 + 400);
        });
      } finally {
        await slowCount.settled();
        await engine.executeRaw('DELETE FROM sources WHERE id=$1', ['fm-example']);
      }
    }, 120_000);

    if (kind === 'pglite') {
      test('PGLite: a statement after the deadline is refused before it runs; one already running finishes', async () => {
        const bound = deadlineBoundEngine(engine);
        const scope = { startedAt: Date.now(), deadlineAt: Date.now() + 50, expired: false };
        await withStatementDeadline(scope, async () => {
          expect(await bound.executeRaw('SELECT 1 AS one')).toEqual([{ one: 1 }]);
          await new Promise((r) => setTimeout(r, 80));
          await expect(bound.executeRaw('SELECT 1')).rejects.toBeInstanceOf(StatementDeadlineError);
        });
        expect(scope.expired).toBe(true);
      });
      return;
    }

    const activeMarked = async (marker: string) => (await engine.executeRaw<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state <> 'idle' AND query LIKE '%' || $1 || '%'", [marker]))[0]!.n;

    test('Postgres: a two-statement entry over its 300 ms budget leaves no backend running and its second statement is refused', async () => {
      const seen: { caught?: unknown; second?: unknown; done?: boolean } = {};
      const entry: DoctorEntry = {
        name: 'two_statement_example', emits: ['two_statement_example'],
        run: async (ctx) => {
          try { await ctx.engine!.executeRaw("SELECT pg_sleep(5), 'gbrain-6803-' || 'two' AS marker /* gbrain-6803-two */"); } catch (error) { seen.caught = error; }
          try { await ctx.engine!.executeRaw('SELECT 1'); } catch (error) { seen.second = error; }
          seen.done = true;
          return [{ name: 'two_statement_example', status: 'ok', message: 'Looks clear (the check swallowed its own cancel).' }];
        },
      };
      await withEntryBudget(300, async () => {
        const started = Date.now();
        const checks = await runDoctorRegistry(ctxFor(engine, ['--json']), [connectionGateEntry, entry]);
        expect(Date.now() - started).toBeLessThan(1_500);
        expect(byName(checks, 'two_statement_example')!.details).toMatchObject({ health: 'unknown', reason: 'budget', limit: 'entry', budget_ms: 300 });
        await new Promise((r) => setTimeout(r, 1_000));
        expect(await activeMarked('gbrain-6803-two')).toBe(0);
        expect(seen.done).toBe(true);
        expect(String((seen.caught as Error)?.message)).toMatch(/statement timeout|canceling statement|abort/i);
        expect(seen.second).toBeInstanceOf(StatementDeadlineError);
      });
    }, 30_000);

    test('Postgres: a cancel the check catches still marks its scope expired, so the runner reports reason budget', async () => {
      const bound = deadlineBoundEngine(engine);
      const scope = { startedAt: Date.now(), deadlineAt: Date.now() + 300, expired: false };
      await withStatementDeadline(scope, async () => {
        await bound.executeRaw('SELECT pg_sleep(3)').catch(() => undefined);
      });
      expect(scope.expired).toBe(true);
      expect(Date.now() - scope.startedAt).toBeLessThan(1_500);
    }, 15_000);

    test('Postgres: a locked config read does not outlive the run deadline', async () => {
      const lock = await lockTable(databaseUrl, 'config', 6_000);
      try {
        const quick: DoctorEntry = { name: 'quick_example', emits: ['quick_example'], run: async () => [{ name: 'quick_example', status: 'ok', message: 'ok' }] };
        const started = Date.now();
        const checks = await runDoctorRegistry(ctxFor(engine, ['--json', '--budget-ms', '1500']), [connectionGateEntry, quick]);
        expect(Date.now() - started).toBeLessThan(2_500);
        expect(byName(checks, 'quick_example')).toBeDefined();
        await new Promise((r) => setTimeout(r, 1_000));
        const [{ n }] = await engine.executeRaw<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE 'SELECT value FROM config%'");
        expect(n).toBe(0);
      } finally {
        await lock.release();
      }
    }, 30_000);

    test('Postgres: entry A out of time mid-forecast never makes entry B report a counter-only ok, and the run forecasts once', async () => {
      const counting = instrumented(engine, { count: /FROM persistence_topology_changes/ });
      const lock = await lockTable(databaseUrl, 'persistence_requests', 1_500);
      try {
        const a = { ...persistenceCapacityEntry, name: 'capacity_a' };
        const b = { ...persistenceCapacityEntry, name: 'capacity_b' };
        const checks = await withEntryBudget(1_000, () => runDoctorRegistry(ctxFor(counting, ['--json']), [connectionGateEntry, a, b]));
        const [first, second] = checks.filter((c) => c.name === 'persistence_capacity');
        expect(first!.details).toMatchObject({ health: 'unknown', reason: 'budget' });
        for (const c of [first!, second!]) {
          const counterOnly = c.status === 'ok' && (c.details?.forecast as { health?: string } | undefined)?.health === 'unknown';
          expect(counterOnly, JSON.stringify(c)).toBe(false);
        }
        expect(second!.status === 'ok' ? (second!.details?.forecast as { rows?: unknown[] }).rows : second!.details?.health).toBeDefined();
        expect(counting.counted).toBe(1);
      } finally {
        await lock.release();
      }
    }, 30_000);

    test('Postgres: under an overall deadline that cancels the forecast, capacity is unknown (reason budget), never counter-only ok', async () => {
      const lock = await lockTable(databaseUrl, 'persistence_requests', 3_000);
      try {
        const args = ['--json', '--scope=brain', '--only', 'persistence_capacity', '--budget-ms', '1200'];
        const capacity = byName(await buildChecks(engine, args, undefined, undefined, startDoctorDeadline(args)), 'persistence_capacity')!;
        expect(capacity.status, JSON.stringify(capacity)).not.toBe('ok');
        expect(capacity.details).toMatchObject({ health: 'unknown', reason: 'budget' });
      } finally {
        await lock.release();
      }
    }, 30_000);
  });
}
