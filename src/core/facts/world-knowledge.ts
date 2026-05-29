/**
 * v0.42.0.0 — world_knowledge: a first-class TakeKind for the Confer fork.
 *
 * A `take` graduates to `world_knowledge` when it has been escalated (via the
 * upstream `links` primitive with link_type `escalated_from`, declared in the
 * confer-everything-v1 pack — NOT a column) AND its computed `world_consensus`
 * has crossed the consensus bar. This is the FIRST-CLASS realization of what
 * the pack previously represented implicitly as a `take_proposals` row with
 * kind='take' + an escalated_from link + world_consensus ≥ 0.8.
 *
 * Design (mirrors src/core/facts/classify.ts — pure logic, no engine writes;
 * the orchestrator / nightly consensus-refresh minion does the persistence):
 *
 *   - `world_consensus` is the nightly-cached value of the `confer_world_consensus`
 *     VIEW (migrate.ts v109 / src/migrations/0003). The view + the
 *     take_proposals.world_consensus column already ship; the minion job that
 *     refreshes the column and re-kinds graduated rows is a separate supervised
 *     change and is intentionally out of scope here.
 *   - We REUSE existing primitives: the `escalated_from` link + the
 *     world_consensus computation. No parallel table, no new column, no
 *     schema migration (take_proposals.kind / takes.kind are TEXT with no
 *     CHECK since v0.38 / migration v87 — kind values are runtime-validated
 *     against the active schema pack's `takes_kinds:` declaration).
 *
 * world_knowledge is a DERIVED / graduation kind: the LLM extraction path
 * (propose-takes.ts, extract-takes-from-pages.ts) never PROPOSES it directly —
 * a model cannot fabricate consensus. It is reached only by promotion of an
 * already-escalated take. The fence parser, CLI, and schema-pack seed lists DO
 * accept it as first-class so a promoted row round-trips through persistence.
 */

import type { TakeKind } from '../engine.ts';

/** The first-class kind value. */
export const WORLD_KNOWLEDGE_KIND = 'world_knowledge';

/**
 * Consensus bar a take must clear to graduate to world_knowledge. The
 * confer-everything-v1 pack states `world_consensus ≥ 0.8`; this is that
 * stated value as a named constant (inclusive bound — see isAtOrAboveConsensus).
 */
export const WORLD_KNOWLEDGE_CONSENSUS_THRESHOLD = 0.8;

/** The single kind that is eligible to graduate. See classifyWorldKnowledge. */
export const PROMOTABLE_SOURCE_KIND = 'take';

/** Inputs to the promotion decision. */
export interface WorldKnowledgeInput {
  /** The take's current kind (pre-promotion). */
  kind: TakeKind;
  /**
   * Whether the take carries an `escalated_from` lineage link (declared in the
   * pack as a link_type over the upstream links primitive). True iff ≥1 such
   * link exists. The caller resolves this from the links table / fence.
   */
  hasEscalatedFromLineage: boolean;
  /**
   * Nightly-cached value of the confer_world_consensus VIEW for this claim,
   * in [0,1]. Null when no consensus has been computed yet (treated as 0).
   */
  worldConsensus: number | null;
}

/** True when `value` clears the consensus bar (0.8 inclusive). */
export function isAtOrAboveConsensus(value: number | null): boolean {
  return (value ?? 0) >= WORLD_KNOWLEDGE_CONSENSUS_THRESHOLD;
}

/**
 * Decide the effective kind for a take, promoting it to `world_knowledge` when
 * it has graduated. Returns the input kind UNCHANGED when promotion does not
 * apply — this function only ever upgrades a `take` to `world_knowledge`; it
 * never demotes and never touches fact/bet/hunch.
 *
 * Promotion fires iff ALL hold:
 *   1. current kind === 'take' (only takes graduate — a `fact` is already
 *      verifiable; `bet`/`hunch` are not consensus-shaped claims).
 *      // TODO: confirm — the pack says kind='take' + escalated_from +
 *      // consensus≥0.8; confirm we should NOT also promote bet/hunch.
 *   2. it has an `escalated_from` lineage link.
 *      // TODO: confirm — a single escalated_from link suffices; confirm
 *      // whether the pack wants a minimum lineage depth/count.
 *   3. world_consensus ≥ WORLD_KNOWLEDGE_CONSENSUS_THRESHOLD (0.8).
 */
export function classifyWorldKnowledge(input: WorldKnowledgeInput): TakeKind {
  const promotes =
    input.kind === PROMOTABLE_SOURCE_KIND &&
    input.hasEscalatedFromLineage &&
    isAtOrAboveConsensus(input.worldConsensus);
  return promotes ? WORLD_KNOWLEDGE_KIND : input.kind;
}

/** Convenience predicate: does this row qualify as world_knowledge right now? */
export function isWorldKnowledge(input: WorldKnowledgeInput): boolean {
  return classifyWorldKnowledge(input) === WORLD_KNOWLEDGE_KIND;
}
