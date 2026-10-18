/**
 * #6696 B1: doctor tiers and budgets (in-process, PGLite).
 *
 * - `--tier ops` runs only the ops sections plus the connection lane, reads no
 *   page aggregate (getHealth / findOrphanPages / getStats throw if called) on a
 *   2,000-page brain, reports PGLite-skipped sections as `not_applicable` info,
 *   and stays complete.
 * - The default run puts every ops section before the slower checks and reads
 *   getHealth once.
 * - A section past the deadline (or the per-entry budget) is unknown with
 *   `reason: budget`, `exact: false`, `elapsed_ms`; the report says
 *   `complete: false` and names it.
 * - `orphan_ratio` estimates above `doctor.orphan_ratio.full_scan_max_pages`
 *   and scans fully under `--tier deep`.
 * - A connect the deadline ended reports every check of the tier as unknown.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildChecks, computeDoctorReport, doctorRunSummary, type Check } from '../src/commands/doctor.ts';
import { DOCTOR_CHECK_REGISTRY, opsCheckNames } from '../src/commands/doctor/registry.ts';
import { DoctorBudgetError, parseBudgetMs, parseDoctorTier, startDoctorDeadline, OPS_BUDGET_MS_DEFAULT } from '../src/commands/doctor/budget.ts';
import { ORPHAN_FULL_SCAN_KEY } from '../src/commands/doctor/checks/orphan-estimate.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function insertNotes(count: number, prefix = 'notes/acme-example'): Promise<void> {
  const sql = sqlQueryForEngine(engine);
  await sql`
    INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, content_hash, created_at, updated_at)
    SELECT ${prefix}::text || '-' || g, 'default', 'note', 'Note ' || g, '', '{}', ${prefix}::text || '-h' || g, now(), now()
    FROM generate_series(1, ${count}::int) AS g
  `;
}

/** The engine with the named methods throwing, and executeRaw optionally delayed for statements matching `slow`. */
function guarded(throwing: string[], slow?: { match: RegExp; ms: number }, calls?: Record<string, number>): BrainEngine {
  return new Proxy(engine, {
    get(target, key) {
      if (typeof key === 'string' && throwing.includes(key)) return () => { throw new Error(`${key} must not run in this tier`); };
      if (key === 'getHealth' && calls) return (...a: unknown[]) => { calls.getHealth = (calls.getHealth ?? 0) + 1; return target.getHealth(...(a as [])); };
      if (key === 'executeRaw' && slow) {
        return async (sql: string, params?: unknown[], opts?: unknown) => {
          if (slow.match.test(sql)) await new Promise((r) => setTimeout(r, slow.ms));
          return target.executeRaw(sql, params, opts as never);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as BrainEngine;
}

const names = (checks: Check[]) => checks.map((c) => c.name);

describe('#6696 B1 doctor tiers', () => {
  test('parses --tier and --budget-ms; ops defaults to a 4000 ms deadline, others to none', () => {
    expect(parseDoctorTier([])).toBe('standard');
    expect(parseDoctorTier(['--tier', 'ops'])).toBe('ops');
    expect(parseDoctorTier(['--tier=deep'])).toBe('deep');
    expect(() => parseDoctorTier(['--tier', 'fast'])).toThrow(/Unknown doctor tier/);
    expect(parseBudgetMs(['--tier', 'ops'], 'ops')).toBe(OPS_BUDGET_MS_DEFAULT);
    expect(parseBudgetMs([], 'standard')).toBeNull();
    expect(parseBudgetMs(['--budget-ms', '900'], 'standard')).toBe(900);
    expect(parseBudgetMs(['--budget-ms', '0'], 'ops')).toBeNull();
    expect(() => parseBudgetMs(['--budget-ms', '-1'], 'ops')).toThrow(/whole number of milliseconds/);
    expect(() => parseBudgetMs(['--budget-ms', '1.5'], 'ops')).toThrow(/whole number of milliseconds/);
  });

  test('--tier ops on a 2,000-page PGLite brain: only ops sections, no page aggregates, complete, PGLite skips are not_applicable info', async () => {
    await insertNotes(2000);
    const args = ['--json', '--tier', 'ops'];
    const deadline = startDoctorDeadline(args);
    const checks = await buildChecks(guarded(['getHealth', 'findOrphanPages', 'getStats']), args, undefined, undefined, deadline);
    const ops = opsCheckNames();
    expect(names(checks).filter((n) => n !== 'connection').every((n) => ops.has(n))).toBe(true);
    for (const n of ['persistence_capacity', 'persistence_terminal_failures', 'managed_sync_not_moving', 'persistence_compaction', 'serve_build_drift', 'schema_pack_consistency', 'embedding_state']) {
      expect(names(checks)).toContain(n);
    }
    expect(checks.filter((c) => c.status !== 'ok')).toEqual([]);
    const skipped = checks.filter((c) => c.details?.health === 'not_applicable');
    expect(skipped.map((c) => c.name).sort()).toEqual(['embedding_state', 'managed_sync_not_moving', 'persistence_terminal_failures', 'schema_pack_consistency']);
    for (const c of skipped) expect(c.severity).toBe('info');
    const report = computeDoctorReport(checks, { engine: 'pglite', run: doctorRunSummary(args, deadline) });
    expect(report.tier).toBe('ops');
    expect(report.complete).toBe(true);
    expect(report.unknown_sections).toEqual([]);
    expect(report.budget_ms).toBe(OPS_BUDGET_MS_DEFAULT);
    expect(checks.every((c) => typeof c.elapsed_ms === 'number')).toBe(true);
  });

  test('the default run puts every ops section before the slower checks and reads getHealth once', async () => {
    const calls: Record<string, number> = {};
    const checks = await buildChecks(guarded([], undefined, calls), ['--json', '--scope=brain']);
    const order = names(checks);
    const ops = [...opsCheckNames()].filter((n) => order.includes(n));
    const firstSlow = order.indexOf('pgvector');
    expect(firstSlow).toBeGreaterThan(0);
    for (const n of ops) expect(order.indexOf(n)).toBeLessThan(firstSlow);
    expect(calls.getHealth).toBe(1);
    expect(checks.every((c) => typeof c.elapsed_ms === 'number')).toBe(true);
    // The registry tags exactly the plan's ops sections.
    expect(DOCTOR_CHECK_REGISTRY.filter((e) => e.tier === 'ops').map((e) => e.name)).toEqual(
      expect.arrayContaining(['persistence_capacity', 'persistence_terminal_failures', 'managed_sync_not_moving', 'persistence_compaction', 'serve_build_drift', 'schema_pack_consistency', 'embedding_state']));
  });

  test('a section past the --budget-ms deadline is unknown (reason budget) and the report is incomplete', async () => {
    const args = ['--json', '--tier', 'ops', '--budget-ms', '150'];
    const deadline = startDoctorDeadline(args);
    const started = Date.now();
    const checks = await buildChecks(guarded([], { match: /FROM persistence_counters/, ms: 600 }), args, undefined, undefined, deadline);
    expect(Date.now() - started).toBeLessThan(600);
    const capacity = checks.find((c) => c.name === 'persistence_capacity')!;
    expect(capacity.status).toBe('warn');
    expect(capacity.details).toMatchObject({ health: 'unknown', reason: 'budget', exact: false });
    expect(typeof capacity.elapsed_ms).toBe('number');
    expect(capacity.fix).toBeDefined();
    const report = computeDoctorReport(checks, { engine: 'pglite', run: doctorRunSummary(args, deadline) });
    expect(report.complete).toBe(false);
    expect(report.unknown_sections).toContain('persistence_capacity');
  });

  test('the per-entry budget (doctor.entry_budget_ms) bounds a standard-tier entry', async () => {
    await engine.setConfig('doctor.entry_budget_ms', '100');
    const checks = await buildChecks(guarded([], { match: /FROM persistence_counters/, ms: 500 }), ['--json', '--scope=brain', '--only', 'persistence_capacity']);
    const capacity = checks.find((c) => c.name === 'persistence_capacity')!;
    expect(capacity.details).toMatchObject({ health: 'unknown', reason: 'budget', budget_ms: 100 });
  });

  test('a connect the deadline ended: connection and every ops section are unknown, nothing claims clear', async () => {
    const args = ['--json', '--tier', 'ops', '--budget-ms', '50'];
    const deadline = startDoctorDeadline(args);
    const checks = await buildChecks(null, args, 'config-file', new DoctorBudgetError(60), deadline);
    const connection = checks.find((c) => c.name === 'connection')!;
    expect(connection.details).toMatchObject({ health: 'unknown', reason: 'budget' });
    for (const n of opsCheckNames()) expect(checks.find((c) => c.name === n)?.details?.health).toBe('unknown');
    expect(computeDoctorReport(checks, { run: doctorRunSummary(args, deadline) }).complete).toBe(false);
  });

  test('orphan_ratio estimates above the full-scan cutoff in standard and scans fully under --tier deep', async () => {
    await insertNotes(400, 'people/alice-example');
    await engine.executeRaw(`UPDATE pages SET type = 'person' WHERE slug LIKE 'people/%'`);
    await engine.setConfig(ORPHAN_FULL_SCAN_KEY, '100');
    const standard = (await buildChecks(engine, ['--json', '--scope=brain', '--only', 'orphan_ratio'])).find((c) => c.name === 'orphan_ratio')!;
    expect(standard.details).toMatchObject({ estimated: true, exact: false, full_scan_max_pages: 100 });
    expect(standard.message).toMatch(/estimated/);
    const deep = (await buildChecks(engine, ['--json', '--scope=brain', '--tier', 'deep', '--only', 'orphan_ratio'])).find((c) => c.name === 'orphan_ratio')!;
    expect(deep.details?.estimated).toBeUndefined();
    expect(deep.message).toMatch(/400\/400 linkable pages/);
  });
});
