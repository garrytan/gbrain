/**
 * v0.41.39 (issue #1700) — cycle phase `enrich_thin`.
 *
 * Opt-in autopilot trickle around `runEnrichCore`. Default OFF; enable with
 * `gbrain config set cycle.enrich_thin.enabled true`. Each tick develops a few
 * thin (stub) pages per source so the brain gets smarter over time, not just
 * bigger — the issue's explicit payoff.
 *
 * Architecture mirrors `conversation-facts-backfill.ts` (the precedent):
 *
 *   - Per-source iteration HERE. PHASE_SCOPE='source' is taxonomy-only (no
 *     runtime fan-out exists yet); the wrapper loops `listSources(engine)`.
 *   - ONE brain-wide BudgetTracker per tick, passed into every per-source
 *     `runEnrichCore` via `opts.budgetTracker` so the core uses it as-is (no
 *     nested `withBudgetTracker`, which would REPLACE the brain-wide cap).
 *   - Brain-wide walltime cap checked between sources.
 *   - Small per-source page cap (`max_pages_per_tick`, default 3) so a tick
 *     trickles rather than draining the whole stub backlog at once.
 *
 * Config keys (defaults explicit):
 *   cycle.enrich_thin.enabled                (false)
 *   cycle.enrich_thin.max_cost_usd           (1.00)   per source per tick
 *   cycle.enrich_thin.max_total_cost_usd     (5.00)   brain-wide per tick
 *   cycle.enrich_thin.max_total_walltime_min (30)     brain-wide per tick
 *   cycle.enrich_thin.max_pages_per_tick     (3)      per source per tick
 *   cycle.enrich_thin.types                  (["person","company"])
 *   cycle.enrich_thin.order                  ("inbound-links")
 *   cycle.enrich_thin.workers                (1)
 *   cycle.enrich_thin.model                  (configured chat model)
 */

import type { BrainEngine } from '../engine.ts';
import type { PageType } from '../types.ts';
import { BudgetExhausted } from '../budget/budget-tracker.ts';
import { isAvailable } from '../ai/gateway.ts';
import { listSources } from '../sources-ops.ts';
import {
  runEnrichCore,
  DEFAULT_TYPES,
  ENRICH_ORDERS,
  type EnrichOrder,
  type EnrichResult,
} from '../../commands/enrich.ts';

