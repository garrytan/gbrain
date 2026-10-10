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
import { type TrustTier, admitsTrust, maxTrust } from '../trust/tier.ts';
import { DEFAULT_HIGH_COSINE_FLOOR } from './evidence.ts';
import { normalizeAlias } from './alias-normalize.ts';

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

// ---------------------------------------------------------------------------
// W3 — confidence-gated reranking: the PRE-rerank grade.
//
// `gradeRetrievalConfidence` grades the final, reranked list. The rerank gate
// needs a grade BEFORE the cross-encoder runs, on the deduped candidates
// (after fusion, cosine re-scoring and dedup). It mirrors the identity tiers
// above, without System One decide evidence (stamped after rerank, opt-in
// paid), and reads only what exists before reranking: the identity lookups
// (exact-lookup hits and alias canonicals, read but not applied), the title
// boost and the stamped raw cosine.
// ---------------------------------------------------------------------------

/**
 * `search.reranker.gate`: off (no grade), shadow (grade + stamp
 * `meta.rerank_gate`, still rerank) or on (a `would_skip` grade skips the
 * cross-encoder).
 */
export type RerankGateMode = 'off' | 'shadow' | 'on';

export const RERANK_GATE_MODES: ReadonlyArray<RerankGateMode> = Object.freeze(['off', 'shadow', 'on']);

export const DEFAULT_RERANK_GATE: RerankGateMode = 'off';

/** Default `search.reranker.gate_min_gap` (δ): cosine margin rank-1 needs over the best other page. */
export const DEFAULT_RERANK_GATE_MIN_GAP = 0.05;

/**
 * The lowest page trust tier a gate-strong rank-1 may carry. An
 * `external_untrusted` page that echoes a common question cannot skip the
 * cross-encoder; a caller's own `min_trust` raises the floor (`maxTrust`).
 */
export const RERANK_GATE_TRUST_FLOOR: TrustTier = 'unknown';

/**
 * Strong reasons a skip would apply to (`would_skip`). Title and alias (and
 * the exact-lookup tier, which is slug or full-title identity) stay
 * shadow-only until a corpus with titles and aliases shows them
 * non-inferior: the counted benchmark has neither (A57).
 */
export const RERANK_GATE_SKIP_REASONS: ReadonlySet<PreRerankStrongReason> = new Set<PreRerankStrongReason>(['high_vector_match']);

/** The one parse contract for the gate key and the per-call override: a `RERANK_GATE_MODES` literal (any case), else unset. */
export function normalizeRerankGate(v: unknown): RerankGateMode | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  return (RERANK_GATE_MODES as ReadonlyArray<string>).includes(s) ? (s as RerankGateMode) : undefined;
}

