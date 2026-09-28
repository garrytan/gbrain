/**
 * take_contradictions dream phase (companion to drift.ts).
 *
 * Detects genuine disagreements between two DIFFERENT active takes —
 * different holders and/or different pages — reusing the `gbrain eval
 * suspected-contradictions` judge machinery as a third pairing strategy
 * (`active_takes`, see eval-contradictions/active-takes-pairing.ts) instead
 * of a parallel system. Persists into the SAME `eval_contradictions_runs`
 * table the CLI probe uses (`writeRunRow`/`loadTrend`) — no new table.
 *
 * Report-only, like drift: this phase never calls `takes supersede`/
 * `takes resolve` itself. A genuine `contradiction` verdict on an
 * active_takes pair always classifies to `manual_review`
 * (auto-supersession.ts) — a disagreement between two people's/sources'
 * stated positions needs a human, never an auto-applied fix.
 *
 * Because this phase runs unattended every night (unlike the CLI probe,
 * which a human reviews immediately after a one-off run), a naive
 * write-a-fresh-report-every-run would silently bury yesterday's undisposed
 * finding under today's row the moment ANY later run (this phase's own next
 * cycle, or a manual `eval suspected-contradictions run`) overwrites
 * `loadTrend`'s latest row. Before persisting, this phase reads the prior
 * latest run and carries forward any still-open `active_takes` finding not
 * re-detected this cycle, so `review` never loses one silently. Only
 * `active_takes`-kind entries are reconciled this way — the two existing
 * strategies' one-shot findings from a manual run are untouched.
 *
 * Default-disabled. Operator opts in:
 *   gbrain config set dream.take_contradictions.enabled true
 *   gbrain config set dream.take_contradictions.budget 1.0
 *   gbrain config set dream.take_contradictions.max_per_cycle 20
 *   gbrain config set dream.take_contradictions.max_candidate_takes 300
 *   gbrain config set dream.take_contradictions.max_per_holder_pairs 5
 *   gbrain config set dream.take_contradictions.max_neighbors_per_take 3
 */

import type { BrainEngine } from '../engine.ts';
import { resolveModel } from '../model-config.ts';
import type { DreamPhaseResult } from './auto-think.ts';
import {
  generateActiveTakesPairs,
  type ActiveTakesPairingOpts,
} from '../eval-contradictions/active-takes-pairing.ts';
import { sortPairs, pairId, buildRunId } from '../eval-contradictions/runner.ts';
import { shouldSkipForDateMismatch } from '../eval-contradictions/date-filter.ts';
import { judgeContradiction, type JudgeInput, type JudgeOutput } from '../eval-contradictions/judge.ts';
import { pairToFinding } from '../eval-contradictions/auto-supersession.ts';
import { buildCalibration } from '../eval-contradictions/calibration.ts';
import { buildSourceTierBreakdown } from '../eval-contradictions/cross-source.ts';
import { buildHotPages } from '../eval-contradictions/severity-classify.ts';
import { CostTracker } from '../eval-contradictions/cost-tracker.ts';
import { JudgeCache } from '../eval-contradictions/cache.ts';
import { JudgeErrorCollector } from '../eval-contradictions/judge-errors.ts';
import { isJudgeFailedRun, sumVerdicts } from '../eval-contradictions/run-health.ts';
import { writeRunRow, loadTrend } from '../eval-contradictions/trends.ts';
import {
  PROMPT_VERSION,
  SCHEMA_VERSION,
  TRUNCATION_POLICY,
  type ContradictionFinding,
  type ProbeReport,
  type VerdictBreakdown,
} from '../eval-contradictions/types.ts';

/** No real search query exists for a corpus-wide pairing — a fixed
 *  descriptive string, paired with crossHolderDisagreementCounts, which
 *  also drops the query-relevance-filtering bullets so this string is
 *  never treated as a real relevance filter. */
const SYNTHETIC_QUERY = 'Do these two independently-held claims directly disagree?';

/** One synthetic query bucket for the whole run — this phase's pairs aren't
 *  grouped by a real per-query search, so a single bucket keeps the
 *  ProbeReport wire shape valid without inventing granularity nothing reads. */
const SYNTHETIC_QUERY_LABEL = 'active_takes:sweep';

