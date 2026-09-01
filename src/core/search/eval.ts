/**
 * Retrieval Evaluation Harness
 *
 * Provides standard IR metrics (Precision@k, Recall@k, MRR, nDCG@k) and a
 * runEval() orchestrator that executes a search strategy against user-defined
 * ground truth (qrels) and returns a structured EvalReport.
 *
 * Pure metric functions have zero dependencies and are fully unit-testable.
 * runEval() depends on BrainEngine + embed and is tested via E2E.
 */

import type { BrainEngine } from '../engine.ts';
import { embed } from '../embedding.ts';
import { hybridSearch } from './hybrid.ts';
import type { HybridSearchOpts } from './hybrid.ts';
import { dedupeRankedKeys } from '../eval/ranked-docs.ts';

// ─────────────────────────────────────────────────────────────────
// Ground truth types
// ─────────────────────────────────────────────────────────────────

export interface EvalQrel {
  /** Optional stable identifier for the query. */
  id?: string;
  query: string;
  /** Required: slugs considered relevant (binary relevance). */
  relevant: string[];
  /**
   * Optional graded relevance for nDCG (score 1–3 typical).
   * When omitted, all slugs in `relevant` get grade 1.
   */
  grades?: Record<string, number>;
}

export interface EvalQrelFile {
  version: 1;
  queries: EvalQrel[];
}

// ─────────────────────────────────────────────────────────────────
// Config types
// ─────────────────────────────────────────────────────────────────

export interface EvalConfig {
  /** Human-readable label for this configuration (shown in A/B output). */
  name?: string;
  strategy?: 'keyword' | 'vector' | 'hybrid';
  /** Override RRF K constant (default: 60). */
  rrf_k?: number;
  /** Enable multi-query expansion (hybrid only, default: false for eval stability). */
  expand?: boolean;
  /** Override cosine dedup threshold (default: 0.85). */
  dedup_cosine_threshold?: number;
  /** Override type ratio cap (default: 0.6). */
  dedup_type_ratio?: number;
  /** Override max chunks per page (default: 2). */
  dedup_max_per_page?: number;
  /** Max results to retrieve per query (default: 10). */
  limit?: number;
}

// ─────────────────────────────────────────────────────────────────
// Report types
// ─────────────────────────────────────────────────────────────────

export interface QueryResult {
  query: string;
  /** Returned slugs in rank order. */
  hits: string[];
  precision_at_k: number;
  recall_at_k: number;
  mrr: number;
  ndcg_at_k: number;
}

export interface EvalReport {
  config: EvalConfig;
  /** The k cutoff used for P@k, R@k, nDCG@k. */
  k: number;
  queries: QueryResult[];
  mean_precision: number;
  mean_recall: number;
  mean_mrr: number;
  mean_ndcg: number;
}

// ─────────────────────────────────────────────────────────────────
// Pure metric functions
// ─────────────────────────────────────────────────────────────────

/**
 * Page-level Precision@k: relevant unique pages in the top k divided by k.
 * The denominator remains k when fewer than k unique pages were returned.
 */
export function precisionAtK(hits: string[], relevant: Set<string>, k: number): number {
  if (k <= 0 || hits.length === 0 || relevant.size === 0) return 0;
  const topK = dedupeRankedKeys(hits).slice(0, k);
  const relevantHits = topK.filter(h => relevant.has(h)).length;
  return relevantHits / k;
}

/**
 * Page-level Recall@k: fraction of all relevant pages found in the first k
 * unique pages. Duplicate chunks neither inflate hits nor consume the cutoff.
 */
export function recallAtK(hits: string[], relevant: Set<string>, k: number): number {
  if (k <= 0 || hits.length === 0 || relevant.size === 0) return 0;
  const topK = dedupeRankedKeys(hits).slice(0, k);
  const relevantHits = topK.filter(h => relevant.has(h)).length;
  return relevantHits / relevant.size;
}

/**
 * Mean Reciprocal Rank: 1/rank of the first relevant hit (0 if none found).
 */
export function mrr(hits: string[], relevant: Set<string>): number {
  if (hits.length === 0 || relevant.size === 0) return 0;
  const uniqueHits = dedupeRankedKeys(hits);
  for (let i = 0; i < uniqueHits.length; i++) {
    if (relevant.has(uniqueHits[i])) return 1 / (i + 1);
  }
  return 0;
}

/**
 * nDCG@k: Normalized Discounted Cumulative Gain.
 *
 * Uses grades map for graded relevance. For binary relevance, pass a Map
 * where all relevant slugs map to grade 1.
 *
 * DCG = sum(grade_i / log2(rank_i + 1)) for i in top-k
 * Ideal DCG = DCG of perfect ranking (all relevant docs at top)
 * nDCG = DCG / IDCG
 */
