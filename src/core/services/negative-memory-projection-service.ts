import type {
  DecisionProjectionMemoryCandidate,
  DecisionProjectionTaskAttempt,
  NegativeMemoryProjection,
  NegativeMemoryProjectionInput,
  ProjectionAnchors,
  ProjectionActivation,
} from '../types.ts';

export function buildNegativeMemoryProjections(
  input: NegativeMemoryProjectionInput,
): NegativeMemoryProjection[] {
  return [
    ...(input.task_attempts ?? []).flatMap((attempt) => (
      attempt.outcome === 'failed' ? [projectFailedAttempt(attempt, input)] : []
    )),
    ...(input.memory_candidates ?? []).flatMap(projectRejectedCandidate),
  ];
}

function projectFailedAttempt(
  attempt: DecisionProjectionTaskAttempt,
  input: NegativeMemoryProjectionInput,
): NegativeMemoryProjection {
  const failedUnder = applicabilityAnchors(attempt.applicability_context);
  const reopenIf = objectField(attempt.applicability_context, 'reopen_if');
  const validUntil = stringField(attempt.applicability_context, 'valid_until');
  const anchorDecision = evaluateAnchors(failedUnder, input.current_anchors ?? {});
  const reopenDecision = evaluateReopenIf(reopenIf, input.current_anchors ?? {});
  const expiryDecision = evaluateExpiry(validUntil, input.now);
  const suppressionApplies = anchorDecision.matches
    && !reopenDecision.matched
    && !expiryDecision.expired
    && !expiryDecision.unverified;
  const reasonCodes = [
    ...(anchorDecision.reason_codes.length > 0 ? anchorDecision.reason_codes : ['applicability_anchors_match']),
    ...reopenDecision.reason_codes,
    ...expiryDecision.reason_codes,
  ];

  return {
    id: `negative-memory:task-attempt:${attempt.id}`,
    failed_under: failedUnder,
    why_failed: attempt.summary,
    do_not_repeat_if: failedUnder,
    reopen_if: reopenIf,
    valid_until: validUntil,
    source_refs: [`task-attempt:${attempt.id}`],
    owner_or_task: `task:${attempt.task_id}`,
    activation: suppressionApplies ? 'suppress_if_valid' : 'verify_first',
    suppression_applies: suppressionApplies,
    reason_codes: reasonCodes,
  };
}

function projectRejectedCandidate(
  candidate: DecisionProjectionMemoryCandidate,
): NegativeMemoryProjection[] {
  if (candidate.status !== 'rejected' && candidate.status !== 'superseded') return [];
  const failedUnder = applicabilityAnchors({
    target_object_id: candidate.target_object_id,
    target_object_type: candidate.target_object_type,
  });

  return [{
    id: `negative-memory:memory-candidate:${candidate.id}`,
    failed_under: failedUnder,
    why_failed: candidate.review_reason ?? `candidate_${candidate.status}`,
    do_not_repeat_if: failedUnder,
    reopen_if: {},
    valid_until: null,
    source_refs: dedupeStrings([`memory-candidate:${candidate.id}`, ...candidate.source_refs]),
    owner_or_task: `candidate:${candidate.id}`,
    activation: 'audit_only',
    suppression_applies: false,
    reason_codes: [`candidate_${candidate.status}`, 'audit_only_not_global_suppression'],
  }];
}

function evaluateAnchors(
  failedUnder: ProjectionAnchors,
  currentAnchors: ProjectionAnchors,
): { matches: boolean; reason_codes: string[] } {
  const entries = Object.entries(failedUnder);
  if (entries.length === 0) {
    return { matches: false, reason_codes: ['missing_applicability_anchors'] };
  }

  const reasonCodes: string[] = [];
  for (const [key, value] of entries) {
    if (!(key in currentAnchors)) {
      reasonCodes.push(`current_anchor_missing:${key}`);
      continue;
    }
    if (currentAnchors[key] !== value) {
      reasonCodes.push(`current_anchor_mismatch:${key}`);
    }
  }

  return {
    matches: reasonCodes.length === 0,
    reason_codes: reasonCodes,
  };
}

function evaluateReopenIf(
  reopenIf: ProjectionAnchors,
  currentAnchors: ProjectionAnchors,
): { matched: boolean; reason_codes: string[] } {
  const reasonCodes: string[] = [];
  for (const [key, value] of Object.entries(reopenIf)) {
    if (currentAnchors[key] === value) {
      reasonCodes.push(`reopen_condition_matched:${key}`);
    }
  }
  return { matched: reasonCodes.length > 0, reason_codes: reasonCodes };
}

function applicabilityAnchors(context: ProjectionAnchors): ProjectionAnchors {
  const anchors: ProjectionAnchors = {};
  for (const [key, value] of Object.entries(context)) {
    if (isMetadataAnchor(key) || value == null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      anchors[key] = value;
    }
  }
  return anchors;
}

function objectField(record: ProjectionAnchors, key: string): ProjectionAnchors {
  const value = record[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as ProjectionAnchors;
}

function stringField(record: ProjectionAnchors, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function evaluateExpiry(
  validUntil: string | null,
  now: Date | string | undefined,
): { expired: boolean; unverified: boolean; reason_codes: string[] } {
  if (!validUntil) return { expired: false, unverified: false, reason_codes: [] };
  if (!now) return { expired: false, unverified: true, reason_codes: ['valid_until_unverified'] };
  const validUntilTime = new Date(validUntil).getTime();
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(validUntilTime) || !Number.isFinite(nowTime)) {
    return { expired: false, unverified: true, reason_codes: ['valid_until_unverified'] };
  }
  if (nowTime > validUntilTime) {
    return { expired: true, unverified: false, reason_codes: ['valid_until_expired'] };
  }
  return { expired: false, unverified: false, reason_codes: [] };
}

function isMetadataAnchor(key: string): boolean {
  return key === 'valid_until'
    || key === 'reopen_if'
    || key === 'why_failed'
    || key === 'do_not_repeat_if';
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}
