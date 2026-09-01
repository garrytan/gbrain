/**
 * v0.32.3 — `gbrain search` CLI surface.
 *
 * Three sub-subcommands, mirroring `gbrain models` (v0.31.12) for shape
 * consistency:
 *
 *   gbrain search modes [--json]
 *     Read-only routing dashboard. Prints the three mode bundles, the
 *     active mode, the source of every resolved knob (mode default vs
 *     config override vs per-call), and a one-liner per knob.
 *
 *   gbrain search modes --reset [--source <mode>]
 *     Clears every search.* override key (per CDX-8). --source acts as
 *     a dry-run that lists what would change without writing.
 *
 *   gbrain search stats [--days N] [--json]
 *     Observability. Reads search_telemetry rollup over the window.
 *     Shows hit rate %, intent mix, mode mix, budget pressure, avg
 *     results, avg tokens delivered.
 *
 *   gbrain search tune [--apply] [--json]
 *     Recommendation engine. Reads stats + brain size + model tier and
 *     prints structured recommendations. --apply mutates config (each
 *     change logged loud + paste-ready revert command at the end).
 *
 * The report builders live in core (src/core/search/modes-report.ts,
 * tune-recommendations.ts, telemetry.ts) and are shared with the
 * search_modes / search_stats / search_tune MCP ops. This file owns arg
 * parsing, text rendering, the --reset lane, and the --apply lane
 * (config mutation stays CLI-only per [CDX-21]).
 */

import type { BrainEngine } from '../core/engine.ts';
import {
  SEARCH_MODES,
  SEARCH_MODE_KEY,
  isSearchMode,
} from '../core/search/mode.ts';
import {
  readSearchStats,
  readGraphSignalsStats,
  telemetryCoverage,
  TELEMETRY_COVERAGE_CAVEAT,
  type GraphSignalsStatsSection,
} from '../core/search/telemetry.ts';
import {
  buildModesReport,
  KNOB_DESCRIPTIONS,
  type SearchModesReport,
} from '../core/search/modes-report.ts';
import {
  buildTuneRecommendations,
  TUNE_MIN_CALLS,
  type TuneRecommendation,
} from '../core/search/tune-recommendations.ts';

function formatModesText(report: SearchModesReport): string {
  const lines: string[] = [];
  lines.push('Search mode (active): ' + report.active_mode + (report.active_mode_valid ? '' : '  (unset — using balanced fallback)'));
  lines.push('');
  lines.push('Resolved knobs:');
  for (const [knob, attr] of Object.entries(report.resolved)) {
    const value = String(attr.value ?? '(undefined)');
    lines.push(`  ${knob.padEnd(28)} = ${value.padEnd(12)} [${attr.source_detail}]`);
  }
  lines.push('');
  lines.push('Mode bundles (frozen — set via `gbrain config set search.mode <mode>`):');
  for (const mode of SEARCH_MODES) {
    const b = report.bundles[mode];
    const active = mode === report.active_mode ? '  ← active' : '';
    lines.push(`  ${mode.padEnd(13)}${active}`);
    lines.push(`    cache=${b.cache_enabled} intentWeighting=${b.intentWeighting} keywordOrFallback=${b.keywordOrFallback}`);
    lines.push(`    tokenBudget=${b.tokenBudget ?? 'none'} searchLimit=${b.searchLimit} expansion=${b.expansion}`);
  }
  lines.push('');
  lines.push('Knob descriptions:');
  for (const [k, desc] of Object.entries(KNOB_DESCRIPTIONS)) {
    lines.push(`  ${k.padEnd(28)} ${desc}`);
  }
  // #4604: the dashboard shows brain-level resolution only.
  lines.push('');
  lines.push(`Note: ${report.per_call_note}`);
  return lines.join('\n');
}

