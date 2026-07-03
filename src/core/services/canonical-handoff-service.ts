import type { BrainEngine } from '../engine.ts';
import type {
  CanonicalHandoffEntry,
  CanonicalHandoffCompletionKind,
  CanonicalHandoffTargetObjectType,
  MemoryCandidateEntry,
} from '../types.ts';
import { MemoryInboxServiceError } from './memory-inbox-service.ts';

const ISO_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export interface RecordCanonicalHandoffInput {
  candidate_id: string;
  reviewed_at?: Date | string | null;
  review_reason?: string | null;
  interaction_id?: string | null;
}

export interface RecordCanonicalHandoffResult {
  candidate: MemoryCandidateEntry;
  handoff: CanonicalHandoffEntry;
}

export interface CompleteCanonicalHandoffInput {
  id: string;
  completed_at?: Date | string | null;
  completion_kind: CanonicalHandoffCompletionKind;
  completion_ref?: string | null;
}

export async function recordCanonicalHandoff(
  engine: BrainEngine,
  input: RecordCanonicalHandoffInput,
): Promise<RecordCanonicalHandoffResult> {
  const candidate = await engine.getMemoryCandidateEntry(input.candidate_id);
  if (!candidate) {
    throw new MemoryInboxServiceError(
      'memory_candidate_not_found',
      `Memory candidate not found: ${input.candidate_id}`,
    );
  }

  if (candidate.status !== 'promoted') {
    throw new MemoryInboxServiceError(
      'invalid_status_transition',
      `Cannot record canonical handoff from ${candidate.status}; only promoted candidates may be handed off.`,
    );
  }

  const targetObjectType = getCanonicalHandoffTargetObjectType(candidate);
  if (!targetObjectType || !candidate.target_object_id || candidate.target_object_id.trim().length === 0) {
    throw new MemoryInboxServiceError(
      'invalid_status_transition',
      `Cannot record canonical handoff for ${candidate.id}; candidate is missing an eligible canonical target.`,
    );
  }

  const reviewedAt = normalizeReviewedAt(input.reviewed_at);
  const handoff = await engine.createCanonicalHandoffEntry({
    id: crypto.randomUUID(),
    scope_id: candidate.scope_id,
    candidate_id: candidate.id,
    target_object_type: targetObjectType,
    target_object_id: candidate.target_object_id,
    source_refs: [...candidate.source_refs],
    reviewed_at: reviewedAt,
    review_reason: input.review_reason ?? null,
    interaction_id: input.interaction_id ?? null,
  });
  if (!handoff) {
    throw new MemoryInboxServiceError(
      'invalid_status_transition',
      `Cannot record canonical handoff for ${candidate.id}; current state changed or the handoff already exists.`,
    );
  }

  return { candidate, handoff };
}

export async function completeCanonicalHandoff(
  engine: BrainEngine,
  input: CompleteCanonicalHandoffInput,
): Promise<CanonicalHandoffEntry> {
  if (!isCanonicalHandoffCompletionKind(input.completion_kind)) {
    throw new MemoryInboxServiceError(
      'invalid_status_transition',
      `Unsupported canonical handoff completion kind: ${input.completion_kind}`,
    );
  }
  const completedAt = input.completed_at == null
    ? new Date()
    : normalizeReviewedAt(input.completed_at);
  const handoff = await engine.completeCanonicalHandoffEntry({
    id: input.id,
    completed_at: completedAt,
    completion_kind: input.completion_kind,
    completion_ref: input.completion_ref ?? null,
  });
  if (!handoff) {
    throw new MemoryInboxServiceError(
      'memory_candidate_not_found',
      `Canonical handoff not found: ${input.id}`,
    );
  }
  return handoff;
}

function getCanonicalHandoffTargetObjectType(
  candidate: MemoryCandidateEntry,
): CanonicalHandoffTargetObjectType | null {
  switch (candidate.target_object_type) {
    case 'curated_note':
    case 'procedure':
    case 'profile_memory':
    case 'personal_episode':
      return candidate.target_object_type;
    case 'other':
    case null:
      return null;
  }
}

function isCanonicalHandoffCompletionKind(value: string): value is CanonicalHandoffCompletionKind {
  return value === 'patch_applied' || value === 'page_written' || value === 'manual';
}

function normalizeReviewedAt(value: Date | string | null | undefined): Date | string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new MemoryInboxServiceError(
        'invalid_status_transition',
        'reviewed_at must be a valid Date when provided.',
      );
    }
    return value;
  }
  if (!isValidIsoDatetime(value)) {
    throw new MemoryInboxServiceError(
      'invalid_status_transition',
      'reviewed_at must be a valid ISO datetime string when provided.',
    );
  }
  return value;
}

function isValidIsoDatetime(value: string): boolean {
  const match = ISO_DATETIME_PATTERN.exec(value);
  if (!match) {
    return false;
  }

  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, _millisRaw, offsetSign, offsetHourRaw, offsetMinuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);

  if (month < 1 || month > 12) {
    return false;
  }
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > maxDay) {
    return false;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  if (offsetSign) {
    const offsetHour = Number(offsetHourRaw);
    const offsetMinute = Number(offsetMinuteRaw);
    if (offsetHour > 23 || offsetMinute > 59) {
      return false;
    }
  }
  return true;
}
