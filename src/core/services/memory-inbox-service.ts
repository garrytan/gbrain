import type { BrainEngine } from '../engine.ts';
import type {
  MemoryCandidateEntry,
  MemoryCandidateEntryInput,
  MemoryCandidatePromotionPreflightInput,
  MemoryCandidatePromotionPreflightReason,
  MemoryCandidatePromotionPreflightResult,
  MemoryCandidateStatus,
  MemoryCandidateStatusEventKind,
  MemoryCandidateTargetObjectType,
} from '../types.ts';
import {
  reviewDuplicateMemory,
  summarizeDuplicateReviewForPreflight,
} from './duplicate-memory-review-service.ts';

type AdvanceableMemoryCandidateStatus = 'captured' | 'candidate' | 'staged_for_review';
type MemoryCandidateAdvanceTargetStatus = 'candidate' | 'staged_for_review';

const ALLOWED_TRANSITIONS: Record<
  AdvanceableMemoryCandidateStatus,
  MemoryCandidateAdvanceTargetStatus | null
> = {
  captured: 'candidate',
  candidate: 'staged_for_review',
  staged_for_review: null,
};
const ISO_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export class MemoryInboxServiceError extends Error {
  constructor(
    public code: 'memory_candidate_not_found' | 'invalid_status_transition' | 'promotion_preflight_failed',
    message: string,
  ) {
    super(message);
    this.name = 'MemoryInboxServiceError';
  }
}

export interface AdvanceMemoryCandidateStatusInput {
  id: string;
  next_status: MemoryCandidateAdvanceTargetStatus;
  reviewed_at?: Date | string | null;
  review_reason?: string | null;
  interaction_id?: string | null;
}

export interface RejectMemoryCandidateEntryInput {
  id: string;
  reviewed_at?: Date | string | null;
  review_reason: string;
  interaction_id?: string | null;
}

export async function createMemoryCandidateEntryWithStatusEvent(
  engine: BrainEngine,
  input: MemoryCandidateEntryInput & { interaction_id?: string | null },
): Promise<MemoryCandidateEntry> {
  return engine.transaction(async (txBase) => {
    const tx = txBase as BrainEngine;
    const created = await tx.createMemoryCandidateEntry(input);
    await tx.createMemoryCandidateStatusEvent({
      id: crypto.randomUUID(),
      candidate_id: created.id,
      scope_id: created.scope_id,
      from_status: null,
      to_status: created.status,
      event_kind: 'created',
      interaction_id: input.interaction_id ?? null,
      reviewed_at: created.reviewed_at,
      review_reason: created.review_reason,
      created_at: created.created_at,
    });
    return created;
  });
}

export async function preflightPromoteMemoryCandidate(
  engine: BrainEngine,
  input: MemoryCandidatePromotionPreflightInput,
): Promise<MemoryCandidatePromotionPreflightResult> {
  const entry = await engine.getMemoryCandidateEntry(input.id);
  if (!entry) {
    throw new MemoryInboxServiceError(
      'memory_candidate_not_found',
      `Memory candidate not found: ${input.id}`,
    );
  }

  const denyReasons: MemoryCandidatePromotionPreflightReason[] = [];
  const deferReasons: MemoryCandidatePromotionPreflightReason[] = [];

  if (entry.status !== 'staged_for_review') {
    denyReasons.push('candidate_not_staged_for_review');
  }
  if (!hasUsableProvenance(entry)) {
    denyReasons.push('candidate_missing_provenance');
  }
  if (!hasUsableTargetBinding(entry)) {
    denyReasons.push('candidate_missing_target_object');
  }
  if (hasScopeConflict(entry)) {
    denyReasons.push('candidate_scope_conflict');
  }
  if (entry.sensitivity === 'unknown') {
    deferReasons.push('candidate_unknown_sensitivity');
  }
  if (requiresRevalidation(entry)) {
    deferReasons.push('candidate_requires_revalidation');
  }

  const duplicateReview = summarizeDuplicateReviewForPreflight(await reviewDuplicateMemory(engine, {
    scope_id: entry.scope_id,
    subject_kind: 'memory_candidate',
    subject_id: entry.id,
    content: entry.proposed_content,
    source_refs: entry.source_refs,
    candidate_type: entry.candidate_type,
    target_object_type: entry.target_object_type ?? undefined,
    target_object_id: entry.target_object_id ?? undefined,
    include_pages: true,
    include_candidates: true,
    limit: 5,
  }));
  if (duplicateReview.decision === 'likely_duplicate') {
    deferReasons.push('candidate_possible_duplicate');
  }

  const reasons: MemoryCandidatePromotionPreflightReason[] = denyReasons.length > 0
    ? denyReasons
    : (deferReasons.length > 0 ? deferReasons : ['candidate_ready_for_promotion']);
  const decision = denyReasons.length > 0
    ? 'deny'
    : (deferReasons.length > 0 ? 'defer' : 'allow');

  const reasonSummaryLine = `Reasons: ${reasons.map(formatReasonLabel).join(', ')}.`;
  const individualReasonSummaryLines = reasons.length > 1
    ? reasons.map((reason) => `Reasons: ${formatReasonLabel(reason)}.`)
    : [];

  return {
    candidate_id: entry.id,
    decision,
    reasons,
    duplicate_review: duplicateReview,
    summary_lines: [
      `Promotion preflight decision: ${decision}.`,
      `Candidate ${entry.id} targets ${entry.target_object_type ?? 'none'}/${entry.target_object_id ?? 'none'}.`,
      `Duplicate review decision: ${duplicateReview.decision}.`,
      reasonSummaryLine,
      ...individualReasonSummaryLines,
    ],
  };
}

