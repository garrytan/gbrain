import type { BrainEngine } from '../engine.ts';
import type { MemoryCandidateEntry, MemoryCandidateStatus } from '../types.ts';

const ALLOWED_TRANSITIONS: Record<MemoryCandidateStatus, MemoryCandidateStatus | null> = {
  captured: 'candidate',
  candidate: 'staged_for_review',
  staged_for_review: null,
};

export class MemoryInboxServiceError extends Error {
  constructor(
    public code: 'memory_candidate_not_found' | 'invalid_status_transition',
    message: string,
  ) {
    super(message);
    this.name = 'MemoryInboxServiceError';
  }
}

export interface AdvanceMemoryCandidateStatusInput {
  id: string;
  next_status: MemoryCandidateStatus;
  reviewed_at?: Date | string | null;
  review_reason?: string | null;
}

export async function advanceMemoryCandidateStatus(
  engine: BrainEngine,
  input: AdvanceMemoryCandidateStatusInput,
): Promise<MemoryCandidateEntry> {
  const entry = await engine.getMemoryCandidateEntry(input.id);
  if (!entry) {
    throw new MemoryInboxServiceError(
      'memory_candidate_not_found',
      `Memory candidate not found: ${input.id}`,
    );
  }

  const allowedNext = ALLOWED_TRANSITIONS[entry.status];
  if (allowedNext !== input.next_status) {
    throw new MemoryInboxServiceError(
      'invalid_status_transition',
      `Cannot advance memory candidate from ${entry.status} to ${input.next_status}.`,
    );
  }

  return engine.updateMemoryCandidateEntryStatus(entry.id, {
    status: input.next_status,
    reviewed_at: input.reviewed_at !== undefined
      ? input.reviewed_at
      : (input.next_status === 'staged_for_review' ? new Date() : null),
    review_reason: input.review_reason ?? null,
  });
}
