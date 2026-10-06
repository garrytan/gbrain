/**
 * Gate policy of the scale tier (scripts/scale/gates.ts, spec F4c). The
 * workflow runs the harness with --enforce and trusts its exit code, so these
 * plant the regressions the tier exists to catch (a slow op, a wrong answer,
 * a slow phase, a quadratic plan) into an otherwise passing report and pin the
 * exit code and the message that names the op and prints its EXPLAIN.
 */
import { describe, expect, test } from 'bun:test';
import {
  CEILINGS_MS, evaluateScaleGates, importProgressPerFile, RATE_MIN_PAGES, HEADLINE_OP, HOT_TABLES, KEY_PLAN_OPS, phaseLimitsMs, PLANNER_HEALTH_ENFORCED, PLANNER_STATS_MIN_ROWS,
  rateMeasure, resultHits, verdictLines, type GatePolicy, type RateMeasure, type ScaleReport,
} from '../../scripts/scale/gates.ts';

const ENFORCE: GatePolicy = { enforce: true, enforcePlanner: PLANNER_HEALTH_ENFORCED, enforceCeilings: false };
const PLAN = { sql: 'SELECT 1', execution_ms: 1, inner_loops: 3, text: 'Result  (actual rows=1 loops=1)' };
const STEADY: RateMeasure = { rate_ratio: 1.1, total_vs_half: 2.1, per_page_ms_first10: 10, per_page_ms_last10: 11, total_ms: 105_000, ms_at_half: 50_000 };

function passingReport(): ScaleReport {
  const ops = ['get_health', 'list_pages', HEADLINE_OP, 'get_backlinks', 'find_orphans', 'query (hybrid, injected vector)']
    .map(op => ({ op, p50_ms: 10, runs_ms: [10, 10, 10, 10, 10], known_answer: 'pass' as const, plan: { statements: 1, slowest: PLAN, worst_loops: PLAN } }));
  return {
    engine: 'pglite', pages: 10_000, seed: 1, import_mode: 'cli',
    import: { wall: { ...STEADY }, cpu: { ...STEADY } },
    planner: { hot_table_stat_rows: Object.fromEntries(HOT_TABLES.map(t => [t, 3])), hot_table_rows: Object.fromEntries(HOT_TABLES.map(t => [t, 10_000])), probed_after: 'get_health' },
    ops,
    data: [{ check: 'noop_reimport_writes_nothing', status: 'pass' }],
    phases_ms: { import: 60_000, budgets: 30_000 },
  };
}