export async function advanceMemoryCandidateStatus(
  engine: BrainEngine,
  input: AdvanceMemoryCandidateStatusInput,
): Promise<MemoryCandidateEntry> {
  return engine.transaction(async (txBase) => {
    const tx = txBase as BrainEngine;
    const entry = await tx.getMemoryCandidateEntry(input.id);
    if (!entry) {
      throw new MemoryInboxServiceError(
        'memory_candidate_not_found',
        `Memory candidate not found: ${input.id}`,
      );
    }

    const allowedNext = getAllowedAdvanceTargetStatus(entry.status);
    if (allowedNext !== input.next_status) {
      throw new MemoryInboxServiceError(
        'invalid_status_transition',
        `Cannot advance memory candidate from ${entry.status} to ${input.next_status}.`,
      );
    }

    const advanced = await tx.updateMemoryCandidateEntryStatus(entry.id, {
      status: input.next_status,
      reviewed_at: normalizeMemoryInboxReviewedAt(
        input.reviewed_at,
        input.next_status === 'staged_for_review' ? new Date() : null,
      ),
      review_reason: input.review_reason ?? null,
    });
    if (!advanced) {
      throw new MemoryInboxServiceError(
        'invalid_status_transition',
        `Cannot advance memory candidate ${entry.id}; current state changed before advance completed.`,
      );
    }
    await recordMemoryCandidateStatusEvent(tx, {
      candidate: advanced,
      from_status: entry.status,
      event_kind: 'advanced',
      interaction_id: input.interaction_id ?? null,
    });
    return advanced;
  });
}

export async function rejectMemoryCandidateEntry(
  engine: BrainEngine,
  input: RejectMemoryCandidateEntryInput,
): Promise<MemoryCandidateEntry> {
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
        `Cannot reject memory candidate from ${entry.status}; only staged_for_review candidates may be rejected.`,
      );
    }

    const rejected = await tx.updateMemoryCandidateEntryStatus(entry.id, {
      status: 'rejected',
      reviewed_at: normalizeMemoryInboxReviewedAt(input.reviewed_at, new Date()),
      review_reason: input.review_reason,
    });
    if (!rejected) {
      throw new MemoryInboxServiceError(
        'invalid_status_transition',
        `Cannot reject memory candidate ${entry.id}; current state changed before rejection completed.`,
      );
    }
    await recordMemoryCandidateStatusEvent(tx, {
      candidate: rejected,
      from_status: entry.status,
      event_kind: 'rejected',
      interaction_id: input.interaction_id ?? null,
    });
    return rejected;
  });
}