/**
 * Distinct prompt_version for this phase's judge calls, folded into the
 * SAME cache-key column the two query-driven strategies already use — no
 * schema change. `crossHolderDisagreementCounts: true` changes the actual
 * prompt text (see judge.ts), so a verdict cached under the standard mode
 * must never be served here, or vice versa; a suffixed prompt_version keeps
 * PROMPT_VERSION bumps (which still invalidate every cached row, including
 * this phase's) working exactly as before.
 */
const CACHE_PROMPT_VERSION = `${PROMPT_VERSION}:cross-holder`;

export type TakeContradictionsJudgeFn = (input: JudgeInput) => Promise<JudgeOutput>;

export interface TakeContradictionsPhaseOpts {
  dryRun: boolean;
  /** issue #2860-style --once: bypass the enabled gate for this run only. */
  forceEnabled?: boolean;
  /** Inject the judge (tests). Defaults to gateway-backed judgeContradiction. */
  judgeFn?: TakeContradictionsJudgeFn;
  /** Disable the persistent judge cache (mirrors RunnerOpts.noCache). Tests
   *  that inject a judgeFn to assert a specific outcome across repeated
   *  runs on the same pair should set this — otherwise a cache hit silently
   *  bypasses the injected judgeFn entirely, same as it would in production. */
  noCache?: boolean;
}

export interface TakeContradictionsConfig extends ActiveTakesPairingOpts {
  enabled: boolean;
  budgetUsd: number;
  maxPerCycle: number;
}

async function loadTakeContradictionsConfig(engine: BrainEngine): Promise<TakeContradictionsConfig> {
  const enabledStr = await engine.getConfig('dream.take_contradictions.enabled');
  const budgetStr = await engine.getConfig('dream.take_contradictions.budget');
  const maxPerStr = await engine.getConfig('dream.take_contradictions.max_per_cycle');
  const maxCandStr = await engine.getConfig('dream.take_contradictions.max_candidate_takes');
  const maxHolderStr = await engine.getConfig('dream.take_contradictions.max_per_holder_pairs');
  const maxNeighborStr = await engine.getConfig('dream.take_contradictions.max_neighbors_per_take');
  return {
    enabled: enabledStr === 'true',
    budgetUsd: budgetStr ? Math.max(0, parseFloat(budgetStr) || 1.0) : 1.0,
    maxPerCycle: maxPerStr ? Math.max(1, parseInt(maxPerStr, 10) || 20) : 20,
    maxCandidateTakes: maxCandStr ? Math.max(1, parseInt(maxCandStr, 10) || 300) : 300,
    maxPerHolderPairs: maxHolderStr ? Math.max(1, parseInt(maxHolderStr, 10) || 5) : 5,
    maxNeighborsPerTake: maxNeighborStr ? Math.max(1, parseInt(maxNeighborStr, 10) || 3) : 3,
  };
}

/** Stable identity for reconciling a finding across runs: an unordered pair
 *  of take ids (falls back to slugs — defensive only, active_takes findings
 *  always carry take_id on both sides). */
