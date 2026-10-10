/**
 * #1663 — CRAG-style retrieval-confidence gate (the ceiling half of the
 * floor/ceiling redesign).
 *
 * Corrective-RAG's core move: GRADE what retrieval returned before acting on
 * it, and escalate when the evidence is weak instead of confidently handing
 * the caller noise. gbrain's grade is zero-LLM — it reads the honesty
 * signals the pipeline already stamps (T4 evidence, the reranker's
 * cross-encoder score, the autocut weak-top floor):
 *
 *   strong   — rank-1 carries identity/vector evidence (alias_hit,
 *              exact_lookup, exact_title_match, high_vector_match) or the
 *              reranker scored the top at/above the weak-top floor.
 *   moderate — lexically verified top (keyword_exact) but no identity or
 *              calibrated-semantic signal; or an OR-relaxed keyword top whose
 *              evidence is corroborated (see `relaxedTopCorroborated`).
 *   weak     — zero results, a reranked top BELOW the weak-top floor
 *              (the #1863 "whole list is low-confidence" shape), an
 *              uncorroborated OR-relaxed keyword top (keyword_relaxed), or an
 *              unverified weak_semantic top.
 *
 * Consumers: the `query` op attaches the grade (+ query shape) to its
 * retrieval response meta on every call, and — config-gated, default OFF —
 * escalates a weak result once:
 *
 *   search.crag_escalation=true  → one high-ceiling retrieval re-run
 *                                  (expansion + relational + wide limit,
 *                                  autocut off) — keep whichever run grades
 *                                  better.
 *   search.crag_think=true       → still-weak + local caller → run `think`
 *                                  (multi-round gather + synthesis) and
 *                                  attach its answer to the response meta.
 *
 * Pure module: no engine access here — grading reads stamped fields only,
 * so it can never add latency or fail the search path.
 */

import type { SearchResult } from '../types.ts';

export type RetrievalConfidence = 'strong' | 'moderate' | 'weak';

export interface ConfidenceGrade {
  level: RetrievalConfidence;
  /** Machine-stable reason code (enumerated below; additive-only). */
  reason:
    | 'zero_results'
    | 'exact_lookup'
    | 'alias_hit'
    | 'exact_title_match'
    | 'high_vector_match'
    | 'rerank_top'
    | 'rerank_top_below_floor'
    | 'keyword_exact_top'
    | 'keyword_relaxed_top'
    | 'keyword_relaxed_corroborated'
    | 'weak_semantic_top'
    | 'decide_evidence';
  /** Rank-1 evidence label when present (auditability). */
  top_evidence?: string;
  /** Rank-1 cross-encoder score when the reranker ran. */
  top_rerank_score?: number;
}

/**
 * Default weak-top floor for the rerank-score check. Matches autocut's
 * `search.autocut_min_top` default (the #1863 calibration): below it the
 * cross-encoder itself says the best candidate is a poor match.
 */
export const DEFAULT_CRAG_MIN_TOP = 0.2;

/** Rows a relaxed top is corroborated against: the top five a reader is handed. */
export const RELAXED_CORROBORATION_DEPTH = 5;

// PostgreSQL's `english` text-search stopwords. The keyword arm drops them,
// so they never decide whether the strict AND query matched.
const ENGLISH_STOPWORDS = new Set(('i me my myself we our ours ourselves you your yours yourself yourselves he him his himself '
  + 'she her hers herself it its itself they them their theirs themselves what which who whom this that these those am is are '
  + 'was were be been being have has had having do does did doing a an the and but if or because as until while of at by for '
  + 'with about against between into through during before after above below to from up down in out on off over under again '
  + 'further then once here there when where why how all any both each few more most other some such no nor not only own same '
  + 'so than too very s t can will just don should now').split(' '));

/**
 * Inflectional stem, applied identically to query and text, so "founded" and
 * "founding" or "headquarters" and "headquartered" compare equal. Lighter
 * than the engine's Snowball stemmer: a miss reads as an unmatched term,
 * which only ever keeps a grade weak.
 */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) word = word.slice(0, -1);
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  return word;
}

