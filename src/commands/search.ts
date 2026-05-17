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
 */

import type { BrainEngine } from '../core/engine.ts';
import {
  MODE_BUNDLES,
  SEARCH_MODES,
  SEARCH_MODE_KEY,
  SEARCH_MODE_CONFIG_KEYS,
  DEFAULT_SEARCH_MODE,
  isSearchMode,
  loadSearchModeConfig,
  resolveSearchMode,
  attributeKnob,
  type SearchMode,
  type ModeBundle,
} from '../core/search/mode.ts';
import { readSearchStats } from '../core/search/telemetry.ts';

const KNOB_DESCRIPTIONS: Record<keyof ModeBundle, string> = {
  cache_enabled: 'Semantic query cache on/off',
  cache_similarity_threshold: 'Cosine-similarity floor for cache hits (0..1)',
  cache_ttl_seconds: 'Per-row cache TTL',
  intentWeighting: 'Zero-LLM intent classifier weight adjustments',
  tokenBudget: 'Per-call token-budget cap (undefined = no cap)',
  expansion: 'LLM multi-query expansion (Haiku call per search)',
  searchLimit: 'Default `limit` for the operation layer',
  reranker_enabled: 'Cross-encoder reranker (ZE zerank-2) on/off',
  reranker_model: 'Provider:model for the reranker',
  reranker_top_n_in: 'Candidates sent to reranker per call',
  reranker_top_n_out: 'Cap on reranked output (null = no truncate)',
  reranker_timeout_ms: 'HTTP timeout for the reranker call',
  floor_ratio: 'Floor-ratio gate for metadata boosts (0..1, undefined = off)',
};

interface SearchModesReport {
  schema_version: 2;
  active_mode: SearchMode;
  active_mode_valid: boolean;
  resolved: Record<keyof ModeBundle, { value: unknown; source: string; source_detail: string; description: string }>;
  bundles: Record<SearchMode, ModeBundle>;
  config_keys: ReadonlyArray<string>;
  _meta?: {
    metric_glossary?: Record<string, string>;
  };
}

async function buildModesReport(engine: BrainEngine): Promise<SearchModesReport> {
  const input = await loadSearchModeConfig(engine);
  const resolved = resolveSearchMode(input);

  const knobs: Array<keyof ModeBundle> = [
    'cache_enabled',
    'cache_similarity_threshold',
    'cache_ttl_seconds',
    'intentWeighting',
    'tokenBudget',
    'expansion',
    'searchLimit',
    // v0.35.6.0 — floor-ratio surfaced in `gbrain search modes` dashboard
    // so config drift is legible. Default undefined renders as 'undefined'
    // in the bundle column, 'mode' source when unset by config/per-call.
    'floor_ratio',
  ];

  const attributions = {} as SearchModesReport['resolved'];
  for (const k of knobs) {
    const a = attributeKnob(k, input, resolved);
    attributions[k] = {
      value: a.value,
      source: a.source,
      source_detail: a.source_detail,
      description: KNOB_DESCRIPTIONS[k],
    };
  }

  return {
    schema_version: 2,
    active_mode: resolved.resolved_mode,
    active_mode_valid: resolved.mode_valid,
    resolved: attributions,
    bundles: {
      conservative: { ...MODE_BUNDLES.conservative },
      balanced: { ...MODE_BUNDLES.balanced },
      tokenmax: { ...MODE_BUNDLES.tokenmax },
    },
    config_keys: SEARCH_MODE_CONFIG_KEYS,
  };
}

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
    lines.push(`    cache=${b.cache_enabled} intentWeighting=${b.intentWeighting}`);
    lines.push(`    tokenBudget=${b.tokenBudget ?? 'none'} searchLimit=${b.searchLimit} expansion=${b.expansion}`);
  }
  lines.push('');
  lines.push('Knob descriptions:');
  for (const [k, desc] of Object.entries(KNOB_DESCRIPTIONS)) {
    lines.push(`  ${k.padEnd(28)} ${desc}`);
  }
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

  if (json) {
    console.log(JSON.stringify({
      schema_version: 2,
      ...stats,
      _meta: {
        metric_glossary: {
          cache_hit_rate: 'cache_hits / (cache_hits + cache_misses) — fraction of searches that reused a recent answer instead of running fresh',
          avg_results: 'mean number of result rows returned per search call',
          avg_tokens: 'mean estimated tokens in the returned chunk text (char/4 heuristic)',
          total_budget_dropped: 'sum of results dropped because the call exceeded its tokenBudget',
        },
      },
    }, null, 2));
    return;
  }

  console.log(`Search stats over the last ${stats.window_days} days:`);
  console.log('');
  console.log(`  Total searches:        ${stats.total_calls}`);
  if (stats.total_calls === 0) {
    console.log('');
    console.log('No telemetry recorded yet. Run a few `gbrain query` calls and re-check.');
    return;
  }
  const hitRatePct = (stats.cache_hit_rate * 100).toFixed(1);
  console.log(`  Cache hit rate:        ${hitRatePct}%  (${stats.cache_hits} hit / ${stats.cache_misses} miss)`);
  console.log(`                         (fraction of searches that reused a recent answer)`);
  console.log(`  Avg results returned:  ${stats.avg_results.toFixed(1)}`);
  console.log(`  Avg tokens delivered:  ${stats.avg_tokens.toFixed(0)}  (char/4 heuristic)`);
  console.log(`  Budget drops total:    ${stats.total_budget_dropped}`);
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
}

