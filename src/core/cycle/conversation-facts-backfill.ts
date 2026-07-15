/**
 * v0.41.11.0 — cycle phase `conversation_facts_backfill`.
 *
 * Opt-in autopilot wrapper around `runExtractConversationFactsCore`.
 * Default OFF; user enables explicitly via
 * `gbrain config set cycle.conversation_facts_backfill.enabled true`.
 *
 * Architecture (per CEO + eng review + Codex outside voice):
 *
 *   - Per-source iteration HERE. PHASE_SCOPE='source' is taxonomy-only
 *     (cycle.ts:131 documents this); no runtime fanout exists yet. The
 *     wrapper enumerates `listSources(engine)` and loops over per-source
 *     core invocations directly.
 *
 *   - Brain-wide BudgetTracker created ONCE per phase tick and passed
 *     into every per-source invocation via `opts.budgetTracker`. The
 *     core function uses it as-is — does NOT wrap in
 *     `withBudgetTracker` (nested wraps REPLACE the active tracker per
 *     gateway.ts AsyncLocalStorage semantics, defeating the brain-wide
 *     cap). This is the Codex C5 + Eng-v2 C5 design.
 *
 *   - Brain-wide walltime cap (Eng-v2 A4) enforced by checking
 *     `Date.now() - startedAt > maxTotalWalltimeMs` between sources.
 *     When exceeded, remaining sources skipped + recorded in
 *     `result.skipped_by_brain_wide_walltime`.
 *
 *   - Symmetric two-layer protection: per-source cap (`max_cost_usd` /
 *     `max_walltime_min`) AND brain-wide cap (`max_total_cost_usd` /
 *     `max_total_walltime_min`). Defaults: $1/source, $5 total, 20min/
 *     source, 30min total.
 *
 * Config keys (all defaults explicit):
 *
 *   cycle.conversation_facts_backfill.enabled              (false)
 *   cycle.conversation_facts_backfill.max_cost_usd         (1.00)
 *   cycle.conversation_facts_backfill.max_total_cost_usd   (5.00)
 *   cycle.conversation_facts_backfill.max_walltime_min     (20)
 *   cycle.conversation_facts_backfill.max_total_walltime_min (30)
 *   cycle.conversation_facts_backfill.types                (["conversation","meeting","slack","email"])
 *
 * `.types` is the single source of truth for "enabled types" — the CLI
 * default reads from the same key (Eng-v2 A2).
 */

import type { BrainEngine } from '../engine.ts';
import { BudgetTracker, BudgetExhausted } from '../budget/budget-tracker.ts';
import { withBudgetTracker } from '../ai/gateway.ts';
import { listSources } from '../sources-ops.ts';
import {
  runExtractConversationFactsCore,
  ALLOWED_TYPES,
  type AllowedType,
  type ExtractConversationFactsResult,
} from '../../commands/extract-conversation-facts.ts';

/** Per-phase wrapper opts. */
export interface ConversationFactsBackfillPhaseOpts {
  dryRun?: boolean;
  signal?: AbortSignal;
}

/** Phase return shape (matches PhaseResult contract from cycle.ts). */
export interface ConversationFactsBackfillPhaseResult {
  phase: 'conversation_facts_backfill';
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  duration_ms: number;
  summary: string;
  details: Record<string, unknown>;
}

const CFG_PREFIX = 'cycle.conversation_facts_backfill';

interface ResolvedConfig {
  enabled: boolean;
  maxCostUsd: number;          // per source per cycle
  maxTotalCostUsd: number;     // brain-wide per cycle
  maxWalltimeMin: number;      // per source per cycle
  maxTotalWalltimeMin: number; // brain-wide per cycle
  types: AllowedType[];
  /**
   * v0.41.15.0 (D9 in cycle context): in-process worker count per
   * per-source invocation. Default 1 — cycle is opt-in per CLAUDE.md,
   * and aggressive concurrency inside a 30-min walltime cap stays
   * opt-in via this config key. PGLite engines clamp to 1 regardless.
   */
  workers: number;
}

