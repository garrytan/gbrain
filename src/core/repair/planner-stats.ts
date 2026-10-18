/**
 * `gbrain repair planner-stats` (F4b, O-DX-9): ANALYZE the hot tables doctor
 * `planner_stats_stale` reports. The preview lists each stale table with its
 * pending row count; `--apply` runs one bounded ANALYZE per table on the brain
 * host (Postgres: 60 s statement timeout, 2 s lock timeout; PGLite also
 * publishes the table's row-delta watermark). Brain-wide; no journal
 * admission and no user data changes, so `--all` and doctor remediation
 * include it. Works when `planner.auto_analyze` is off.
 *
 * Postgres: when `missingSearchStatistics` finds search's statistics absent,
 * the plan leads with one `search-statistics` item whose apply is
 * `refreshProjectionStatistics` (the one refresh path for those columns).
 *
 * Both engines: a hot table carrying an expression index without statistics
 * (`readExpressionIndexesWithoutStats`, lhf wave 2 item 6) is planned too,
 * with the index named in its action; the same whole-table ANALYZE collects
 * it. On Postgres this repair is the recovery (autovacuum waits for 10% of the
 * rows to change), run by an operator.
 */
import { PLANNER_STATS_TABLES, type PlannerStatsTable } from '../planner-stats-schema.ts';
import { readExpressionIndexesWithoutStats, readPlannerTableStates, repairPlannerTable } from '../planner-stats.ts';
import { missingSearchStatistics, refreshProjectionStatistics } from '../search/projection-statistics.ts';
import type { RepairHandler, RepairItem } from './core.ts';

const SEARCH_STATISTICS_ITEM = 'search-statistics';

export const plannerStatsRepair: RepairHandler = {
  kind: 'planner-stats',
  publication: 'projection',
  embeds: false,
  // ANALYZE is idempotent, so every run plans what is stale now (the cursor never skips a table).
  async plan(engine) {
    const tables = await readPlannerTableStates(engine) ?? [];
    const missing = await missingSearchStatistics(engine);
    const search: RepairItem[] = missing.length === 0 ? [] : [{ cursor: { phase: 0, id: 0 }, source_id: '(brain)', slug: SEARCH_STATISTICS_ITEM,
      chars: 0, action: `collect search statistics (${missing.length} absent: ${missing.join(', ')})` }];
    const gaps = await readExpressionIndexesWithoutStats(engine);
    const reasons = (table: PlannerStatsTable) => {
      const t = tables.find(state => state.table === table);
      const stale = t?.stale ? [`${t.pending} rows changed since ANALYZE, threshold ${Math.round(t.threshold)}${t.has_stats ? '' : ', no statistics'}`] : [];
      return stale.concat(gaps.filter(g => g.table === table).map(g => `expression index ${g.index} has no statistics`));
    };
    const items: RepairItem[] = search.concat(PLANNER_STATS_TABLES.filter(table => reasons(table).length > 0).map(table => ({
      cursor: { phase: 0, id: PLANNER_STATS_TABLES.indexOf(table) + 1 }, source_id: '(brain)', slug: table, chars: 0,
      action: `analyze (${reasons(table).join('; ')})`,
    })));
    return { items, residuals: {} };
  },
  async apply(ctx, item) {
    if (item.slug === SEARCH_STATISTICS_ITEM) return refreshProjectionStatistics(ctx.engine);
    if (!PLANNER_STATS_TABLES.includes(item.slug as PlannerStatsTable)) return false;
    await repairPlannerTable(ctx.engine, item.slug as PlannerStatsTable);
    return true;
  },
};
