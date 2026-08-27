/**
 * v0.41.11.0 — cycle phase `conversation_facts_backfill`.
 *
 * Opt-in autopilot wrapper around `runExtractConversationFactsCore`.
 * Default OFF; user enables explicitly via
 * `gbrain config set cycle.conversation_facts_backfill.enabled true`.
 *
 * Architecture (per CEO + eng review + Codex outside voice):
 *
 *   - Per-source iteration HERE. The outer cycle scheduler now uses
 *     PHASE_SCOPE for fanout admission, while this legacy wrapper still
 *     enumerates `listSources(engine)` and loops over per-source core
 *     invocations directly.
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
 *   cycle.conversation_facts_backfill.types                (all of ALLOWED_TYPES — src/core/facts/conversation-types.ts)
 *
 * `.types` is the single source of truth for "enabled types" — the CLI
 * default reads from the same key (Eng-v2 A2).
 */

import type { BrainEngine } from '../engine.ts';
import {
  BudgetTracker,
  BudgetExhausted,
  loadPricingOverrides,
} from '../budget/budget-tracker.ts';
import { withBudgetTracker } from '../ai/gateway.ts';
import { listSources } from '../sources-ops.ts';
import {
  runExtractConversationFactsCore,
  isAbortError,
  type ExtractConversationFactsResult,
} from '../../commands/extract-conversation-facts.ts';
// The type allowlist comes straight from the canonical leaf module (same
// binding extract-conversation-facts.ts re-exports) so this phase is part of
// the drift-guarded set in test/conversation-facts-type-allowlist-drift.test.ts.
import { ALLOWED_TYPES, type AllowedType } from '../facts/conversation-types.ts';

/** Per-phase wrapper opts. */
export interface ConversationFactsBackfillPhaseOpts {
  dryRun?: boolean;
  signal?: AbortSignal;
  /**
   * issue #2860 — `gbrain dream --phase conversation_facts_backfill --once`.
   * Bypasses the `cycle.conversation_facts_backfill.enabled` gate for THIS
   * call only; never reads or writes config. Per-source + brain-wide cost/
   * walltime caps still apply — the override lifts the on/off switch, not
   * the spend guards.
   */
  once?: boolean;
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
  const pricingOverrides = await loadPricingOverrides(engine);

