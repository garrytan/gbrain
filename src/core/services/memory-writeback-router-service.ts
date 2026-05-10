import type {
  MemoryCandidateExtractionKind,
  MemoryCandidateGeneratedBy,
  MemoryCandidateSensitivity,
  MemoryCandidateTargetObjectType,
  MemoryCandidateType,
  MemoryScenarioSourceKind,
  MemoryWritebackEvidenceKind,
  RouteMemoryWritebackCandidateInput,
  RouteMemoryWritebackInput,
  RouteMemoryWritebackResult,
} from '../types.ts';

export const MEMORY_WRITEBACK_EVIDENCE_KINDS = [
  'direct_user_statement',
  'source_extracted',
  'agent_inferred',
  'ambiguous',
  'contradicts_existing',
  'code_sensitive',
  'task_mechanics',
] as const satisfies readonly MemoryWritebackEvidenceKind[];

export const MEMORY_WRITEBACK_DECISIONS = [
  'create_candidate',
  'canonical_write_allowed',
  'no_write',
  'defer',
] as const;

export const MEMORY_WRITEBACK_INTENDED_OPERATIONS = [
  'create_memory_candidate_entry',
  'put_page',
  'none',
] as const;

const DEFAULT_SCOPE_ID = 'workspace:default';
const ACCUMULATION_SOURCE_KINDS = new Set<MemoryScenarioSourceKind>([
  'import',
  'meeting',
  'cron',
  'session_end',
  'trace_review',
]);

export function routeMemoryWriteback(
  input: RouteMemoryWritebackInput,
): RouteMemoryWritebackResult {
  const content = input.content.trim();
  const sourceRefs = normalizeSourceRefs(input.source_refs);
  const scopeId = normalizeOptionalString(input.scope_id) ?? DEFAULT_SCOPE_ID;
  const sourceKind = input.source_kind ?? null;
  const sensitivity = input.sensitivity ?? 'work';
  const targetObjectType = input.target_object_type ?? null;
  const targetObjectId = normalizeOptionalString(input.target_object_id);

  if (!content) {
    return baseResult(input, {
      decision: 'no_write',
      intended_operation: 'none',
      reasons: ['empty_content'],
      source_kind: sourceKind,
      scope_id: scopeId,
      sensitivity,
      candidate_type: null,
      extraction_kind: null,
      target_object_type: targetObjectType,
      target_object_id: targetObjectId,
    });
  }

  if (input.evidence_kind === 'task_mechanics') {
    return baseResult(input, {
      decision: 'no_write',
      intended_operation: 'none',
      reasons: ['task_mechanics_not_durable'],
      source_kind: sourceKind,
      scope_id: scopeId,
      sensitivity,
      candidate_type: null,
      extraction_kind: null,
      target_object_type: targetObjectType,
      target_object_id: targetObjectId,
    });
  }

  const canonicalMissing = canonicalMissingRequirements(
    input,
    sourceRefs,
    targetObjectType,
    targetObjectId,
    sensitivity,
  );
  if (input.allow_canonical_write === true && canonicalMissing.length > 0) {
    return baseResult(input, {
      decision: 'defer',
      intended_operation: 'none',
      reasons: canonicalMissingReasons(canonicalMissing),
      missing_requirements: canonicalMissing,
      source_kind: sourceKind,
      scope_id: scopeId,
      sensitivity,
      candidate_type: null,
      extraction_kind: null,
      target_object_type: targetObjectType,
      target_object_id: targetObjectId,
    });
  }

  if (isCanonicalAllowed(input, sourceRefs, targetObjectType, targetObjectId, sensitivity)) {
    return {
      ...baseResult(input, {
        decision: 'canonical_write_allowed',
        intended_operation: 'put_page',
        reasons: ['direct_canonical_write_allowed'],
        source_kind: sourceKind,
        scope_id: scopeId,
        sensitivity,
        candidate_type: null,
        extraction_kind: null,
        target_object_type: targetObjectType,
        target_object_id: targetObjectId,
      }),
      canonical_write_requirements: {
        source_refs: sourceRefs,
        target_object_type: targetObjectType,
        target_object_id: targetObjectId,
        sensitivity,
      },
    };
  }

  const candidateRoute = candidateRouteReason(
    input.evidence_kind,
    sourceKind,
    input.allow_canonical_write,
  );
  if (!candidateRoute) {
    return baseResult(input, {
      decision: 'defer',
      intended_operation: 'none',
      reasons: ['writeback_route_unclear'],
      missing_requirements: ['evidence_kind'],
      source_kind: sourceKind,
      scope_id: scopeId,
      sensitivity,
      candidate_type: null,
      extraction_kind: null,
      target_object_type: targetObjectType,
      target_object_id: targetObjectId,
    });
  }

  if (sourceRefs.length === 0) {
    return baseResult(input, {
      decision: 'defer',
      intended_operation: 'none',
      reasons: ['candidate_missing_provenance'],
      missing_requirements: ['source_refs'],
      source_kind: sourceKind,
      scope_id: scopeId,
      sensitivity,
      candidate_type: null,
      extraction_kind: null,
      target_object_type: targetObjectType,
      target_object_id: targetObjectId,
    });
  }

  const candidateType = input.candidate_type ?? defaultCandidateType(input.evidence_kind);
  const extractionKind = defaultExtractionKind(input.evidence_kind);
  const reasons = candidateReasons(candidateRoute, input.evidence_kind, targetObjectType);
  const candidateInput: RouteMemoryWritebackCandidateInput = {
    scope_id: scopeId,
    candidate_type: candidateType,
    proposed_content: content,
    source_refs: sourceRefs,
    generated_by: generatedByForSourceKind(sourceKind),
    extraction_kind: extractionKind,
    confidence_score: normalizeScore(input.confidence_score, 0.5),
    importance_score: normalizeScore(input.importance_score, 0.5),
    recurrence_score: normalizeScore(input.recurrence_score, 0),
    sensitivity,
    status: candidateStatus(input.evidence_kind, sensitivity, targetObjectType, targetObjectId),
    target_object_type: targetObjectType,
    target_object_id: targetObjectId,
    reviewed_at: null,
    review_reason: reasons.join(', '),
    interaction_id: normalizeOptionalString(input.interaction_id),
  };

  return {
    ...baseResult(input, {
      decision: 'create_candidate',
      intended_operation: 'create_memory_candidate_entry',
      reasons,
      source_kind: sourceKind,
      scope_id: scopeId,
      sensitivity,
      candidate_type: candidateType,
      extraction_kind: extractionKind,
      target_object_type: targetObjectType,
      target_object_id: targetObjectId,
    }),
    candidate_input: candidateInput,
  };
}

