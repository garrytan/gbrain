/**
 * lhf wave 2 item 6: planner statistics after index builds. `buildIndexOnline`
 * analyzes the table after it creates an index (best effort: a failed ANALYZE
 * warns with the command and never fails the migration), and the F4b
 * maintenance passes give an already-present expression index its statistics
 * (`readExpressionIndexesWithoutStats`), never on a search's first read.
 * In-memory PGLite ($0); Postgres doctor and repair are in
 * test/e2e/planner-stats-postgres.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { __testing, analyzePlannerTables, maybeRefreshPlannerStats, readExpressionIndexesWithoutStats, readPlannerStatsState } from '../src/core/planner-stats.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import { plannerStatsRepair } from '../src/core/repair/planner-stats.ts';
import { runMigrations } from '../src/core/migrate.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';
import { PAGES_NAME_LOOKUP_INDEXES, v240 } from '../src/core/schema-migrations/v240-pages-name-lookup-indexes.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

const TITLE_INDEX = PAGES_NAME_LOOKUP_INDEXES[0];
const PAGES = 600;
let engine: PGLiteEngine;

async function hasIndexStats(name: string): Promise<boolean> {
  const [row] = await engine.executeRaw<{ has: boolean }>('SELECT EXISTS (SELECT 1 FROM pg_stats WHERE tablename = $1) AS has', [name]);
  return row!.has;
}

async function doctor(): Promise<Check> {
  const entry = DOCTOR_CHECK_REGISTRY.find(e => e.name === 'planner_stats_stale')!;
  const ctx = { engine, progress: { heartbeat() {}, start() {}, tick() {}, finish() {} } } as unknown as DoctorContext;
  return ((await entry.run(ctx)) as Check[])[0]!;
}

/** The pre-item-6 upgrade: pages analyzed, then v240's index built with no ANALYZE after it. */
async function upgradedBrainWithUnanalyzedIndex() {
  await engine.executeRaw(`DROP INDEX IF EXISTS ${TITLE_INDEX.name}`);
  await analyzePlannerTables(engine, ['pages'], 'repair');
  await engine.executeRaw(TITLE_INDEX.sql);
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ out: T; text: string }> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  const warn = console.warn;
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    return { out: await fn(), text: lines.join('') };
  } finally {
    process.stderr.write = write;
    console.warn = warn;
  }
}