function findingIdentity(f: { a: { take_id: number | null; slug: string }; b: { take_id: number | null; slug: string } }): string {
  const aKey = f.a.take_id !== null ? `t${f.a.take_id}` : f.a.slug;
  const bKey = f.b.take_id !== null ? `t${f.b.take_id}` : f.b.slug;
  return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

/** How far back to look for this phase's own prior `active_takes` findings.
 *  Wider than "just the latest row" on purpose: `eval_contradictions_runs`
 *  is shared with the manual `gbrain eval suspected-contradictions` CLI
 *  probe (same `writeRunRow`), which can write a row between two nightly
 *  cycles — reading only rows[0] would then see a run with zero
 *  `active_takes` findings and silently drop everything, exactly the bug
 *  this reconciliation exists to prevent. Scanning a window and keying by
 *  the `active_takes` kind (unique to this phase — the CLI probe never
 *  produces it) skips right over any such row instead of being fooled by it. */
const RECONCILE_LOOKBACK_DAYS = 30;

/** This phase's own still-open findings, most-recent-per-identity, not yet
 *  resolved/dismissed — carried forward if this run doesn't re-detect them. */
async function loadOpenPriorFindings(engine: BrainEngine): Promise<ContradictionFinding[]> {
  const rows = await loadTrend(engine, RECONCILE_LOOKBACK_DAYS); // newest first
  const latestByIdentity = new Map<string, ContradictionFinding>();
  for (const row of rows) {
    for (const pq of row.report_json.per_query) {
      for (const f of pq.contradictions) {
        if (f.kind !== 'active_takes') continue;
        const id = findingIdentity(f);
        if (latestByIdentity.has(id)) continue; // a newer row already settled this identity
        latestByIdentity.set(id, f);
      }
    }
  }
  return [...latestByIdentity.values()]
    .filter((f) => f.status !== 'resolved' && f.status !== 'dismissed')
    .map((f) => ({ ...f, status: 'open' as const }));
}

function skipped(detail: string): DreamPhaseResult {
  return { name: 'take_contradictions', status: 'skipped', detail, duration_ms: 0 };
}

export async function runPhaseTakeContradictions(
  engine: BrainEngine,
  opts: TakeContradictionsPhaseOpts,
): Promise<DreamPhaseResult> {
  const start = Date.now();
  const config = await loadTakeContradictionsConfig(engine);
  if (!config.enabled && !opts.forceEnabled) {
    return skipped('dream.take_contradictions.enabled is false');
  }

  const pairs = await generateActiveTakesPairs(engine, config);
  if (pairs.length === 0) {
    return {
      name: 'take_contradictions',
      status: 'complete',
      detail: 'no candidates: fewer than 2 active takes, or no cross-page pairs found',
      totals: { candidates: 0 },
      duration_ms: Date.now() - start,
    };
  }

  if (opts.dryRun) {
    return {
      name: 'take_contradictions',
      status: 'skipped',
      detail: `dry-run: ${Math.min(pairs.length, config.maxPerCycle)} of ${pairs.length} candidate pair(s) would be judged`,
      totals: { candidates: pairs.length },
      duration_ms: Date.now() - start,
    };
  }

  const modelId = await resolveModel(engine, {
    configKey: 'models.take_contradictions',
    tier: 'reasoning',
    fallback: 'sonnet',
  });
  const judgeFn = opts.judgeFn ?? judgeContradiction;
  const tracker = new CostTracker({ capUsd: config.budgetUsd });
  const errs = new JudgeErrorCollector();
  const cache = new JudgeCache({ engine, modelId, promptVersion: CACHE_PROMPT_VERSION, disabled: opts.noCache });

  const verdictBreakdown: VerdictBreakdown = {
    no_contradiction: 0, contradiction: 0, temporal_supersession: 0,
    temporal_regression: 0, temporal_evolution: 0, negation_artifact: 0,
  };

  const sorted = sortPairs(pairs, 'deterministic').slice(0, config.maxPerCycle);
  const newFindings: ContradictionFinding[] = [];
  let judged = 0;
  let attempted = 0; // judge calls actually made (success or error) — distinguishes
                      // "nothing needed judging" (all date-skipped) from "everything failed"
  let skippedByDate = 0;
  let budgetExhausted = false;

  for (const pair of sorted) {
    // Same order/mechanism as runner.ts's loop: a read-only check against
    // ACTUAL recorded spend (CostTracker), not a pre-reservation — a
    // reservation-based gate (e.g. BudgetMeter, which drift.ts uses) would
    // charge budget for a pair that turns out to be a free cache hit below.
    if (tracker.exceededCap()) {
      budgetExhausted = true;
      break;
    }
    const dateDecision = shouldSkipForDateMismatch({
      textA: pair.a.text, textB: pair.b.text,
      effectiveDateA: pair.a.effective_date, effectiveDateB: pair.b.effective_date,
    });
    if (dateDecision.skip) {
      skippedByDate++;
      continue;
    }
    const cached = await cache.lookup(pair.a.text, pair.b.text);
    if (cached) {
      judged++;
      verdictBreakdown[cached.verdict]++;
      if (cached.verdict !== 'no_contradiction') {
        newFindings.push({ ...pairToFinding(pair, cached), status: 'open' });
      }
      continue;
    }
    attempted++;
    try {
      const out = await judgeFn({
        query: SYNTHETIC_QUERY,
        a: { slug: pair.a.slug, text: pair.a.text, source_tier: pair.a.source_tier, holder: pair.a.holder, effective_date: pair.a.effective_date },
        b: { slug: pair.b.slug, text: pair.b.text, source_tier: pair.b.source_tier, holder: pair.b.holder, effective_date: pair.b.effective_date },
        model: modelId,
        crossHolderDisagreementCounts: true,
      });
      tracker.recordJudgeCall(modelId, out.usage);
      await cache.store(pair.a.text, pair.b.text, out.verdict);
      judged++;
      verdictBreakdown[out.verdict.verdict]++;
      if (out.verdict.verdict !== 'no_contradiction') {
        newFindings.push({ ...pairToFinding(pair, out.verdict), status: 'open' });
      }
    } catch (err) {
      errs.record(pairId(pair), err);
    }
  }

  // Reconcile: union new findings with still-open prior ones not re-detected
  // this run, deduped by stable pair identity (new detection wins — fresher
  // judge output for the same pair).
  const seen = new Set(newFindings.map(findingIdentity));
  const carriedForward = (await loadOpenPriorFindings(engine)).filter((f) => !seen.has(findingIdentity(f)));
  const allFindings = [...newFindings, ...carriedForward];

  const judgeErrors = errs.finalize();
  const cost = tracker.finalize();
  const genuineContradictions = newFindings.filter((f) => f.verdict === 'contradiction').length;
  const runId = buildRunId(start);
  const runStatus = isJudgeFailedRun(sumVerdicts(verdictBreakdown), judgeErrors.total) ? ('judge_failed' as const) : ('ok' as const);
  const cacheStats = cache.stats();

  const report: ProbeReport = {
    schema_version: SCHEMA_VERSION,
    run_status: runStatus,
    run_id: runId,
    judge_model: modelId,
    prompt_version: PROMPT_VERSION,
    truncation_policy: TRUNCATION_POLICY,
    top_k: 0, // not applicable — no search/top-K for this pairing strategy
    sampling: 'deterministic',
    queries_evaluated: 1,
    queries_with_contradiction: genuineContradictions > 0 ? 1 : 0,
    queries_with_any_finding: allFindings.length > 0 ? 1 : 0,
    total_contradictions_flagged: allFindings.length,
    verdict_breakdown: verdictBreakdown,
    calibration: buildCalibration({ queriesTotal: 1, queriesWithContradiction: genuineContradictions > 0 ? 1 : 0 }),
    judge_errors: judgeErrors,
    cost_usd: cost,
    cache: cacheStats,
    duration_ms: Date.now() - start,
    source_tier_breakdown: buildSourceTierBreakdown(sorted),
    per_query: [{
      query: SYNTHETIC_QUERY_LABEL,
      result_count: pairs.length,
      contradictions: allFindings,
      pairs_skipped_by_date: skippedByDate,
      pairs_cache_hit: cacheStats.hits,
      pairs_judged: judged,
    }],
    hot_pages: buildHotPages(allFindings),
  };
  await writeRunRow(engine, report, Date.now() - start);

  const detail =
    `judged ${judged}/${sorted.length} pair(s): ${genuineContradictions} genuine contradiction(s)` +
    (carriedForward.length > 0 ? `, ${carriedForward.length} carried forward from a prior unresolved run` : '') +
    (budgetExhausted ? ' (budget exhausted)' : '') +
    (judgeErrors.total > 0 ? ` (${judgeErrors.total} judge error(s))` : '') +
    `. Cumulative cost: $${cost.total.toFixed(4)} / $${config.budgetUsd.toFixed(2)}. ` +
    'Report-only: never calls takes supersede/resolve — every genuine contradiction lands as manual_review for a human.';

  // Zero judged has two very different causes: nothing needed judging (every
  // survivor was date-skipped, or budget capped before any attempt — both
  // fine outcomes, same as drift's own "capped, not broken" framing) versus
  // every attempted judge call erroring (a real failure). `attempted`
  // distinguishes them — matches drift.ts's judged/failed split.
  const status: 'complete' | 'partial' | 'failed' =
    judged > 0 || carriedForward.length > 0
      ? (budgetExhausted || judgeErrors.total > 0 ? 'partial' : 'complete')
      : (budgetExhausted || attempted === 0 ? (budgetExhausted ? 'partial' : 'complete') : 'failed');

  return {
    name: 'take_contradictions',
    status,
    detail,
    totals: {
      candidates: pairs.length,
      judged,
      contradictions_found: genuineContradictions,
      carried_forward: carriedForward.length,
      budget_exhausted: budgetExhausted ? 1 : 0,
    },
    duration_ms: Date.now() - start,
  };
}

/** Test helper: expose internals without running the full phase. */
export const __testing = { loadTakeContradictionsConfig, loadOpenPriorFindings, findingIdentity };