export async function recordMemoryCandidateStatusEvent(
  engine: BrainEngine,
  input: {
    candidate: MemoryCandidateEntry;
    from_status: MemoryCandidateStatus | null;
    event_kind: Exclude<MemoryCandidateStatusEventKind, 'created'>;
    interaction_id?: string | null;
  },
): Promise<void> {
  await engine.createMemoryCandidateStatusEvent({
    id: crypto.randomUUID(),
    candidate_id: input.candidate.id,
    scope_id: input.candidate.scope_id,
    from_status: input.from_status,
    to_status: input.candidate.status,
    event_kind: input.event_kind,
    interaction_id: input.interaction_id ?? null,
    reviewed_at: input.candidate.reviewed_at,
    review_reason: input.candidate.review_reason,
  });
}

export function normalizeMemoryInboxReviewedAt(
  value: Date | string | null | undefined,
  fallback: Date | string | null,
): Date | string | null;
export function normalizeMemoryInboxReviewedAt(
  value: Date | string | null | undefined,
  fallback: undefined,
): Date | string | null | undefined;
export function normalizeMemoryInboxReviewedAt(
  value: Date | string | null | undefined,
  fallback: Date | string | null | undefined,
): Date | string | null | undefined {
  const resolved = value === undefined ? fallback : value;
  if (resolved === undefined || resolved === null) {
    return resolved;
  }
  if (resolved instanceof Date) {
    if (Number.isNaN(resolved.getTime())) {
      throw new MemoryInboxServiceError(
        'invalid_status_transition',
        'reviewed_at must be a valid Date when provided.',
      );
    }
    return resolved;
  }
  if (!isValidIsoDatetime(resolved)) {
    throw new MemoryInboxServiceError(
      'invalid_status_transition',
      'reviewed_at must be a valid ISO datetime string when provided.',
    );
  }
  return resolved;
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

function hasScopeConflict(entry: MemoryCandidateEntry): boolean {
  const targetClass = classifyTargetObjectType(entry.target_object_type);
  if (targetClass === 'work_visible') {
    return entry.sensitivity === 'personal' || entry.sensitivity === 'secret';
  }
  if (targetClass === 'personal_only') {
    return entry.sensitivity === 'work';
  }
  return false;
}

function hasUsableProvenance(entry: MemoryCandidateEntry): boolean {
  return entry.source_refs.some((sourceRef) => sourceRef.trim().length > 0);
}

function hasUsableTargetBinding(entry: MemoryCandidateEntry): boolean {
  return entry.target_object_type != null
    && entry.target_object_id != null
    && entry.target_object_id.trim().length > 0;
}

function requiresRevalidation(entry: MemoryCandidateEntry): boolean {
  return entry.candidate_type === 'procedure'
    || entry.target_object_type === 'other';
}

function classifyTargetObjectType(
  targetObjectType: MemoryCandidateTargetObjectType | null,
): 'work_visible' | 'personal_only' | 'other' {
  if (targetObjectType === 'curated_note' || targetObjectType === 'procedure') {
    return 'work_visible';
  }
  if (targetObjectType === 'profile_memory' || targetObjectType === 'personal_episode') {
    return 'personal_only';
  }
  return 'other';
}

function getAllowedAdvanceTargetStatus(
  status: MemoryCandidateStatus,
): MemoryCandidateAdvanceTargetStatus | null {
  switch (status) {
    case 'captured':
    case 'candidate':
    case 'staged_for_review':
      return ALLOWED_TRANSITIONS[status];
    case 'rejected':
    case 'promoted':
    case 'superseded':
      return null;
    default:
      return assertNeverMemoryCandidateStatus(status);
  }
}

function assertNeverMemoryCandidateStatus(status: never): never {
  throw new Error(`Unhandled memory candidate status: ${status}`);
}

function formatReasonLabel(reason: MemoryCandidatePromotionPreflightReason): string {
  switch (reason) {
    case 'candidate_not_staged_for_review':
      return 'candidate is not staged for review';
    case 'candidate_missing_provenance':
      return 'candidate is missing provenance';
    case 'candidate_missing_target_object':
      return 'candidate is missing a target object';
    case 'candidate_scope_conflict':
      return 'candidate scope conflicts with its target';
    case 'candidate_unknown_sensitivity':
      return 'candidate sensitivity is unknown';
    case 'candidate_requires_revalidation':
      return 'candidate requires revalidation';
    case 'candidate_possible_duplicate':
      return 'possible duplicate';
    case 'candidate_ready_for_promotion':
      return 'candidate is ready for promotion';
  }
}
