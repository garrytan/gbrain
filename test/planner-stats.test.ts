/**
 * F4b (spec 5.3, O-ENG-12): transactional planner-statistics accounting and
 * row-delta ANALYZE on PGLite. In-memory PGLite ($0). Restart and crash cases
 * live in test/planner-stats-restart.test.ts, the 2,000-page import in
 * test/planner-stats-import.slow.test.ts, Postgres in
 * test/e2e/planner-stats-postgres.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  __testing, analyzePlannerTables, maybeRefreshPlannerStats, readPlannerStatsState, type PlannerRefreshReason,
} from '../src/core/planner-stats.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { REPAIR_KINDS } from '../src/core/repair/core.ts';
import { plannerStatsRepair } from '../src/core/repair/planner-stats.ts';
import { runImport } from '../src/commands/import.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw('DELETE FROM planner_stats_deltas');
  await engine.executeRaw('DELETE FROM planner_stats_state');
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'planner.%' OR key = 'import.analyze_every_pages'");
  // The reset deletes rows but keeps catalog row counts; re-sample the emptied pages table so an index
  // count left by an earlier test's narrow ANALYZE is not read as an expression index without statistics.
  await engine.executeRaw('ANALYZE pages');
  __testing.reset(engine);
  __testing.hooks.afterWatermark = undefined;
  __testing.hooks.onAnalyzed = undefined;
});

async function table(name: string) {
  const state = await readPlannerStatsState(engine);
  return state!.find(t => t.table === name)!;
}

async function insertFacts(count: number) {
  await engine.executeRaw(`INSERT INTO facts (fact, source) SELECT 'claim ' || g, 'test' FROM generate_series(1, $1::int) g`, [count]);
}

async function insertTakes(count: number) {
  const page = await engine.putPage('notes/takes-host', { type: 'note', title: 'Takes host', compiled_truth: 'Host page.' });
  await engine.executeRaw(
    `INSERT INTO takes (page_id, row_num, claim, kind, holder) SELECT $1, g, 'take ' || g, 'take', 'garry' FROM generate_series(1, $2::int) g`,
    [page.id, count]);
  return page.id;
}

async function runDoctorCheck(): Promise<Check> {
  const entry = DOCTOR_CHECK_REGISTRY.find(e => e.name === 'planner_stats_stale')!;
  const ctx = { engine, progress: { heartbeat() {}, start() {}, tick() {}, finish() {} } } as unknown as DoctorContext;
  const result = await entry.run(ctx);
  return (result as Check[])[0]!;
}

describe('transactional accounting (O-ENG-12)', () => {
  test('1. a raw executeRaw UPDATE of 600 facts rows makes facts stale', async () => {
    await insertFacts(600);
    await maybeRefreshPlannerStats(engine, 'repair', { throttle: false });
    expect(await table('facts')).toMatchObject({ pending: 0, stale: false, has_stats: true });

    await engine.executeRaw("UPDATE facts SET fact = fact || ' (edited)'");

    expect(await table('facts')).toMatchObject({ pending: 600, stale: true });
  });

  test('2. delete/reinsert of 300 takes counts 600', async () => {
    const pageId = await insertTakes(300);
    await analyzePlannerTables(engine, ['takes'], 'repair');
    expect((await table('takes')).pending).toBe(0);

    await engine.transaction(async tx => {
      await tx.executeRaw('DELETE FROM takes WHERE page_id = $1', [pageId]);
      await tx.executeRaw(
        `INSERT INTO takes (page_id, row_num, claim, kind, holder) SELECT $1, g, 'take ' || g, 'take', 'garry' FROM generate_series(1, 300) g`, [pageId]);
    });

    expect((await table('takes')).pending).toBe(600);
  });

  test('3. a rolled-back transaction adds nothing', async () => {
    await expect(engine.transaction(async tx => {
      await tx.executeRaw(`INSERT INTO facts (fact, source) SELECT 'rolled back ' || g, 'test' FROM generate_series(1, 700) g`);
      throw new Error('roll back');
    })).rejects.toThrow('roll back');

    expect(await table('facts')).toMatchObject({ pending: 0, stale: false });
    const [{ n }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM planner_stats_deltas');
    expect(n).toBe(0);
  });

  test('5. a modification committed between reading the watermark and publishing stays pending', async () => {
    await insertFacts(700);
    __testing.hooks.afterWatermark = async (_engine, name) => {
      if (name === 'facts') await engine.executeRaw(`INSERT INTO facts (fact, source) SELECT 'racer ' || g, 'test' FROM generate_series(1, 25) g`);
    };

    const result = await maybeRefreshPlannerStats(engine, 'repair', { throttle: false });

    expect(result.analyzed.map(a => a.table)).toEqual(['facts']);
    expect((await table('facts')).pending).toBe(25);
  });

  test('a stale table is analyzed once and its pending count resets; unchanged tables are left alone', async () => {
    await insertFacts(700);
    const first = await maybeRefreshPlannerStats(engine, 'repair', { throttle: false });
    expect(first.analyzed).toEqual([expect.objectContaining({ table: 'facts', pending: 700 })]);
    const second = await maybeRefreshPlannerStats(engine, 'repair', { throttle: false });
    expect(second.analyzed).toEqual([]);
    expect(await table('facts')).toMatchObject({ pending: 0, reltuples: 700, has_stats: true });
  });

  test('checks are throttled to one per 2 s per engine', async () => {
    await maybeRefreshPlannerStats(engine, 'idle');
    await insertFacts(700);
    expect((await maybeRefreshPlannerStats(engine, 'idle')).skipped).toBe('throttled');
    expect((await maybeRefreshPlannerStats(engine, 'import', { throttle: false })).analyzed.map(a => a.table)).toEqual(['facts']);
  });
});

describe('first relevant read (O-ENG-12, decision 5)', () => {
  test('get_health on stale tables analyzes them before answering', async () => {
    await insertFacts(800);
    await engine.getHealth();
    expect(await table('facts')).toMatchObject({ pending: 0, has_stats: true });
  });

  test('a table whose last ANALYZE exceeded planner.first_read_budget_ms is analyzed after the read', async () => {
    await insertFacts(800);
    await engine.executeRaw("INSERT INTO planner_stats_state (table_name, analyzed_through, last_analyze_ms) VALUES ('facts', 0, 60000)");
    await engine.setConfig('planner.first_read_budget_ms', '2000');
    const order: string[] = [];
    let analyzed!: () => void;
    const done = new Promise<void>(resolve => { analyzed = resolve; });
    __testing.hooks.onAnalyzed = async (_engine, event) => { order.push(`analyze:${event.table}`); analyzed(); };

    await engine.findOrphanPages();
    order.push('read answered');
    await done;

    expect(order).toEqual(['read answered', 'analyze:facts']);
    expect((await table('facts')).pending).toBe(0);
  });

  test('reads inside a transaction never analyze', async () => {
    await insertFacts(800);
    await engine.transaction(async tx => { await tx.listPages({ limit: 5 }); });
    expect((await table('facts')).pending).toBe(800);
  });
});

describe('7. planner.auto_analyze=false', () => {
  test('disables every call site; doctor still reports', async () => {
    await withEnv({ GBRAIN_PLANNER_AUTO_ANALYZE: 'false' }, async () => {
      await insertFacts(800);
      for (const reason of ['first_read', 'import', 'managed_sync', 'cycle', 'idle'] as PlannerRefreshReason[]) {
        __testing.reset(engine);
        expect((await maybeRefreshPlannerStats(engine, reason, { throttle: false })).skipped).toBe('disabled');
      }
      __testing.reset(engine);
      await engine.getHealth();
      await engine.searchKeyword('claim');
      await engine.findOrphanPages();
      await engine.listPages({ limit: 5 });

      const dir = mkdtempSync(join(tmpdir(), 'planner-off-'));
      for (let i = 0; i < 3; i++) writeFileSync(join(dir, `note-${i}.md`), `---\ntitle: Note ${i}\n---\nBody ${i}.\n`);
      await engine.setConfig('import.analyze_every_pages', '1');
      await runImport(engine, [dir, '--no-embed']);

      const facts = await table('facts');
      expect(facts).toMatchObject({ pending: 800, stale: true });

      const check = await runDoctorCheck();
      expect(check.status).toBe('warn');
      expect(check.message).toContain('facts (800 rows changed since ANALYZE');
      expect(check.message).toContain('gbrain repair planner-stats --apply');
      expect(check.message).toContain('gbrain config set planner.auto_analyze true');
    });
  });

  test('config key planner.auto_analyze=false disables too; the env var wins over config', async () => {
    await insertFacts(800);
    await engine.setConfig('planner.auto_analyze', 'false');
    expect((await maybeRefreshPlannerStats(engine, 'cycle', { throttle: false })).skipped).toBe('disabled');
    await withEnv({ GBRAIN_PLANNER_AUTO_ANALYZE: '1' }, async () => {
      expect((await maybeRefreshPlannerStats(engine, 'cycle', { throttle: false })).analyzed.map(a => a.table)).toEqual(['facts']);
    });
  });
});

describe('doctor planner_stats_stale and repair planner-stats', () => {
  test('doctor is ok when fresh, warns naming each stale table and the exact fix; repair clears it', async () => {
    expect((await runDoctorCheck()).status).toBe('ok');
    expect(categorizeCheck('planner_stats_stale')).toBe('ops');

    await insertFacts(900);
    await withEnv({ GBRAIN_PLANNER_AUTO_ANALYZE: '0' }, async () => {
      const check = await runDoctorCheck();
      expect(check.status).toBe('warn');
      expect(check.message).toContain('facts (900 rows changed since ANALYZE, threshold 500');
      expect(check.details?.fix).toBe('gbrain repair planner-stats --apply');

      expect(REPAIR_KINDS).toContain('planner-stats');
      const plan = await plannerStatsRepair.plan(engine, { brain_id: 'host', source_ids: [] }, null);
      expect(plan.items.map(i => i.slug)).toEqual(['facts']);
      const ctx = { engine, logger: { info() {}, warn() {}, error() {} } } as never;
      expect(await plannerStatsRepair.apply(ctx, plan.items[0]!)).toBe(true);
      expect((await runDoctorCheck()).status).toBe('ok');
    });
  });
});
