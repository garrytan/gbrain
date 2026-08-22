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
 *              calibrated-semantic signal.
 *   weak     — zero results, a reranked top BELOW the weak-top floor
 *              (the #1863 "whole list is low-confidence" shape), or an
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
    | 'weak_semantic_top';
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

export function gradeRetrievalConfidence(
  results: SearchResult[],
  opts: { minTopScore?: number } = {},
): ConfidenceGrade {
  if (results.length === 0) return { level: 'weak', reason: 'zero_results' };
  const top = results[0];
  const floor = typeof opts.minTopScore === 'number' ? opts.minTopScore : DEFAULT_CRAG_MIN_TOP;

  // Identity-tier signals win outright — retrieval FOUND the named thing.
  if (top.exact_lookup !== undefined) {
    return { level: 'strong', reason: 'exact_lookup', top_evidence: top.evidence };
  }
  if (top.alias_hit === true || top.evidence === 'alias_hit') {
    return { level: 'strong', reason: 'alias_hit', top_evidence: top.evidence };
  }
  if (top.evidence === 'exact_title_match') {
    return { level: 'strong', reason: 'exact_title_match', top_evidence: top.evidence };
  }
  if (top.evidence === 'high_vector_match') {
    return { level: 'strong', reason: 'high_vector_match', top_evidence: top.evidence };
  }

  // Calibrated cross-encoder signal when the reranker ran.
  if (typeof top.rerank_score === 'number' && Number.isFinite(top.rerank_score)) {
    return top.rerank_score >= floor
      ? { level: 'strong', reason: 'rerank_top', top_evidence: top.evidence, top_rerank_score: top.rerank_score }
      : { level: 'weak', reason: 'rerank_top_below_floor', top_evidence: top.evidence, top_rerank_score: top.rerank_score };
  }

  // No reranker: fall back to the T4 evidence contract.
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
 * knobs (callerExpanded) — otherwise the re-run would be a no-op re-query.
 */
export function shouldEscalateRetrieval(
  grade: ConfidenceGrade,
  opts: { enabled: boolean; alreadyEscalated?: boolean },
): boolean {
  return opts.enabled && !opts.alreadyEscalated && grade.level === 'weak';
}

/** Rank a grade for better-of-two comparison after an escalated re-run. */
export function confidenceRank(level: RetrievalConfidence): number {
  switch (level) {
    case 'strong': return 2;
    case 'moderate': return 1;
    case 'weak': return 0;
  }
}