export interface EnrichThinPhaseOpts {
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface EnrichThinPhaseResult {
  phase: 'enrich_thin';
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  duration_ms: number;
  summary: string;
  details: Record<string, unknown>;
}

const CFG_PREFIX = 'cycle.enrich_thin';

interface ResolvedConfig {
  enabled: boolean;
  maxCostUsd: number;          // per source per tick
  maxTotalCostUsd: number;     // brain-wide per tick
  maxTotalWalltimeMin: number; // brain-wide per tick
  maxPagesPerTick: number;     // per source per tick
  types: PageType[];
  order: EnrichOrder;
  workers: number;
  model?: string;
}

export type EnrichThinResultStatus =
  | 'completed'
  | 'disabled'
  | 'no_chat_gateway'
  | 'no_sources'
  | 'no_candidates'
  | 'insufficient_evidence'
  | 'zero_budget_cap'
  | 'budget_blocked'
  | 'budget_exhausted'
  | 'walltime_exhausted'
  | 'partial_errors';

export interface EnrichThinOutcomeInput {
  sourcesCount: number;
  candidatesConsidered: number;
  pagesEnriched: number;
  pagesSkippedInsufficient: number;
  anyBudgetFlag: boolean;
  anyError: boolean;
  skippedByBrainWideWalltime: number;
  spentUsd: number;
  maxCostUsd: number;
  maxTotalCostUsd: number;
}

export function classifyEnrichThinOutcome(input: EnrichThinOutcomeInput): {
  result_status: EnrichThinResultStatus;
  budget_exhausted: boolean;
} {
  if (input.maxCostUsd === 0 || input.maxTotalCostUsd === 0) {
    return { result_status: 'zero_budget_cap', budget_exhausted: true };
  }
  if (input.anyError) return { result_status: 'partial_errors', budget_exhausted: false };
  if (input.sourcesCount === 0) return { result_status: 'no_sources', budget_exhausted: false };
  if (input.candidatesConsidered === 0) return { result_status: 'no_candidates', budget_exhausted: false };
  if (input.anyBudgetFlag && input.spentUsd > 0) {
    return { result_status: 'budget_exhausted', budget_exhausted: true };
  }
  if (input.anyBudgetFlag) return { result_status: 'budget_blocked', budget_exhausted: false };
  if (input.skippedByBrainWideWalltime > 0) {
    return { result_status: 'walltime_exhausted', budget_exhausted: false };
  }
  if (input.pagesEnriched === 0 && input.pagesSkippedInsufficient > 0) {
    return { result_status: 'insufficient_evidence', budget_exhausted: false };
  }
  return { result_status: 'completed', budget_exhausted: false };
}

async function loadCfg(engine: BrainEngine): Promise<ResolvedConfig> {
  const get = (k: string) => engine.getConfig(`${CFG_PREFIX}.${k}`);
  const [enabled, maxCost, maxTotalCost, maxTotalWall, maxPages, typesRaw, orderRaw, workersRaw, model] =
    await Promise.all([
      get('enabled'),
      get('max_cost_usd'),
      get('max_total_cost_usd'),
      get('max_total_walltime_min'),
      get('max_pages_per_tick'),
      get('types'),
      get('order'),
      get('workers'),
      get('model'),
    ]);

  const enabledFlag = (() => {
    if (enabled == null) return false;
    const v = enabled.trim().toLowerCase();
    return !['false', '0', 'no', 'off', ''].includes(v);
  })();

  const parseFloatOrDefault = (raw: string | null, fallback: number): number => {
    if (raw == null) return fallback;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const parseNonNegativeFloatOrDefault = (raw: string | null, fallback: number): number => {
    if (raw == null) return fallback;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const parseIntOrDefault = (raw: string | null, fallback: number): number => {
    if (raw == null) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 1 ? n : fallback;
  };

  let types: PageType[] = [...DEFAULT_TYPES];
  if (typesRaw) {
    try {
      const parsed = JSON.parse(typesRaw);
      if (Array.isArray(parsed)) {
        const filtered = parsed.filter((t): t is string => typeof t === 'string' && t.length > 0);
        if (filtered.length > 0) types = filtered as PageType[];
      }
    } catch {
      // fall through to default
    }
  }

  const order: EnrichOrder =
    orderRaw && (ENRICH_ORDERS as readonly string[]).includes(orderRaw.trim())
      ? (orderRaw.trim() as EnrichOrder)
      : 'inbound-links';

  return {
    enabled: enabledFlag,
    maxCostUsd: parseNonNegativeFloatOrDefault(maxCost, 1.0),
    maxTotalCostUsd: parseNonNegativeFloatOrDefault(maxTotalCost, 5.0),
    maxTotalWalltimeMin: parseFloatOrDefault(maxTotalWall, 30),
    maxPagesPerTick: parseIntOrDefault(maxPages, 3),
    types,
    order,
    workers: parseIntOrDefault(workersRaw, 1),
    model: model ?? undefined,
  };
}

export async function runPhaseEnrichThin(
  engine: BrainEngine,
  opts: EnrichThinPhaseOpts = {},
): Promise<EnrichThinPhaseResult> {
  const cfg = await loadCfg(engine);

  if (!cfg.enabled) {
    return {
      phase: 'enrich_thin',
      status: 'skipped',
      duration_ms: 0,
      summary: 'cycle.enrich_thin.enabled=false (default OFF)',
      details: {
        reason: 'disabled',
        result_status: 'disabled',
        budget_exhausted: false,
        enable_hint: 'gbrain config set cycle.enrich_thin.enabled true',
      },
    };
  }

  const startedAt = Date.now();

  if (cfg.maxCostUsd === 0 || cfg.maxTotalCostUsd === 0) {
    return {
      phase: 'enrich_thin',
      status: 'skipped',
      duration_ms: Date.now() - startedAt,
      summary: 'enrich_thin budget cap is zero; no enrichment attempted',
      details: {
        result_status: 'zero_budget_cap',
        budget_exhausted: true,
        spent_usd: 0,
        max_cost_usd: cfg.maxCostUsd,
        max_total_cost_usd: cfg.maxTotalCostUsd,
      },
    };
  }

  // Chat gateway required for synthesis (dry-run skips the LLM but still needs
  // the candidate query; allow dry-run without a gateway).
  if (!opts.dryRun && !isAvailable('chat')) {
    return {
      phase: 'enrich_thin',
      status: 'skipped',
      duration_ms: Date.now() - startedAt,
      summary: 'no chat gateway configured',
      details: { reason: 'no_chat_gateway', result_status: 'no_chat_gateway', budget_exhausted: false },
    };
  }

  const maxTotalWalltimeMs = cfg.maxTotalWalltimeMin * 60_000;
  const sources = await listSources(engine);
  if (sources.length === 0) {
    return {
      phase: 'enrich_thin',
      status: 'ok',
      duration_ms: Date.now() - startedAt,
      summary: 'no sources to process',
      details: { sources_count: 0, result_status: 'no_sources', budget_exhausted: false },
    };
  }

  // P2#2 (codex): enforce BOTH a per-source cap AND the brain-wide total. Per
  // source we run with maxCostUsd = min(per-source cap, brain-wide remaining);
  // runEnrichCore creates + enforces its own tracker for that cap (its internal
  // withBudgetTracker). We sum each source's spend and stop the loop once the
  // brain-wide total is reached. The prior single brain-wide tracker let one
  // source drain the whole tick; passing a per-source cap fixes that without
  // nested withBudgetTracker (which REPLACES, not stacks).
  const perSourceResults: Record<string, EnrichResult & { error?: string }> = {};
  let skippedByBrainWideWalltime = 0;
  let totalSpent = 0;

  for (const src of sources) {
    if (opts.signal?.aborted) throw new Error('aborted'); // propagates; cycle handles
    if (Date.now() - startedAt > maxTotalWalltimeMs) {
      skippedByBrainWideWalltime++;
      continue;
    }
    const remainingBrainWide = cfg.maxTotalCostUsd - totalSpent;
    if (remainingBrainWide <= 0) break; // brain-wide cap reached
    const perSourceCap = Math.min(cfg.maxCostUsd, remainingBrainWide);
    try {
      const r = await runEnrichCore(engine, {
        sourceId: src.id,
        types: cfg.types,
        order: cfg.order,
        limit: cfg.maxPagesPerTick,
        workers: cfg.workers,
        model: cfg.model,
        dryRun: opts.dryRun,
        maxCostUsd: perSourceCap,
      }, opts.signal);
      perSourceResults[src.id] = r;
      totalSpent += r.spent_usd ?? 0;
      // r.budget_exhausted here means THIS source hit perSourceCap. Only stop the
      // whole tick when the brain-wide total is actually reached; otherwise move
      // on so a cheap source isn't starved by an expensive earlier one.
      if (totalSpent >= cfg.maxTotalCostUsd) break;
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        // Defensive: runEnrichCore returns partial on budget rather than throwing.
        continue;
      }
      perSourceResults[src.id] = {
        candidates_considered: 0,
        pages_enriched: 0,
        pages_skipped_insufficient: 0,
        pages_skipped_lock: 0,
        pages_skipped_disappeared: 0,
        pages_failed: 0,
        error: (err as Error).message,
      };
    }
  }

  const totals = { enriched: 0, skipped_insufficient: 0, sources_processed: 0, candidates_considered: 0 };
  for (const r of Object.values(perSourceResults)) {
    if (!r.error) totals.sources_processed++;
    totals.candidates_considered += r.candidates_considered ?? 0;
    totals.enriched += r.pages_enriched ?? 0;
    totals.skipped_insufficient += r.pages_skipped_insufficient ?? 0;
  }

  const anyError = Object.values(perSourceResults).some((r) => r.error);
  const anyBudgetFlag = Object.values(perSourceResults).some((r) => r.budget_exhausted === true);
  const outcome = classifyEnrichThinOutcome({
    sourcesCount: sources.length,
    candidatesConsidered: totals.candidates_considered,
    pagesEnriched: totals.enriched,
    pagesSkippedInsufficient: totals.skipped_insufficient,
    anyBudgetFlag,
    anyError,
    skippedByBrainWideWalltime,
    spentUsd: totalSpent,
    maxCostUsd: cfg.maxCostUsd,
    maxTotalCostUsd: cfg.maxTotalCostUsd,
  });
  const status =
    outcome.result_status === 'partial_errors' ||
    outcome.result_status === 'budget_blocked' ||
    outcome.result_status === 'budget_exhausted' ||
    outcome.result_status === 'walltime_exhausted'
      ? 'warn'
      : 'ok';
  const summary = `${totals.enriched} page(s) enriched across ${totals.sources_processed}/${sources.length} sources, ~$${totalSpent.toFixed(4)} spent (${outcome.result_status})`;

  return {
    phase: 'enrich_thin',
    status,
    duration_ms: Date.now() - startedAt,
    summary,
    details: {
      sources_count: sources.length,
      sources_processed: totals.sources_processed,
      result_status: outcome.result_status,
      budget_exhausted: outcome.budget_exhausted,
      candidates_considered: totals.candidates_considered,
      pages_enriched: totals.enriched,
      pages_skipped_insufficient: totals.skipped_insufficient,
      spent_usd: totalSpent,
      skipped_by_brain_wide_walltime: skippedByBrainWideWalltime,
      max_cost_usd: cfg.maxCostUsd,
      max_total_cost_usd: cfg.maxTotalCostUsd,
      max_pages_per_tick: cfg.maxPagesPerTick,
      types: cfg.types,
      order: cfg.order,
      per_source: perSourceResults,
    },
  };
}
