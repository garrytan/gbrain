/**
 * F4b (O-ENG-12, O-CEO-9, O-CEO-17): row-delta ANALYZE for PGLite.
 *
 * PGLite has no autovacuum, so planner statistics are only as fresh as the
 * last explicit ANALYZE; without them search and graph reads plan as
 * pages-by-pages nested loops. The f4_planner_stats migration
 * (`planner-stats-schema.ts`) records every statement's row count on the hot
 * tables in `planner_stats_deltas`, transactionally and durably. A table is
 * stale when the rows modified since its last ANALYZE exceed
 * max(500, 10% of pg_class.reltuples), or when it has rows but no pg_stats
 * row. `maybeRefreshPlannerStats` ANALYZEs the stale tables and publishes a
 * per-table watermark: the highest delta id it read before the ANALYZE, so a
 * modification committed between that read and the publication stays pending.
 *
 * Call sites: the PGLite engine's planner-sensitive reads (first relevant
 * read, `planner.first_read_budget_ms`), bulk import, managed sync and the
 * database timeline walk every `import.analyze_every_pages` pages, stale link
 * drains (`plannerStatsForLinkDrain`), the cycle after its freshness phases,
 * the resident consumer's idle tick, and `refreshProjectionStatistics` (full
 * ANALYZE, then watermarks for every table). `planner.auto_analyze=false`
 * (env GBRAIN_PLANNER_AUTO_ANALYZE) disables all of them; doctor
 * `planner_stats_stale` and `gbrain repair planner-stats` keep working.
 * Postgres: every function here is a no-op (autovacuum owns statistics).
 */
import type { BrainEngine } from './engine.ts';
import { PLANNER_STATS_TABLES, type PlannerStatsTable } from './planner-stats-schema.ts';

export const PLANNER_STATS_MIN_PENDING = 500;
export const PLANNER_STATS_PENDING_RATIO = 0.1;
export const PLANNER_STATS_THROTTLE_MS = 2000;
export const DEFAULT_FIRST_READ_BUDGET_MS = 2000;
export const DEFAULT_IMPORT_ANALYZE_EVERY_PAGES = 500;
export const PLANNER_STATS_REPAIR_COMMAND = 'gbrain repair planner-stats --apply';

export type PlannerRefreshReason = 'first_read' | 'import' | 'managed_sync' | 'extract' | 'cycle' | 'idle' | 'repair';

export interface PlannerTableState {
  table: PlannerStatsTable;
  pending: number;
  reltuples: number;
  has_stats: boolean;
  threshold: number;
  stale: boolean;
  analyzed_at: string | null;
  last_analyze_ms: number | null;
}

export interface PlannerRefreshResult {
  reason: PlannerRefreshReason;
  skipped?: 'not_pglite' | 'disabled' | 'throttled' | 'in_flight' | 'unavailable';
  analyzed: Array<{ table: PlannerStatsTable; pending: number; ms: number }>;
  /** Stale tables whose last ANALYZE exceeded the first-read budget: refreshed after the read instead of before it. */
  deferred: PlannerStatsTable[];
}

interface PlannerTestHooks {
  /** Runs after a table's watermark is read and before its ANALYZE and publication. */
  afterWatermark?: (engine: BrainEngine, table: PlannerStatsTable, watermark: number) => Promise<void>;
  /** Runs after each published ANALYZE. */
  onAnalyzed?: (engine: BrainEngine, event: { reason: PlannerRefreshReason; table: PlannerStatsTable; pending: number; ms: number }) => Promise<void>;
}

const hooks: PlannerTestHooks = {};
const runtime = new WeakMap<BrainEngine, { lastCheck: number; inflight: Promise<unknown> | null }>();

function runtimeFor(engine: BrainEngine) {
  let state = runtime.get(engine);
  if (!state) runtime.set(engine, state = { lastCheck: 0, inflight: null });
  return state;
}

const OFF = ['0', 'false', 'off', 'no'];

