/**
 * eval-contradictions/runner — the orchestrator.
 *
 * One run of `gbrain eval suspected-contradictions`:
 *   1. Load queries from one of three sources (file, single, capture).
 *      --from-capture detects an empty eval_candidates table and exits 2.
 *   2. For each query, run hybridSearch (engine-side, embedding cost
 *      tracked separately).
 *   3. Generate pairs:
 *        - cross_slug_chunks across the top-K results
 *        - intra_page_chunk_take for each unique page's active takes
 *          (P1 batched via engine.listActiveTakesForPages)
 *   4. Apply the A1 date pre-filter; pairs that pass go to the cache (P2)
 *      or judge.
 *   5. Sort by combined retrieval score; deterministic vs score-first
 *      sampling controls the order pairs are judged (A3).
 *   6. Track cost (A2 soft ceiling): pre-flight estimate + mid-run
 *      cumulative stop.
 *   7. judge_errors counted as first-class (Codex fix); failed pairs go
 *      into the typed counters, not stderr.
 *   8. Aggregate per-query + global stats + Wilson CI + source-tier
 *      breakdown + hot pages.
 *
 * Returns a ProbeReport plus a side-channel `judgeErrors` array for the
 * doctor integration. Pure orchestration — no filesystem, no CLI parsing.
 */

import type { BrainEngine } from '../engine.ts';
import { hybridSearch } from '../search/hybrid.ts';
import type { SearchResult } from '../types.ts';
import { buildCalibration } from './calibration.ts';
import { JudgeCache } from './cache.ts';
import { CostTracker, estimateUpperBoundCost } from './cost-tracker.ts';
import { buildSourceTierBreakdown, classifySlugTier } from './cross-source.ts';
import { shouldSkipForDateMismatch } from './date-filter.ts';
import { judgeContradiction, type JudgeInput, type JudgeOutput } from './judge.ts';
import { JudgeErrorCollector } from './judge-errors.ts';
import { buildHotPages } from './severity-classify.ts';
import { pairToFinding } from './auto-supersession.ts';
import {
  PROMPT_VERSION,
  SCHEMA_VERSION,
  TRUNCATION_POLICY,
  type ContradictionFinding,
  type ContradictionPair,
  type PairMember,
  type PerQueryResult,
  type ProbeReport,
  type Verdict,
  type VerdictBreakdown,
} from './types.ts';

const DEFAULT_TOP_K = 5;
const DEFAULT_JUDGE_MODEL = 'anthropic:claude-haiku-4-5';
const DEFAULT_MAX_PAIR_CHARS = 1500;

/** Caller-supplied judge function signature; defaults to judgeContradiction. */
export type JudgeFn = (input: JudgeInput) => Promise<JudgeOutput>;

export interface RunnerOpts {
  engine: BrainEngine;
  queries: string[];
  judgeModel?: string;
  topK?: number;
  /** Pair-sampling policy (A3). 'deterministic' uses combined_score DESC. */
  sampling?: 'deterministic' | 'score-first';
  /** USD cap for the run. Soft ceiling enforced pre-flight + mid-run. */
  budgetUsd?: number;
  /** True iff user passed --yes; allows over-budget pre-flight to proceed. */
  yesOverride?: boolean;
  /** UTF-8-safe per-pair truncation (C4). */
  maxPairChars?: number;
  /** Disable the persistent cache (P2). Useful for benchmark runs. */
  noCache?: boolean;
  /** Test hooks: override the judge and the search functions. */
  judgeFn?: JudgeFn;
  searchFn?: (engine: BrainEngine, query: string, opts: { limit: number }) => Promise<SearchResult[]>;
  abortSignal?: AbortSignal;
}

export interface RunnerResult {
  report: ProbeReport;
  /** Detailed error rows (Codex fix — first-class, not stderr). */
  judgeErrorRows: ReadonlyArray<{ kind: string; pair_id: string; reason: string }>;
  /** True iff the run stopped early because cumulative cost > budget. */
  capHitMidRun: boolean;
  /** True iff pre-flight refused (only set when --yes was not passed). */
  preFlightRefused: boolean;
}

