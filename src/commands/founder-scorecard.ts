/**
 * gbrain founder scorecard <entity-slug> — rolls up Phase 2's typed-claim
 * substrate + the takes outcome columns into a four-metric founder
 * scorecard.
 *
 * v0.35.4 (T7). Pure aggregation over facts + takes + the trajectory
 * derived metrics. Zero new schema. Zero LLM calls.
 *
 * Output (schema_version: 1, additive-only across releases per R5):
 *
 *   {
 *     schema_version: 1,
 *     entity_slug: "companies/acme-example",
 *     window: { since, until },
 *     claim_accuracy: {
 *       predicted: <number of takes with resolved_outcome != null>,
 *       accurate:  <number where resolved_outcome === true>,
 *       pct:       <accurate / predicted, or null when predicted=0>,
 *     },
 *     consistency: {
 *       score:           <1 - (unique_metric_changes / typed_facts), clamped [0,1]>,
 *       metric_changes:  <consecutive metric-value changes across typed facts>,
 *       typed_facts:     <count of typed-claim facts in the window>,
 *     },
 *     growth_trajectory: [
 *       { metric, direction: 'up'|'down'|'flat', latest_delta_pct },
 *       ...
 *     ],
 *     red_flags: [
 *       { kind: 'regression',        metric, text },
 *       { kind: 'narrative_drift',                text },
 *       { kind: 'missed_prediction',              text },
 *     ],
 *   }
 *
 * Usage:
 *   gbrain founder scorecard companies/acme-example
 *   gbrain founder scorecard companies/acme-example --since 2025-05-17 --until 2026-05-17
 *   gbrain founder scorecard companies/acme-example --json
 */

import type { BrainEngine, Take, TrajectoryPoint } from '../core/engine.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';
import {
  computeTrajectoryStats,
  TRAJECTORY_SCHEMA_VERSION,
} from '../core/trajectory.ts';

export interface FounderScorecard {
  schema_version: number;
  entity_slug: string;
  window: { since: string | null; until: string | null };
  claim_accuracy: {
    predicted: number;
    accurate: number;
    pct: number | null;
  };
  consistency: {
    score: number | null;
    metric_changes: number;
    typed_facts: number;
  };
  growth_trajectory: Array<{
    metric: string;
    direction: 'up' | 'down' | 'flat';
    latest_delta_pct: number;
  }>;
  red_flags: Array<{
    kind: 'regression' | 'narrative_drift' | 'missed_prediction';
    metric?: string;
    text: string;
  }>;
}

/**
 * Pure data function — given a sorted trajectory + takes window, compute
 * the scorecard. Exported for tests so the rollup math is exercised
 * without a DB round trip.
 */