function baseResult(
  input: RouteMemoryWritebackInput,
  fields: {
    decision: RouteMemoryWritebackResult['decision'];
    intended_operation: RouteMemoryWritebackResult['intended_operation'];
    reasons: string[];
    missing_requirements?: string[];
    source_kind: MemoryScenarioSourceKind | null;
    scope_id: string;
    sensitivity: MemoryCandidateSensitivity;
    candidate_type: MemoryCandidateType | null;
    extraction_kind: MemoryCandidateExtractionKind | null;
    target_object_type: MemoryCandidateTargetObjectType | null;
    target_object_id: string | null;
  },
): RouteMemoryWritebackResult {
  return {
    decision: fields.decision,
    intended_operation: fields.intended_operation,
    applied: false,
    reasons: fields.reasons,
    missing_requirements: fields.missing_requirements ?? [],
    normalized_signal: {
      evidence_kind: input.evidence_kind,
      source_kind: fields.source_kind,
      scope_id: fields.scope_id,
      sensitivity: fields.sensitivity,
      candidate_type: fields.candidate_type,
      extraction_kind: fields.extraction_kind,
      target_object_type: fields.target_object_type,
      target_object_id: fields.target_object_id,
    },
  };
}

function normalizeSourceRefs(value: string[] | undefined): string[] {
  if (!value) return [];
  return value.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeScore(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function isCanonicalAllowed(
  input: RouteMemoryWritebackInput,
  sourceRefs: string[],
  targetObjectType: MemoryCandidateTargetObjectType | null,
  targetObjectId: string | null,
  sensitivity: MemoryCandidateSensitivity,
): targetObjectType is Exclude<MemoryCandidateTargetObjectType, 'other'> {
  return input.allow_canonical_write === true
    && (input.evidence_kind === 'direct_user_statement' || input.evidence_kind === 'source_extracted')
    && sourceRefs.length > 0
    && !!targetObjectType
    && targetObjectType !== 'other'
    && !!targetObjectId
    && sensitivity !== 'unknown';
}

function canonicalMissingRequirements(
  input: RouteMemoryWritebackInput,
  sourceRefs: string[],
  targetObjectType: MemoryCandidateTargetObjectType | null,
  targetObjectId: string | null,
  sensitivity: MemoryCandidateSensitivity,
): string[] {
  if (input.allow_canonical_write !== true) return [];
  const missing: string[] = [];
  if (sourceRefs.length === 0) missing.push('source_refs');
  if (!targetObjectType || targetObjectType === 'other') missing.push('target_object_type');
  if (!targetObjectId) missing.push('target_object_id');
  if (sensitivity === 'unknown') missing.push('sensitivity');
  if (input.evidence_kind !== 'direct_user_statement' && input.evidence_kind !== 'source_extracted') {
    missing.push('canonical_evidence_kind');
  }
  return missing;
}

function canonicalMissingReasons(missing: string[]): string[] {
  const reasons = new Set<string>();
  if (missing.includes('source_refs')) reasons.add('canonical_provenance_required');
  if (missing.includes('target_object_type') || missing.includes('target_object_id')) {
    reasons.add('canonical_target_required');
  }
  if (missing.includes('sensitivity')) reasons.add('canonical_sensitivity_required');
  if (missing.includes('canonical_evidence_kind')) reasons.add('canonical_evidence_kind_not_allowed');
  return [...reasons];
}

function candidateRouteReason(
  evidenceKind: MemoryWritebackEvidenceKind,
  sourceKind: MemoryScenarioSourceKind | null,
  allowCanonicalWrite: boolean | undefined,
): string | null {
  switch (evidenceKind) {
    case 'direct_user_statement':
      return allowCanonicalWrite === true ? null : 'direct_signal_without_canonical_request';
    case 'source_extracted':
      return allowCanonicalWrite === true ? null : 'extracted_signal_without_canonical_request';
    case 'agent_inferred':
      return 'inferred_signal_requires_review';
    case 'ambiguous':
      return 'ambiguous_signal_requires_review';
    case 'contradicts_existing':
      return 'contradiction_requires_review';
    case 'code_sensitive':
      return 'code_claim_requires_revalidation';
    case 'task_mechanics':
      return null;
  }
  if (sourceKind && ACCUMULATION_SOURCE_KINDS.has(sourceKind)) {
    return 'accumulation_signal_requires_review';
  }
  return null;
}

function candidateReasons(
  routeReason: string,
  evidenceKind: MemoryWritebackEvidenceKind,
  targetObjectType: MemoryCandidateTargetObjectType | null,
): string[] {
  const reasons = [routeReason];
  if (evidenceKind === 'code_sensitive' && !reasons.includes('code_claim_requires_revalidation')) {
    reasons.push('code_claim_requires_revalidation');
  }
  if (targetObjectType === 'other') {
    reasons.push('target_object_requires_manual_review');
  }
  return [...new Set(reasons)];
}

function defaultCandidateType(evidenceKind: MemoryWritebackEvidenceKind): MemoryCandidateType {
  switch (evidenceKind) {
    case 'ambiguous':
      return 'open_question';
    case 'contradicts_existing':
    case 'code_sensitive':
      return 'note_update';
    case 'direct_user_statement':
    case 'source_extracted':
    case 'agent_inferred':
    case 'task_mechanics':
      return 'fact';
  }
}

function defaultExtractionKind(evidenceKind: MemoryWritebackEvidenceKind): MemoryCandidateExtractionKind {
  switch (evidenceKind) {
    case 'direct_user_statement':
      return 'manual';
    case 'source_extracted':
      return 'extracted';
    case 'ambiguous':
      return 'ambiguous';
    case 'agent_inferred':
    case 'contradicts_existing':
    case 'code_sensitive':
    case 'task_mechanics':
      return 'inferred';
  }
}

function generatedByForSourceKind(sourceKind: MemoryScenarioSourceKind | null): MemoryCandidateGeneratedBy {
  if (sourceKind === 'import') return 'import';
  if (sourceKind === 'manual') return 'manual';
  return 'agent';
}

function candidateStatus(
  evidenceKind: MemoryWritebackEvidenceKind,
  sensitivity: MemoryCandidateSensitivity,
  targetObjectType: MemoryCandidateTargetObjectType | null,
  targetObjectId: string | null,
): 'captured' | 'candidate' {
  if (
    evidenceKind === 'ambiguous'
    || evidenceKind === 'contradicts_existing'
    || evidenceKind === 'code_sensitive'
    || sensitivity === 'unknown'
    || targetObjectType === 'other'
    || !targetObjectType
    || !targetObjectId
  ) {
    return 'captured';
  }
  return 'candidate';
}
