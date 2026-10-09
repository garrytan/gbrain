/**
 * F4b (spec 5.3 test 9, O-CEO-9): on Postgres the f4_planner_stats migration
 * is a no-op (autovacuum owns statistics): no planner_stats_* table, no
 * gbrain_count_modifications function, no planner_stats_* trigger, and
 * maybeRefreshPlannerStats never runs. Doctor planner_stats_stale reads
 * pg_stat_user_tables.n_mod_since_analyze, and repair planner-stats ANALYZEs
 * the stale table with bounded timeouts.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import { maybeRefreshPlannerStats, readPostgresPlannerStats } from '../../src/core/planner-stats.ts';
import { DOCTOR_CHECK_REGISTRY } from '../../src/commands/doctor/registry.ts';
import { plannerStatsRepair } from '../../src/core/repair/planner-stats.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { Check } from '../../src/commands/doctor.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

d('planner stats on Postgres', () => {
  beforeAll(async () => { await setupDB(); });
  afterAll(async () => { await teardownDB(); });

  async function doctor(): Promise<Check> {
    const entry = DOCTOR_CHECK_REGISTRY.find(e => e.name === 'planner_stats_stale')!;
    const ctx = { engine: getEngine(), progress: { heartbeat() {}, start() {}, tick() {}, finish() {} } } as unknown as DoctorContext;
    return ((await entry.run(ctx)) as Check[])[0]!;
  }

  test('9. no planner_stats objects exist and the refresh is a no-op', async () => {
    const engine = getEngine();
    const [objects] = await engine.executeRaw<{ tables: number; functions: number; triggers: number }>(
      `SELECT (SELECT count(*)::int FROM pg_class WHERE relname LIKE 'planner_stats%') AS tables,
              (SELECT count(*)::int FROM pg_proc WHERE proname = 'gbrain_count_modifications') AS functions,
              (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE 'planner_stats%') AS triggers`);
    expect(objects).toEqual({ tables: 0, functions: 0, triggers: 0 });
    expect((await maybeRefreshPlannerStats(engine, 'first_read', { throttle: false })).skipped).toBe('not_pglite');
  });

  test('9. doctor reads pg_stat_user_tables; repair planner-stats analyzes the stale table', async () => {
    const engine = getEngine();
    // Autoanalyze would race the wait below: 2,000 inserts cross its threshold, and an
    // ANALYZE that lands first resets n_mod_since_analyze to 0, so the counter never
    // reaches 2,000. Hold autovacuum off facts for this test; the test's own repair
    // step is the ANALYZE that clears the counter.
    await engine.executeRaw('ALTER TABLE facts SET (autovacuum_enabled = false)');
    try {
      await engine.executeRaw(`INSERT INTO facts (fact, source) SELECT 'pg claim ' || g, 'test' FROM generate_series(1, 2000) g`);
      // pg_stat counters are reported asynchronously by the backend; wait until the inserts are visible.
      for (let i = 0; i < 50; i++) {
        await engine.executeRaw('SELECT pg_stat_clear_snapshot()');
        const facts = (await readPostgresPlannerStats(engine)).find(t => t.table === 'facts');
        if (facts && facts.pending >= 2000) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      const states = await readPostgresPlannerStats(engine);
      const facts = states.find(t => t.table === 'facts')!;
      expect(facts.pending).toBeGreaterThanOrEqual(2000);
      expect(states.map(t => t.table)).toContain('pages');

      const check = await doctor();
      expect(check.details?.engine).toBe('postgres');
      expect(check.details?.fix).toBe('gbrain repair planner-stats --apply');
      if (facts.stale) {
        expect(check.status).toBe('warn');
        expect(check.message).toContain('facts (');
        const plan = await plannerStatsRepair.plan(engine, { brain_id: 'host', source_ids: [] }, null);
        expect(plan.items.map(i => i.slug)).toContain('facts');
        const ctx = { engine, logger: { info() {}, warn() {}, error() {} } } as never;
        expect(await plannerStatsRepair.apply(ctx, plan.items.find(i => i.slug === 'facts')!)).toBe(true);
      } else {
        // Autovacuum (or a prior ANALYZE) touched facts within the last hour: Postgres does not warn then.
        expect(facts.analyzed_at).not.toBeNull();
      }
      await engine.executeRaw('SELECT pg_stat_clear_snapshot()');
      const after = (await readPostgresPlannerStats(engine)).find(t => t.table === 'facts')!;
      expect(after.stale).toBe(false);
    } finally {
      await engine.executeRaw('ALTER TABLE facts RESET (autovacuum_enabled)');
    }
  });
});
