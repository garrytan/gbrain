/**
 * distiller/decide.ts — the decider (collapses Q1 + Q2 + Q3 of the flowchart).
 *
 * Given a candidate topic and the existing skills IN THE SAME CARE LANE, return
 * one of { none | exact_match | update | split }. This is the seat the Task 1
 * plan reserves for an LLM classifier; v0 (this file) is a deterministic
 * placeholder using token overlap so the pipeline runs end-to-end without an
 * LLM or the DB.
 *
 * v0 covers none / exact_match / update. `split` (Q3 — "enough nuance to split
 * one skill into two?") is a genuinely LLM-shaped judgement and is produced only
 * by the injected classifier seam in run.ts, not by this deterministic pass —
 * the types + pipeline support it so the real classifier can return it.
 *
 * TODO(decider): replace this body with an LLM call that classifies `topic`
 *   against `sameLane` skill descriptions/triggers, returning the same
 *   DistillDecisionResult shape (including `split`). Keep the signature so
 *   run.ts / tests don't change. Use check-resolvable MECE for the deterministic
 *   exact-trigger-collision case as a pre-filter.
 */

import type { CandidateTopic, DistillDecisionResult, ExistingSkill } from './types.ts';

/** Score at/above which a matched skill is considered to already cover a topic. */
export const EXACT_MATCH_THRESHOLD = 0.5;
/** Score at/above which a skill is close enough that the topic updates it. */
export const UPDATE_THRESHOLD = 0.2;
/** Fraction of NEW topic tokens below which "no new info" ⇒ exact_match. */
export const NEW_INFO_MAX_FOR_EXACT = 0.2;

/** Lowercase word tokens (len>2), deduped. Crude on purpose — placeholder. */
export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
}

/** Jaccard-ish overlap: shared tokens / skill tokens (recall of the skill). */
function overlap(topicTokens: Set<string>, skillTokens: Set<string>): number {
  if (skillTokens.size === 0) return 0;
  let hits = 0;
  for (const t of skillTokens) if (topicTokens.has(t)) hits++;
  return hits / skillTokens.size;
}

/** Fraction of the topic's tokens NOT present in the skill (new information). */
function newInfoRatio(topicTokens: Set<string>, skillTokens: Set<string>): number {
  if (topicTokens.size === 0) return 0;
  let novel = 0;
  for (const t of topicTokens) if (!skillTokens.has(t)) novel++;
  return novel / topicTokens.size;
}

/**
 * v0 deterministic decider. `sameLane` MUST already be filtered to the topic's
 * role (run.ts does this) — this function does not re-check the lane.
 */
export function decideDistillation(
  topic: CandidateTopic,
  sameLane: ExistingSkill[],
): DistillDecisionResult {
  const topicTokens = tokens([topic.title, topic.summary, ...(topic.triggers ?? [])].join(' '));

  // Empty library (or empty lane) → nothing to match → create.
  if (sameLane.length === 0) {
    return {
      decision: 'none',
      reason: 'no existing skill in this care lane — a new skill should be created',
      confidence: 1,
    };
  }

  // Find the best-overlapping existing skill.
  let best: { skill: ExistingSkill; score: number } | null = null;
  for (const skill of sameLane) {
    const skillTokens = tokens([skill.description, ...skill.triggers].join(' '));
    const score = overlap(topicTokens, skillTokens);
    if (!best || score > best.score) best = { skill, score };
  }

  // No meaningful overlap with anything → create.
  if (!best || best.score < UPDATE_THRESHOLD) {
    return {
      decision: 'none',
      reason: `no existing lane skill overlaps this topic (best ${Math.round(
        (best?.score ?? 0) * 100,
      )}%) — create a new skill`,
      confidence: best ? 1 - best.score : 1,
    };
  }

  // A close skill exists. Does the topic add new information?
  const bestTokens = tokens([best.skill.description, ...best.skill.triggers].join(' '));
  const novel = newInfoRatio(topicTokens, bestTokens);

  if (best.score >= EXACT_MATCH_THRESHOLD && novel <= NEW_INFO_MAX_FOR_EXACT) {
    return {
      decision: 'exact_match',
      matchedSkill: best.skill.name,
      reason: `'${best.skill.name}' already covers this topic (${Math.round(
        best.score * 100,
      )}% overlap, ${Math.round(novel * 100)}% new) — no change`,
      confidence: best.score,
    };
  }

  return {
    decision: 'update',
    matchedSkill: best.skill.name,
    reason: `'${best.skill.name}' is the closest skill (${Math.round(
      best.score * 100,
    )}% overlap) and this topic adds ${Math.round(novel * 100)}% new content — update it`,
    confidence: best.score,
  };
}
