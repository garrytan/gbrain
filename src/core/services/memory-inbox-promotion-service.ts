import type { BrainEngine } from '../engine.ts';
import type { MemoryCandidateEntry } from '../types.ts';
import {
  MemoryInboxServiceError,
  normalizeMemoryInboxReviewedAt,
  preflightPromoteMemoryCandidate,
  recordMemoryCandidateStatusEvent,
} from './memory-inbox-service.ts';
import {
  type DuplicateMemoryReviewFreshness,
  duplicateMemoryReviewFreshnessEquals,
  getDuplicateMemoryReviewFreshness,
} from './duplicate-memory-review-service.ts';

export interface PromoteMemoryCandidateEntryInput {
  id: string;
  reviewed_at?: Date | string | null;
  review_reason?: string | null;
  interaction_id?: string | null;
  retry_on_stale?: boolean;
}

export async function promoteMemoryCandidateEntry(
  engine: BrainEngine,
  input: PromoteMemoryCandidateEntryInput,
): Promise<MemoryCandidateEntry> {
  const reviewedAt = normalizeMemoryInboxReviewedAt(input.reviewed_at, new Date());
  const maxAttempts = input.retry_on_stale === true ? 2 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await promoteMemoryCandidateEntryOnce(engine, input, reviewedAt);
    } catch (error) {
      if (attempt < maxAttempts && isStaleDuplicateReviewInputsError(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('unreachable promotion retry state');
}

async function promoteMemoryCandidateEntryOnce(
  engine: BrainEngine,
  input: PromoteMemoryCandidateEntryInput,
  reviewedAt: Date | string | null,
): Promise<MemoryCandidateEntry> {
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

  const freshnessBefore = await getDuplicateMemoryReviewFreshness(engine, {
    scope_id: currentEntry.scope_id,
  });
  const preflight = await preflightPromoteMemoryCandidate(engine, { id: input.id });
  if (preflight.decision !== 'allow') {
    throw new MemoryInboxServiceError(
      'promotion_preflight_failed',
      `Cannot promote memory candidate ${input.id}: ${preflight.reasons.join(', ')}.`,
    );
  }
  const freshnessAfter = await getDuplicateMemoryReviewFreshness(engine, {
    scope_id: currentEntry.scope_id,
  });
  if (!duplicateMemoryReviewFreshnessEquals(freshnessBefore, freshnessAfter)) {
    throw staleDuplicateReviewInputsError(input.id, freshnessBefore, freshnessAfter);
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

    const freshnessAtWrite = await getDuplicateMemoryReviewFreshness(tx, {
      scope_id: entry.scope_id,
    });
    if (!duplicateMemoryReviewFreshnessEquals(freshnessAfter, freshnessAtWrite)) {
      throw staleDuplicateReviewInputsError(input.id, freshnessAfter, freshnessAtWrite);
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

function staleDuplicateReviewInputsError(
  candidateId: string,
  before: DuplicateMemoryReviewFreshness,
  after: DuplicateMemoryReviewFreshness,
): MemoryInboxServiceError {
  const changes = describeDuplicateReviewFreshnessChanges(before, after);
  const changeSummary = changes.length > 0 ? changes.join('; ') : 'freshness marker order changed';
  const error = new MemoryInboxServiceError(
    'promotion_preflight_failed',
    `Cannot promote memory candidate ${candidateId}: duplicate review inputs changed; retry promotion. Changed inputs: ${changeSummary}.`,
  ) as MemoryInboxServiceError & { stale_duplicate_review_inputs?: true };
  error.stale_duplicate_review_inputs = true;
  return error;
}

function isStaleDuplicateReviewInputsError(error: unknown): boolean {
  return error instanceof MemoryInboxServiceError
    && error.code === 'promotion_preflight_failed'
    && (error as MemoryInboxServiceError & { stale_duplicate_review_inputs?: true }).stale_duplicate_review_inputs === true;
}

function describeDuplicateReviewFreshnessChanges(
  before: DuplicateMemoryReviewFreshness,
  after: DuplicateMemoryReviewFreshness,
): string[] {
  return [
    ...describeMarkerChanges('pages', before.pages, after.pages),
    ...describeMarkerChanges('memory candidates', before.memory_candidates, after.memory_candidates),
  ];
}

function describeMarkerChanges(
  label: string,
  before: Array<{ id: string; updated_at: string }>,
  after: Array<{ id: string; updated_at: string }>,
): string[] {
  const beforeById = new Map(before.map((marker) => [marker.id, marker]));
  const afterById = new Map(after.map((marker) => [marker.id, marker]));
  const added = after.filter((marker) => !beforeById.has(marker.id)).map((marker) => marker.id);
  const removed = before.filter((marker) => !afterById.has(marker.id)).map((marker) => marker.id);
  const updated = after
    .filter((marker) => beforeById.has(marker.id) && beforeById.get(marker.id)?.updated_at !== marker.updated_at)
    .map((marker) => marker.id);
  const lines: string[] = [];
  if (added.length > 0) lines.push(`${label} added: ${added.join(', ')}`);
  if (removed.length > 0) lines.push(`${label} removed: ${removed.join(', ')}`);
  if (updated.length > 0) lines.push(`${label} updated: ${updated.join(', ')}`);
  return lines;
}