async function loadCfg(engine: BrainEngine): Promise<ResolvedConfig> {
  const get = (k: string) => engine.getConfig(`${CFG_PREFIX}.${k}`);
  const [enabled, maxCost, maxTotalCost, maxWall, maxTotalWall, typesRaw, workersRaw] =
    await Promise.all([
      get('enabled'),
      get('max_cost_usd'),
      get('max_total_cost_usd'),
      get('max_walltime_min'),
      get('max_total_walltime_min'),
      get('types'),
      get('workers'),
    ]);

  // Truthy-string parse mirrors isFactsExtractionEnabled.
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

  let types: AllowedType[] = [...ALLOWED_TYPES];
  if (typesRaw) {
    try {
      const parsed = JSON.parse(typesRaw);
      if (Array.isArray(parsed)) {
        const filtered = parsed
          .filter((t): t is string => typeof t === 'string')
          .filter((t): t is AllowedType =>
            (ALLOWED_TYPES as readonly string[]).includes(t),
          );
        if (filtered.length > 0) types = filtered;
      }
    } catch {
      // fall through to default
    }
  }

  // v0.41.15.0 (D9): integer-positive parse for workers config key.
  const parsedWorkers = (() => {
    if (workersRaw == null) return 1;
    const n = parseInt(workersRaw, 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return n;
  })();

  return {
    enabled: enabledFlag,
    maxCostUsd: parseFloatOrDefault(maxCost, 1.0),
    maxTotalCostUsd: parseFloatOrDefault(maxTotalCost, 5.0),
    maxWalltimeMin: parseFloatOrDefault(maxWall, 20),
    maxTotalWalltimeMin: parseFloatOrDefault(maxTotalWall, 30),
    types,
    workers: parsedWorkers,
  };
}

export async function runPhaseConversationFactsBackfill(
  engine: BrainEngine,
  opts: ConversationFactsBackfillPhaseOpts = {},
): Promise<ConversationFactsBackfillPhaseResult> {
  const cfg = await loadCfg(engine);

  if (!cfg.enabled) {
    return {
      phase: 'conversation_facts_backfill',
      status: 'skipped',
      duration_ms: 0,
      summary: 'cycle.conversation_facts_backfill.enabled=false (default OFF)',
      details: {
        reason: 'disabled',
        enable_hint:
          'gbrain config set cycle.conversation_facts_backfill.enabled true',
      },
    };
  }

  const startedAt = Date.now();
  const maxTotalWalltimeMs = cfg.maxTotalWalltimeMin * 60_000;

  const sources = await listSources(engine);
  if (sources.length === 0) {
    return {
      phase: 'conversation_facts_backfill',
      status: 'ok',
      duration_ms: Date.now() - startedAt,
      summary: 'no sources to process',
      details: { sources_count: 0 },
    };
  }

  // Brain-wide tracker — created ONCE, scoped to brain-wide cap. Passed
  // explicitly into every per-source core invocation via opts.budgetTracker
  // so the core doesn't wrap (which would REPLACE).
  const brainTracker = new BudgetTracker({
    maxCostUsd: cfg.maxTotalCostUsd,
    label: 'conversation_facts_backfill:brain-wide',
  });

  const perSourceResults: Record<string, ExtractConversationFactsResult & { error?: string }> = {};
  let skippedByBrainWideCap = 0;
  let skippedByBrainWideWalltime = 0;
  let totalSpent = 0;

  try {
    // Single withBudgetTracker scope wraps the entire loop so the
    // brain-wide tracker counts EVERY gateway call inside any per-source
    // invocation. The core uses opts.budgetTracker as-is (no nested wrap),
    // so the AsyncLocalStorage scope established here remains active.
    await withBudgetTracker(brainTracker, async () => {
      for (const src of sources) {
        if (opts.signal?.aborted) throw new Error('aborted');

        // Brain-wide walltime check.
        if (Date.now() - startedAt > maxTotalWalltimeMs) {
          skippedByBrainWideWalltime++;
          continue;
        }

        try {
          const result = await runExtractConversationFactsCore(engine, {
            sourceId: src.id,
            types: cfg.types,
            dryRun: opts.dryRun,
            // Pass brain-wide tracker so core skips its own auto-wrap.
            budgetTracker: brainTracker,
            // v0.41.15.0 (D9 cycle context): cycle config controls
            // per-source worker count. Default 1 — opt-in concurrency
            // for cycle paths.
            workers: cfg.workers,
          }, opts.signal);
          perSourceResults[src.id] = result;
          if (result.budget_exhausted) {
            // Brain-wide cap hit. Remaining sources skipped.
            skippedByBrainWideCap = Math.max(
              0,
              sources.length - Object.keys(perSourceResults).length,
            );
            break;
          }
        } catch (err) {
          if (err instanceof BudgetExhausted) {
            skippedByBrainWideCap = Math.max(
              0,
              sources.length - Object.keys(perSourceResults).length,
            );
            break;
          }
          // Per-source failure: record + continue with next source.
          perSourceResults[src.id] = {
            pages_considered: 0,
            pages_processed: 0,
            pages_skipped: 0,
            pages_skipped_too_large: 0,
            pages_skipped_disappeared: 0,
            // v0.41.15.0 (D6 + D11): new counters from the per-page lock
            // + delete-orphans-first replay safety.
            pages_lock_skipped: 0,
            orphan_facts_cleaned: 0,
            segments_processed: 0,
            facts_extracted: 0,
            facts_inserted: 0,
            error: (err as Error).message,
          };
        }
      }
    });
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      // Brain-wide cap hit during last source.
    } else if ((err as Error).message === 'aborted' || opts.signal?.aborted) {
      // Propagate abort.
      throw err;
    } else {
      // Unexpected error.
      return {
        phase: 'conversation_facts_backfill',
        status: 'fail',
        duration_ms: Date.now() - startedAt,
        summary: `brain-wide loop failed: ${(err as Error).message}`,
        details: { error: (err as Error).message, perSourceResults },
      };
    }
  }

  totalSpent = brainTracker.totalSpent;

  // Aggregate.
  const totals = {
    pages_processed: 0,
    pages_skipped: 0,
    facts_inserted: 0,
    sources_processed: 0,
  };
  for (const r of Object.values(perSourceResults)) {
    if (!r.error) totals.sources_processed++;
    totals.pages_processed += r.pages_processed;
    totals.pages_skipped += r.pages_skipped;
    totals.facts_inserted += r.facts_inserted;
  }

  const anyError = Object.values(perSourceResults).some((r) => r.error);
  const status = anyError ? 'warn' : 'ok';
  const summary = `${totals.facts_inserted} facts inserted across ${totals.sources_processed}/${sources.length} sources, ~$${totalSpent.toFixed(4)} spent`;

  return {
    phase: 'conversation_facts_backfill',
    status,
    duration_ms: Date.now() - startedAt,
    summary,
    details: {
      sources_count: sources.length,
      sources_processed: totals.sources_processed,
      pages_processed: totals.pages_processed,
      pages_skipped: totals.pages_skipped,
      facts_inserted: totals.facts_inserted,
      spent_usd: totalSpent,
      skipped_by_brain_wide_cap: skippedByBrainWideCap,
      skipped_by_brain_wide_walltime: skippedByBrainWideWalltime,
      types: cfg.types,
      max_total_cost_usd: cfg.maxTotalCostUsd,
      max_total_walltime_min: cfg.maxTotalWalltimeMin,
      per_source: perSourceResults,
    },
  };
}