async function runModesSubcommand(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const reset = args.includes('--reset');
  const sourceIdx = args.indexOf('--source');
  const dryRunSource = sourceIdx !== -1 ? args[sourceIdx + 1] : null;

  // --reset path: clear every search.* OVERRIDE key (not search.mode itself).
  // --source <mode> is a dry-run that prints what would change.
  if (reset || dryRunSource) {
    const dryRun = Boolean(dryRunSource);
    if (dryRunSource && !isSearchMode(dryRunSource)) {
      console.error(`Invalid --source value: ${dryRunSource}. Expected one of: ${SEARCH_MODES.join(', ')}`);
      process.exit(1);
    }
    const overrides = await engine.listConfigKeys('search.');
    const toRemove = overrides.filter((k) => k !== SEARCH_MODE_KEY && k !== 'search.mode_upgrade_notice_shown');
    if (toRemove.length === 0) {
      console.log('No search.* overrides set. Mode bundle is the only voice.');
      return;
    }
    if (dryRun) {
      console.log(`--source ${dryRunSource} (dry run). Would unset ${toRemove.length} key(s):`);
      for (const k of toRemove) console.log(`  - ${k}`);
      console.log(`No changes written. Re-run with --reset to apply.`);
      return;
    }
    let deleted = 0;
    for (const k of toRemove) {
      const n = await engine.unsetConfig(k);
      deleted += n;
    }
    console.log(`Reset complete. Unset ${deleted} key(s):`);
    for (const k of toRemove) console.log(`  - ${k}`);
    console.log(`Mode bundle is now the only voice. Verify with: gbrain search modes`);
    return;
  }

  // Default: read-only dashboard.
  const report = await buildModesReport(engine);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatModesText(report));
  }
}

async function runStatsSubcommand(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const daysIdx = args.indexOf('--days');
  const days = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) : 7;

  const stats = await readSearchStats(engine, { days: Number.isFinite(days) ? days : 7 });

  // v0.40.4 — graph_signals section (readGraphSignalsStats now lives in
  // core/search/telemetry.ts, shared with the search_stats op).
  const gsSection = await readGraphSignalsStats(engine, Number.isFinite(days) ? days : 7);

  if (json) {
    console.log(JSON.stringify({
      schema_version: 2,
      ...stats,
      coverage: telemetryCoverage(),
      graph_signals: gsSection,
      _meta: {
        metric_glossary: {
          cache_hit_rate: 'cache_hits / (cache_hits + cache_misses) — fraction of searches that reused a recent answer instead of running fresh',
          avg_results: 'mean number of result rows returned per search call',
          avg_tokens: 'mean estimated tokens in the returned chunk text (char/4 heuristic)',
          total_budget_dropped: 'sum of results dropped because the call exceeded its tokenBudget',
          graph_signals_enabled: 'whether graph_signals is on for the active mode (or via search.graph_signals override)',
          graph_signals_failures_count: 'count of fail-open events in the JSONL audit over the window',
        },
      },
    }, null, 2));
    return;
  }

  console.log(`Search stats over the last ${stats.window_days} days:`);
  console.log(`  Coverage note: ${TELEMETRY_COVERAGE_CAVEAT}`);
  console.log('');
  console.log(`  Total searches:        ${stats.total_calls}`);
  if (stats.total_calls === 0) {
    console.log('');
    console.log('No telemetry recorded in this window. This can mean no search activity, or');
    console.log('it can reflect the coverage gap above — CLI calls flush on clean exit, but');
    console.log('hard kills and over-bound drains still drop their buffer. `gbrain serve` /');
    console.log('an MCP session records most reliably (telemetry stays best-effort either way).');
    // Still print the graph-signals section since failures are tracked
    // independently of the search_telemetry table.
    if (gsSection.enabled || gsSection.failures_count > 0) {
      console.log('');
      printGraphSignalsSection(gsSection);
    }
    return;
  }
  const hitRatePct = (stats.cache_hit_rate * 100).toFixed(1);
  console.log(`  Cache hit rate:        ${hitRatePct}%  (${stats.cache_hits} hit / ${stats.cache_misses} miss)`);
  console.log(`                         (fraction of searches that reused a recent answer)`);
  console.log(`  Avg results returned:  ${stats.avg_results.toFixed(1)}`);
  console.log(`  Avg tokens delivered:  ${stats.avg_tokens.toFixed(0)}  (char/4 heuristic)`);
  console.log(`  Budget drops total:    ${stats.total_budget_dropped}`);
  // T7 — rank-1 match-quality drift signal. Watch for avg drifting DOWN.
  if (stats.avg_rank1_score !== null && stats.rank1_count > 0) {
    const d = stats.rank1_distribution;
    console.log(`  Avg rank-1 score:      ${stats.avg_rank1_score.toFixed(3)}  (${stats.rank1_count} samples; <0.6:${d.lt_solid} 0.6-0.85:${d.solid} >=0.85:${d.high})`);
    console.log(`                         (top-result match quality; a downward drift = retrieval regressing)`);
  }
  console.log('');
  console.log('  Mode distribution:');
  for (const [m, c] of Object.entries(stats.mode_distribution).sort((a, b) => b[1] - a[1])) {
    const pct = ((c / stats.total_calls) * 100).toFixed(1);
    console.log(`    ${m.padEnd(14)} ${c} (${pct}%)`);
  }
  console.log('');
  console.log('  Intent distribution:');
  for (const [i, c] of Object.entries(stats.intent_distribution).sort((a, b) => b[1] - a[1])) {
    const pct = ((c / stats.total_calls) * 100).toFixed(1);
    console.log(`    ${i.padEnd(14)} ${c} (${pct}%)`);
  }
  if (stats.oldest_seen || stats.newest_seen) {
    console.log('');
    console.log(`  Window: ${stats.oldest_seen ?? '?'} → ${stats.newest_seen ?? '?'}`);
  }
  console.log('');
  printGraphSignalsSection(gsSection);
}