function words(text: string): string[] {
  return text.normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function contentTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(text)) {
    const lower = w.toLowerCase();
    if (!ENGLISH_STOPWORDS.has(lower)) out.add(stem(lower));
  }
  return out;
}

/**
 * Name terms: content words written with a capital past the query's first
 * word (a name such as "Acme Example") or an interior capital ("ARR",
 * "McKinsey"). Sentence-initial capitalization is not a name signal.
 */
function nameTerms(query: string): Set<string> {
  const out = new Set<string>();
  words(query).forEach((w, i) => {
    const lower = w.toLowerCase();
    if (ENGLISH_STOPWORDS.has(lower)) return;
    if (/\p{Lu}/u.test(w.slice(1)) || (i > 0 && /^\p{Lu}/u.test(w))) out.add(stem(lower));
  });
  return out;
}

/**
 * An OR-relaxed keyword top means no single chunk matched every query term.
 * That happens for two different reasons, and the grade must tell them apart
 * (gbrain-evals A4, #5919):
 *
 *   - the question uses a word the corpus never writes ("Which CITY is Acme
 *     Example headquartered in?" against "Acme Example is headquartered in
 *     ..."), while the rest of the question is matched by one chunk; or
 *   - the asked-about thing is not in the evidence: the entity is matched in
 *     one chunk and the attribute only in others (a missing attribute), or
 *     a name in the question appears nowhere (an absent entity).
 *
 * Corroborated (graded moderate, not weak) when, over the top
 * RELAXED_CORROBORATION_DEPTH rows, all of these hold:
 *
 *   1. at most one query content term appears in none of the rows;
 *   2. that unmatched term is not a name term (an unmatched name means the
 *      question is about something the evidence does not mention);
 *   3. one row (title plus chunk text) contains every query term matched
 *      anywhere in the window, and at least two of them, so the matched
 *      evidence sits together instead of being split across pages.
 *
 * Purely lexical by design: relaxed rows only reach fusion when every vector
 * list is empty, so no cosine or rerank score exists on this path. A
 * question whose attribute is phrased with words the evidence never uses
 * ("annual recurring revenue" against "ARR") stays weak: lexically it is
 * indistinguishable from the attribute being absent.
 */
export function relaxedTopCorroborated(results: readonly SearchResult[], query: string): boolean {
  const asked = contentTerms(query);
  const rows = results.slice(0, RELAXED_CORROBORATION_DEPTH).map(r => contentTerms(`${r.title ?? ''} ${r.chunk_text ?? ''}`));
  const matched = [...asked].filter(t => rows.some(row => row.has(t)));
  const unmatched = [...asked].filter(t => !matched.includes(t));
  if (unmatched.length > 1 || matched.length < 2) return false;
  const names = nameTerms(query);
  if (unmatched.some(t => names.has(t))) return false;
  return rows.some(row => matched.every(t => row.has(t)));
}

