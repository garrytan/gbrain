import type { BrainEngine } from '../engine.ts';
import type { CanonicalHandoffEntry, MemoryCandidateEntry } from '../types.ts';
import { MemoryInboxServiceError } from './memory-inbox-service.ts';

type HistoricalValidityDecision = 'allow' | 'defer' | 'deny';
type HistoricalValidityFallback = 'none' | 'supersede' | 'unresolved_conflict';
type HistoricalValidityReason =
  | 'candidate_not_promoted'
  | 'candidate_missing_handoff'
  | 'candidate_superseded'
  | 'newer_promoted_candidate_exists'
  | 'competing_candidate_under_review'
  | 'candidate_review_window_expired'
  | 'candidate_currently_valid';

export interface AssessHistoricalValidityInput {
  candidate_id: string;
  now?: Date;
}

export interface HistoricalValidityAssessment {
  candidate_id: string;
  handoff_id: string | null;
  decision: HistoricalValidityDecision;
  stale_claim: boolean;
  recommended_fallback: HistoricalValidityFallback;
  reasons: HistoricalValidityReason[];
  summary_lines: string[];
}

const DEFAULT_REVIEW_WINDOW_DAYS = 30;
const PROCEDURE_REVIEW_WINDOW_DAYS = 7;
const PEER_BATCH_SIZE = 100;

export async function assessHistoricalValidity(
  engine: BrainEngine,
  input: AssessHistoricalValidityInput,
): Promise<HistoricalValidityAssessment> {
  if (input.now && Number.isNaN(input.now.getTime())) {
    throw new MemoryInboxServiceError(
      'invalid_status_transition',
      'now must be a valid Date when provided.',
    );
  }
  const candidate = await engine.getMemoryCandidateEntry(input.candidate_id);
  if (!candidate) {
    throw new MemoryInboxServiceError(
      'memory_candidate_not_found',
      `Memory candidate not found: ${input.candidate_id}`,
    );
  }

  if (candidate.status === 'superseded') {
    return buildAssessment(candidate.id, null, 'deny', true, 'supersede', ['candidate_superseded']);
  }

  if (candidate.status !== 'promoted') {
    return buildAssessment(candidate.id, null, 'deny', false, 'none', ['candidate_not_promoted']);
  }

  const handoff = await getCanonicalHandoffForCandidate(engine, candidate.id);
  if (!handoff) {
    return buildAssessment(candidate.id, null, 'deny', false, 'none', ['candidate_missing_handoff']);
  }

  const peers = await listAllTargetPeers(engine, candidate).then((entries) =>
    entries.filter((entry) => entry.id !== candidate.id),
  );
  const candidateEvidenceAt = getCandidateEvidenceTimestamp(candidate, handoff);
  const newerPromotedPeerExists = peers.some((peer) =>
    peer.status === 'promoted' && getPeerEvidenceTimestamp(peer) > candidateEvidenceAt.getTime()
  );
  if (newerPromotedPeerExists) {
    return buildAssessment(candidate.id, handoff.id, 'deny', true, 'supersede', ['newer_promoted_candidate_exists']);
  }

  const competingPeerUnderReview = peers.some((peer) => peer.status === 'staged_for_review');
  if (competingPeerUnderReview) {
    return buildAssessment(candidate.id, handoff.id, 'defer', false, 'unresolved_conflict', ['competing_candidate_under_review']);
  }

  const now = input.now ?? new Date();
  const reviewWindowDays = candidate.target_object_type === 'procedure'
    ? PROCEDURE_REVIEW_WINDOW_DAYS
    : DEFAULT_REVIEW_WINDOW_DAYS;
  const reviewAgeMs = now.getTime() - candidateEvidenceAt.getTime();
  if (reviewAgeMs > reviewWindowDays * 24 * 60 * 60 * 1000) {
    return buildAssessment(candidate.id, handoff.id, 'defer', true, 'none', ['candidate_review_window_expired']);
  }

  return buildAssessment(candidate.id, handoff.id, 'allow', false, 'none', ['candidate_currently_valid']);
}

async function getCanonicalHandoffForCandidate(
  engine: BrainEngine,
  candidateId: string,
): Promise<CanonicalHandoffEntry | null> {
  const handoffs = await engine.listCanonicalHandoffEntries({
    candidate_id: candidateId,
    limit: 2,
    offset: 0,
  });
  return handoffs[0] ?? null;
}

async function listAllTargetPeers(
  engine: BrainEngine,
  candidate: MemoryCandidateEntry,
): Promise<MemoryCandidateEntry[]> {
  if (!candidate.target_object_type || !candidate.target_object_id) {
    return [];
  }

  const peers: MemoryCandidateEntry[] = [];
  for (let offset = 0; ; offset += PEER_BATCH_SIZE) {
    const batch = await engine.listMemoryCandidateEntries({
      scope_id: candidate.scope_id,
      target_object_type: candidate.target_object_type,
      target_object_id: candidate.target_object_id,
      limit: PEER_BATCH_SIZE,
      offset,
    });
    peers.push(...batch);
    if (batch.length < PEER_BATCH_SIZE) {
      break;
    }
  }
  return peers;
}

function getCandidateEvidenceTimestamp(
  candidate: MemoryCandidateEntry,
  handoff: CanonicalHandoffEntry,
): Date {
  return handoff.reviewed_at
    ?? candidate.reviewed_at
    ?? handoff.created_at
    ?? candidate.updated_at;
}

function getPeerEvidenceTimestamp(peer: MemoryCandidateEntry): number {
  return (peer.reviewed_at ?? peer.updated_at).getTime();
}

function buildAssessment(
  candidateId: string,
  handoffId: string | null,
  decision: HistoricalValidityDecision,
  staleClaim: boolean,
  recommendedFallback: HistoricalValidityFallback,
  reasons: HistoricalValidityReason[],
): HistoricalValidityAssessment {
  return {
    candidate_id: candidateId,
    handoff_id: handoffId,
    decision,
    stale_claim: staleClaim,
    recommended_fallback: recommendedFallback,
    reasons,
    summary_lines: [
      `Historical validity decision: ${decision}.`,
      `Stale claim: ${staleClaim ? 'yes' : 'no'}.`,
      `Recommended fallback: ${recommendedFallback}.`,
      `Reasons: ${reasons.join(', ')}.`,
    ],
  };
}