/** Custom error class for pre-flight budget refusal. */
export class PreFlightBudgetError extends Error {
  constructor(public readonly estimatedUsd: number, public readonly capUsd: number) {
    super(`Estimated cost $${estimatedUsd.toFixed(4)} exceeds --budget-usd cap $${capUsd.toFixed(2)}; pass --yes to override.`);
    this.name = 'PreFlightBudgetError';
  }
}

/** Build a pair key for judge_errors row identification. Stable per run. */
function pairId(pair: ContradictionPair): string {
  const a = pair.a.chunk_id ?? `take-${pair.a.take_id}`;
  const b = pair.b.chunk_id ?? `take-${pair.b.take_id}`;
  return `${pair.kind}:${pair.a.slug}#${a}:${pair.b.slug}#${b}`;
}

/** Convert a SearchResult into a PairMember (chunk shape). */
function searchResultToMember(r: SearchResult): PairMember {
  return {
    slug: r.slug,
    chunk_id: r.chunk_id,
    take_id: null,
    source_tier: classifySlugTier(r.slug),
    holder: null,
    text: r.chunk_text,
    // Lane A1: effective_date carried through from the search projection.
    // null when the page has no temporal anchor (judge will see `(date unknown)`).
    effective_date: r.effective_date ?? null,
    effective_date_source: r.effective_date_source ?? null,
  };
}

/**
 * Convert a Take into a PairMember.
 *
 * Lane A1: takes are paired with a chunk from the same page, so the take's
 * effective_date is inherited from the chunk's page-level effective_date.
 * A future enhancement could distinguish `takes.since_date` from
 * `pages.effective_date` here — for v1 they share the same page anchor.
 */
function takeToMember(
  take: { id: number; page_slug: string; claim: string; holder: string },
  source_tier: ReturnType<typeof classifySlugTier>,
  effective_date: string | null,
  effective_date_source: string | null,
): PairMember {
  return {
    slug: take.page_slug,
    chunk_id: null,
    take_id: take.id,
    source_tier,
    holder: take.holder,
    text: take.claim,
    effective_date,
    effective_date_source,
  };
}

/** Build cross-slug pairs from the top-K (every distinct-slug pair once). */
function generateCrossSlugPairs(results: SearchResult[]): ContradictionPair[] {
  const out: ContradictionPair[] = [];
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      if (results[i].slug === results[j].slug) continue;  // skip same-slug
      const a = searchResultToMember(results[i]);
      const b = searchResultToMember(results[j]);
      out.push({
        kind: 'cross_slug_chunks',
        a, b,
        combined_score: (results[i].score ?? 0) + (results[j].score ?? 0),
      });
    }
  }
  return out;
}

/** Build intra-page pairs: for each result page, pair its chunks with the page's takes. */
async function generateIntraPagePairs(
  engine: BrainEngine,
  results: SearchResult[],
): Promise<ContradictionPair[]> {
  if (results.length === 0) return [];
  // Unique page_ids only.
  const pageIds = Array.from(new Set(results.map((r) => r.page_id)));
  const takesByPage = await engine.listActiveTakesForPages(pageIds);
  const out: ContradictionPair[] = [];
  for (const r of results) {
    const takes = takesByPage.get(r.page_id) ?? [];
    if (takes.length === 0) continue;
    const chunkMember = searchResultToMember(r);
    for (const t of takes) {
      const takeMember = takeToMember(
        t,
        chunkMember.source_tier,
        chunkMember.effective_date,
        chunkMember.effective_date_source,
      );
      out.push({
        kind: 'intra_page_chunk_take',
        a: chunkMember,
        b: takeMember,
        // Take has no retrieval score; weight 1.0 so intra-page pairs surface
        // alongside cross-slug ones in deterministic ordering.
        combined_score: (r.score ?? 0) + 1.0,
      });
    }
  }
  return out;
}

/**
 * Sort pairs by the chosen sampling policy.
 *
 * - deterministic: by combined_score DESC, then (slug-a, slug-b) lex.
 *   Stable for measurement — re-runs surface the same pairs in the same
 *   order, so cache hit-rate doesn't depend on RNG.
 * - score-first: same as deterministic for v1 (A3 reduction; if we add
 *   triage-mode-specific behavior later it diverges here).
 */