interface TuneRecommendation {
  knob: string;
  current: unknown;
  suggested: unknown;
  reason: string;
  apply_command: string;
}

async function runTuneSubcommand(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const apply = args.includes('--apply');

  const modeInput = await loadSearchModeConfig(engine);
  const resolved = resolveSearchMode(modeInput);
  const stats = await readSearchStats(engine, { days: 7 });

  const recs: TuneRecommendation[] = [];

  // Recommendation 1: low call volume → no data yet.
  if (stats.total_calls < 20) {
    if (json) {
      console.log(JSON.stringify({
        schema_version: 2,
        status: 'insufficient_data',
        total_calls: stats.total_calls,
        recommendations: [],
        message: 'Not enough search activity in the last 7 days to tune. Run `gbrain search stats` after some real usage.',
      }, null, 2));
      return;
    }
    console.log('Not enough search activity in the last 7 days to tune.');
    console.log(`Total searches: ${stats.total_calls} (need >= 20 for confident recommendations).`);
    console.log('Run a few `gbrain query` calls, then re-run `gbrain search tune`.');
    return;
  }

  // Recommendation 2: budget pressure under conservative.
  if (resolved.resolved_mode === 'conservative' && stats.total_calls > 0) {
    const dropPctPerCall = stats.total_budget_dropped / stats.total_calls;
    if (dropPctPerCall > 2) {
      recs.push({
        knob: 'search.mode',
        current: 'conservative',
        suggested: 'balanced',
        reason: `Avg ${dropPctPerCall.toFixed(1)} results dropped per search by the 4K budget. Consider balanced (12K budget) or raise search.tokenBudget.`,
        apply_command: 'gbrain config set search.mode balanced',
      });
    }
  }

  // Recommendation 3: high cache hit rate → bump similarity threshold.
  if (stats.cache_hit_rate > 0.85 && stats.cache_hits + stats.cache_misses > 50) {
    recs.push({
      knob: 'search.cache.similarity_threshold',
      current: resolved.cache_similarity_threshold,
      suggested: 0.94,
      reason: `Cache hit rate is ${(stats.cache_hit_rate * 100).toFixed(1)}%. You can raise similarity threshold to 0.94 for tighter freshness at small recall cost.`,
      apply_command: 'gbrain config set search.cache.similarity_threshold 0.94',
    });
  }

  // Recommendation 4: tokenmax + Haiku subagent.
  const subagentModel = await engine.getConfig('models.tier.subagent');
  if (resolved.resolved_mode === 'tokenmax' && subagentModel && /haiku/i.test(subagentModel)) {
    recs.push({
      knob: 'search.mode',
      current: 'tokenmax',
      suggested: 'balanced',
      reason: `Subagent tier is Haiku but mode is tokenmax. LLM expansion adds ~50ms + ~1¢ per query. Balanced cuts that cost without losing intent weighting or cache.`,
      apply_command: 'gbrain config set search.mode balanced',
    });
  }

  // Recommendation 5: cache disabled but available — fix the free win.
  if (!resolved.cache_enabled && stats.total_calls > 5) {
    recs.push({
      knob: 'search.cache.enabled',
      current: false,
      suggested: true,
      reason: 'Cache is disabled but mode bundles enable it by default. Cache is a free win (zero LLM cost, big latency drop on repeat queries).',
      apply_command: 'gbrain config unset search.cache.enabled',
    });
  }

  if (json) {
    console.log(JSON.stringify({
      schema_version: 2,
      status: recs.length === 0 ? 'no_recommendations' : 'has_recommendations',
      total_calls: stats.total_calls,
      cache_hit_rate: stats.cache_hit_rate,
      active_mode: resolved.resolved_mode,
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

  console.log(`Search tune (last 7 days, active mode: ${resolved.resolved_mode}):`);
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

/**
 * `gbrain search modes` is read-only — no DB connection strictly required
 * for the bundle display IF the engine is given. The dispatch in cli.ts
 * adds 'search' to its dispatch table so the engine connects normally;
 * this export is here so future no-engine modes (e.g. `gbrain search --help`
 * without an engine) could route through it cleanly.
 */
export const _exports_for_test = {
  buildModesReport,
  formatModesText,
  maybeApplyRecommendation,
  buildRevertCommand,
};

// Suppress unused-export TS warning — these are intentionally retained for
// downstream callers (cli.ts dispatch / future skill linkage).
void DEFAULT_SEARCH_MODE;