export function gradeRetrievalConfidence(
  results: SearchResult[],
  /**
   * `ignoreDecideEvidence`: the deterministic grade (S4's agreement rule excludes the S3-derived input).
   * `query`: the query text; without it an OR-relaxed top is never corroborated.
   */
  opts: { minTopScore?: number; ignoreDecideEvidence?: boolean; query?: string } = {},
): ConfidenceGrade {
  if (results.length === 0) return { level: 'weak', reason: 'zero_results' };
  const top = results[0];
  const floor = typeof opts.minTopScore === 'number' ? opts.minTopScore : DEFAULT_CRAG_MIN_TOP;
  // Calibrated cross-encoder score of rank 1 when the reranker ran (System One rubric levels are not calibrated).
  // Every grade carries it, including the identity tiers that decide before it: a verbatim quote grades
  // `high_vector_match`, and a reader of `top_rerank_score` must still see that the reranker ran.
  const reranked = typeof top.rerank_score === 'number' && Number.isFinite(top.rerank_score) && top.rerank_score_kind !== 'rubric';
  const rerankScore = reranked ? { top_rerank_score: top.rerank_score! } : {};

  // Identity-tier signals win outright — retrieval FOUND the named thing.
  if (top.exact_lookup !== undefined) {
    return { level: 'strong', reason: 'exact_lookup', top_evidence: top.evidence, ...rerankScore };
  }
  if (top.alias_hit === true || top.evidence === 'alias_hit') {
    return { level: 'strong', reason: 'alias_hit', top_evidence: top.evidence, ...rerankScore };
  }
  if (top.evidence === 'exact_title_match') {
    return { level: 'strong', reason: 'exact_title_match', top_evidence: top.evidence, ...rerankScore };
  }
  if (top.evidence === 'high_vector_match') {
    return { level: 'strong', reason: 'high_vector_match', top_evidence: top.evidence, ...rerankScore };
  }

  // System One S3 (only stamped when the slot acted): the top kept candidate cleared the evidence threshold.
  if (!opts.ignoreDecideEvidence && top.decide_evidence?.clears) {
    return { level: 'strong', reason: 'decide_evidence', top_evidence: top.evidence, ...rerankScore };
  }

  if (reranked) {
    return top.rerank_score! >= floor
      ? { level: 'strong', reason: 'rerank_top', top_evidence: top.evidence, ...rerankScore }
      : { level: 'weak', reason: 'rerank_top_below_floor', top_evidence: top.evidence, ...rerankScore };
  }

  // No reranker: fall back to the T4 evidence contract. An OR-relaxed
  // lexical top matched some query terms, not the query (gbrain-evals A4-2:
  // 120 of 120 unanswerable questions had one at rank 1); it is moderate
  // only when the top rows corroborate it (#5919).
  if (top.keyword_relaxed === true) {
    return opts.query !== undefined && relaxedTopCorroborated(results, opts.query)
      ? { level: 'moderate', reason: 'keyword_relaxed_corroborated', top_evidence: top.evidence }
      : { level: 'weak', reason: 'keyword_relaxed_top', top_evidence: top.evidence };
  }
  if (top.evidence === 'keyword_exact') {
    return { level: 'moderate', reason: 'keyword_exact_top', top_evidence: top.evidence };
  }
  return { level: 'weak', reason: 'weak_semantic_top', top_evidence: top.evidence };
}

/** Meta block the `query` op attaches under `retrieval.crag`. */
export interface CragMetaBlock {
  confidence: RetrievalConfidence;
  reason: ConfidenceGrade['reason'];
  query_shape: 'factual' | 'open';
  top_rerank_score?: number;
  /** Present when the high-ceiling retrieval re-run fired. */
  escalated?: boolean;
  escalated_confidence?: RetrievalConfidence;
  /** Still weak after (or without) escalation → the honest next move. */
  escalate_to_think?: boolean;
  /** Present when search.crag_think ran the think pipeline. */
  think?: {
    answer: string;
    citations: number;
    synthesis_status?: string;
    model?: string;
  };
}

/**
 * Decision helper for the op layer: should the high-ceiling retrieval
 * re-run fire? Kept pure/exported so the policy is unit-testable.
 * Retrieval-side escalation only pays off when a better index sweep could
 * plausibly contain the answer — which is true for BOTH shapes, but the
 * op only re-runs when the first pass didn't already use the high-ceiling
 * knobs (`callerExpanded`) — otherwise the re-run would pay a second
 * query-expansion LLM call + a second rerank pass over a near-identical
 * candidate set (#4610: this guard was documented here long before it was
 * implemented; the production call site now passes the resolved expand
 * flag, so default-shape `query` callers — expand on unless explicitly
 * disabled — no longer double-spend on every weak grade).
 */
export function shouldEscalateRetrieval(
  grade: ConfidenceGrade,
  opts: { enabled: boolean; alreadyEscalated?: boolean; callerExpanded?: boolean },
): boolean {
  return opts.enabled && !opts.alreadyEscalated && !opts.callerExpanded && grade.level === 'weak';
}

/** Rank a grade for better-of-two comparison after an escalated re-run. */
export function confidenceRank(level: RetrievalConfidence): number {
  switch (level) {
    case 'strong': return 2;
    case 'moderate': return 1;
    case 'weak': return 0;
  }
}
