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
 */
import { plannerAutoAnalyzeEnabled, PLANNER_STATS_REPAIR_COMMAND, readPlannerTableStates } from '../../../core/planner-stats.ts';
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
    const details = { engine: engine.kind, auto_analyze: autoAnalyze, checked: tables.map(t => t.table), stale, missing_search_statistics: missing, fix: PLANNER_STATS_REPAIR_COMMAND };
    if (stale.length === 0 && missing.length === 0) {
      checks.push({ name: 'planner_stats_stale', status: 'ok', message: `Planner statistics are fresh on ${tables.length} hot tables.`, details });
      return checks;
    }
    if (missing.length > 0) {
      const owner = await canAnalyzePages(engine);
      const why = `Search's planner statistics are absent (${missing.join(', ')}), so search plans as nested loops over every page: `
        + 'at 5,000 pages a search took 50-60 s instead of 0.5 s. Autovacuum does not restore them after pg_upgrade or a deleted pg_statistic.';
      const listed = stale.map(t => `${t.table} (${t.pending} rows changed since ANALYZE, threshold ${Math.round(t.threshold)})`).join(', ');
      checks.push({ name: 'planner_stats_stale', status: 'warn',
        message: `${why}${listed ? ` Also stale: ${listed}.` : ''} Fix on the brain host: ${PLANNER_STATS_REPAIR_COMMAND}${owner ? '' : ' as the table owner'}.`, details,
        fix: { argv: PLANNER_STATS_REPAIR_COMMAND.split(' '), consent: [], actor: owner ? 'agent' : 'host_admin', why,
          verify: doctorVerify('planner_stats_stale'), requires_exclusive: false } });
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
      message: `Stale planner statistics: ${listed}. ${why} Fix on the brain host: ${PLANNER_STATS_REPAIR_COMMAND}.${off}`, details });
  } catch (err) {
    checks.push({ name: 'planner_stats_stale', status: 'warn',
      message: `Planner statistics could not be read: ${err instanceof Error ? err.message : String(err)}. Freshness is unknown; preview the repair with: gbrain repair planner-stats` });
  }
  return checks;
}

export const plannerStatsEntry: DoctorEntry = { name: 'planner_stats_stale', emits: ['planner_stats_stale'], run: runPlannerStats };
