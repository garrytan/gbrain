/**
 * S9 `conflict` (hot-memory contradiction): the question, the evidence items
 * and the ONE pair reducer shared by the sweep, calibration and evals.
 *
 * Each swept fact is the request state; each eligible neighbour gets one
 * `choice` question (duplicate | supersede | independent). Per pair,
 * independently: `duplicate` chosen at or above threshold -> duplicate
 * (receipt only); else P(supersede) at or above decide.slots.conflict.
 * proposal_floor -> proposal (a pending supersede in `on` mode only; v1 never
 * supersedes automatically); else independent. Pure: no I/O.
 */
import type { ChoiceAnswer, DecideQuestion, EvidenceItem } from './types.ts';
import { thresholdValue } from './types.ts';

export const CONFLICT_OPTIONS: Readonly<Record<'duplicate' | 'supersede' | 'independent', string>> = {
  duplicate: '`fact` and `candidate` state the same claim',
  supersede: '`fact` is a newer or corrected version of the same claim, so `candidate` is no longer true',
  independent: '`fact` and `candidate` can both be true',
};

export const CONFLICT_INSTRUCTIONS = 'How does `fact` relate to `candidate`, an earlier stored fact about the same entity?';

/** Neighbours judged per swept fact, and the cosine floor they must clear. */
export const CONFLICT_NEIGHBOURS = 5;
export const CONFLICT_MIN_COSINE = 0.8;
/** The watermark only advances past facts created at least this long ago (commit-order lag). */
export const CONFLICT_WATERMARK_LAG_MS = 60_000;
export const DEFAULT_PROPOSAL_FLOOR = 0.5;

export type ConflictOutcome = 'duplicate' | 'proposal' | 'independent';

export interface ConflictFact {
  id: number;
  source_id: string;
  fact: string;
  visibility: 'private' | 'world';
}

export function factEvidence(f: ConflictFact): EvidenceItem {
  return { text: f.fact, class: 'facts', fact_id: f.id, source_id: f.source_id, visibility: f.visibility };
}

export function conflictState(f: ConflictFact): Record<string, EvidenceItem> {
  return { fact: factEvidence(f) };
}

export function conflictQuestion(id: string, rank: number, candidate: ConflictFact): DecideQuestion {
  return { id, kind: 'choice', rank, instructions: CONFLICT_INSTRUCTIONS, options: { ...CONFLICT_OPTIONS }, inputs: { candidate: factEvidence(candidate) } };
}

/** P(supersede) for the proposal floor: the reported probability, else the confidence when supersede was chosen. */
export function supersedeProbability(answer: ChoiceAnswer): number {
  return answer.probabilities.supersede ?? (answer.choice === 'supersede' ? answer.confidence : 0);
}

/**
 * The pair reducer. `threshold` is the calibrated (or override) duplicate
 * threshold; without one (shadow diagnostics) the chosen label decides.
 */
export function reduceConflict(answer: ChoiceAnswer, policy: { threshold?: number; proposalFloor: number }): ConflictOutcome {
  if (answer.choice === 'duplicate' && thresholdValue(answer) >= (policy.threshold ?? 0)) return 'duplicate';
  if (supersedeProbability(answer) >= policy.proposalFloor) return 'proposal';
  return 'independent';
}

/** Unordered pair identity (pair dedup across and within sweeps). */
export function pairKey(sourceId: string, a: number, b: number): string {
  return `conflict:${sourceId}:${Math.min(a, b)}:${Math.max(a, b)}`;
}

/** Which way a proposal points: the superseding fact is newer (larger id) or older than the one it would expire. */
export function proposalDirection(supersedingId: number, expiredId: number): 'new_supersedes_old' | 'old_supersedes_new' {
  return supersedingId > expiredId ? 'new_supersedes_old' : 'old_supersedes_new';
}

/**
 * The prefix of `facts` (ascending id, all above the watermark) a sweep may
 * process: it stops at the first fact created less than `lagMs` ago, so a
 * lower id that commits late is never skipped by an advanced watermark.
 */
export function sweepWindow<T extends { id: number; created_at: Date | string }>(facts: readonly T[], nowMs: number, lagMs = CONFLICT_WATERMARK_LAG_MS): T[] {
  const out: T[] = [];
  for (const f of facts) {
    if (nowMs - new Date(f.created_at).getTime() < lagMs) break;
    out.push(f);
  }
  return out;
}

/** Eligibility beyond the SQL prefilter: the guards decideSingleFact applies, re-checked on the returned rows. */
export function eligibleCandidate(
  fact: { id: number; source_id: string; entity_slug: string | null; visibility: string },
  c: { id: number; source_id: string; entity_slug: string | null; visibility: string; expired_at: Date | string | null; valid_until: Date | string | null; source_markdown_slug: string | null; similarity: number },
  nowMs: number,
): boolean {
  return c.id !== fact.id && c.source_id === fact.source_id && c.entity_slug === fact.entity_slug && c.visibility === fact.visibility
    && c.expired_at === null && (c.valid_until === null || new Date(c.valid_until).getTime() > nowMs)
    && (!c.source_markdown_slug || c.source_markdown_slug === fact.entity_slug)
    && c.similarity >= CONFLICT_MIN_COSINE;
}
