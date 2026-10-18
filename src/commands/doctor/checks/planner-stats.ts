/**
 * planner_stats_stale (F4b, O-DX-9): hot tables whose planner statistics are
 * stale enough to give the query planner the wrong shape (pages-by-pages
 * nested loops in search and graph reads).
 *
 * PGLite reads the F4b row deltas (src/core/planner-stats.ts): stale when the
 * rows modified since the table's last ANALYZE exceed max(500, 10% of its
 * rows), or when it has rows but no statistics. Postgres reads
 * `pg_stat_user_tables.n_mod_since_analyze` against the same threshold and
 * warns only when neither ANALYZE nor autoanalyze ran in the last hour. Both
 * name each table and the fix. Reports even when `planner.auto_analyze` is
 * off.
 *
 * Postgres also reports the search statistics `missingSearchStatistics`
 * finds absent (projection-statistics.ts, the test the write-pass skip and the
 * search guard use): after pg_upgrade or a deleted pg_statistic autovacuum
 * never collects them, and search plans as nested loops (50-60 s at 5,000
 * pages). The fix runs the same refresh through `gbrain repair planner-stats
 * --apply`; a role that may not ANALYZE gets it as a host-operator step.
 *
 * Both engines also report each expression index on a hot table that has no
 * statistics under its own name (`readExpressionIndexesWithoutStats`, lhf wave 2
 * item 6), with its own reason: no whole-table ANALYZE since the index was
 * built. PGLite's next maintenance pass analyzes the table; on Postgres
 * autovacuum waits for 10% of the rows to change, so the operator runs the
 * repair.
 */
import { plannerAutoAnalyzeEnabled, PLANNER_STATS_REPAIR_COMMAND, readExpressionIndexesWithoutStats, readPlannerTableStates,
  type ExpressionIndexGap } from '../../../core/planner-stats.ts';
import { canAnalyzePages, missingSearchStatistics } from '../../../core/search/projection-statistics.ts';
import type { Check } from '../../doctor.ts';
import { doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

async function runPlannerStats(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('planner_stats_stale');
  try {
    const tables = await readPlannerTableStates(engine);
    if (!tables) {
      checks.push({ name: 'planner_stats_stale', status: 'ok',
        message: 'Planner statistics accounting is not installed yet (schema migration pending). Run: gbrain apply-migrations --yes' });
      return checks;
    }
    const autoAnalyze = engine.kind === 'pglite' ? await plannerAutoAnalyzeEnabled(engine) : null;
    const stale = tables.filter(t => t.stale);
    const missing = await missingSearchStatistics(engine);
    const gaps = await readExpressionIndexesWithoutStats(engine);
    const details = { engine: engine.kind, auto_analyze: autoAnalyze, checked: tables.map(t => t.table), stale, missing_search_statistics: missing,
      expression_indexes_without_statistics: gaps, fix: PLANNER_STATS_REPAIR_COMMAND };
    const expression = expressionIndexText(gaps, engine.kind, autoAnalyze);
    if (stale.length === 0 && missing.length === 0 && gaps.length === 0) {
      checks.push({ name: 'planner_stats_stale', status: 'ok', message: `Planner statistics are fresh on ${tables.length} hot tables.`, details });
      return checks;
    }
    if (missing.length > 0) {
      const owner = await canAnalyzePages(engine);
      const why = `Search's planner statistics are absent (${missing.join(', ')}), so search plans as nested loops over every page: `
        + 'at 5,000 pages a search took 50-60 s instead of 0.5 s. Autovacuum does not restore them after pg_upgrade or a deleted pg_statistic.';
      const listed = stale.map(t => `${t.table} (${t.pending} rows changed since ANALYZE, threshold ${Math.round(t.threshold)})`).join(', ');
      checks.push({ name: 'planner_stats_stale', status: 'warn',
        message: `${why}${listed ? ` Also stale: ${listed}.` : ''}${expression ? ` Also: ${expression}` : ''} Fix on the brain host: ${PLANNER_STATS_REPAIR_COMMAND}${owner ? '' : ' as the table owner'}.`, details,
        fix: { argv: PLANNER_STATS_REPAIR_COMMAND.split(' '), consent: [], actor: owner ? 'agent' : 'host_admin', why,
          verify: doctorVerify('planner_stats_stale'), requires_exclusive: false } });
      return checks;
    }
    if (stale.length === 0) {
      checks.push({ name: 'planner_stats_stale', status: 'warn', message: `${expression} Fix on the brain host: ${PLANNER_STATS_REPAIR_COMMAND}.`, details });
      return checks;
    }
    const listed = stale.map(t => `${t.table} (${t.pending} rows changed since ANALYZE, threshold ${Math.round(t.threshold)}${t.has_stats ? '' : ', no statistics'})`).join(', ');
    const why = engine.kind === 'pglite'
      ? 'PGLite has no autovacuum, so search and graph reads may plan as slow nested loops until these tables are analyzed.'
      : 'Autovacuum has not analyzed them in the last hour, so search and graph reads may plan against stale row counts.';
    const off = autoAnalyze === false
      ? ' Automatic ANALYZE is off (planner.auto_analyze=false or GBRAIN_PLANNER_AUTO_ANALYZE=0); to turn it back on: gbrain config set planner.auto_analyze true.'
      : '';
    checks.push({ name: 'planner_stats_stale', status: 'warn',
      message: `Stale planner statistics: ${listed}. ${why}${expression ? ` Also: ${expression}` : ''} Fix on the brain host: ${PLANNER_STATS_REPAIR_COMMAND}.${off}`, details });
  } catch (err) {
    checks.push({ name: 'planner_stats_stale', status: 'warn',
      message: `Planner statistics could not be read: ${err instanceof Error ? err.message : String(err)}. Freshness is unknown; preview the repair with: gbrain repair planner-stats` });
  }
  return checks;
}

/** The expression-index sentence: its own reason, never a row delta, and who runs the ANALYZE on this engine. */
function expressionIndexText(gaps: ExpressionIndexGap[], kind: string, autoAnalyze: boolean | null): string {
  if (gaps.length === 0) return '';
  const names = gaps.map(g => `expression index ${g.index} (on ${g.table}) has no statistics`).join('; ');
  const who = kind === 'pglite'
    ? autoAnalyze === false
      ? 'Automatic ANALYZE is off (planner.auto_analyze=false), so it stays this way until the repair runs.'
      : 'The next maintenance pass (cycle, idle tick or import) analyzes the table; the repair does it now.'
    : 'Autovacuum does not analyze the table until 10% of its rows change, so an operator runs the repair.';
  return `${names}. No whole-table ANALYZE has run since the index was built (a column-list ANALYZE skips index expressions), so the planner estimates its lookups `
    + `with default selectivity (a 50-name entity names batch on a 55k-page brain: 5.4 s instead of 1.2 s). ${who}`;
}

export const plannerStatsEntry: DoctorEntry = { name: 'planner_stats_stale', emits: ['planner_stats_stale'], run: runPlannerStats };
