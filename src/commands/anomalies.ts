/**
 * gbrain anomalies — Statistical anomalies in recent page activity.
 *
 * Deterministic: zero LLM calls. Computes baseline (mean, stddev) of pages
 * touched per cohort × day over `lookback_days`, with `generate_series`
 * zero-fill so rare cohorts don't get sparse-day biased baselines. Reports
 * cohorts whose target-day count exceeds `mean + sigma * stddev`.
 *
 * Cohort kinds: tag, type. Year cohort deferred to v0.30.
 *
 * Usage:
 *   gbrain anomalies                          # since=today, lookback=30d, sigma=3
 *   gbrain anomalies --since 2026-04-28
 *   gbrain anomalies --sigma 2 --lookback-days 60
 *   gbrain anomalies --json
 */

import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';

interface RunOpts {
  since?: string;
  lookbackDays?: number;
  sigma?: number;
  json?: boolean;
}

function parseArgs(args: string[]): RunOpts | { help: true } {
  const opts: RunOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--since') {
      const v = args[++i];
      if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) opts.since = v;
      continue;
    }
    if (a === '--lookback-days') {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n) && n >= 1) opts.lookbackDays = n;
      continue;
    }
    if (a === '--sigma') {
      const n = parseFloat(args[++i] ?? '');
      if (Number.isFinite(n) && n > 0) opts.sigma = n;
      continue;
    }
  }
  return opts;
}

const HELP = `Usage: gbrain anomalies [options]

Statistical anomalies in recent page activity, grouped by cohort (tag, type).

Options:
  --since YYYY-MM-DD   Target day (default: today UTC)
  --lookback-days N    Baseline window (default 30)
  --sigma N            Threshold multiplier (default 3.0)
  --json               JSON output for agents
  --help, -h           Show this help
`;

export async function runAnomalies(engine: BrainEngine, args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if ('help' in parsed) {
    console.log(HELP);
    return;
  }
  // v0.31.1 (Issue #734): on thin-client installs, route via MCP.
  let rows;
  const cfg = loadConfig();
  if (isThinClient(cfg)) {
    const raw = await callRemoteTool(cfg!, 'find_anomalies', {
      since: parsed.since,
      lookback_days: parsed.lookbackDays,
      sigma: parsed.sigma,
    }, { timeoutMs: 30_000 });
    rows = unpackToolResult<Awaited<ReturnType<BrainEngine['findAnomalies']>>>(raw);
  } else {
    rows = await engine.findAnomalies({
      since: parsed.since,
      lookback_days: parsed.lookbackDays,
      sigma: parsed.sigma,
    });
  }
  if (parsed.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('(no anomalies for this window)');
    return;
  }
  console.log(`${rows.length} anomalous cohort(s) for ${parsed.since ?? new Date().toISOString().slice(0, 10)}:\n`);
  rows.forEach(r => {
    const baselineMean = r.baseline_mean.toFixed(2);
    const baselineStd = r.baseline_stddev.toFixed(2);
    const sigma = r.sigma_observed.toFixed(2);
    console.log(
      `[${r.cohort_kind}=${r.cohort_value}] ` +
      `count=${r.count}, baseline mean=${baselineMean}±${baselineStd}, sigma=${sigma}`
    );
    const slugSample = r.page_slugs.slice(0, 5).join(', ');
    const more = r.page_slugs.length > 5 ? `, +${r.page_slugs.length - 5} more` : '';
    if (slugSample) console.log(`  pages: ${slugSample}${more}`);
  });
}
