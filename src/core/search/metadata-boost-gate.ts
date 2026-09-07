/**
 * metadata-boost-gate.ts — `search.metadata_boost_gate`: skip the post-fusion
 * METADATA boosts when the vector arm was the only voter.
 *
 * WHY. Cat 13 conceptual recall (a user paraphrases an IDEA; the gold concept
 * page shares no tokens with the query). E1 localization receipt
 * (`~/gbrain-lme-receipts/cat13/E1-localize`, tuning split, offline
 * re-simulation validated 359/359 vs the live order): gbrain's own vector arm
 * ranks the gold page at nDCG@5 60.3 while the live hybrid scores 50.6 — the
 * whole gap is created AFTER the vector arm. Of 105 gap probes, 78 were
 * post-fusion metadata-boost reorders: hub pages (companies/*, people/*,
 * meetings) carrying backlink (100 intruders), graph-adjacency (50) and
 * recency (10) boosts of 1.035–1.124x — larger than the ~2% spacing between
 * adjacent vector ranks — while the gold concept page carried a backlink boost
 * in 0/96. In 73/105 gaps BOTH lexical arms (strict keyword, title) were
 * empty: the vector arm was the only voter and the boosts re-ordered a pure
 * vector ranking. Ablation: skipping the metadata boosts exactly when the
 * vector arm is the only voter fixes 73/105 gaps with 0 collateral (tuning
 * nDCG@5 50.6 → 57.3).
 *
 * WHAT (the ONE pre-registered mechanism). `search.metadata_boost_gate`:
 *   - `always`  — the pre-wave behavior: every post-fusion stage runs (the
 *                 bundles flipped to `lexical` on the Phase E3 receipt).
 *   - `lexical` — the metadata-axis stages (backlink, salience, recency + the
 *                 chronicle type boost inside it, graph signals, alias-resolved)
 *                 run ONLY when a lexical arm voted in fusion: a strict keyword
 *                 row, a title-arm row or a relational row reached
 *                 `composeFusionLists` (after the relaxed-row demotion). When
 *                 only vector / variant / clause arms voted, those stages are
 *                 skipped and the vector order stands.
 *   Image modality is exempt from `lexical`: hybrid.ts never runs the keyword
 *   / title arms for an image query and excludes the relational arm from
 *   fusion by construction, so "the lexical arms had a chance and did not
 *   vote" cannot hold there — `lexicalVoted` is false for EVERY image query.
 *   Skipping would silently disable backlink / salience / recency / graph
 *   boosts for the whole modality, not just vector-only-voter queries. So an
 *   image-modality decision applies the boosts (reason `image_modality`) even
 *   under `lexical`; the caller passes `modality` from `effectiveModality`.
 *   Untouched in BOTH settings: the supersede downrank (correctness), the
 *   exact-match boost, the title-phrase boost (E1: 0 effect), the
 *   compiled-truth boost inside RRF, the cosine re-score, dedup, the reranker
 *   and autocut. `mbg=` folds into the knobs hash (v=29 epoch) so a `lexical`
 *   write can never serve an `always` lookup.
 *
 * WHERE. hybrid.ts computes `lexicalVoted` from the very lists it hands to
 * `composeFusionLists` (`lexicalArmsVoted`), takes the decision here
 * (`decideMetadataBoosts`), threads `skipMetadataBoosts` into
 * `runPostFusionStages`, and stamps the decision on
 * `HybridSearchMeta.metadata_boost_gate` — ALWAYS, even under `always`, so an
 * operator can count vector-only-voter queries before flipping the knob. The
 * keyword-only fallback paths (no embedding provider / embed failed) never
 * consult the gate: there the lexical arms ARE the recall.
 *
 * Pure: no engine, no IO, deterministic; unit-tested in
 * test/search/metadata-boost-gate.test.ts (pure) and
 * test/search/metadata-boost-gate-hybrid.test.ts (hermetic PGLite).
 */

import type { SearchResult } from '../types.ts';
import type { ModalityMode } from './query-intent.ts';

export type MetadataBoostGate = 'always' | 'lexical';

export const METADATA_BOOST_GATES: ReadonlyArray<MetadataBoostGate> = Object.freeze(['always', 'lexical']);

/** Hash/fallback identity only — every bundle is `lexical` since the Phase E3 receipt; stays `always` so a knobs literal without the field keeps its pre-wave knobsHash. */
export const DEFAULT_METADATA_BOOST_GATE: MetadataBoostGate = 'always';

