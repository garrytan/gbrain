/**
 * arm-confidence.ts — arm-confidence-weighted fusion for the LEXICAL arms.
 *
 * WHY. On conceptual-recall probes (a user paraphrases an IDEA in their own
 * words; the gold page shares few or no tokens with the query), the keyword
 * arm still returns strict AND matches — pages that happen to contain the
 * query's content words — and fuses them at full RRF weight. Cat 13
 * conceptual-recall receipt (Voyage space, voyage-4@1024, reranker off,
 * autocut off; `~/gbrain-lme-receipts/cat13/E0-V1`): hybrid nDCG@5 53.0 on
 * the held-out concepts vs bare vector 60.5 (P@1 48.1 vs 65.2); grep-only
 * alone scores 52.2. The keyword arm's noise on paraphrase probes drags the
 * fused result BELOW the vector arm it is supposed to complement.
 *
 * WHAT (the ONE pre-registered mechanism). When the keyword arm's evidence is
 * WEAK, its lists — the keyword list AND the title list, the same
 * lexical-evidence class — fuse at HALF weight (`weight 0.5` on the
 * fusion-lists.ts entries; equivalently k×2 in the old k-only form). "Weak" is
 * a SCALE-FREE statistic over the rows the keyword arm returned, so the floor
 * is portable across corpora and FTS configurations:
 *
 *   margin_ratio = top / (top + second)      (≥ 2 rows)
 *                = 1.0                        (a single row: nothing contests it)
 *                = 0                          (empty arm: no evidence at all)
 *
 * where `top` / `second` are the two largest `score` values (raw
 * `ts_rank × sourceFactor`, exactly as the engines return them — the keyword
 * arm dedups per page, so these are two distinct pages). A tie between the
 * top two pages is 0.5; a dominant top page approaches 1.0. The RAW top score
 * is exposed alongside for calibration/diagnostics only — it is
 * scale-bound (FTS config, document length, source boosts) and is NOT what
 * the floor compares against. Normalization happens here, in TypeScript — no
 * engine SQL change (touching either engine triggers the parity rule).
 *
 * WHEN. The down-weight applies only when ALL hold:
 *   - the knob is on (`keyword_arm_confidence_floor` non-null; every bundle
 *     lands at `null` = off — the Phase E2 receipt decides the flip);
 *   - the keyword list is non-empty (an empty arm has nothing to demote);
 *   - a TEXT vector arm actually voted (never on the keyword-only fallback
 *     paths — no-embedding-provider / embed-failed — where the lexical arms
 *     ARE the recall; those paths do not compose through fusion-lists.ts);
 *   - the query is NOT relational ("who invested in X"): the relational arm
 *     and the exact/alias tiers own that shape, and its keyword evidence is
 *     entity-shaped, not paraphrase noise;
 *   - `margin_ratio < floor`.
 * Otherwise the entries are emitted WITHOUT a `weight` key — byte-identical
 * to the pre-knob composition.
 *
 * Free parameters fixed BEFORE the decision run (plan Phase E2): the weight
 * multiplier is 0.5 (not swept); the floor is calibrated on a seeded
 * tuning split as the median `margin_ratio` over probes whose keyword top
 * hit is NOT gold (read per probe from
 * `HybridSearchMeta.keyword_arm_confidence` with the knob OFF), then judged
 * once on the held-out concepts.
 *
 * Pure: no engine, no IO, deterministic; unit-tested in
 * test/search/arm-confidence.test.ts; wired through
 * fusion-lists.ts `composeFusionLists` (the ONE composition point).
 */

import type { SearchResult } from '../types.ts';

/** RRF weight applied to the keyword AND title lists when the arm is weak. */
export const KEYWORD_ARM_WEAK_WEIGHT = 0.5;

/** Inclusive upper bound of the `keyword_arm_confidence_floor` range `(0, 1]`. */
export const KEYWORD_ARM_CONFIDENCE_FLOOR_MAX = 1;