describe('scale gates under --enforce', () => {
  test('a passing report exits 0 and says which gates are still report-only', () => {
    const report = passingReport();
    const verdict = evaluateScaleGates(report, ENFORCE);
    expect(verdict.failures).toEqual([]);
    expect(verdict.exitCode).toBe(0);
    expect(verdictLines(report, verdict, ENFORCE).at(-1)).toContain('all enforced gates passed');
  });

  test('a planted wrong answer exits 1, names the op and prints its EXPLAIN', () => {
    const report = passingReport();
    report.ops[3] = { ...report.ops[3]!, known_answer: 'fail', detail: 'default:notes/scale-0-5 not returned for scaletok0x5' };
    const verdict = evaluateScaleGates(report, ENFORCE);
    expect(verdict.exitCode).toBe(1);
    expect(verdict.failures.map(f => f.gate)).toEqual(['known_answer:get_backlinks']);
    const lines = verdictLines(report, verdict, ENFORCE).join('\n');
    expect(lines).toContain('GATE FAIL known_answer:get_backlinks');
    expect(lines).toContain('not returned for scaletok0x5');
    expect(lines).toContain('Result  (actual rows=1 loops=1)');
    expect(lines).toContain('bun run test:scale -- --engine pglite --pages 10000 --seed 1 --enforce');
  });

  test('a planted slow op breaches its ceiling report-only, and fails once ceilings are enforced', () => {
    const report = passingReport();
    report.ops[2] = { ...report.ops[2]!, p50_ms: CEILINGS_MS[HEADLINE_OP]! + 1 };
    const reportOnly = evaluateScaleGates(report, ENFORCE);
    expect(reportOnly.exitCode).toBe(0);
    expect(reportOnly.reportOnlyBreaches.map(b => b.gate)).toEqual([`ceiling:${HEADLINE_OP}`]);
    expect(verdictLines(report, reportOnly, ENFORCE).join('\n')).toContain(`REPORT-ONLY ceiling:${HEADLINE_OP}`);

    const enforced = evaluateScaleGates(report, { ...ENFORCE, enforceCeilings: true });
    expect(enforced.exitCode).toBe(1);
    expect(enforced.failures.map(f => f.gate)).toEqual([`ceiling:${HEADLINE_OP}`]);
    expect(enforced.failures[0]!.message).toContain(`p50 ${CEILINGS_MS[HEADLINE_OP]! + 1} ms`);
    expect(enforced.failures[0]!.explain).toContain('Result  (actual rows=1 loops=1)');
  });

  test('a calibrated budget breach follows the ceilings switch', () => {
    const report = { ...passingReport(), budgets_ms: { list_pages: 9 } };
    expect(evaluateScaleGates(report, ENFORCE).reportOnlyBreaches.map(b => b.gate)).toEqual(['budget:list_pages']);
    expect(evaluateScaleGates(report, { ...ENFORCE, enforceCeilings: true }).failures.map(f => f.gate)).toEqual(['budget:list_pages']);
  });

  test('ceilings are defined at 10k pages and do not bind a 50k brain', () => {
    const report = { ...passingReport(), pages: 50_000, phases_ms: { import: 60_000, budgets: 30_000 } };
    report.ops[0] = { ...report.ops[0]!, p50_ms: 5_000 };
    expect(evaluateScaleGates(report, { ...ENFORCE, enforceCeilings: true }).results.some(r => r.gate.startsWith('ceiling:'))).toBe(false);
  });

  test('an over-cap budgets phase is report-only behind the planner switch and fails when it is on', () => {
    const report = passingReport();
    report.phases_ms.budgets = 5 * 60_000 + 1;
    const off = evaluateScaleGates(report, { ...ENFORCE, enforcePlanner: false });
    expect(off.exitCode).toBe(0);
    expect(off.reportOnlyBreaches.map(b => b.gate)).toEqual(['phase:budgets']);
    expect(verdictLines(report, off, { ...ENFORCE, enforcePlanner: false }).join('\n')).toContain('REPORT-ONLY phase:budgets: phase timer: budgets took 300 s');
    const on = evaluateScaleGates(report, { ...ENFORCE, enforcePlanner: true });
    expect(on.exitCode).toBe(1);
    expect(on.failures.map(f => f.gate)).toEqual(['phase:budgets']);
  });

  test('a phase over its timer fails naming the phase; limits are 20 min at 10k and 100 min at 50k', () => {
    expect(phaseLimitsMs(10_000)).toEqual({ import: 15 * 60_000, budgets: 5 * 60_000 });
    expect(phaseLimitsMs(50_000)).toEqual({ import: 75 * 60_000, budgets: 25 * 60_000 });
    const report = passingReport();
    report.phases_ms.import = 15 * 60_000 + 1;
    const verdict = evaluateScaleGates(report, ENFORCE);
    expect(verdict.exitCode).toBe(1);
    expect(verdict.failures.map(f => f.gate)).toEqual(['phase:import']);
    expect(verdict.failures[0]!.message).toContain('phase timer: import took 900 s (ceiling 900 s');
  });

  test('import rate fails on either ratio: last-10% cost, or total vs the halfway mark', () => {
    const slowTail = passingReport();
    slowTail.import.cpu = { ...STEADY, rate_ratio: 2.3, per_page_ms_last10: 23 };
    expect(evaluateScaleGates(slowTail, ENFORCE).failures.map(f => f.gate)).toEqual(['import_rate']);
    const slowHalf = passingReport();
    slowHalf.import.cpu = { ...STEADY, total_vs_half: 2.6 };
    expect(evaluateScaleGates(slowHalf, ENFORCE).failures.map(f => f.gate)).toEqual(['import_rate']);
    const tiny = { ...slowHalf, pages: RATE_MIN_PAGES - 1 };
    expect(evaluateScaleGates(tiny, ENFORCE)).toMatchObject({ exitCode: 0, reportOnlyBreaches: [expect.objectContaining({ gate: 'import_rate' })] });
  });

  // A shared CI host that takes the CPU away mid-import inflates wall time but not the import
  // process's CPU time; a brain whose per-page work really grows raises both.
  describe('import rate from the progress stream', () => {
    const PAGES = 10_000;
    function progressStream(perPage: (i: number) => { wall: number; cpu: number }): string {
      let wall = 0;
      let cpu = 0;
      const lines = ['{"event":"start","phase":"import.files","total":10000,"ts":"t"}', 'a non-JSON warning line'];
      for (let i = 0; i < PAGES; i++) {
        const page = perPage(i);
        wall += page.wall;
        cpu += page.cpu;
        lines.push(JSON.stringify({ event: 'tick', phase: 'import.files', done: i + 1, total: PAGES, elapsed_ms: wall, cpu_ms: cpu, ts: 't' }));
      }
      return lines.join('\n');
    }
    function importRateGate(engine: ScaleReport['engine'], stderr: string) {
      const { wallMs, cpuMs } = importProgressPerFile(stderr);
      const report = { ...passingReport(), engine, import: { wall: rateMeasure(wallMs), cpu: rateMeasure(cpuMs) } };
      return evaluateScaleGates(report, ENFORCE).results.find(r => r.gate === 'import_rate')!;
    }
    const lastTenth = (i: number) => i >= PAGES * 0.9;

    test('wall time spiking while CPU time stays flat passes on PGLite and still fails on Postgres', () => {
      const stolen = progressStream(i => ({ wall: lastTenth(i) ? 13 : 5, cpu: 5 }));
      const pglite = importRateGate('pglite', stolen);
      expect(pglite.status).toBe('pass');
      expect(pglite.message).toContain('import rate (cpu time): last 10% per-page cost 5 ms is 1x the first 10%');
      expect(pglite.message).toContain('Not judged on pglite: wall time ratio 2.6');
      const postgres = importRateGate('postgres', stolen);
      expect(postgres.status).toBe('fail');
      expect(postgres.message).toContain('import rate (wall time): last 10% per-page cost 13 ms is 2.6x the first 10%');
    });

    test('CPU time rising with the brain fails on both engines', () => {
      const growing = progressStream(i => ({ wall: lastTenth(i) ? 13 : 5, cpu: lastTenth(i) ? 12 : 5 }));
      expect(importRateGate('pglite', growing)).toMatchObject({ status: 'fail', enforced: true });
      expect(importRateGate('postgres', growing)).toMatchObject({ status: 'fail', enforced: true });
    });

    test('a tick without cpu_ms, or a missing tick, leaves NaN for the harness to reject', () => {
      const stream = progressStream(() => ({ wall: 5, cpu: 5 })).split('\n');
      stream[5] = stream[5]!.replace(/,"cpu_ms":\d+/, '');
      stream.splice(9, 1);
      const { wallMs, cpuMs } = importProgressPerFile(stream.join('\n'));
      expect(wallMs).toHaveLength(PAGES);
      expect(Number.isNaN(cpuMs[3]!) && Number.isNaN(cpuMs[4]!)).toBe(true);
      expect(wallMs.filter(ms => !Number.isFinite(ms))).toHaveLength(2);
    });
  });

  test('a failed data check (no-op re-import wrote rows) exits 1 naming the check', () => {
    const report = passingReport();
    report.data = [{ check: 'noop_reimport_writes_nothing', status: 'fail', detail: 're-importing the unchanged corpus imported 3 page(s)' }];
    const verdict = evaluateScaleGates(report, ENFORCE);
    expect(verdict.exitCode).toBe(1);
    expect(verdict.failures[0]!.message).toContain('noop_reimport_writes_nothing failed: re-importing the unchanged corpus imported 3 page(s)');
  });

  test('planner health stays report-only behind the switch, and enforces with the plan when switched on', () => {
    const report = passingReport();
    report.planner.hot_table_stat_rows.links = 0;
    const quadratic = { ...PLAN, inner_loops: 10 * report.pages + 1, text: 'Nested Loop  (actual rows=1 loops=1)\n  ->  Seq Scan on links (loops=100001)' };
    report.ops[0] = { ...report.ops[0]!, plan: { statements: 1, slowest: PLAN, worst_loops: quadratic } };

    const off = evaluateScaleGates(report, { ...ENFORCE, enforcePlanner: false });
    expect(off.exitCode).toBe(0);
    expect(off.reportOnlyBreaches.map(b => b.gate)).toEqual(['planner_stats', 'planner_loops:get_health']);

    const on = evaluateScaleGates(report, { ...ENFORCE, enforcePlanner: true });
    expect(on.exitCode).toBe(1);
    expect(on.failures.map(f => f.gate)).toEqual(['planner_stats', 'planner_loops:get_health']);
    expect(on.failures[0]!.message).toContain('no pg_stats rows after get_health for links (10000 rows)');
    expect(on.failures[1]!.explain).toContain('Seq Scan on links (loops=100001)');
    expect(KEY_PLAN_OPS).toContain('get_health');
  });

  test('planner health is enforced since F4b and checks only hot tables above the row threshold', () => {
    expect(PLANNER_HEALTH_ENFORCED).toBe(true);
    const small = passingReport();
    small.planner.hot_table_stat_rows.takes = 0;
    small.planner.hot_table_rows.takes = PLANNER_STATS_MIN_ROWS;
    expect(evaluateScaleGates(small, ENFORCE)).toMatchObject({ exitCode: 0, failures: [] });
    small.planner.hot_table_rows.takes = PLANNER_STATS_MIN_ROWS + 1;
    const verdict = evaluateScaleGates(small, ENFORCE);
    expect(verdict.failures.map(f => f.gate)).toEqual(['planner_stats']);
    expect(verdict.failures[0]!.message).toContain(`no pg_stats rows after get_health for takes (${PLANNER_STATS_MIN_ROWS + 1} rows)`);
    expect(verdict.failures[0]!.message).toContain('gbrain repair planner-stats --apply');
  });

  test('missing pg_stats rows on Postgres are report-only: autovacuum owns its statistics', () => {
    const report = { ...passingReport(), engine: 'postgres' as const };
    report.planner.hot_table_stat_rows.facts = 0;
    const verdict = evaluateScaleGates(report, ENFORCE);
    expect(verdict.exitCode).toBe(0);
    expect(verdict.reportOnlyBreaches.map(b => b.gate)).toEqual(['planner_stats']);
    expect(verdict.reportOnlyBreaches[0]!.message).toContain('autovacuum');
  });

  test('without --enforce every run exits 0 and says how many gates would fail', () => {
    const report = passingReport();
    report.ops[0] = { ...report.ops[0]!, known_answer: 'fail', detail: 'page_count 1 != 10000' };
    const policy = { ...ENFORCE, enforce: false };
    const verdict = evaluateScaleGates(report, policy);
    expect(verdict.exitCode).toBe(0);
    expect(verdictLines(report, verdict, policy).at(-1)).toContain('1 gate(s) would fail under --enforce');
  });
});

test('resultHits reads slugs from arrays and nested evidence objects', () => {
  expect(resultHits([{ slug: 'a', source_id: 'default' }, { results: [{ slug: 'b' }] }])).toEqual([{ slug: 'a', source_id: 'default' }, { slug: 'b' }]);
  expect(resultHits(null)).toEqual([]);
});