/** `planner.auto_analyze` (config) with GBRAIN_PLANNER_AUTO_ANALYZE (env) taking precedence; default on. */
export async function plannerAutoAnalyzeEnabled(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  let raw = process.env.GBRAIN_PLANNER_AUTO_ANALYZE ?? null;
  if (raw === null) {
    try { raw = await engine.getConfig('planner.auto_analyze'); } catch { raw = null; }
  }
  return raw == null || !OFF.includes(raw.trim().toLowerCase());
}

async function numericConfig(engine: Pick<BrainEngine, 'getConfig'>, key: string, fallback: number): Promise<number> {
  const raw = await engine.getConfig(key);
  const value = raw == null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** `import.analyze_every_pages`: bulk import and managed sync check planner statistics every N pages (0 disables). */
export async function importAnalyzeEveryPages(engine: BrainEngine): Promise<number> {
  if (engine.kind !== 'pglite') return 0;
  return Math.floor(await numericConfig(engine, 'import.analyze_every_pages', DEFAULT_IMPORT_ANALYZE_EVERY_PAGES));
}

export const plannerStatsThreshold = (reltuples: number) =>
  Math.max(PLANNER_STATS_MIN_PENDING, PLANNER_STATS_PENDING_RATIO * Math.max(0, reltuples));

/** Per hot table: rows modified since its watermark, planner row estimate and whether pg_stats has rows. Null before the migration. */
export async function readPlannerStatsState(engine: BrainEngine): Promise<PlannerTableState[] | null> {
  const [present] = await engine.executeRaw<{ ok: boolean }>(
    "SELECT to_regclass('planner_stats_deltas') IS NOT NULL AND to_regclass('planner_stats_state') IS NOT NULL AS ok");
  if (!present?.ok) return null;
  const rows = await engine.executeRaw<{ table_name: PlannerStatsTable; pending: string | number; reltuples: number | null;
    has_stats: boolean; analyzed_at: string | Date | null; last_analyze_ms: number | null }>(
    `WITH pending AS (
       SELECT d.table_name, sum(d.n) AS n FROM planner_stats_deltas d
         LEFT JOIN planner_stats_state s ON s.table_name = d.table_name
        WHERE d.id > COALESCE(s.analyzed_through, 0)
        GROUP BY d.table_name)
     SELECT t.table_name, COALESCE(p.n, 0)::bigint AS pending, c.reltuples::float8 AS reltuples,
            EXISTS (SELECT 1 FROM pg_stats ps WHERE ps.schemaname = 'public' AND ps.tablename = t.table_name) AS has_stats,
            s.analyzed_at, s.last_analyze_ms
       FROM unnest($1::text[]) WITH ORDINALITY AS t(table_name, position)
       LEFT JOIN pending p ON p.table_name = t.table_name
       LEFT JOIN planner_stats_state s ON s.table_name = t.table_name
       LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || t.table_name)
      ORDER BY t.position`,
    [[...PLANNER_STATS_TABLES]]);
  return rows.map(row => {
    const pending = Number(row.pending);
    const reltuples = Number(row.reltuples ?? -1);
    const threshold = plannerStatsThreshold(reltuples);
    return {
      table: row.table_name, pending, reltuples, has_stats: row.has_stats, threshold,
      stale: pending > threshold || (reltuples > 0 && !row.has_stats),
      analyzed_at: row.analyzed_at == null ? null : new Date(row.analyzed_at).toISOString(),
      last_analyze_ms: row.last_analyze_ms,
    };
  });
}

/**
 * Postgres variant for doctor and repair: autovacuum's own counters. A table
 * is stale when `n_mod_since_analyze` exceeds the same threshold and neither
 * ANALYZE nor autoanalyze ran in the last hour.
 */
export async function readPostgresPlannerStats(engine: BrainEngine): Promise<PlannerTableState[]> {
  const rows = await engine.executeRaw<{ table_name: PlannerStatsTable; pending: string | number; reltuples: number | null;
    analyzed_at: string | Date | null; recent: boolean }>(
    `SELECT s.relname AS table_name, s.n_mod_since_analyze AS pending, c.reltuples::float8 AS reltuples,
            GREATEST(s.last_analyze, s.last_autoanalyze) AS analyzed_at,
            COALESCE(GREATEST(s.last_analyze, s.last_autoanalyze) > now() - interval '1 hour', false) AS recent
       FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
      WHERE s.schemaname = current_schema() AND s.relname = ANY($1::text[])
      ORDER BY array_position($1::text[], s.relname::text)`,
    [[...PLANNER_STATS_TABLES]]);
  return rows.map(row => {
    const pending = Number(row.pending);
    const reltuples = Number(row.reltuples ?? -1);
    const threshold = plannerStatsThreshold(reltuples);
    return { table: row.table_name, pending, reltuples, has_stats: true, threshold, stale: pending > threshold && !row.recent,
      analyzed_at: row.analyzed_at == null ? null : new Date(row.analyzed_at).toISOString(), last_analyze_ms: null };
  });
}

/** The engine's table states: the F4b deltas on PGLite (null before the migration), autovacuum's counters on Postgres. */
export async function readPlannerTableStates(engine: BrainEngine): Promise<PlannerTableState[] | null> {
  return engine.kind === 'pglite' ? readPlannerStatsState(engine) : readPostgresPlannerStats(engine);
}

/** `gbrain repair planner-stats --apply`: one bounded ANALYZE on the brain host (Postgres: 60 s statement, 2 s lock timeout). */
export async function repairPlannerTable(engine: BrainEngine, table: PlannerStatsTable): Promise<void> {
  if (!PLANNER_STATS_TABLES.includes(table)) throw new Error(`Not a planner statistics table: ${table}`);
  if (engine.kind === 'pglite') {
    await analyzePlannerTables(engine, [table], 'repair');
    return;
  }
  await engine.transaction(async tx => {
    await tx.executeRaw("SET LOCAL statement_timeout = '60s'");
    await tx.executeRaw("SET LOCAL lock_timeout = '2s'");
    await tx.executeRaw(`ANALYZE ${table}`);
  });
}

async function readWatermarks(engine: BrainEngine, tables: readonly PlannerStatsTable[]): Promise<Map<PlannerStatsTable, number>> {
  const rows = await engine.executeRaw<{ table_name: PlannerStatsTable; watermark: string | number }>(
    `SELECT t.table_name, COALESCE((SELECT max(d.id) FROM planner_stats_deltas d WHERE d.table_name = t.table_name), 0) AS watermark
       FROM unnest($1::text[]) AS t(table_name)`, [[...tables]]);
  return new Map(rows.map(row => [row.table_name, Number(row.watermark)]));
}

/** `ms` null (a full ANALYZE, not timed per table) keeps the table's last measured ANALYZE time. */
async function publishWatermark(engine: BrainEngine, table: PlannerStatsTable, watermark: number, ms: number | null): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO planner_stats_state (table_name, analyzed_through, analyzed_at, last_analyze_ms) VALUES ($1, $2, now(), $3)
     ON CONFLICT (table_name) DO UPDATE SET analyzed_through = GREATEST(planner_stats_state.analyzed_through, EXCLUDED.analyzed_through),
       analyzed_at = EXCLUDED.analyzed_at, last_analyze_ms = COALESCE(EXCLUDED.last_analyze_ms, planner_stats_state.last_analyze_ms)`,
    [table, watermark, ms === null ? null : Math.round(ms)]);
  await engine.executeRaw('DELETE FROM planner_stats_deltas WHERE table_name = $1 AND id <= $2', [table, watermark]);
}

/**
 * Per table: read its watermark, then ANALYZE it, publish the watermark and drop
 * the deltas it covers in one transaction. Table names come only from
 * PLANNER_STATS_TABLES.
 */
export async function analyzePlannerTables(engine: BrainEngine, tables: readonly PlannerStatsTable[], reason: PlannerRefreshReason,
  pending: ReadonlyMap<PlannerStatsTable, number> = new Map()): Promise<PlannerRefreshResult['analyzed']> {
  const analyzed: PlannerRefreshResult['analyzed'] = [];
  for (const table of tables) {
    if (!PLANNER_STATS_TABLES.includes(table)) throw new Error(`Not a planner statistics table: ${table}`);
    const watermark = (await readWatermarks(engine, [table])).get(table) ?? 0;
    await hooks.afterWatermark?.(engine, table, watermark);
    const ms = await engine.transaction(async tx => {
      const started = performance.now();
      await tx.executeRaw(`ANALYZE ${table}`);
      const elapsed = performance.now() - started;
      await publishWatermark(tx, table, watermark, elapsed);
      return elapsed;
    });
    const event = { table, pending: pending.get(table) ?? 0, ms: Math.round(ms) };
    analyzed.push(event);
    await hooks.onAnalyzed?.(engine, { reason, ...event });
  }
  return analyzed;
}

/**
 * After a full ANALYZE (GBRA-39's `refreshProjectionStatistics` on PGLite):
 * read the watermarks first with `beginFullAnalyze`, ANALYZE, then call the
 * returned function in the same transaction to publish them for every table.
 * A no-op before the migration and on Postgres.
 */
export async function beginFullAnalyze(engine: BrainEngine): Promise<() => Promise<void>> {
  const noop = async () => {};
  if (engine.kind !== 'pglite') return noop;
  const [present] = await engine.executeRaw<{ ok: boolean }>("SELECT to_regclass('planner_stats_state') IS NOT NULL AS ok");
  if (!present?.ok) return noop;
  const marks = await readWatermarks(engine, PLANNER_STATS_TABLES);
  return async () => {
    for (const table of PLANNER_STATS_TABLES) await publishWatermark(engine, table, marks.get(table) ?? 0, null);
  };
}

/**
 * Check the hot tables and ANALYZE the stale ones (PGLite, when
 * `planner.auto_analyze` is on). Checks are throttled to one per 2 s per
 * engine unless `throttle: false` (the page-count cadence of import and
 * managed sync). With `budgetMs`, a stale table whose last ANALYZE took longer
 * is returned in `deferred` instead of being analyzed now.
 */
export async function maybeRefreshPlannerStats(engine: BrainEngine, reason: PlannerRefreshReason,
  opts: { throttle?: boolean; budgetMs?: number } = {}): Promise<PlannerRefreshResult> {
  const result: PlannerRefreshResult = { reason, analyzed: [], deferred: [] };
  if (engine.kind !== 'pglite') return { ...result, skipped: 'not_pglite' };
  const state = runtimeFor(engine);
  if (state.inflight) {
    await state.inflight.catch(() => {});
    return { ...result, skipped: 'in_flight' };
  }
  if (opts.throttle !== false && Date.now() - state.lastCheck < PLANNER_STATS_THROTTLE_MS) return { ...result, skipped: 'throttled' };
  state.lastCheck = Date.now();
  if (!await plannerAutoAnalyzeEnabled(engine)) return { ...result, skipped: 'disabled' };
  const run = (async (): Promise<PlannerRefreshResult> => {
    const tables = await readPlannerStatsState(engine);
    if (!tables) return { ...result, skipped: 'unavailable' };
    const stale = tables.filter(t => t.stale);
    const now = stale.filter(t => opts.budgetMs === undefined || (t.last_analyze_ms ?? 0) <= opts.budgetMs);
    result.deferred = stale.filter(t => !now.includes(t)).map(t => t.table);
    result.analyzed = await analyzePlannerTables(engine, now.map(t => t.table), reason, new Map(stale.map(t => [t.table, t.pending])));
    return result;
  })();
  state.inflight = run;
  try { return await run; } finally { state.inflight = null; }
}

/** A stale link drain at least this large checks planner statistics before its first page (PLANNER_STATS_MIN_PENDING's floor). */
export const LINK_DRAIN_ANALYZE_MIN_STALE = 500;
/** Link-graph tables the drain rewrites that carry no F4b deltas: analyzed whenever `links` is. */
const LINK_DRAIN_UNTRACKED_TABLES = ['link_transitions', 'link_relationships'] as const;

/**
 * Planner upkeep for a stale link drain (`extractStaleFromDB` and
 * `extractManagedStaleLinks`). The drain reads every page twice through
 * readPageSnapshot and rewrites its links; on a brain that grew since its last
 * ANALYZE the snapshot read scans the whole source instead of using
 * pages_source_slug_key, so per-page cost grows with brain size. PGLite with at
 * least LINK_DRAIN_ANALYZE_MIN_STALE stale pages (`countStale`, called only on
 * PGLite): refresh stale tables now, then again every
 * `import.analyze_every_pages` drained pages through the returned tick. Each
 * refresh ANALYZEs only tables past the F4b threshold, plus link_transitions
 * and link_relationships when `links` was analyzed. Postgres, small drains and
 * `planner.auto_analyze=false`: a no-op. Never throws.
 */
export async function plannerStatsForLinkDrain(engine: BrainEngine, countStale: () => Promise<number>): Promise<(drained: number) => Promise<void>> {
  const noop = async () => {};
  const every = await importAnalyzeEveryPages(engine).catch(() => 0);
  if (every <= 0 || await countStale().catch(() => 0) < LINK_DRAIN_ANALYZE_MIN_STALE) return noop;
  const refresh = async () => {
    const { analyzed } = await maybeRefreshPlannerStats(engine, 'extract', { throttle: false });
    if (!analyzed.some(a => a.table === 'links')) return;
    for (const table of LINK_DRAIN_UNTRACKED_TABLES) await engine.executeRaw(`ANALYZE ${table}`);
  };
  await refresh().catch(() => undefined);
  let next = every;
  return async drained => {
    if (drained < next) return;
    next = drained + every;
    await refresh().catch(() => undefined);
  };
}

/**
 * The first relevant read (O-ENG-12): refresh stale tables within
 * `planner.first_read_budget_ms` before the read; the returned function, called
 * once the read has answered, refreshes the tables whose last ANALYZE exceeded
 * the budget. A no-op for reads inside a transaction. Never throws: planner
 * upkeep must not fail a read.
 */
export async function beforePlannerRead(engine: BrainEngine, inTransaction = false): Promise<() => void> {
  const noop = () => {};
  if (inTransaction) return noop;
  const state = runtimeFor(engine);
  if (!state.inflight && Date.now() - state.lastCheck < PLANNER_STATS_THROTTLE_MS) return noop;
  try {
    const budgetMs = await numericConfig(engine, 'planner.first_read_budget_ms', DEFAULT_FIRST_READ_BUDGET_MS);
    const { deferred } = await maybeRefreshPlannerStats(engine, 'first_read', { budgetMs });
    if (deferred.length === 0) return noop;
    return () => {
      if (state.inflight) return;
      const run = analyzePlannerTables(engine, deferred, 'first_read').catch(() => []);
      state.inflight = run.finally(() => { state.inflight = null; });
    };
  } catch {
    return noop;
  }
}

/** Run a planner-sensitive read between `beforePlannerRead` and its deferred refresh. */
export async function plannerRead<T>(engine: BrainEngine, inTransaction: boolean, read: () => Promise<T>): Promise<T> {
  const settle = await beforePlannerRead(engine, inTransaction);
  try { return await read(); } finally { settle(); }
}

/** Exposed for tests. */
export const __testing = {
  hooks,
  /** Forget an engine's throttle and in-flight state. */
  reset(engine: BrainEngine) { runtime.delete(engine); },
};