/**
 * The ONE range contract for `keyword_arm_confidence_floor`, shared by the
 * config-key parser (mode.ts `loadOverridesFromConfig`) and the per-call
 * seams in hybrid.ts (inner search AND cache resolver) — mirrors
 * `normalizeExpansionVariantBudget` (fusion-lists.ts):
 *
 *   - finite number in `(0, 1]` (or a string that parses to one, e.g. the
 *     config value `'0.6'`)                              → that number
 *   - `null`, `false`, or the literals `off` / `null` / `false` (any case)
 *                                                        → `null` (knob off)
 *   - anything else (0, negatives, > 1, NaN, ±Infinity, `''`, garbage
 *     strings, `true`, objects, `undefined`)             → `undefined` (unset:
 *     fall through to the next resolution tier — config → bundle)
 */
export function normalizeKeywordArmConfidenceFloor(v: unknown): number | null | undefined {
  if (v === null || v === false) return null;
  if (typeof v === 'string') {
    const lit = v.trim().toLowerCase();
    if (lit === 'off' || lit === 'null' || lit === 'false') return null;
    if (lit === '') return undefined;
    return normalizeKeywordArmConfidenceFloor(Number(lit));
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= KEYWORD_ARM_CONFIDENCE_FLOOR_MAX) return v;
  return undefined;
}

/** Scale-free confidence statistic over the keyword arm's returned rows. */
export interface KeywordArmConfidence {
  /**
   * `top / (top + second)` over the two largest row scores; 1 for a single
   * row; 0 for an empty arm (or a non-positive top score). In `[0, 1]`.
   */
  margin_ratio: number;
  /** Raw top row score (`ts_rank × sourceFactor`) — diagnostics only, scale-bound. */
  top_score: number;
}

/** Decision stamp surfaced through `HybridSearchMeta.keyword_arm_confidence`. */
export interface KeywordArmConfidenceDecision extends KeywordArmConfidence {
  /** True iff the keyword + title lists fused at `KEYWORD_ARM_WEAK_WEIGHT`. */
  downweighted: boolean;
}

const finiteNonNegative = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;

/**
 * Compute the keyword arm's confidence from its returned rows. Order-
 * independent (takes the two largest scores, not positions 0/1) so a caller
 * that re-sorted or filtered the list gets the same answer.
 */
export function keywordArmConfidence(rows: readonly SearchResult[]): KeywordArmConfidence {
  if (rows.length === 0) return { margin_ratio: 0, top_score: 0 };
  let top = 0;
  let second = 0;
  for (const r of rows) {
    const s = finiteNonNegative(r.score);
    if (s > top) {
      second = top;
      top = s;
    } else if (s > second) {
      second = s;
    }
  }
  if (top <= 0) return { margin_ratio: 0, top_score: 0 };
  if (rows.length === 1) return { margin_ratio: 1, top_score: top };
  return { margin_ratio: top / (top + second), top_score: top };
}

export interface KeywordArmWeightInput {
  /** The keyword list that will actually fuse (post relaxed-row demotion). */
  keywordList: readonly SearchResult[];
  /** Resolved `keyword_arm_confidence_floor`; `null` = knob off. */
  floor: number | null;
  /** Did a TEXT vector arm return ≥ 1 row? (fusion-lists.ts `textArmsNonEmpty`). */
  vectorArmVoted: boolean;
  /** Did the relational-intent parser match the query? */
  relationalQuery: boolean;
}

export interface KeywordArmWeightResult {
  decision: KeywordArmConfidenceDecision;
  /** `KEYWORD_ARM_WEAK_WEIGHT` when down-weighted; `undefined` = emit no `weight` key. */
  weight: number | undefined;
}

/** The weight decision for the keyword + title fusion entries (see header). */
export function decideKeywordArmWeight(input: KeywordArmWeightInput): KeywordArmWeightResult {
  const confidence = keywordArmConfidence(input.keywordList);
  const floor = input.floor;
  const downweighted =
    floor !== null &&
    Number.isFinite(floor) &&
    input.keywordList.length > 0 &&
    input.vectorArmVoted &&
    !input.relationalQuery &&
    confidence.margin_ratio < floor;
  return {
    decision: { ...confidence, downweighted },
    weight: downweighted ? KEYWORD_ARM_WEAK_WEIGHT : undefined,
  };
}