export function ndcgAtK(hits: string[], grades: Map<string, number>, k: number): number {
  if (k <= 0 || hits.length === 0 || grades.size === 0) return 0;

  const topK = dedupeRankedKeys(hits).slice(0, k);
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const grade = grades.get(topK[i]) ?? 0;
    dcg += grade / Math.log2(i + 2); // log2(rank + 1), rank is 1-indexed
  }

  // Ideal DCG: sort all graded docs by grade desc, take top-k
  const idealGrades = Array.from(grades.values())
    .filter(g => g > 0)
    .sort((a, b) => b - a)
    .slice(0, k);

  let idcg = 0;
  for (let i = 0; i < idealGrades.length; i++) {
    idcg += idealGrades[i] / Math.log2(i + 2);
  }

  if (idcg === 0) return 0;
  return Math.min(1, Math.max(0, dcg / idcg));
}

// ─────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────

/**
 * Run a full evaluation of one search configuration against all qrels.
 * Returns an EvalReport with per-query and mean metrics.
 */
export interface RunEvalOptions {
  /**
   * Optional per-query progress callback. Called after each qrel finishes.
   * CLI wrappers pass a reporter.tick()-backed implementation; no-op otherwise.
   */
  onProgress?: (done: number, total: number, query: string) => void;
}

