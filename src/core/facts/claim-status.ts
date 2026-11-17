/**
 * How solid a recalled fact is: one label per fact, computed at read time.
 *
 *   stale        expired, superseded, or past its valid_until
 *   contested    a pending owner decision names it (facts/contested-claims.ts)
 *   unsupported  no source is recorded, so nothing backs it
 *   accepted     the owner confirmed it, or it comes from the owner's own notes
 *                (trust tier user_confirmed / operator_curated), confidence not low
 *   provisional  anything else: written by an agent, observed by a tool, or
 *                outside text, not yet confirmed
 *
 * The first rule that matches wins, in that order. Labels never block a read
 * or a write; they tell the reader how far to rely on the fact. Staleness is
 * derived from the dates on each call, never stored. Pure: no I/O.
 */
import type { Contested } from '../eligibility/labels.ts';

export const CLAIM_STATUSES = ['accepted', 'provisional', 'contested', 'unsupported', 'stale'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Confidence below this keeps a confirmed fact provisional. */
export const LOW_CONFIDENCE = 0.5;

export interface AssessableFact {
  trust_tier?: string;
  contested?: Contested;
  valid_until?: string | null;
  expired_at?: string | null;
  superseded_by?: number | string | null;
  source?: string | null;
  confidence?: number | null;
}

export interface ClaimAssessment {
  claim_status: ClaimStatus;
  /** One plain sentence: why the fact has this status. */
  claim_status_reason: string;
}

const day = (iso: string) => iso.slice(0, 10);

const PROVISIONAL_REASON: Record<string, string> = {
  agent_written: 'written by an agent and not confirmed',
  tool_observed: 'observed by a tool and not confirmed',
  external_untrusted: 'taken from outside text and not confirmed',
  unknown: 'its origin is unknown',
};

export function assessClaim(f: AssessableFact, now: Date = new Date()): ClaimAssessment {
  if (f.expired_at) return { claim_status: 'stale', claim_status_reason: `expired on ${day(f.expired_at)}` };
  if (f.superseded_by !== null && f.superseded_by !== undefined) {
    return { claim_status: 'stale', claim_status_reason: `superseded by fact ${f.superseded_by}` };
  }
  if (f.valid_until && Date.parse(f.valid_until) < now.getTime()) {
    return { claim_status: 'stale', claim_status_reason: `held until ${day(f.valid_until)}, which has passed` };
  }
  if (f.contested) {
    return { claim_status: 'contested',
      claim_status_reason: `${f.contested.role === 'challenger' ? 'it disputes another fact' : 'another fact disputes it'}; the owner has not decided yet (${f.contested.proposal_ref})` };
  }
  if (!f.source || !f.source.trim()) return { claim_status: 'unsupported', claim_status_reason: 'no source is recorded for it' };
  const lowConfidence = typeof f.confidence === 'number' && f.confidence < LOW_CONFIDENCE;
  if ((f.trust_tier === 'user_confirmed' || f.trust_tier === 'operator_curated') && !lowConfidence) {
    return { claim_status: 'accepted',
      claim_status_reason: f.trust_tier === 'user_confirmed' ? 'the owner confirmed it' : "it comes from the owner's own notes" };
  }
  if (lowConfidence) return { claim_status: 'provisional', claim_status_reason: `its confidence is below ${LOW_CONFIDENCE}` };
  return { claim_status: 'provisional', claim_status_reason: PROVISIONAL_REASON[f.trust_tier ?? 'unknown'] ?? 'it is not confirmed' };
}

/** Each fact with its claim_status and claim_status_reason added (additive fields). */
export function withClaimStatus<T extends AssessableFact>(facts: T[], now: Date = new Date()): Array<T & ClaimAssessment> {
  return facts.map(f => ({ ...f, ...assessClaim(f, now) }));
}