/** δ parse contract: a finite number (or numeric string) in [0, 1], else unset. */
export function normalizeRerankGateMinGap(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

export type PreRerankStrongReason = 'exact_lookup' | 'alias_hit' | 'exact_title_match' | 'high_vector_match';

export type PreRerankNotStrongReason =
  | 'no_candidates'
  /** More than one exact-lookup or alias page, or a single-token alias hop would move rank 1. */
  | 'identity_ambiguous'
  /** Image modality or unified multimodal routing: never strong. */
  | 'multimodal'
  | 'no_cosine'
  | 'cosine_below_floor'
  /** Rank-1's cosine does not lead the best other page by δ. */
  | 'gap_below_min'
  | 'below_trust_floor';

export interface PreRerankGrade {
  strong: boolean;
  reason: PreRerankStrongReason | PreRerankNotStrongReason;
  /** Rank-1's stamped raw cosine, when finite. */
  top_cosine?: number;
  /** Rank-1's cosine minus the best cosine of a different page in the same space (rank-1's own cosine when no other page). */
  gap?: number;
  /** The page a strong grade vouches for: the identity page, or the fused rank-1. */
  top?: { slug: string; source_id: string; page_id?: number };
}

export interface PreRerankGradeInput {
  /** The deduped candidates in fused order (the reranker's input). Read only. */
  candidates: readonly SearchResult[];
  query: string;
  /** Hits the exact-lookup tier would apply (one per page). */
  exactLookupHits: readonly SearchResult[];
  /** Full-query alias canonicals the alias hop would apply. */
  aliasCanonicals: ReadonlyArray<{ slug: string; source_id: string }>;
  /** True when the opt-in single-token alias hop has a candidate to move. */
  aliasTokenHop?: boolean;
  /** Image modality or unified multimodal routing. */
  multimodal: boolean;
  /** `search.evidence_cosine_floor` (default 0.8). */
  cosineFloor?: number;
  /** `search.reranker.gate_min_gap` (δ). */
  minGap?: number;
}

const pageKey = (r: { slug: string; source_id?: string }): string => `${r.source_id ?? 'default'}::${r.slug}`;

/**
 * Pure pre-rerank grade. Strong when, in this order:
 *   - the exact-lookup tier finds exactly one page;
 *   - else the alias hop finds exactly one page;
 *   - else rank-1 is a FULL-title identity (title boost and normalized
 *     title equals the normalized query; a phrase inside a longer title is
 *     not identity);
 *   - else rank-1 is `high_vector_match` (cosine at or above the floor) AND
 *     leads the best candidate from a different page in the same embedding
 *     space by at least δ. Candidates are not in cosine order and dedup keeps
 *     several chunks per page, so the gap is computed over pages.
 * Multimodal queries and image rows are never strong. The trust floor is
 * applied afterwards (`applyRerankGateTrust`): it needs the page's tier.
 */
export function gradePreRerank(input: PreRerankGradeInput): PreRerankGrade {
  const { candidates } = input;
  if (input.exactLookupHits.length > 1) return { strong: false, reason: 'identity_ambiguous' };
  if (input.exactLookupHits.length === 1) {
    const h = input.exactLookupHits[0];
    return { strong: true, reason: 'exact_lookup', top: { slug: h.slug, source_id: h.source_id ?? 'default', ...(typeof h.page_id === 'number' && h.page_id > 0 ? { page_id: h.page_id } : {}) } };
  }
  if (input.aliasCanonicals.length > 1 || (input.aliasCanonicals.length === 0 && input.aliasTokenHop)) {
    return { strong: false, reason: 'identity_ambiguous' };
  }
  if (input.aliasCanonicals.length === 1) {
    const a = input.aliasCanonicals[0];
    return { strong: true, reason: 'alias_hit', top: { slug: a.slug, source_id: a.source_id } };
  }
  const top = candidates[0];
  if (!top) return { strong: false, reason: 'no_candidates' };
  if (input.multimodal || top.modality === 'image') return { strong: false, reason: 'multimodal' };
  const topRef = { slug: top.slug, source_id: top.source_id ?? 'default', ...(typeof top.page_id === 'number' ? { page_id: top.page_id } : {}) };
  const qNorm = normalizeAlias(input.query);
  if ((top.title_match_boost ?? 1) > 1 && qNorm !== '' && normalizeAlias(top.title ?? '') === qNorm) {
    return { strong: true, reason: 'exact_title_match', top: topRef };
  }
  const cosine = top.cosine;
  if (typeof cosine !== 'number' || !Number.isFinite(cosine)) return { strong: false, reason: 'no_cosine' };
  const floor = input.cosineFloor ?? DEFAULT_HIGH_COSINE_FLOOR;
  if (cosine < floor) return { strong: false, reason: 'cosine_below_floor', top_cosine: cosine };
  const own = pageKey(top);
  let other = 0;
  for (const r of candidates) {
    if (r.modality === 'image' || pageKey(r) === own) continue;
    if (typeof r.cosine === 'number' && Number.isFinite(r.cosine) && r.cosine > other) other = r.cosine;
  }
  const gap = cosine - other;
  if (gap < (input.minGap ?? DEFAULT_RERANK_GATE_MIN_GAP)) return { strong: false, reason: 'gap_below_min', top_cosine: cosine, gap };
  return { strong: true, reason: 'high_vector_match', top_cosine: cosine, gap, top: topRef };
}

/** A strong grade whose page tier is below `max(callerFloor, RERANK_GATE_TRUST_FLOOR)` is not strong. Unknown tier reads as `unknown`. */
export function applyRerankGateTrust(grade: PreRerankGrade, tier: TrustTier | undefined, callerFloor?: TrustTier): PreRerankGrade {
  if (!grade.strong) return grade;
  const floor = callerFloor ? maxTrust(callerFloor, RERANK_GATE_TRUST_FLOOR) : RERANK_GATE_TRUST_FLOOR;
  return admitsTrust(tier ?? 'unknown', floor) ? grade : { ...grade, strong: false, reason: 'below_trust_floor' };
}