export function computeFounderScorecard(args: {
  entitySlug: string;
  windowSince: string | null;
  windowUntil: string | null;
  points: TrajectoryPoint[];
  takes: Take[];
  driftThresholdRedFlag?: number;
}): FounderScorecard {
  const driftRedFlag = args.driftThresholdRedFlag ?? 0.5;
  const { regressions, drift_score } = computeTrajectoryStats(args.points);

  // claim_accuracy — over resolved takes only.
  const resolved = args.takes.filter(t => t.resolved_outcome !== null);
  const accurate = resolved.filter(t => t.resolved_outcome === true).length;
  const accuracyPct = resolved.length > 0 ? accurate / resolved.length : null;

  // consistency — count consecutive value changes per metric. A 'change'
  // is a pair where the relative delta is >=5%. The score normalizes
  // by total typed facts so a long-stable trajectory scores 1.0.
  const byMetric = new Map<string, TrajectoryPoint[]>();
  for (const p of args.points) {
    if (p.metric === null || p.value === null) continue;
    if (!byMetric.has(p.metric)) byMetric.set(p.metric, []);
    byMetric.get(p.metric)!.push(p);
  }
  let metricChanges = 0;
  let typedFacts = 0;
  for (const series of byMetric.values()) {
    typedFacts += series.length;
    for (let i = 1; i < series.length; i++) {
      const a = series[i - 1].value!;
      const b = series[i].value!;
      if (a === 0) continue;
      if (Math.abs(b - a) / Math.abs(a) >= 0.05) metricChanges += 1;
    }
  }
  const consistencyScore = typedFacts > 0
    ? Math.max(0, Math.min(1, 1 - metricChanges / typedFacts))
    : null;

  // growth_trajectory — per metric, the most recent delta direction.
  const growth: FounderScorecard['growth_trajectory'] = [];
  for (const [metric, series] of byMetric) {
    if (series.length < 2) continue;
    const latest = series[series.length - 1].value!;
    const prior = series[series.length - 2].value!;
    if (prior === 0) continue;
    const delta = (latest - prior) / prior;
    const dir: 'up' | 'down' | 'flat' =
      Math.abs(delta) < 0.01 ? 'flat' : (delta > 0 ? 'up' : 'down');
    growth.push({ metric, direction: dir, latest_delta_pct: delta });
  }
  // Stable ordering: alphabetical by metric so the JSON is deterministic.
  growth.sort((a, b) => a.metric.localeCompare(b.metric));

  // red_flags — surface regressions, big narrative drift, and missed
  // predictions (resolved=false on a take).
  const redFlags: FounderScorecard['red_flags'] = [];
  for (const r of regressions) {
    const pct = Math.abs(r.delta_pct * 100).toFixed(1);
    redFlags.push({
      kind: 'regression',
      metric: r.metric,
      text: `${r.metric} fell ${pct}% (${r.from_date} → ${r.to_date})`,
    });
  }
  if (drift_score !== null && drift_score >= driftRedFlag) {
    redFlags.push({
      kind: 'narrative_drift',
      text: `Narrative drift score ${drift_score.toFixed(2)} — claims are diverging rapidly`,
    });
  }
  const missed = args.takes.filter(t => t.resolved_outcome === false);
  for (const m of missed) {
    redFlags.push({
      kind: 'missed_prediction',
      text: `Missed prediction: ${truncate(m.claim, 200)}`,
    });
  }

  return {
    schema_version: TRAJECTORY_SCHEMA_VERSION,
    entity_slug: args.entitySlug,
    window: { since: args.windowSince, until: args.windowUntil },
    claim_accuracy: {
      predicted: resolved.length,
      accurate,
      pct: accuracyPct,
    },
    consistency: {
      score: consistencyScore,
      metric_changes: metricChanges,
      typed_facts: typedFacts,
    },
    growth_trajectory: growth,
    red_flags: redFlags,
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3) + '...';
}

interface RunOpts {
  sub: 'scorecard';
  entitySlug: string;
  since?: string;
  until?: string;
  json?: boolean;
}

const HELP = `Usage: gbrain founder scorecard <entity-slug> [options]

Rolls up the entity's typed-claim trajectory + resolved-take outcomes into
the four founder-evaluation metrics: claim accuracy, consistency, growth
trajectory, red flags.

Options:
  --since YYYY-MM-DD  Lower bound on valid_from / take created_at (default: 1 year ago)
  --until YYYY-MM-DD  Upper bound (default: today)
  --json              JSON output (stable schema_version: 1)
  --help, -h          Show this help

Examples:
  gbrain founder scorecard companies/acme-example
  gbrain founder scorecard companies/acme-example --since 2025-05-17 --json
`;

function parseArgs(args: string[]): RunOpts | { help: true } | { error: string } {
  if (args[0] !== 'scorecard') {
    return { error: `Unknown founder subcommand: ${args[0] ?? '(none)'}. Did you mean "founder scorecard"?` };
  }
  const opts: Partial<RunOpts> = { sub: 'scorecard' };
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--since') { opts.since = args[++i]; continue; }
    if (a === '--until') { opts.until = args[++i]; continue; }
    if (a.startsWith('-')) return { error: `Unknown flag: ${a}` };
    positional.push(a);
  }
  if (positional.length !== 1) {
    return { error: 'Exactly one entity-slug positional argument is required.' };
  }
  return { ...(opts as RunOpts), entitySlug: positional[0] };
}

