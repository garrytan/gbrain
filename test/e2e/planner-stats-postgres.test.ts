/**
 * F4b (spec 5.3 test 9, O-CEO-9): on Postgres the f4_planner_stats migration
 * is a no-op (autovacuum owns statistics): no planner_stats_* table, no
 * gbrain_count_modifications function, no planner_stats_* trigger, and
 * maybeRefreshPlannerStats never runs. Doctor planner_stats_stale reads
 * pg_stat_user_tables.n_mod_since_analyze, and repair planner-stats ANALYZEs
 * the stale table with bounded timeouts.
 *
 * lhf wave 2 item 6: doctor names an expression index without statistics with
 * its own reason, the repair (operator-driven on Postgres) clears it, a role
 * that cannot see the index's statistics gets no warning, and buildIndexOnline
 * analyzes after a build; a failed ANALYZE warns and keeps the valid index.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import { maybeRefreshPlannerStats, readExpressionIndexesWithoutStats, readPostgresPlannerStats } from '../../src/core/planner-stats.ts';
import { buildIndexOnline } from '../../src/core/schema-migrations/helpers.ts';
import { PAGES_NAME_LOOKUP_INDEXES } from '../../src/core/schema-migrations/v240-pages-name-lookup-indexes.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
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
      // Leave facts as the test found it: 2,000 rows left behind give idx_facts_fts index tuples, and
      // whenever autovacuum vacuums them before it analyzes, the expression-index test below sees that
      // index without statistics too.
      await engine.executeRaw("DELETE FROM facts WHERE source = 'test' AND fact LIKE 'pg claim %'");
      await engine.executeRaw('ALTER TABLE facts RESET (autovacuum_enabled)');
      await engine.executeRaw('ANALYZE facts');
    }
  });

  describe('item 6: expression index statistics', () => {
    const TITLE_INDEX = PAGES_NAME_LOOKUP_INDEXES[0];
    const repairCtx = () => ({ engine: getEngine(), logger: { info() {}, warn() {}, error() {} } }) as never;
    const hasIndexStats = async () => (await getEngine().executeRaw<{ has: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_stats WHERE schemaname = current_schema() AND tablename = $1) AS has', [TITLE_INDEX.name]))[0]!.has;
    /** The pre-item-6 upgrade: pages analyzed, then the index built with no ANALYZE after it. */
    async function unanalyzedIndex() {
      const engine = getEngine();
      await engine.executeRaw(`DROP INDEX IF EXISTS ${TITLE_INDEX.name}`);
      await engine.executeRaw('ANALYZE pages');
      await engine.executeRaw(TITLE_INDEX.sql);
    }
    async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ out: T; text: string }> {
      const lines: string[] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
      try { return { out: await fn(), text: lines.join('\n') }; } finally { console.warn = warn; }
    }

    beforeAll(async () => {
      const engine = getEngine();
      await engine.executeRaw('ALTER TABLE pages SET (autovacuum_enabled = false)');
      await engine.executeRaw(
        `INSERT INTO pages (source_id, slug, type, title) SELECT 'default', 'people/item6-' || g, 'person', 'Person Example ' || g FROM generate_series(1, 600) g`);
    });
    afterAll(async () => {
      const engine = getEngine();
      await engine.executeRaw("DELETE FROM pages WHERE slug LIKE 'people/item6-%'");
      await engine.executeRaw('ALTER TABLE pages RESET (autovacuum_enabled)');
      await engine.executeRaw('ANALYZE pages');
    });

    test('doctor names the index with its own reason; the operator repair clears it', async () => {
      await unanalyzedIndex();
      expect(await readExpressionIndexesWithoutStats(getEngine())).toEqual([{ index: TITLE_INDEX.name, table: 'pages' }]);
      const check = await doctor();
      expect(check.status).toBe('warn');
      expect(check.message).toContain(`expression index ${TITLE_INDEX.name} (on pages) has no statistics`);
      expect(check.message).toContain('an operator runs the repair');
      expect(check.message).toContain('gbrain repair planner-stats --apply');
      expect(check.message).not.toContain('pages (0 rows changed');

      const plan = await plannerStatsRepair.plan(getEngine(), { brain_id: 'host', source_ids: [] }, null);
      const item = plan.items.find(i => i.slug === 'pages')!;
      expect(item.action).toContain(`expression index ${TITLE_INDEX.name} has no statistics`);
      expect(await plannerStatsRepair.apply(repairCtx(), item)).toBe(true);
      expect(await hasIndexStats()).toBe(true);
      expect(await readExpressionIndexesWithoutStats(getEngine())).toEqual([]);
      expect((await doctor()).message).not.toContain('expression index');
    });

    test('a role that cannot see the index statistics reads them as unknown, not absent', async () => {
      await unanalyzedIndex();
      const engine = getEngine();
      await engine.executeRaw("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_item6_reader') THEN CREATE ROLE gbrain_item6_reader; END IF; END $$");
      await engine.executeRaw('GRANT USAGE ON SCHEMA public TO gbrain_item6_reader');
      await engine.executeRaw('GRANT SELECT ON pages TO gbrain_item6_reader');
      try {
        const seen = await engine.transaction(async tx => {
          await tx.executeRaw('SET LOCAL ROLE gbrain_item6_reader');
          return readExpressionIndexesWithoutStats(tx);
        });
        expect(seen).toEqual([]);
        expect(await readExpressionIndexesWithoutStats(engine)).toEqual([{ index: TITLE_INDEX.name, table: 'pages' }]);
      } finally {
        await engine.executeRaw('REVOKE ALL ON pages FROM gbrain_item6_reader');
        await engine.executeRaw('REVOKE ALL ON SCHEMA public FROM gbrain_item6_reader');
        await engine.executeRaw('DROP ROLE gbrain_item6_reader');
      }
    });

    test('buildIndexOnline builds concurrently, prints the notice and analyzes the table', async () => {
      await getEngine().executeRaw(`DROP INDEX IF EXISTS ${TITLE_INDEX.name}`);
      const notices: string[] = [];
      expect(await buildIndexOnline(getEngine(), 240, TITLE_INDEX, { notice: line => notices.push(line) })).toBe('created');
      expect(notices.join('')).toContain(`building ${TITLE_INDEX.name} on ~`);
      expect(notices.join('')).toContain('then analyzing pages');
      expect(await hasIndexStats()).toBe(true);
    });

    test('a failed ANALYZE warns with the repair command and keeps the valid index', async () => {
      await getEngine().executeRaw(`DROP INDEX IF EXISTS ${TITLE_INDEX.name}`);
      await getEngine().executeRaw('ANALYZE pages');
      const base = getEngine();
      const failing = Object.create(base) as BrainEngine;
      failing.transaction = (async (fn: (tx: BrainEngine) => Promise<unknown>) => base.transaction(async tx => {
        const wrapped = Object.create(tx) as BrainEngine;
        wrapped.executeRaw = (async (sql: string, params?: unknown[]) => {
          if (/^ANALYZE\b/.test(sql)) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
          return tx.executeRaw(sql, params as never);
        }) as BrainEngine['executeRaw'];
        return fn(wrapped);
      })) as BrainEngine['transaction'];
      const { out, text } = await captureWarnings(() => buildIndexOnline(failing, 240, TITLE_INDEX));
      expect(out).toBe('created');
      expect(text).toContain(`${TITLE_INDEX.name} is built and valid, but ANALYZE pages failed`);
      expect(text).toContain('gbrain repair planner-stats --apply');
      const [valid] = await base.executeRaw<{ valid: boolean }>('SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass($1)', [TITLE_INDEX.name]);
      expect(valid!.valid).toBe(true);
      expect(await readExpressionIndexesWithoutStats(base)).toEqual([{ index: TITLE_INDEX.name, table: 'pages' }]);
      const plan = await plannerStatsRepair.plan(base, { brain_id: 'host', source_ids: [] }, null);
      expect(await plannerStatsRepair.apply(repairCtx(), plan.items.find(i => i.slug === 'pages')!)).toBe(true);
      expect(await readExpressionIndexesWithoutStats(base)).toEqual([]);
    });
  });
});
