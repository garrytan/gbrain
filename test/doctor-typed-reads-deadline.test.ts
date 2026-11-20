/**
 * Typed engine reads that replaced a doctor-bounded `executeRaw` statement keep the doctor's statement deadline.
 *
 * Before S2 the decide-health check read its tables through `executeRaw` on the deadline-bound engine
 * (src/core/statement-deadline.ts), so a lock-blocked statement ended at the doctor budget. S2a moved them to typed
 * decide members. On Postgres each of those members, run inside `withStatementDeadline` through
 * `deadlineBoundEngine`, must end at the deadline too: it rejects near the deadline, the scope reports `expired`,
 * and no backend is left waiting on the lock. PGLite has one connection and no cancellation: it only refuses a
 * member called after the deadline.
 *
 * One case per bounded member; the pin keeps the set to exactly the members a doctor check reaches.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import * as statementDeadline from '../src/core/statement-deadline.ts';
import { StatementDeadlineError, deadlineBoundEngine, deadlineFailure, withStatementDeadline, type StatementDeadline } from '../src/core/statement-deadline.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

/** Read through the namespace so this file loads (and its cases fail by behaviour) where the set is not exported yet. */
const BOUNDED_TYPED_READS: ReadonlySet<string> = (statementDeadline as { BOUNDED_TYPED_READS?: ReadonlySet<string> }).BOUNDED_TYPED_READS ?? new Set();

const DEADLINE_MS = 400;
const LOCK_MS = 2_000;

interface Case { member: string; table: string; call: (engine: BrainEngine) => Promise<unknown> }

/** The decide members a doctor check calls, each with the table whose lock blocks its statement. */
const CASES: Case[] = [
  { member: 'readDecideState', table: 'decide_state', call: (e) => e.readDecideState('doctor_deadline_probe') },
  { member: 'decideSlotUsage', table: 'decision_receipts', call: (e) => e.decideSlotUsage(24) },
  { member: 'dailyDecideSpend', table: 'decide_spend', call: (e) => e.dailyDecideSpend(new Date(Date.now() - 86_400_000)) },
  { member: 'listDecideResolvedModels', table: 'decision_receipts', call: (e) => e.listDecideResolvedModels(24) },
  { member: 'listDecideMixedModelDecisions', table: 'decision_receipts', call: (e) => e.listDecideMixedModelDecisions(24) },
  { member: 'listDecideReceiptStats', table: 'decision_receipts', call: (e) => e.listDecideReceiptStats({ sinceHours: 24 }) },
  { member: 'listDecideCalibrations', table: 'decide_calibrations', call: (e) => e.listDecideCalibrations({ includeRetired: true }) },
];

test('the bounded typed reads are exactly the decide members a doctor check reaches', () => {
  expect([...BOUNDED_TYPED_READS].filter((name) => CASES.some((c) => c.member === name)).sort()).toEqual(CASES.map((c) => c.member).sort());
  // The set lists the decide members only: the trunk adds its journal reads next to these (src/core/statement-deadline.ts).
  expect([...BOUNDED_TYPED_READS].filter((name) => !CASES.some((c) => c.member === name))).toEqual([]);
  for (const { member } of CASES) expect(typeof (PostgresEngine.prototype as unknown as Record<string, unknown>)[member], member).toBe('function');
});

/** A second connection holding ACCESS EXCLUSIVE on `table` for `holdMs`. */
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

for (const kind of testBackends()) {
  describe(`doctor-bounded typed reads (${kind})`, () => {
    let engine: BrainEngine;
    let databaseUrl = '';
    let close: () => Promise<void> = async () => undefined;

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
    afterAll(async () => { await close(); });

    const scopeFor = (deadlineMs: number): StatementDeadline => ({ startedAt: Date.now(), deadlineAt: Date.now() + deadlineMs, expired: false });

    if (kind === 'pglite') {
      test('PGLite refuses a member called after the deadline and otherwise runs it unchanged', async () => {
        const bound = deadlineBoundEngine(engine);
        const live = scopeFor(5_000);
        expect(await withStatementDeadline(live, () => bound.readDecideState('doctor_deadline_probe'))).toBeNull();
        expect(live.expired).toBe(false);
        const past = scopeFor(-1);
        await expect(withStatementDeadline(past, async () => bound.readDecideState('doctor_deadline_probe'))).rejects.toBeInstanceOf(StatementDeadlineError);
        expect(past.expired).toBe(true);
      });
    } else {
      for (const { member, table, call } of CASES) {
        test(`${member} ends at the doctor deadline while ${table} is locked`, async () => {
          const bound = deadlineBoundEngine(engine);
          const lock = await lockTable(databaseUrl, table, LOCK_MS);
          try {
            const scope = scopeFor(DEADLINE_MS);
            const error = await withStatementDeadline(scope, async () => call(bound)).then(() => null, (e: unknown) => e ?? new Error('rejected with nothing'));
            expect(error, `${member} returned instead of ending at the deadline`).not.toBeNull();
            expect(deadlineFailure(error), String(error)).toBe(true);
            expect(Date.now() - scope.startedAt).toBeLessThan(DEADLINE_MS + 1_200);
            expect(scope.expired).toBe(true);
            await new Promise((r) => setTimeout(r, 500));
            const [{ n }] = await engine.executeRaw<{ n: number }>(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database() AND wait_event_type = 'Lock'");
            expect(n, `a backend still waits on the lock for ${member}`).toBe(0);
          } finally {
            await lock.release();
          }
        }, 30_000);
      }
    }
  });
}
