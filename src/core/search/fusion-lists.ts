/**
 * fusion-lists.ts — the ONE composition point for hybridSearch's RRF inputs.
 *
 * Invariant: every vector recall list carries a ROLE (`original` | `variant` |
 * `clause` | `image`) as a tagged object, never a parallel index-aligned
 * array. The `Promise.allSettled` salvage path in hybrid.ts filters failed
 * arms out, and the both-mode image branch fails open, so any positional
 * convention ("last list is the image branch", "index 0 is the original")
 * silently mis-tags lists under partial failure. Roles make the k and weight
 * assignment a property of the list, not of its position.
 *
 * Weighting (budget-normalized weighted RRF, literature form `w / (k + rank)`):
 *   - `original` fuses at weight 1 (the caller's own query is the anchor).
 *   - `variant` + `clause` arms share ONE total budget
 *     `expansionVariantBudget`: `weight_i = b / n_voting_arms` where
 *     n_voting_arms is the count of NON-EMPTY variant/clause lists (an empty
 *     list casts no vote, so the budget is spent only by lists that do —
 *     accepted deviation from a naive "divide by every variant" split; the
 *     ModeBundle doc in mode.ts states the same formula). Total expansion
 *     influence therefore no longer scales with the nondeterministic variant
 *     count.
 *     Two variants agreeing on a distractor at rank 0 contribute `budget / k`
 *     in total and tie the original's rank-0 vote exactly at budget 1.0.
 *   - `null` budget = legacy: every list weight 1 (no `weight` key emitted),
 *     byte-identical to the pre-role `allLists` mapping.
 *   - original missing (its embed OR searchVector failed): every surviving
 *     text arm is a `variant` and they share the budget (pre-registered).
 *
 * k assignment mirrors the pre-role mapping, minus its mis-tag corner:
 *   - image arm present AND ≥1 text arm present ('both' mode that did not
 *     fall open) → text arms at `textRrfK`, image arm at `imageRrfK`.
 *   - otherwise every vector arm at `vectorK` (text mode, image-only mode,
 *     unified routing, and 'both' mode whose image branch fell open — the
 *     corner where the old "last list is the image" rule handed a TEXT
 *     variant list the image k).
 *   - keyword list at `keywordK`; title list at `keywordK` only if non-empty;
 *     relational list at `baseRrfK` only if `includeRelational` && non-empty.
 *
 * Arm-confidence weighting of the LEXICAL arms (arm-confidence.ts, Cat 13):
 *   - when `keywordArmConfidenceFloor` is set, the keyword list is non-empty,
 *     a TEXT vector arm voted, the query is not relational, and the keyword
 *     arm's scale-free `margin_ratio` is below the floor, the keyword AND
 *     title entries carry `weight: 0.5` (`KEYWORD_ARM_WEAK_WEIGHT`);
 *   - otherwise (floor `null`/unset = every bundle today) those entries are
 *     emitted without a `weight` key — byte-identical to the pre-knob output.
 *   - `onKeywordArmConfidence` fires ONCE per composition with the decision
 *     (margin_ratio, top_score, downweighted) — always, even when the knob is
 *     off — so hybrid.ts can stamp `HybridSearchMeta.keyword_arm_confidence`
 *     and an operator can calibrate the floor with the knob off.
 *
 * Pure: no engine, no IO, deterministic; unit-tested in
 * test/search/fusion-lists.test.ts + test/search/arm-confidence.test.ts.
 */

import type { SearchResult } from '../types.ts';
import { decideKeywordArmWeight, type KeywordArmConfidenceDecision } from './arm-confidence.ts';

export type VectorArmRole = 'original' | 'variant' | 'clause' | 'image';

export interface VectorArm {
  list: SearchResult[];
  role: VectorArmRole;
}

/** One RRF input: `weight / (k + rank)` per row (weight defaults to 1). */
export interface FusionListEntry {
  list: SearchResult[];
  k: number;
  weight?: number;
}

/** Tag-and-append helper: the single way hybrid.ts adds a vector arm. */
export function pushVectorList(arms: VectorArm[], list: SearchResult[], role: VectorArmRole): void {
  arms.push({ list, role });
}

/**
 * Is the TEXT vector arm healthy? Any non-image arm with ≥1 row counts —
 * including a surviving expansion variant (real semantic evidence). The image
 * arm never counts: image evidence can't substitute for the text-side lexical
 * rescue the OR-relaxed keyword rows exist to provide.
 */
export function textArmsNonEmpty(arms: readonly VectorArm[]): boolean {
  return arms.some((a) => a.role !== 'image' && a.list.length > 0);
}

export interface FusionKs {
  /** Intent-effective k for vector lists outside cross-modal both mode. */
  vectorK: number;
  /** Cross-modal both mode: text-side vector k. */
  textRrfK: number;
  /** Cross-modal both mode: image-side vector k. */
  imageRrfK: number;
  /** Intent-effective k for the keyword AND title lexical lists. */
  keywordK: number;
  /** Neutral k for the relational arm. */
  baseRrfK: number;
}