/** The engine with every ANALYZE failing as a held lock would. */
function failingAnalyze(base: PGLiteEngine): BrainEngine {
  const fail = (sql: string) => { if (/^\s*ANALYZE\b/i.test(sql)) throw new Error('canceling statement due to lock timeout'); };
  const wrap = (target: BrainEngine): BrainEngine => {
    const wrapped = Object.create(target) as BrainEngine;
    wrapped.executeRaw = (async (sql: string, ...rest: unknown[]) => { fail(sql); return (target.executeRaw as (...a: unknown[]) => unknown)(sql, ...rest); }) as BrainEngine['executeRaw'];
    wrapped.transaction = (async (fn: (tx: BrainEngine) => Promise<unknown>, opts?: unknown) =>
      (target.transaction as (f: unknown, o?: unknown) => Promise<unknown>)((tx: BrainEngine) => fn(wrap(tx)), opts)) as BrainEngine['transaction'];
    return wrapped;
  };
  return wrap(base);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title) SELECT 'default', 'people/person-' || g, 'person', 'Person Example ' || g FROM generate_series(1, $1::int) g`,
    [PAGES]);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'planner.%'");
  __testing.reset(engine);
});

describe('expression index statistics on an upgraded PGLite brain', () => {
  test('a pre-existing v240 index with no statistics is flagged with its own reason, never as a row delta', async () => {
    await upgradedBrainWithUnanalyzedIndex();
    expect(await hasIndexStats(TITLE_INDEX.name)).toBe(false);
    const pages = (await readPlannerStatsState(engine))!.find(t => t.table === 'pages')!;
    expect(pages.stale).toBe(false);
    expect(await readExpressionIndexesWithoutStats(engine)).toEqual([{ index: TITLE_INDEX.name, table: 'pages' }]);

    const check = await doctor();
    expect(check.status).toBe('warn');
    expect(check.message).toContain(`expression index ${TITLE_INDEX.name} (on pages) has no statistics`);
    expect(check.message).toContain('The next maintenance pass');
    expect(check.message).toContain('gbrain repair planner-stats --apply');
    expect(check.message).not.toContain('rows changed since ANALYZE');
  });

  test("a search's first read never runs the probe; the next maintenance pass gives the index statistics", async () => {
    await upgradedBrainWithUnanalyzedIndex();
    const statements: string[] = [];
    const spy = Object.create(engine) as PGLiteEngine;
    spy.executeRaw = (async (sql: string, params?: unknown[]) => { statements.push(sql); return engine.executeRaw(sql, params as never); }) as PGLiteEngine['executeRaw'];
    const first = await maybeRefreshPlannerStats(spy, 'first_read', { throttle: false });
    expect(first.analyzed).toEqual([]);
    expect(statements.some(sql => sql.includes('indexprs'))).toBe(false);
    expect(await hasIndexStats(TITLE_INDEX.name)).toBe(false);

    const cycle = await maybeRefreshPlannerStats(engine, 'cycle');
    expect(cycle.analyzed.map(a => a.table)).toEqual(['pages']);
    expect(await hasIndexStats(TITLE_INDEX.name)).toBe(true);
    expect(await readExpressionIndexesWithoutStats(engine)).toEqual([]);
    expect((await doctor()).status).toBe('ok');
    __testing.reset(engine);
    expect((await maybeRefreshPlannerStats(engine, 'cycle')).analyzed).toEqual([]);
  });

  test('planner.auto_analyze=false leaves it to the repair, which names the index and clears it', async () => {
    await upgradedBrainWithUnanalyzedIndex();
    await engine.setConfig('planner.auto_analyze', 'false');
    expect((await maybeRefreshPlannerStats(engine, 'cycle')).skipped).toBe('disabled');
    expect((await doctor()).message).toContain('Automatic ANALYZE is off');

    const plan = await plannerStatsRepair.plan(engine, { brain_id: 'host', source_ids: [] }, null);
    const item = plan.items.find(i => i.slug === 'pages')!;
    expect(item.action).toBe(`analyze (expression index ${TITLE_INDEX.name} has no statistics)`);
    const ctx = { engine, logger: { info() {}, warn() {}, error() {} } } as never;
    expect(await plannerStatsRepair.apply(ctx, item)).toBe(true);
    expect(await hasIndexStats(TITLE_INDEX.name)).toBe(true);
    expect((await plannerStatsRepair.plan(engine, { brain_id: 'host', source_ids: [] }, null)).items.map(i => i.slug)).not.toContain('pages');
  });

  test('all-null and empty expressions do not stay flagged', async () => {
    await engine.executeRaw(`INSERT INTO facts (fact, source) SELECT 'claim ' || g, 'test' FROM generate_series(1, 50) g`);
    await analyzePlannerTables(engine, ['facts'], 'repair');
    await engine.executeRaw('CREATE INDEX test_facts_null_expr ON facts (lower(entity_slug))');
    await engine.executeRaw("CREATE INDEX test_facts_empty_expr ON facts (lower(fact)) WHERE fact = 'no fact matches this'");
    try {
      expect(await readExpressionIndexesWithoutStats(engine)).toEqual([{ index: 'test_facts_null_expr', table: 'facts' }]);
      await maybeRefreshPlannerStats(engine, 'idle');
      const [nulls] = await engine.executeRaw<{ null_frac: number }>("SELECT null_frac FROM pg_stats WHERE tablename = 'test_facts_null_expr'");
      expect(nulls!.null_frac).toBe(1);
      expect(await hasIndexStats('test_facts_empty_expr')).toBe(false);
      expect(await readExpressionIndexesWithoutStats(engine)).toEqual([]);
    } finally {
      for (const sql of ['DROP INDEX test_facts_null_expr', 'DROP INDEX test_facts_empty_expr', 'DELETE FROM facts']) await engine.executeRaw(sql);
    }
  });
});

describe('buildIndexOnline analyzes after it builds', () => {
  test('the v240 handler prints the build notice and leaves the index with statistics', async () => {
    await engine.executeRaw(`DROP INDEX IF EXISTS ${TITLE_INDEX.name}`);
    const { text } = await captureStderr(() => v240.handler!(engine));
    expect(text).toContain(`building ${TITLE_INDEX.name} on ~${PAGES} rows, then analyzing pages`);
    expect(text).not.toContain('[warn]');
    expect(await hasIndexStats(TITLE_INDEX.name)).toBe(true);
    expect(await readExpressionIndexesWithoutStats(engine)).toEqual([]);
  });

  test('a forced ANALYZE failure leaves the migration applied, the index valid and the warning printed', async () => {
    await engine.executeRaw(`DROP INDEX IF EXISTS ${TITLE_INDEX.name}`);
    await engine.setConfig('version', String(v240.version - 1));
    const { out, text } = await captureStderr(() => runMigrations(failingAnalyze(engine)));
    expect(out.current).toBe(LATEST_SCHEMA_VERSION);
    expect(await engine.getConfig('version')).toBe(String(LATEST_SCHEMA_VERSION));
    expect(text).toContain(`[${v240.version}] ✓ ${v240.name}`);
    expect(text).toContain(`${TITLE_INDEX.name} is built and valid, but ANALYZE pages failed (canceling statement due to lock timeout)`);
    expect(text).toContain('Run on the brain host: gbrain repair planner-stats --apply');
    const [valid] = await engine.executeRaw<{ valid: boolean }>('SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass($1)', [TITLE_INDEX.name]);
    expect(valid!.valid).toBe(true);
    expect(await readExpressionIndexesWithoutStats(engine)).toEqual([{ index: TITLE_INDEX.name, table: 'pages' }]);

    await maybeRefreshPlannerStats(engine, 'cycle');
    expect(await readExpressionIndexesWithoutStats(engine)).toEqual([]);
  }, 60_000);
});