function sortPairs(
  pairs: ContradictionPair[],
  sampling: 'deterministic' | 'score-first',
): ContradictionPair[] {
  void sampling;  // unused param flag for forward compatibility
  return [...pairs].sort((x, y) => {
    if (y.combined_score !== x.combined_score) return y.combined_score - x.combined_score;
    if (x.a.slug !== y.a.slug) return x.a.slug < y.a.slug ? -1 : 1;
    if (x.b.slug !== y.b.slug) return x.b.slug < y.b.slug ? -1 : 1;
    return 0;
  });
}

/**
 * Orchestrate one run. The runner is engine-aware (needs hybridSearch and
 * the persistent cache + run-row writers); callers pass an array of query
 * strings — CLI flag parsing lives in the command file, not here.
 */
export async function runContradictionProbe(opts: RunnerOpts): Promise<RunnerResult> {
  const startedAt = Date.now();
  const judgeModel = opts.judgeModel ?? DEFAULT_JUDGE_MODEL;
  const topK = Math.max(1, opts.topK ?? DEFAULT_TOP_K);
  const sampling = opts.sampling ?? 'deterministic';
  const budgetUsd = opts.budgetUsd ?? 5.0;
  const maxPairChars = opts.maxPairChars ?? DEFAULT_MAX_PAIR_CHARS;
  const judgeFn = opts.judgeFn ?? judgeContradiction;
  const searchFn =
    opts.searchFn ??
    ((engine, query, o) => hybridSearch(engine, query, { limit: o.limit }));

  const errs = new JudgeErrorCollector();
  const tracker = new CostTracker({ capUsd: budgetUsd });
  const cache = new JudgeCache({ engine: opts.engine, modelId: judgeModel, disabled: !!opts.noCache });

  // Pre-flight: pair count = queries × min(topK*(topK-1)/2 + topK, 50).
  // Conservative upper bound; the actual count depends on takes per page.
  const conservativePairsPerQuery = (topK * (topK - 1)) / 2 + topK * 2;
  const estimated = estimateUpperBoundCost({
    pairCount: opts.queries.length * conservativePairsPerQuery,
    queryCount: opts.queries.length,
    judgeModel,
  });
  if (estimated > budgetUsd && !opts.yesOverride) {
    throw new PreFlightBudgetError(estimated, budgetUsd);
  }

  const perQuery: PerQueryResult[] = [];
  const allFindings: ContradictionFinding[] = [];
  const allPairs: ContradictionPair[] = [];
  let capHitMidRun = false;
  let queriesWithContradiction = 0;
  let queriesWithAnyFinding = 0;
  // v0.34 / Lane A2: per-verdict tally across every judged pair (and cache hit).
  const verdictBreakdown: VerdictBreakdown = {
    no_contradiction: 0,
    contradiction: 0,
    temporal_supersession: 0,
    temporal_regression: 0,
    temporal_evolution: 0,
    negation_artifact: 0,
  };
  const tallyVerdict = (v: Verdict) => { verdictBreakdown[v]++; };

  for (const query of opts.queries) {
    if (opts.abortSignal?.aborted) break;
    if (capHitMidRun) {
      // Emit empty per-query so denominators stay honest.
      perQuery.push({
        query,
        result_count: 0,
        contradictions: [],
        pairs_skipped_by_date: 0,
        pairs_cache_hit: 0,
        pairs_judged: 0,
      });
      continue;
    }

    // Search.
    const results = await searchFn(opts.engine, query, { limit: topK });

    // Pairs.
    const cross = generateCrossSlugPairs(results);
    const intra = await generateIntraPagePairs(opts.engine, results);
    const allPairsForQuery = [...cross, ...intra];
    allPairs.push(...allPairsForQuery);

    // Date pre-filter.
    // v0.34 / Lane B: thread page-level effective_date through so the
    // filter's relaxation rule fires for dated pairs (judge classifies
    // temporal supersession instead of the pair being silently skipped).
    const survivedDate: ContradictionPair[] = [];
    let skippedByDate = 0;
    for (const p of allPairsForQuery) {
      const decision = shouldSkipForDateMismatch({
        textA: p.a.text,
        textB: p.b.text,
        effectiveDateA: p.a.effective_date,
        effectiveDateB: p.b.effective_date,
      });
      if (decision.skip) {
        skippedByDate++;
        continue;
      }
      survivedDate.push(p);
    }

    // Sort.
    const sorted = sortPairs(survivedDate, sampling);

    // Judge each pair.
    const findings: ContradictionFinding[] = [];
    let cacheHits = 0;
    let judged = 0;
    for (const pair of sorted) {
      if (opts.abortSignal?.aborted) break;
      if (tracker.exceededCap()) {
        capHitMidRun = true;
        break;
      }
      // Cache lookup.
      const cached = await cache.lookup(pair.a.text, pair.b.text);
      if (cached) {
        cacheHits++;
        tallyVerdict(cached.verdict);
        // v0.34 / Lane A2: emit findings for every non-no_contradiction verdict.
        // Without this, the new verdicts (temporal_supersession etc.) would
        // disappear from the report and the whole wave is invisible to users.
        if (cached.verdict !== 'no_contradiction') {
          findings.push(pairToFinding(pair, cached));
        }
        continue;
      }
      // Judge call.
      try {
        const out = await judgeFn({
          query,
          a: {
            slug: pair.a.slug,
            text: pair.a.text,
            source_tier: pair.a.source_tier,
            holder: pair.a.holder,
            effective_date: pair.a.effective_date,
          },
          b: {
            slug: pair.b.slug,
            text: pair.b.text,
            source_tier: pair.b.source_tier,
            holder: pair.b.holder,
            effective_date: pair.b.effective_date,
          },
          model: judgeModel,
          maxPairChars,
          abortSignal: opts.abortSignal,
        });
        tracker.recordJudgeCall(judgeModel, out.usage);
        await cache.store(pair.a.text, pair.b.text, out.verdict);
        judged++;
        tallyVerdict(out.verdict.verdict);
        // v0.34 / Lane A2: same emit predicate as the cache-hit branch.
        if (out.verdict.verdict !== 'no_contradiction') {
          findings.push(pairToFinding(pair, out.verdict));
        }
      } catch (err) {
        errs.record(pairId(pair), err);
      }
    }

    // v0.34 / Lane A2: distinguish strict-contradiction from any-finding.
    // The strict count drives the Wilson-CI denominator (the historic
    // headline metric). The broad count surfaces the wave's new value:
    // "of N queries, M had at least one temporal signal."
    if (findings.length > 0) queriesWithAnyFinding++;
    if (findings.some((f) => f.verdict === 'contradiction')) queriesWithContradiction++;
    perQuery.push({
      query,
      result_count: results.length,
      contradictions: findings,
      pairs_skipped_by_date: skippedByDate,
      pairs_cache_hit: cacheHits,
      pairs_judged: judged,
    });
    allFindings.push(...findings);
  }

  // Aggregate.
  const cacheStats = cache.stats();
  const judgeErrors = errs.finalize();
  const cost = tracker.finalize();
  const calibration = buildCalibration({
    queriesTotal: opts.queries.length,
    queriesWithContradiction,
  });
  const breakdown = buildSourceTierBreakdown(allPairs);
  const hotPages = buildHotPages(allFindings);
  const runId = new Date(startedAt).toISOString().replace(/[:.]/g, '-').replace(/-(?=\d{3}Z$)/, '.');
  const durationMs = Date.now() - startedAt;

  const report: ProbeReport = {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    judge_model: judgeModel,
    prompt_version: PROMPT_VERSION,
    truncation_policy: TRUNCATION_POLICY,
    top_k: topK,
    sampling,
    queries_evaluated: opts.queries.length,
    queries_with_contradiction: queriesWithContradiction,
    queries_with_any_finding: queriesWithAnyFinding,
    total_contradictions_flagged: allFindings.length,
    verdict_breakdown: verdictBreakdown,
    calibration,
    judge_errors: judgeErrors,
    cost_usd: cost,
    cache: cacheStats,
    duration_ms: durationMs,
    source_tier_breakdown: breakdown,
    per_query: perQuery,
    hot_pages: hotPages,
  };

  return {
    report,
    judgeErrorRows: errs.rowsOut(),
    capHitMidRun,
    preFlightRefused: false,
  };
}
