/**
 * gbrain eval trajectory <entity-slug> — chronological typed-claim
 * trajectory + regression detection + narrative drift score.
 *
 * v0.35.4 (T6) — pure data fn + JSON formatter + human formatter +
 * thin-client routing seam. Mirrors `gbrain salience` / `gbrain anomalies`
 * shape so the four temporal-axis read CLIs feel consistent.
 *
 * Usage:
 *   gbrain eval trajectory companies/acme-example
 *   gbrain eval trajectory companies/acme-example --metric mrr
 *   gbrain eval trajectory companies/acme-example --since 2026-01-01 --until 2026-07-31
 *   gbrain eval trajectory companies/acme-example --json
 */

import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';
import {
  computeTrajectoryStats,
  TRAJECTORY_SCHEMA_VERSION,
  type TrajectoryRegression,
} from '../core/trajectory.ts';

interface RunOpts {
  entitySlug: string;
  metric?: string;
  since?: string;
  until?: string;
  limit?: number;
  json?: boolean;
}

interface WireTrajectoryResult {
  points: Array<{
    fact_id: number;
    valid_from: string;
    metric: string | null;
    value: number | null;
    unit: string | null;
    period: string | null;
    text: string;
    source_session: string | null;
    source_markdown_slug: string | null;
  }>;
  regressions: TrajectoryRegression[];
  drift_score: number | null;
  schema_version: number;
}

const HELP = `Usage: gbrain eval trajectory <entity-slug> [options]

Show the chronological claim trajectory for an entity (typed metric values
over time, plus regressions and narrative drift score).

Examples:
  gbrain eval trajectory companies/acme-example
  gbrain eval trajectory companies/acme-example --metric mrr
  gbrain eval trajectory companies/acme-example --since 2026-01-01 --until 2026-07-31
  gbrain eval trajectory companies/acme-example --json

Options:
  --metric M          Filter to a single canonical metric (mrr, arr, team_size, …)
  --since YYYY-MM-DD  Lower bound on valid_from
  --until YYYY-MM-DD  Upper bound on valid_from
  --limit N           Max points (default 100, max 500)
  --json              JSON output for agents (stable schema_version: 1)
  --help, -h          Show this help
`;

function parseArgs(args: string[]): RunOpts | { help: true } | { error: string } {
  const opts: Partial<RunOpts> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--metric') { opts.metric = args[++i]; continue; }
    if (a === '--since')  { opts.since  = args[++i]; continue; }
    if (a === '--until')  { opts.until  = args[++i]; continue; }
    if (a === '--limit')  {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n) && n > 0) opts.limit = n;
      continue;
    }
    if (a.startsWith('-')) {
      return { error: `Unknown flag: ${a}` };
    }
    positional.push(a);
  }
  if (positional.length !== 1) {
    return { error: 'Exactly one entity-slug positional argument is required.' };
  }
  return { ...(opts as RunOpts), entitySlug: positional[0] };
}

export async function runEvalTrajectory(engine: BrainEngine, args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if ('help' in parsed) {
    console.log(HELP);
    return;
  }
  if ('error' in parsed) {
    console.error(parsed.error);
    console.error('');
    console.error(HELP);
    process.exit(1);
  }

  let result: WireTrajectoryResult;
  const cfg = loadConfig();
  if (isThinClient(cfg)) {
    // Thin-client install: route through the remote find_trajectory MCP op.
    const raw = await callRemoteTool(cfg!, 'find_trajectory', {
      entity_slug: parsed.entitySlug,
      metric: parsed.metric,
      since: parsed.since,
      until: parsed.until,
      limit: parsed.limit,
    }, { timeoutMs: 30_000 });
    result = unpackToolResult<WireTrajectoryResult>(raw);
  } else {
    // Local: call engine.findTrajectory directly, then compute derived
    // metrics via trajectory.ts. ctx.remote is implicitly false here so
    // visibility filtering is OFF — trusted local caller sees all facts.
    const points = await engine.findTrajectory({
      entitySlug: parsed.entitySlug,
      metric: parsed.metric,
      since: parsed.since,
      until: parsed.until,
      limit: parsed.limit,
    });
    const { regressions, drift_score } = computeTrajectoryStats(points);
    result = {
      points: points.map(p => ({
        fact_id: p.fact_id,
        valid_from: p.valid_from.toISOString().slice(0, 10),
        metric: p.metric,
        value: p.value,
        unit: p.unit,
        period: p.period,
        text: p.text,
        source_session: p.source_session,
        source_markdown_slug: p.source_markdown_slug,
      })),
      regressions,
      drift_score,
      schema_version: TRAJECTORY_SCHEMA_VERSION,
    };
  }

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human format. Title + per-point line + regression callouts + drift.
  console.log(`Entity: ${parsed.entitySlug}`);
  if (parsed.metric) console.log(`Metric: ${parsed.metric}`);
  if (parsed.since || parsed.until) {
    console.log(`Window: ${parsed.since ?? '(unbounded)'} → ${parsed.until ?? '(now)'}`);
  }
  console.log('');

  if (result.points.length === 0) {
    console.log('(no typed claims for this entity in the window)');
    return;
  }

  // Build a regression lookup so each point's row can be annotated.
  const regBy = new Map<string, TrajectoryRegression>();
  for (const r of result.regressions) {
    regBy.set(`${r.metric}|${r.to_date}|${r.to_value}`, r);
  }

  for (const p of result.points) {
    const metricCell = p.metric ?? '-';
    const valueCell = p.value === null ? '-' : formatValue(p.value, p.unit);
    const sourceCell = p.source_session ?? p.source_markdown_slug ?? '';
    let line = `  ${p.valid_from}  ${pad(metricCell, 14)} ${pad(valueCell, 12)} (${sourceCell})`;
    const reg = p.metric && p.value !== null
      ? regBy.get(`${p.metric}|${p.valid_from}|${p.value}`)
      : undefined;
    if (reg) {
      const pct = Math.abs(reg.delta_pct * 100).toFixed(1);
      line += ` [REGRESSION ↓${pct}%]`;
    }
    console.log(line);
  }

  console.log('');
  if (result.drift_score === null) {
    console.log('Drift score: (insufficient embedded points; need 3+)');
  } else {
    const score = result.drift_score;
    const tier =
      score < 0.15 ? 'stable narrative' :
      score < 0.35 ? 'mild drift' :
      score < 0.6  ? 'moderate drift' :
                     'narrative changing fast';
    console.log(`Drift score: ${score.toFixed(2)} (${tier})`);
  }
  if (result.regressions.length > 0) {
    console.log(`Regressions detected: ${result.regressions.length}`);
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function formatValue(v: number, unit: string | null): string {
  // Currency-style display for USD; plain for everything else. Keeps the
  // output readable without locale assumptions.
  if (unit === 'USD') {
    if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
    if (Math.abs(v) >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
    return `$${v.toFixed(0)}`;
  }
  return String(v);
}