/** Why the decision came out the way it did (stamped on meta for --explain). */
export type MetadataBoostGateReason =
  /** gate = always: every stage runs regardless of who voted. */
  | 'gate_always'
  /** gate = lexical and a keyword / title / relational row fused: stages run. */
  | 'lexical_voted'
  /** gate = lexical and only vector-class arms voted: metadata stages skipped. */
  | 'vector_only_voter'
  /** gate = lexical but the query is image-modality: no lexical arm ever ran, so stages run. */
  | 'image_modality';

/** The decision, as stamped on `HybridSearchMeta.metadata_boost_gate`. */
export interface MetadataBoostGateDecision {
  gate: MetadataBoostGate;
  /** Did a strict keyword, title-arm or relational row reach fusion? */
  lexical_voted: boolean;
  /** Did the metadata-axis post-fusion stages run on this query? */
  boosts_applied: boolean;
  reason: MetadataBoostGateReason;
}

/**
 * The ONE parse contract for `metadata_boost_gate`, shared by the config-key
 * parser (mode.ts `loadOverridesFromConfig`) and the per-call seams in
 * hybrid.ts (inner search AND cache resolver) — mirrors
 * `normalizeKeywordArmConfidenceFloor` (arm-confidence.ts):
 *
 *   - the literals `always` / `lexical` (any case, surrounding whitespace
 *     ignored)                                            → that gate
 *   - anything else (`''`, `on`/`off`, booleans, numbers, `null`, objects,
 *     `undefined`)                                        → `undefined` (unset:
 *     fall through to the next resolution tier — config → bundle)
 *
 * Deliberately NO `on`/`off` aliases: "off" is ambiguous here (off = boosts
 * off? off = gate off?) and a misread would silently flip ranking.
 */
export function normalizeMetadataBoostGate(v: unknown): MetadataBoostGate | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  return (METADATA_BOOST_GATES as ReadonlyArray<string>).includes(s) ? (s as MetadataBoostGate) : undefined;
}

export interface LexicalArmsVotedInput {
  /** Keyword list exactly as handed to composeFusionLists (post relaxed-row demotion). */
  keywordFusionList: ReadonlyArray<SearchResult>;
  /** Title list exactly as handed to composeFusionLists (post relaxed-row demotion). */
  titleFusionList: ReadonlyArray<SearchResult>;
  /** Relational arm (relational-recall.ts); fused only when `includeRelational`. */
  relationalList: ReadonlyArray<SearchResult>;
  /** composeFusionLists' own relational inclusion flag (false for image modality). */
  includeRelational: boolean;
}

/**
 * Did any lexical-class arm cast a vote in fusion? Mirrors the inclusion
 * rules of `composeFusionLists` exactly: the keyword list always fuses (even
 * empty — an empty list casts no vote), the title list fuses when non-empty,
 * the relational list fuses when `includeRelational` and non-empty. Relaxed
 * (OR-fallback) rows count only when they actually reached fusion — i.e. the
 * caller already applied the vector-healthy demotion to the lists it passes.
 */
export function lexicalArmsVoted(input: LexicalArmsVotedInput): boolean {
  return (
    input.keywordFusionList.length > 0 ||
    input.titleFusionList.length > 0 ||
    (input.includeRelational && input.relationalList.length > 0)
  );
}

export interface DecideMetadataBoostsInput {
  gate: MetadataBoostGate;
  lexicalVoted: boolean;
  /**
   * The query's effective modality (hybrid.ts `effectiveModality`). `image`
   * exempts the query from `lexical` (see the module header); `text` / `both`
   * / undefined take the normal vote-based decision.
   */
  modality?: ModalityMode;
}

/**
 * The decision. `always` → apply. `lexical` → apply iff a lexical arm voted,
 * except image modality (no lexical arm ran) → apply, reason `image_modality`.
 * `boosts_applied === false` is the ONLY outcome that changes ranking; under
 * `always` every result is byte-identical to the pre-knob pipeline.
 */
export function decideMetadataBoosts(input: DecideMetadataBoostsInput): MetadataBoostGateDecision {
  const { gate, lexicalVoted, modality } = input;
  if (gate === 'always') {
    return { gate, lexical_voted: lexicalVoted, boosts_applied: true, reason: 'gate_always' };
  }
  if (modality === 'image') {
    return { gate, lexical_voted: lexicalVoted, boosts_applied: true, reason: 'image_modality' };
  }
  return lexicalVoted
    ? { gate, lexical_voted: true, boosts_applied: true, reason: 'lexical_voted' }
    : { gate, lexical_voted: false, boosts_applied: false, reason: 'vector_only_voter' };
}