export interface FusionKnobs {
  /** `search.expansion_variant_budget`: null = legacy (weight 1 everywhere). */
  expansionVariantBudget: number | null;
  /**
   * `search.keyword_arm_confidence_floor`: null/undefined = off (keyword +
   * title entries carry no `weight` key). See arm-confidence.ts.
   */
  keywordArmConfidenceFloor?: number | null;
}

/** Inclusive upper bound of the `expansion_variant_budget` range `(0, 4]`. */
export const EXPANSION_VARIANT_BUDGET_MAX = 4;

/**
 * The ONE range contract for `expansion_variant_budget`, shared by the
 * per-call SearchOpts seam (hybrid.ts, inner search AND cache resolver) and
 * the config-key parser (mode.ts `loadOverridesFromConfig`):
 *
 *   - finite number in `(0, 4]` (or a string that parses to one, e.g. the
 *     config value `'0.5'`)                         → that number
 *   - `null`, or the literal `'legacy'` / `'null'`  → `null` (legacy weight 1)
 *   - anything else (0, negatives, > 4, NaN, ±Infinity, `''`, garbage
 *     strings, booleans, objects, `undefined`)      → `undefined` (unset:
 *     fall through to the next resolution tier — config → bundle)
 *
 * Without this, a per-call `NaN`/`0`/`-1`/`4.5` reached resolveSearchMode
 * unvalidated (per-call wins over config/bundle on `!== undefined`), so
 * `evb=NaN` could be folded into the cache key and `budget / n` could
 * zero or negate every variant vote.
 */
export function normalizeExpansionVariantBudget(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v === 'string') {
    const lit = v.trim().toLowerCase();
    if (lit === 'legacy' || lit === 'null') return null;
    if (lit === '') return undefined;
    return normalizeExpansionVariantBudget(Number(lit));
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= EXPANSION_VARIANT_BUDGET_MAX) return v;
  return undefined;
}

export interface ComposeFusionListsInput {
  arms: readonly VectorArm[];
  keywordFusionList: SearchResult[];
  titleFusionList: SearchResult[];
  relationalList: SearchResult[];
  /** False on image-modality queries (the relational arm is text-only). */
  includeRelational: boolean;
  /**
   * True when the relational-intent parser matched the query. Gates the
   * arm-confidence down-weight OFF (relational keyword evidence is
   * entity-shaped, not paraphrase noise). Default false.
   */
  relationalQuery?: boolean;
  /** Fires once with the arm-confidence decision (even when the knob is off). */
  onKeywordArmConfidence?: (decision: KeywordArmConfidenceDecision) => void;
  ks: FusionKs;
  knobs: FusionKnobs;
}

const isExpansionRole = (role: VectorArmRole): boolean => role === 'variant' || role === 'clause';

/**
 * Compose the complete weighted RRF input list. Arm order is preserved
 * (fusion's first-seen row identity and stable tie-breaks depend on it), then
 * keyword, title, relational — the same order the pre-role mapping used.
 */
export function composeFusionLists(input: ComposeFusionListsInput): FusionListEntry[] {
  const { arms, keywordFusionList, titleFusionList, relationalList, includeRelational, ks, knobs } = input;

  const hasImageArm = arms.some((a) => a.role === 'image');
  const hasTextArm = arms.some((a) => a.role !== 'image');
  const bothMode = hasImageArm && hasTextArm;
  const textK = bothMode ? ks.textRrfK : ks.vectorK;
  const imageK = bothMode ? ks.imageRrfK : ks.vectorK;

  const budget = knobs.expansionVariantBudget;
  const votingExpansionArms = arms.filter((a) => isExpansionRole(a.role) && a.list.length > 0).length;
  const expansionWeight =
    budget === null || votingExpansionArms === 0 ? undefined : budget / votingExpansionArms;

  const out: FusionListEntry[] = [];
  for (const arm of arms) {
    if (arm.role === 'image') {
      out.push({ list: arm.list, k: imageK });
    } else if (isExpansionRole(arm.role) && expansionWeight !== undefined && arm.list.length > 0) {
      out.push({ list: arm.list, k: textK, weight: expansionWeight });
    } else {
      out.push({ list: arm.list, k: textK });
    }
  }
  // Arm-confidence weighting (arm-confidence.ts): the keyword AND title
  // lists share one decision, computed from the keyword list that actually
  // fuses (post relaxed-row demotion). `weight` undefined → no key emitted.
  const lexical = decideKeywordArmWeight({
    keywordList: keywordFusionList,
    floor: knobs.keywordArmConfidenceFloor ?? null,
    vectorArmVoted: textArmsNonEmpty(arms),
    relationalQuery: input.relationalQuery === true,
  });
  try {
    input.onKeywordArmConfidence?.(lexical.decision);
  } catch {
    // Meta stamping must never break fusion.
  }
  const lexicalWeight = lexical.weight === undefined ? {} : { weight: lexical.weight };
  out.push({ list: keywordFusionList, k: ks.keywordK, ...lexicalWeight });
  if (titleFusionList.length > 0) {
    out.push({ list: titleFusionList, k: ks.keywordK, ...lexicalWeight });
  }
  if (includeRelational && relationalList.length > 0) {
    out.push({ list: relationalList, k: ks.baseRrfK });
  }
  return out;
}