  if (!cfg.enabled) {
    if (!opts.once) {
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
    process.stderr.write(
      '[dream] --once: cycle.conversation_facts_backfill.enabled is false but ' +
      '--phase conversation_facts_backfill --once forces this run (config untouched)\n',
    );
  }

  const startedAt = Date.now();
  const maxTotalWalltimeMs = cfg.maxTotalWalltimeMin * 60_000;
  const maxWalltimeMs = cfg.maxWalltimeMin * 60_000;

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

  type PerSourceRecord = ExtractConversationFactsResult & {
    error?: string;
    walltime_exhausted?: boolean;
  };
  const perSourceResults: Record<string, PerSourceRecord> = {};
  let skippedByBrainWideCap = 0;
  let skippedByBrainWideWalltime = 0;
  let sourcesBudgetExhausted = 0;
  let sourcesWalltimeExhausted = 0;
  let totalSpent = 0;

  const zeroResult = (): ExtractConversationFactsResult => ({
    pages_considered: 0,
    pages_processed: 0,
    pages_skipped: 0,
    pages_skipped_too_large: 0,
    pages_skipped_disappeared: 0,
    pages_skipped_completed: 0,
    pages_skipped_non_extractable: 0,
    pages_marked_non_extractable: 0,
    pages_skipped_unrecognized_speaker: 0,
    pages_failed: 0,
    pages_llm_fallback: 0,
    // v0.41.15.0 (D6 + D11): new counters from the per-page lock
    // + delete-orphans-first replay safety.
    pages_lock_skipped: 0,
    orphan_facts_cleaned: 0,
    segments_processed: 0,
    facts_extracted: 0,
    facts_inserted: 0,
    // #4052: alias_exact resolution counters (required on the result type).
    fallback_slugify_count: 0,
    resolution_errors: 0,
  });

  // #3627: the per-source caps (max_cost_usd / max_walltime_min) were parsed
  // but never enforced — one runaway source could eat the whole brain-wide
  // budget while every later source starved. Each source now runs under its
  // OWN tracker capped at min(per-source cap, brain-wide remainder) with the
  // tracker's runtime cap as the LLM-boundary walltime check, PLUS an
  // AbortController deadline threaded as the core's signal (the core already
  // aborts at page/pool boundaries). Per-source exhaustion records and
  // CONTINUES to the next source; only the brain-wide caps break the loop.
  try {
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      if (opts.signal?.aborted) throw new Error('aborted');

      // Brain-wide walltime check.
      const remainingWallMs = maxTotalWalltimeMs - (Date.now() - startedAt);
      if (remainingWallMs <= 0) {
        skippedByBrainWideWalltime++;
        continue;
      }

      // Brain-wide cost check (sum of per-source tracker spends).
      const remainingCostUsd = cfg.maxTotalCostUsd - totalSpent;
      if (remainingCostUsd <= 0) {
        skippedByBrainWideCap = sources.length - i;
        break;
      }

      const perSourceWallMs = Math.min(maxWalltimeMs, remainingWallMs);
      const perSourceCapUsd = Math.min(cfg.maxCostUsd, remainingCostUsd);
      const tracker = new BudgetTracker({
        maxCostUsd: perSourceCapUsd,
        maxRuntimeMs: perSourceWallMs,
        label: `conversation_facts_backfill:${src.id}`,
        pricingOverrides,
      });

      // Per-source deadline signal. The tracker's maxRuntimeMs fires at LLM
      // call boundaries (core catches BudgetExhausted and returns a partial
      // result + receipt); the AbortController is the backstop for stretches
      // with no LLM call. An outer abort forwards so shutdown still works.
      const controller = new AbortController();
      let walltimeFired = false;
      const timer = setTimeout(() => {
        walltimeFired = true;
        controller.abort(new Error(
          `conversation_facts_backfill: per-source walltime cap (${cfg.maxWalltimeMin}min) hit for ${src.id}`,
        ));
      }, perSourceWallMs);
      const onOuterAbort = () => controller.abort();
      opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

      try {
        const result = await withBudgetTracker(tracker, () =>
          runExtractConversationFactsCore(engine, {
            sourceId: src.id,
            types: cfg.types,
            dryRun: opts.dryRun,
            // Per-source tracker so core skips its own auto-wrap.
            budgetTracker: tracker,
            // v0.41.15.0 (D9 cycle context): cycle config controls
            // per-source worker count. Default 1 — opt-in concurrency
            // for cycle paths.
            workers: cfg.workers,
          }, controller.signal),
        );
        perSourceResults[src.id] = result;
        // #3627: per-source exhaustion (cost or the tracker's runtime cap)
        // is recorded and the loop CONTINUES — the next source gets its own
        // fresh budget. Only the brain-wide checks at the loop top break.
        if (result.budget_exhausted) sourcesBudgetExhausted++;
      } catch (err) {
        if (opts.signal?.aborted) throw err; // real caller abort propagates
        if (walltimeFired) {
          // Our own per-source deadline aborted the core mid-run: record +
          // continue with the next source.
          sourcesWalltimeExhausted++;
          perSourceResults[src.id] = {
            ...zeroResult(),
            walltime_exhausted: true,
            error: 'walltime_exhausted',
          };
        } else if (err instanceof BudgetExhausted) {
          // Escaped the core's own catch — same per-source posture.
          sourcesBudgetExhausted++;
          perSourceResults[src.id] = {
            ...zeroResult(),
            budget_exhausted: true,
            error: err.message,
          };
        } else if (isAbortError(err)) {
          // #4052 wave abort-honesty fix: an abort that is neither our own
          // per-source deadline (walltimeFired) nor a flagged caller signal
          // is still cycle-runner control flow — propagate it rather than
          // downgrading it to a per-source failure record.
          throw err;
        } else {
          // Per-source failure: record + continue with next source.
          perSourceResults[src.id] = {
            ...zeroResult(),
            pages_failed: 1,
            error: (err as Error).message,
          };
        }
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onOuterAbort);
        totalSpent += tracker.totalSpent;
      }
    }
  } catch (err) {
    if (isAbortError(err) || opts.signal?.aborted) {
      // Abort is control flow owned by the cycle runner; never downgrade it
      // into a per-source warning or phase failure result. isAbortError also
      // matches the loop-top `throw new Error('aborted')`.
      throw err;
    }
    // Unexpected error.
    return {
      phase: 'conversation_facts_backfill',
      status: 'fail',
      duration_ms: Date.now() - startedAt,
      summary: `brain-wide loop failed: ${(err as Error).message}`,
      details: { error: (err as Error).message, perSourceResults },
    };
  }

  // Aggregate.
  const totals = {
    pages_processed: 0,
    pages_skipped: 0,
    pages_skipped_completed: 0,
    pages_skipped_non_extractable: 0,
    pages_marked_non_extractable: 0,
    pages_skipped_unrecognized_speaker: 0,
    pages_failed: 0,
    facts_inserted: 0,
    fallback_slugify_count: 0,
    resolution_errors: 0,
    sources_processed: 0,
  };
  for (const r of Object.values(perSourceResults)) {
    if (!r.error) totals.sources_processed++;
    totals.pages_processed += r.pages_processed;
    totals.pages_skipped += r.pages_skipped;
    totals.pages_skipped_completed += r.pages_skipped_completed;
    totals.pages_skipped_non_extractable += r.pages_skipped_non_extractable;
    totals.pages_marked_non_extractable += r.pages_marked_non_extractable;
    totals.pages_skipped_unrecognized_speaker += r.pages_skipped_unrecognized_speaker;
    totals.pages_failed += r.pages_failed;
    totals.facts_inserted += r.facts_inserted;
    totals.fallback_slugify_count += r.fallback_slugify_count;
    totals.resolution_errors += r.resolution_errors;
  }

  const anyError = Object.values(perSourceResults).some(
    (r) => r.error || r.pages_failed > 0,
  );
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
      pages_skipped_completed: totals.pages_skipped_completed,
      pages_skipped_non_extractable: totals.pages_skipped_non_extractable,
      pages_marked_non_extractable: totals.pages_marked_non_extractable,
      pages_skipped_unrecognized_speaker: totals.pages_skipped_unrecognized_speaker,
      pages_failed: totals.pages_failed,
      facts_inserted: totals.facts_inserted,
      fallback_slugify_count: totals.fallback_slugify_count,
      resolution_errors: totals.resolution_errors,
      spent_usd: totalSpent,
      skipped_by_brain_wide_cap: skippedByBrainWideCap,
      skipped_by_brain_wide_walltime: skippedByBrainWideWalltime,
      // #3627: per-source cap enforcement observability.
      sources_budget_exhausted: sourcesBudgetExhausted,
      sources_walltime_exhausted: sourcesWalltimeExhausted,
      types: cfg.types,
      max_cost_usd: cfg.maxCostUsd,
      max_walltime_min: cfg.maxWalltimeMin,
      max_total_cost_usd: cfg.maxTotalCostUsd,
      max_total_walltime_min: cfg.maxTotalWalltimeMin,
      per_source: perSourceResults,
    },
  };
}