export async function runEval(
  engine: BrainEngine,
  qrels: EvalQrel[],
  config: EvalConfig,
  k = 5,
  options: RunEvalOptions = {},
): Promise<EvalReport> {
  const strategy = config.strategy ?? 'hybrid';
  const limit = config.limit ?? Math.max(k * 2, 10);

  const queryResults: QueryResult[] = [];

  let done = 0;
  for (const qrel of qrels) {
    const hits = dedupeRankedKeys(await runQuery(engine, qrel.query, strategy, config, limit));

    const relevantSet = new Set(qrel.relevant);
    const gradesMap = buildGradesMap(qrel);

    queryResults.push({
      query: qrel.query,
      hits,
      precision_at_k: precisionAtK(hits, relevantSet, k),
      recall_at_k: recallAtK(hits, relevantSet, k),
      mrr: mrr(hits, relevantSet),
      ndcg_at_k: ndcgAtK(hits, gradesMap, k),
    });
    done++;
    options.onProgress?.(done, qrels.length, qrel.query);
  }

  return {
    config,
    k,
    queries: queryResults,
    mean_precision: mean(queryResults.map(r => r.precision_at_k)),
    mean_recall: mean(queryResults.map(r => r.recall_at_k)),
    mean_mrr: mean(queryResults.map(r => r.mrr)),
    mean_ndcg: mean(queryResults.map(r => r.ndcg_at_k)),
  };
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

async function runQuery(
  engine: BrainEngine,
  query: string,
  strategy: 'keyword' | 'vector' | 'hybrid',
  config: EvalConfig,
  limit: number,
): Promise<string[]> {
  const dedupOpts = {
    cosineThreshold: config.dedup_cosine_threshold,
    maxTypeRatio: config.dedup_type_ratio,
    maxPerPage: config.dedup_max_per_page,
  };

  if (strategy === 'keyword') {
    const results = await engine.searchKeyword(query, { limit });
    return results.map(r => r.slug);
  }

  if (strategy === 'vector') {
    const embedding = await embed(query);
    const results = await engine.searchVector(embedding, { limit });
    return results.map(r => r.slug);
  }

  // hybrid
  const hybridOpts: HybridSearchOpts = {
    limit,
    expansion: config.expand ?? false,
    rrfK: config.rrf_k,
    dedupOpts,
  };
  const results = await hybridSearch(engine, query, hybridOpts);
  return results.map(r => r.slug);
}

/**
 * Build a grades Map for nDCG. If qrel has explicit grades, use them.
 * Otherwise, assign grade=1 to every slug in relevant (binary relevance).
 */
function buildGradesMap(qrel: EvalQrel): Map<string, number> {
  if (qrel.grades && Object.keys(qrel.grades).length > 0) {
    return new Map(Object.entries(qrel.grades));
  }
  return new Map(qrel.relevant.map(slug => [slug, 1]));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * #4608: validate + normalize ONE qrels entry before any query is billed.
 * Pre-fix, parseQrels cast blindly and the first malformed entry crashed
 * inside buildGradesMap (`qrel.relevant.map`) AFTER runEval had already
 * spent a live search + rerank per entry up to that point. The validator
 * throws with the entry index — commands/eval.ts catches and prints a
 * clean usage error before the first provider call.
 *
 * Friendly aliases: the `gbrain eval gate` per-entry keys
 * (`relevant_slugs`, `first_relevant_slug` — see bench/qrels-file.ts)
 * map onto `relevant`, so the same file works in both commands. The gate's
 * FEDERATED shape (`relevant: [{source_id, slug}]`) is rejected BY NAME:
 * bare `gbrain eval` compares unqualified slugs, so accepting the object
 * form would silently score all-zero (the issue's quieter half).
 */
function normalizeQrelEntry(e: unknown, i: number): EvalQrel {
  if (!e || typeof e !== 'object' || Array.isArray(e)) {
    throw new Error(`qrels entry ${i}: expected an object, got ${Array.isArray(e) ? 'an array' : typeof e}.`);
  }
  const o = e as Record<string, unknown>;
  if (typeof o.query !== 'string' || o.query.trim().length === 0) {
    throw new Error(`qrels entry ${i}: "query" must be a non-empty string.`);
  }
  let relevant = o.relevant;
  if (relevant === undefined && Array.isArray(o.relevant_slugs)) {
    relevant = o.relevant_slugs; // gate-shape alias
  }
  if (!Array.isArray(relevant)) {
    const hint = o.relevant_slugs !== undefined
      ? ' Found "relevant_slugs" with a non-array value.'
      : '';
    throw new Error(
      `qrels entry ${i} ("${o.query}"): missing "relevant" (array of gold slug strings).${hint}`,
    );
  }
  const slugs: string[] = [];
  for (const s of relevant) {
    if (typeof s === 'string') {
      slugs.push(s);
      continue;
    }
    if (s && typeof s === 'object' && 'slug' in (s as Record<string, unknown>)) {
      throw new Error(
        `qrels entry ${i} ("${o.query}"): "relevant" contains {source_id, slug} objects — that is the ` +
          '`gbrain eval gate` federated shape. Bare `gbrain eval` compares unqualified slugs; ' +
          'use `"relevant": ["<slug>", ...]` here, or run `gbrain eval gate --qrels` for source-qualified gold.',
      );
    }
    throw new Error(`qrels entry ${i} ("${o.query}"): "relevant" must contain only slug strings.`);
  }
  // Gate-shape alias: fold first_relevant_slug into the gold set (bare eval
  // has no separate top-1 metric; MRR covers it).
  if (typeof o.first_relevant_slug === 'string' && o.first_relevant_slug.length > 0 && !slugs.includes(o.first_relevant_slug)) {
    slugs.push(o.first_relevant_slug);
  }
  if (slugs.length === 0) {
    throw new Error(`qrels entry ${i} ("${o.query}"): "relevant" is empty — every entry needs at least one gold slug.`);
  }
  if (o.grades !== undefined) {
    if (typeof o.grades !== 'object' || o.grades === null || Array.isArray(o.grades)) {
      throw new Error(`qrels entry ${i} ("${o.query}"): "grades" must be an object mapping slug -> number.`);
    }
    // #4608 residual: a non-numeric grade value (a string, null) survives
    // the shape check above and the blind cast below, then produces NaN
    // nDCG AFTER the paid searches already ran. Validate the VALUES behind
    // the same pre-billing gate, with the same named-error + entry-index
    // style as every other check here.
    for (const [slug, g] of Object.entries(o.grades as Record<string, unknown>)) {
      if (typeof g !== 'number' || !Number.isFinite(g)) {
        throw new Error(
          `qrels entry ${i} ("${o.query}"): "grades" value for "${slug}" must be a finite number, got ${JSON.stringify(g)}.`,
        );
      }
    }
  }
  return {
    ...(typeof o.id === 'string' ? { id: o.id } : {}),
    query: o.query,
    relevant: slugs,
    ...(o.grades ? { grades: o.grades as Record<string, number> } : {}),
  };
}

/**
 * Parse qrels from either a file path or an inline JSON string.
 * Returns the array of EvalQrel entries. #4608: every entry is validated
 * (and gate-shape keys normalized) here, BEFORE runEval bills any search.
 */
export function parseQrels(input: string): EvalQrel[] {
  let raw: string;

  // Inline JSON starts with '[' or '{'
  if (input.trimStart().startsWith('[') || input.trimStart().startsWith('{')) {
    raw = input;
  } else {
    // Treat as file path
    const { readFileSync } = require('fs');
    raw = readFileSync(input, 'utf-8');
  }

  const parsed = JSON.parse(raw);

  // Support both array format and { version, queries } / { schema_version,
  // queries } wrappers (the latter is the gate's file shape).
  const entries: unknown[] | null = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { queries?: unknown }).queries)
      ? (parsed as { queries: unknown[] }).queries
      : null;
  if (entries === null) {
    throw new Error('Invalid qrels format. Expected array or { version, queries } object.');
  }
  return entries.map((e, i) => normalizeQrelEntry(e, i));
}