function printGraphSignalsSection(gs: GraphSignalsStatsSection): void {
  console.log('  Graph signals:');
  const sourceLabel = gs.source === 'config' ? 'config override' : 'mode default';
  console.log(`    enabled:    ${gs.enabled} (${sourceLabel})`);
  if (gs.failures_count === 0) {
    console.log('    failures:   0 (fail-open events in window)');
  } else {
    console.log(`    failures:   ${gs.failures_count} fail-open event(s)`);
    const top = Object.entries(gs.failures_by_reason)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    for (const [reason, count] of top) {
      console.log(`      ${reason.padEnd(20)} ${count}`);
    }
  }
  if (!gs.enabled && gs.failures_count > 0) {
    console.log(`    note:       failures observed but graph_signals currently off — historical events`);
  }
}

async function runTuneSubcommand(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const apply = args.includes('--apply');

  const report = await buildTuneRecommendations(engine);
  const recs = report.recommendations;

  // Recommendation gate: low call volume → no data yet.
  if (report.status === 'insufficient_data') {
    if (json) {
      console.log(JSON.stringify({
        schema_version: 2,
        status: 'insufficient_data',
        total_calls: report.total_calls,
        coverage: report.coverage,
        recommendations: [],
        message: 'Not enough search activity in the last 7 days to tune. Run `gbrain search stats` after some real usage.',
      }, null, 2));
      return;
    }
    console.log('Not enough search activity in the last 7 days to tune.');
    console.log(`Total searches: ${report.total_calls} (need >= ${TUNE_MIN_CALLS} for confident recommendations).`);
    console.log(`(${TELEMETRY_COVERAGE_CAVEAT} Low counts can reflect this gap, not just low usage.)`);
    console.log('Use `gbrain serve` or an MCP session for a while, then re-run `gbrain search tune`.');
    return;
  }

  if (json) {
    console.log(JSON.stringify({
      schema_version: 2,
      status: report.status,
      total_calls: report.total_calls,
      cache_hit_rate: report.cache_hit_rate,
      active_mode: report.active_mode,
      coverage: report.coverage,
      recommendations: recs,
      applied: apply ? recs.map(r => r.apply_command) : [],
      _meta: {
        metric_glossary: {
          cache_hit_rate: 'cache_hits / (cache_hits + cache_misses)',
          total_calls: 'total searches recorded in the last 7 days',
        },
      },
    }, null, 2));
    if (apply) {
      for (const r of recs) {
        await maybeApplyRecommendation(engine, r);
      }
    }
    return;
  }

  console.log(`Search tune (last 7 days, active mode: ${report.active_mode}):`);
  console.log(`(${TELEMETRY_COVERAGE_CAVEAT})`);
  console.log('');

  if (recs.length === 0) {
    console.log('  No recommendations. Your search config looks well-tuned.');
    return;
  }

  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    console.log(`  ${i + 1}. ${r.knob}: ${String(r.current)} → ${String(r.suggested)}`);
    console.log(`     ${r.reason}`);
    console.log(`     Apply: ${r.apply_command}`);
    console.log('');
  }

  if (apply) {
    console.log('Applying recommendations:');
    const reverts: string[] = [];
    for (const r of recs) {
      await maybeApplyRecommendation(engine, r);
      console.log(`  ✓ ${r.apply_command}`);
      reverts.push(buildRevertCommand(r));
    }
    console.log('');
    console.log('To revert these changes:');
    for (const cmd of reverts) console.log(`  ${cmd}`);
  } else {
    console.log('Run `gbrain search tune --apply` to apply these changes automatically.');
  }
}

