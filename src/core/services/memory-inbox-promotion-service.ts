import type { BrainEngine } from '../engine.ts';
import type { MemoryCandidateEntry } from '../types.ts';
import {
  MemoryInboxServiceError,
  normalizeMemoryInboxReviewedAt,
  preflightPromoteMemoryCandidate,
  recordMemoryCandidateStatusEvent,
} from './memory-inbox-service.ts';
import {
  duplicateMemoryReviewFreshnessMarkersEqual,
  getDuplicateMemoryReviewFreshnessMarker,
} from './duplicate-memory-review-service.ts';

export interface PromoteMemoryCandidateEntryInput {
  id: string;
  reviewed_at?: Date | string | null;
  review_reason?: string | null;
  interaction_id?: string | null;
}

export async function promoteMemoryCandidateEntry(
  engine: BrainEngine,
  input: PromoteMemoryCandidateEntryInput,
): Promise<MemoryCandidateEntry> {
  const reviewedAt = normalizeMemoryInboxReviewedAt(input.reviewed_at, new Date());
  const currentEntry = await engine.getMemoryCandidateEntry(input.id);
  if (!currentEntry) {
    throw new MemoryInboxServiceError(
      'memory_candidate_not_found',
      `Memory candidate not found: ${input.id}`,
    );
  }
  if (currentEntry.status !== 'staged_for_review') {
    throw new MemoryInboxServiceError(
      'invalid_status_transition',
      `Cannot promote memory candidate from ${currentEntry.status}; only staged_for_review candidates may be promoted.`,
    );
  }

  const freshnessBefore = await getDuplicateMemoryReviewFreshnessMarker(engine, {
    scope_id: currentEntry.scope_id,
  });
  const preflight = await preflightPromoteMemoryCandidate(engine, { id: input.id });
  if (preflight.decision !== 'allow') {
    throw new MemoryInboxServiceError(
      'promotion_preflight_failed',
      `Cannot promote memory candidate ${input.id}: ${preflight.reasons.join(', ')}.`,
    );
  }
  const freshnessAfter = await getDuplicateMemoryReviewFreshnessMarker(engine, {
    scope_id: currentEntry.scope_id,
  });
  if (!duplicateMemoryReviewFreshnessMarkersEqual(freshnessBefore, freshnessAfter)) {
    throw staleDuplicateReviewInputsError(input.id);
  }

  return engine.transaction(async (txBase) => {
    const tx = txBase as BrainEngine;
    const entry = await tx.getMemoryCandidateEntry(input.id);
    if (!entry) {
      throw new MemoryInboxServiceError(
        'memory_candidate_not_found',
        `Memory candidate not found: ${input.id}`,
      );
    }

    if (entry.status !== 'staged_for_review') {
      throw new MemoryInboxServiceError(
        'invalid_status_transition',
        `Cannot promote memory candidate from ${entry.status}; only staged_for_review candidates may be promoted.`,
      );
    }

    const freshnessAtWrite = await getDuplicateMemoryReviewFreshnessMarker(tx, {
      scope_id: entry.scope_id,
    });
    if (!duplicateMemoryReviewFreshnessMarkersEqual(freshnessAfter, freshnessAtWrite)) {
      throw staleDuplicateReviewInputsError(input.id);
    }

    const promoted = await tx.promoteMemoryCandidateEntry(entry.id, {
      expected_current_status: 'staged_for_review',
      reviewed_at: reviewedAt,
      review_reason: input.review_reason ?? null,
    });
    if (!promoted) {
      throw new MemoryInboxServiceError(
        'invalid_status_transition',
        `Cannot promote memory candidate ${input.id}; current state changed before promotion completed.`,
      );
    }
    await recordMemoryCandidateStatusEvent(tx, {
      candidate: promoted,
      from_status: entry.status,
      event_kind: 'promoted',
      interaction_id: input.interaction_id ?? null,
    });
    return promoted;
  });
}

function staleDuplicateReviewInputsError(candidateId: string): MemoryInboxServiceError {
  return new MemoryInboxServiceError(
    'promotion_preflight_failed',
    `Cannot promote memory candidate ${candidateId}: duplicate review inputs changed; retry promotion.`,
  );
}
