/**
 * Correctness gate orchestrator (v0.41).
 *
 * Runs every qrels query against the brain via bare `hybridSearch` (per
 * eng-D6 — determinism over production-mirroring; matches the existing
 * eval harness pattern at src/core/search/eval.ts:242), then computes:
 *   - mean_recall_at_k
 *   - first_relevant_hit_rate
 *   - expected_top1_hit_rate (when any entries set expected_top1)
 *
 * Compares are on `${source_id}::${slug}` strings (per eng-D5) so multi-
 * source brains don't false-pass via wrong-source hits.
 *
 * Failure mode (Finding 2D): a per-query exception (timeout, brain error,
 * etc.) flips verdict to `fail` with a per-query breach naming the
 * exception. The lenient alternative — drop the failing query from the
 * aggregate — would silently inflate scores by hiding hard queries.
 */

import type { BrainEngine } from '../engine.ts';
import { hybridSearch } from '../search/hybrid.ts';
import {
  computeExpectedTop1Hit,
  computeFirstRelevantHit,
  computeRecallAtK,
  DEFAULT_QRELS_THRESHOLDS,
  refKey,
  type QrelsFile,
  type QrelsEntry,
} from './qrels-file.ts';

export interface CorrectnessGateOpts {
  /** Top-K for recall@K. Defaults to DEFAULT_QRELS_THRESHOLDS.k (10). */
  k?: number;
  /**
   * Pluggable search function for tests. Default uses bare `hybridSearch`.
   * Tests inject a stub to drive deterministic per-query behavior without
   * a real brain.
   */
  searchFn?: (engine: BrainEngine, query: string, opts: { limit: number }) => Promise<Array<{ source_id?: string; slug: string }>>;
}

export interface PerQueryResult {
  query_id: string;
  query: string;
  recall_at_k: number;
  first_relevant_hit: 0 | 1;
  expected_top1_hit?: 0 | 1;
  retrieved_count: number;
  /** When the query throws, recorded as a per-query failure. */
  errored?: true;
  error_message?: string;
}

export interface CorrectnessSummary {
  k: number;
  queries_total: number;
  queries_run: number; // queries_total - queries_errored
  queries_errored: number;
  mean_recall_at_k: number;
  first_relevant_hit_rate: number;
  /** Denominator = queries with expected_top1 SET (not total queries). */
  expected_top1_hit_rate: number;
  expected_top1_denominator: number;
}

export interface CorrectnessResult {
  summary: CorrectnessSummary;
  per_query: PerQueryResult[];
}

/** Build the canonical `${source_id}::${slug}` set for a SearchResult-like array. */
function toRefKeySet(results: Array<{ source_id?: string; slug: string }>): string[] {
  return results.map(r => `${r.source_id ?? 'default'}::${r.slug}`);
}

async function runOneQuery(
  engine: BrainEngine,
  entry: QrelsEntry,
  k: number,
  searchFn: NonNullable<CorrectnessGateOpts['searchFn']>,
): Promise<PerQueryResult> {
  let retrieved: string[];
  try {
    const raw = await searchFn(engine, entry.query, { limit: k });
    retrieved = toRefKeySet(raw);
  } catch (err) {
    return {
      query_id: entry.query_id,
      query: entry.query,
      recall_at_k: 0,
      first_relevant_hit: 0,
      retrieved_count: 0,
      errored: true,
      error_message: (err as Error).message,
    };
  }

  const relevant = entry.relevant.map(refKey);
  const recall = computeRecallAtK(retrieved, relevant, k);
  const firstRelevant = computeFirstRelevantHit(retrieved, relevant);

  const out: PerQueryResult = {
    query_id: entry.query_id,
    query: entry.query,
    recall_at_k: recall,
    first_relevant_hit: firstRelevant,
    retrieved_count: retrieved.length,
  };

  if (entry.expected_top1) {
    out.expected_top1_hit = computeExpectedTop1Hit(retrieved, refKey(entry.expected_top1));
  }

  return out;
}

/**
 * Run the correctness gate against a brain. Returns per-query results +
 * aggregate summary. Does NOT throw on per-query failures (they're recorded
 * as `errored: true` in the per-query list and surface as a non-zero
 * `queries_errored` in the summary). DOES throw if the entire qrels file
 * is empty (caller bug; parseQrelsFile already rejects this shape).
 */
export async function runCorrectnessGate(
  engine: BrainEngine,
  qrels: QrelsFile,
  opts: CorrectnessGateOpts = {},
): Promise<CorrectnessResult> {
  if (qrels.queries.length === 0) {
    throw new Error('runCorrectnessGate: qrels file has no queries');
  }
  const k = opts.k ?? DEFAULT_QRELS_THRESHOLDS.k;
  const searchFn = opts.searchFn ?? (async (e, q, o) => {
    const results = await hybridSearch(e, q, { limit: o.limit });
    return results.map(r => ({ source_id: r.source_id, slug: r.slug }));
  });

  const perQuery: PerQueryResult[] = [];
  for (const entry of qrels.queries) {
    perQuery.push(await runOneQuery(engine, entry, k, searchFn));
  }

  const errored = perQuery.filter(p => p.errored).length;
  const run = perQuery.length - errored;
  const nonErrored = perQuery.filter(p => !p.errored);

  const meanRecall = nonErrored.length === 0
    ? 0
    : nonErrored.reduce((s, p) => s + p.recall_at_k, 0) / nonErrored.length;
  const firstRelevantRate = nonErrored.length === 0
    ? 0
    : nonErrored.reduce((s, p) => s + p.first_relevant_hit, 0) / nonErrored.length;

  const withExpectedTop1 = nonErrored.filter(p => p.expected_top1_hit !== undefined);
  const expectedTop1Rate = withExpectedTop1.length === 0
    ? 0
    : withExpectedTop1.reduce((s, p) => s + (p.expected_top1_hit ?? 0), 0) / withExpectedTop1.length;

  return {
    summary: {
      k,
      queries_total: perQuery.length,
      queries_run: run,
      queries_errored: errored,
      mean_recall_at_k: meanRecall,
      first_relevant_hit_rate: firstRelevantRate,
      expected_top1_hit_rate: expectedTop1Rate,
      expected_top1_denominator: withExpectedTop1.length,
    },
    per_query: perQuery,
  };
}