async function maybeApplyRecommendation(engine: BrainEngine, r: TuneRecommendation): Promise<void> {
  // The apply command is the canonical paste-ready string; here we
  // re-parse it to call setConfig / unsetConfig directly so the call
  // happens in-process.
  const parts = r.apply_command.split(/\s+/);
  if (parts[0] !== 'gbrain' || parts[1] !== 'config') return;
  if (parts[2] === 'set' && parts.length === 5) {
    await engine.setConfig(parts[3], parts[4]);
  } else if (parts[2] === 'unset' && parts.length === 4) {
    await engine.unsetConfig(parts[3]);
  }
}

function buildRevertCommand(r: TuneRecommendation): string {
  const parts = r.apply_command.split(/\s+/);
  if (parts[2] === 'set') {
    return `gbrain config set ${parts[3]} ${String(r.current)}`;
  } else if (parts[2] === 'unset') {
    return `gbrain config set ${parts[3]} ${String(r.current)}`;
  }
  return r.apply_command;
}

const USAGE = `Usage: gbrain search <modes|stats|tune> [flags]

Subcommands:
  modes [--json]              Show active mode, bundles, and per-knob source.
  modes --reset               Clear all search.* overrides (mode bundle wins).
  modes --source <mode>       Dry-run: list what --reset would change.
  stats [--days N] [--json]   Cache hit rate, intent mix, budget pressure.
  tune [--apply] [--json]     Print recommendations; --apply mutates config.

Examples:
  gbrain search modes
  gbrain search modes --reset
  gbrain search stats --days 30 --json
  gbrain search tune
  gbrain search tune --apply
`;

export async function runSearch(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  if (!sub || sub === '--help' || sub === '-h') {
    console.log(USAGE);
    return;
  }

  switch (sub) {
    case 'modes':
      await runModesSubcommand(engine, rest);
      return;
    case 'stats':
      await runStatsSubcommand(engine, rest);
      return;
    case 'tune':
      await runTuneSubcommand(engine, rest);
      return;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      console.error(USAGE);
      process.exit(1);
  }
}

export const _exports_for_test = {
  buildModesReport,
  formatModesText,
  maybeApplyRecommendation,
  buildRevertCommand,
};
