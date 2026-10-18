/**
 * #6696 B1 on Postgres: the ops tier and its deadline.
 *
 * - executeRaw `deadlineAt` ends the statement at the absolute deadline
 *   (statement_timeout from the time left), not at the longer timeoutMs.
 * - `--tier ops` runs every ops section for real (none not_applicable), stays
 *   complete on a fresh brain and reads no page aggregate.
 * - A section slower than `--budget-ms` is unknown with reason budget and the
 *   run returns near the deadline.
 *
 * Run: DATABASE_URL=... bun test test/e2e/doctor-ops-tier-postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { buildChecks, computeDoctorReport, doctorRunSummary } from '../../src/commands/doctor.ts';
import { opsCheckNames } from '../../src/commands/doctor/registry.ts';
import { startDoctorDeadline } from '../../src/commands/doctor/budget.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;
let engine: PostgresEngine;

describeE2E('doctor --tier ops on Postgres (#6696)', () => {
  beforeAll(async () => { engine = await setupDB(); }, 120_000);
  afterAll(async () => { await teardownDB(); });

  test('executeRaw deadlineAt bounds the statement by the time left', async () => {
    const started = Date.now();
    await expect(engine.executeRaw('SELECT pg_sleep(5)', [], { timeoutMs: 10_000, deadlineAt: started + 300 })).rejects.toThrow(/statement timeout|canceling statement/i);
    expect(Date.now() - started).toBeLessThan(2_000);
    const rows = await engine.executeRaw<{ one: number }>('SELECT 1 AS one', [], { timeoutMs: 10_000, deadlineAt: Date.now() + 2_000 });
    expect(rows[0]!.one).toBe(1);
  });

  test('every ops section runs (none not_applicable), the report is complete and no page aggregate is read', async () => {
    const args = ['--json', '--tier', 'ops'];
    const deadline = startDoctorDeadline(args);
    const guarded = new Proxy(engine, {
      get(target, key) {
        if (key === 'getHealth' || key === 'findOrphanPages' || key === 'getStats') return () => { throw new Error(`${String(key)} must not run in the ops tier`); };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as BrainEngine;
    const checks = await buildChecks(guarded, args, undefined, undefined, deadline);
    const ops = opsCheckNames();
    expect(checks.filter((c) => c.name !== 'connection').every((c) => ops.has(c.name))).toBe(true);
    expect(checks.filter((c) => c.details?.health === 'not_applicable').map((c) => c.name)).toEqual([]);
    expect(checks.filter((c) => c.details?.health === 'unknown').map((c) => c.name)).toEqual([]);
    const report = computeDoctorReport(checks, { engine: 'postgres', run: doctorRunSummary(args, deadline) });
    expect(report.complete).toBe(true);
    expect(report.elapsed_ms).toBeLessThan(4_000);
  });

  test('a section slower than --budget-ms is unknown (reason budget) and the run ends near the deadline', async () => {
    const args = ['--json', '--tier', 'ops', '--budget-ms', '400'];
    const deadline = startDoctorDeadline(args);
    const slow = new Proxy(engine, {
      get(target, key) {
        if (key === 'executeRaw') {
          return async (sql: string, params?: unknown[], opts?: never) => {
            if (/FROM persistence_counters/.test(sql)) await target.executeRaw('SELECT pg_sleep(3)', [], opts);
            return target.executeRaw(sql, params, opts);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as BrainEngine;
    const started = Date.now();
    const checks = await buildChecks(slow, args, undefined, undefined, deadline);
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(checks.find((c) => c.name === 'persistence_capacity')?.details).toMatchObject({ health: 'unknown', reason: 'budget' });
    expect(computeDoctorReport(checks, { engine: 'postgres', run: doctorRunSummary(args, deadline) }).unknown_sections).toContain('persistence_capacity');
  });
});