export async function runFounder(engine: BrainEngine, args: string[]): Promise<void> {
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

  // Default window: last year.
  const now = new Date();
  const oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const windowSince = parsed.since ?? oneYearAgo.toISOString().slice(0, 10);
  const windowUntil = parsed.until ?? now.toISOString().slice(0, 10);

  let scorecard: FounderScorecard;
  const cfg = loadConfig();
  if (isThinClient(cfg)) {
    // Thin-client path: server-side find_trajectory + listTakes computed
    // locally is too heavyweight for one HTTP call, so this path fetches
    // the trajectory via the remote MCP op and reads takes through a
    // future `takes_list` op. For now thin-client returns a degraded
    // scorecard built from trajectory only (no take outcomes).
    // TODO(v0.35.5): add `takes_list_by_entity` MCP op + thin-client wire-up.
    const raw = await callRemoteTool(cfg!, 'find_trajectory', {
      entity_slug: parsed.entitySlug,
      since: windowSince,
      until: windowUntil,
    }, { timeoutMs: 30_000 });
    const trajWire = unpackToolResult<{
      points: Array<{
        fact_id: number; valid_from: string;
        metric: string | null; value: number | null;
        unit: string | null; period: string | null;
        text: string; source_session: string | null; source_markdown_slug: string | null;
      }>;
    }>(raw);
    const points: TrajectoryPoint[] = trajWire.points.map(p => ({
      fact_id: p.fact_id,
      valid_from: new Date(p.valid_from),
      metric: p.metric,
      value: p.value,
      unit: p.unit,
      period: p.period,
      text: p.text,
      source_session: p.source_session,
      source_markdown_slug: p.source_markdown_slug,
      embedding: null,
    }));
    scorecard = computeFounderScorecard({
      entitySlug: parsed.entitySlug,
      windowSince,
      windowUntil,
      points,
      takes: [],
    });
  } else {
    // Local: full pipeline. Get the trajectory + the entity's resolved takes.
    const points = await engine.findTrajectory({
      entitySlug: parsed.entitySlug,
      since: windowSince,
      until: windowUntil,
    });
    let takes: Take[] = [];
    try {
      takes = await engine.listTakes({
        page_slug: parsed.entitySlug,
        active: true,
        resolved: true,
        limit: 100,
      });
    } catch {
      // Some entity pages don't exist; treat as no takes.
      takes = [];
    }
    scorecard = computeFounderScorecard({
      entitySlug: parsed.entitySlug,
      windowSince,
      windowUntil,
      points,
      takes,
    });
  }

  if (parsed.json) {
    console.log(JSON.stringify(scorecard, null, 2));
    return;
  }

  // Human format.
  console.log(`Entity: ${scorecard.entity_slug}`);
  console.log(`Window: ${scorecard.window.since} → ${scorecard.window.until}`);
  console.log('');

  console.log('Claim accuracy:');
  if (scorecard.claim_accuracy.predicted === 0) {
    console.log('  (no resolved predictions in window)');
  } else {
    const pct = scorecard.claim_accuracy.pct === null
      ? 'n/a'
      : `${(scorecard.claim_accuracy.pct * 100).toFixed(1)}%`;
    console.log(`  ${scorecard.claim_accuracy.accurate}/${scorecard.claim_accuracy.predicted} predictions accurate (${pct})`);
  }
  console.log('');

  console.log('Consistency:');
  if (scorecard.consistency.typed_facts === 0) {
    console.log('  (no typed claims in window)');
  } else {
    const score = scorecard.consistency.score === null
      ? 'n/a'
      : scorecard.consistency.score.toFixed(2);
    console.log(`  score ${score} (${scorecard.consistency.metric_changes} changes across ${scorecard.consistency.typed_facts} typed facts)`);
  }
  console.log('');

  console.log('Growth trajectory:');
  if (scorecard.growth_trajectory.length === 0) {
    console.log('  (no metrics with 2+ data points)');
  } else {
    for (const g of scorecard.growth_trajectory) {
      const sign = g.direction === 'up' ? '↑' : g.direction === 'down' ? '↓' : '→';
      const pct = (g.latest_delta_pct * 100).toFixed(1);
      console.log(`  ${g.metric}: ${sign} ${pct}%`);
    }
  }
  console.log('');

  console.log('Red flags:');
  if (scorecard.red_flags.length === 0) {
    console.log('  (none)');
  } else {
    for (const r of scorecard.red_flags) {
      console.log(`  [${r.kind}] ${r.text}`);
    }
  }
}
