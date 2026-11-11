/**
 * T4 — evidence + create_safety contract (retrieval-maxpool incident).
 *
 * The incident's ROOT behavior: the agent read a single blended score (0.64)
 * and decided "no strong match, safe to write a new page" — then wrote a
 * duplicate on top of a fully-developed concept page. A blended RRF/cosine
 * score is not a calibrated probability (Codex#5), so keying the
 * don't-duplicate decision off a raw threshold is fragile.
 *
 * The fix (Codex#6): tell the agent WHY a result matched, not just a number.
 * `evidence` names the strongest signal that surfaced the page; `create_safety`
 * is the derived "is this page already here?" hint the agent keys off instead
 * of a raw score. Pure + deterministic; stamped on every result so MCP callers
 * and `--explain` read the same contract.
 *
 * Evidence precedence (strongest signal wins):
 *   alias_hit          — query exactly matched the page's declared chosen name
 *   exact_title_match  — query is a phrase in the page title (title boost fired)
 *   high_vector_match  — base (pre-boost) score >= HIGH_MATCH_FLOOR
 *   keyword_exact      — surfaced by a strict lexical arm (keyword/title FTS,
 *                        keyword_hit=true, not keyword_relaxed) with a solid
 *                        score (#3783 — a solid blended score alone no longer
 *                        earns this label); in keyword mode (GBRA-449) any
 *                        strict keyword row, whatever its score
 *   weak_semantic      — everything else (low-confidence tail)
 *
 * create_safety:
 *   exists   — strong evidence this IS the page; do NOT create a duplicate
 *   probable — likely the page; prefer updating over creating
 *   unknown  — weak signal; the agent should look closer before deciding
 */

import type { SearchResult } from '../types.ts';

export type Evidence =
  | 'alias_hit'
  | 'exact_title_match'
  | 'high_vector_match'
  | 'keyword_exact'
  | 'weak_semantic';

export type CreateSafety = 'exists' | 'probable' | 'unknown';

/**
 * Legacy pre-v0.46.15 floor — kept exported for back-compat, but
 * `high_vector_match` no longer keys off it: base_score is a blended
 * RRF/keyword/title/alias composite, NOT a cosine, so a generic
 * high-scoring page could read as a confident vector match (#3963,
 * TODOS retrieval-cathedral P1).
 */
export const HIGH_MATCH_FLOOR = 0.85;
/** base_score at/above this is a solid (not weak) match. */
export const SOLID_MATCH_FLOOR = 0.6;
/**
 * v0.46.15 — `high_vector_match` fires ONLY on a real query↔chunk cosine at/
 * above this floor (SearchResult.cosine, hydrated from the active embedding
 * column). Config-overridable via `search.evidence_cosine_floor`; the default
 * is calibrated for the current default embedding columns — per-model
 * calibration is a filed follow-up. Keyless/hermetic runs have no cosine and
 * honestly fall through to keyword_exact/weak_semantic (create_safety
 * degrades exists→probable, the safe direction for the don't-duplicate
 * contract).
 */
export const DEFAULT_HIGH_COSINE_FLOOR = 0.8;

export interface EvidenceOpts {
  /** Cosine floor for high_vector_match (default DEFAULT_HIGH_COSINE_FLOOR). */
  cosineFloor?: number;
  /**
   * GBRA-449: the rows come from a keyword-mode search (search `match: "keyword"`;
   * not the operator's `search.mcp_keyword_only` route), where every strict row satisfies the query as the
   * caller wrote it, its own OR included. Such a row (unless it matched only an
   * entity name the engine added, `matched_alias`) is keyword_exact whatever its
   * score; normalized ts_rank for an OR or one-word query sits far under
   * SOLID_MATCH_FLOOR. create_safety still follows the score floor.
   */
  keywordMode?: boolean;
}

export function classifyEvidence(r: SearchResult, opts: EvidenceOpts = {}): Evidence {
  if (r.alias_hit) return 'alias_hit';
  if (r.title_match_boost && r.title_match_boost > 1.0) return 'exact_title_match';
  const floor = typeof opts.cosineFloor === 'number' ? opts.cosineFloor : DEFAULT_HIGH_COSINE_FLOOR;
  if (typeof r.cosine === 'number' && Number.isFinite(r.cosine) && r.cosine >= floor) {
    return 'high_vector_match';
  }
  // #3783 — keyword_exact requires ACTUAL lexical-arm membership
  // (keyword_hit stamped pre-fusion by markKeywordHits, OR-propagated
  // through RRF). Pre-fix, any base_score >= SOLID_MATCH_FLOOR was labeled
  // keyword_exact with zero keyword verification, so a pure-vector row with
  // a solid blended score lied to the agent about WHY it matched. Rows
  // without the flag (incl. legacy cached rows) honestly degrade to
  // weak_semantic — create_safety 'unknown', the safe look-closer direction.
  // gbrain-evals A4-2: an OR-relaxed lexical row (keyword_relaxed, the
  // zero-strict-recall fallback) matched some query terms, not the query, so
  // it is not lexically verified.
  const base = typeof r.base_score === 'number' ? r.base_score : r.score;
  // GBRA-449: keyword mode waives the floor for a row that matched the caller's own statement, not an engine-added
  // name (matched_alias: the row matched only one of the entity's other names the engine ORed into the query).
  const callersOwnMatch = opts.keywordMode === true && !r.matched_alias;
  if (r.keyword_hit === true && r.keyword_relaxed !== true && (callersOwnMatch || (Number.isFinite(base) && base >= SOLID_MATCH_FLOOR))) {
    return 'keyword_exact';
  }
  return 'weak_semantic';
}

/**
 * #3783 — stamp lexical-arm membership on rows a keyword/title FTS query
 * surfaced. Called on the raw arm output BEFORE fusion (hybrid pipeline) or
 * before stampEvidence (direct keyword-only consumers: MCP keyword-only
 * opt-out, no-embedding fallbacks, entity near-miss suggestions). Mutates in
 * place, idempotent. RRF fusion OR-propagates the flag so a row that also
 * appeared in a vector list keeps it regardless of merge order.
 */
export function markKeywordHits(results: SearchResult[]): void {
  for (const r of results) r.keyword_hit = true;
}

export function createSafetyFor(evidence: Evidence): CreateSafety {
  switch (evidence) {
    case 'alias_hit':
    case 'exact_title_match':
    case 'high_vector_match':
      return 'exists';
    case 'keyword_exact':
      return 'probable';
    case 'weak_semantic':
      return 'unknown';
  }
}

/**
 * Stamp `evidence` + `create_safety` on every result in place. Called once at
 * the end of the hybrid pipeline (after the alias hop, before slice) so the
 * agent-facing result carries the contract. Idempotent. GBRA-449: create_safety
 * is derived from the label without `keywordMode`, so a keyword-mode row
 * relabelled keyword_exact under the score floor keeps the `unknown` it had.
 */
export function stampEvidence(results: SearchResult[], opts: EvidenceOpts = {}): void {
  for (const r of results) {
    const e = classifyEvidence(r, opts);
    r.evidence = e;
    r.create_safety = createSafetyFor(opts.keywordMode ? classifyEvidence(r, { ...opts, keywordMode: false }) : e);
  }
}
