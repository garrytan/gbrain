import type { Operation } from './operations.ts';
import { advanceMemoryCandidateStatus, MemoryInboxServiceError } from './services/memory-inbox-service.ts';

type OperationErrorCtor = new (
  code: 'memory_candidate_not_found' | 'invalid_params',
  message: string,
  suggestion?: string,
  docs?: string,
) => Error;

const MEMORY_CANDIDATE_STATUS_VALUES = ['captured', 'candidate', 'staged_for_review'] as const;
const MEMORY_CANDIDATE_ADVANCE_STATUS_VALUES = ['candidate', 'staged_for_review'] as const;
const MEMORY_CANDIDATE_TYPE_VALUES = ['fact', 'relationship', 'note_update', 'procedure', 'profile_update', 'open_question', 'rationale'] as const;
const MEMORY_CANDIDATE_GENERATED_BY_VALUES = ['agent', 'map_analysis', 'dream_cycle', 'manual', 'import'] as const;
const MEMORY_CANDIDATE_EXTRACTION_KIND_VALUES = ['extracted', 'inferred', 'ambiguous', 'manual'] as const;
const MEMORY_CANDIDATE_SENSITIVITY_VALUES = ['public', 'work', 'personal', 'secret', 'unknown'] as const;
const MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES = ['curated_note', 'procedure', 'profile_memory', 'personal_episode', 'other'] as const;

export const DEFAULT_MEMORY_INBOX_SCOPE_ID = 'workspace:default';
export const MAX_MEMORY_CANDIDATE_LIMIT = 100;

function invalidParams(
  deps: { OperationError: OperationErrorCtor },
  message: string,
): Error {
  return new deps.OperationError('invalid_params', message);
}

function requireEnumValue<T extends string>(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw invalidParams(deps, `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function optionalEnumValue<T extends string>(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (value == null) {
    return undefined;
  }
  return requireEnumValue(deps, field, value, allowed);
}

function normalizeSourceRefs(
  deps: { OperationError: OperationErrorCtor },
  params: Record<string, unknown>,
): string[] {
  if (Array.isArray(params.source_refs)) {
    if (!params.source_refs.every((entry) => typeof entry === 'string')) {
      throw invalidParams(deps, 'source_refs must be an array of strings');
    }
    return [...params.source_refs];
  }
  if (typeof params.source_ref === 'string') {
    return [params.source_ref];
  }
  if (params.source_ref == null && params.source_refs == null) {
    return [];
  }
  throw invalidParams(deps, 'source_ref must be a string and source_refs must be an array of strings');
}

function normalizeLimit(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): number {
  if (value == null) {
    return 20;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidParams(deps, 'limit must be a non-negative number');
  }
  return Math.min(Math.floor(value), MAX_MEMORY_CANDIDATE_LIMIT);
}

function normalizeOffset(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): number {
  if (value == null) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidParams(deps, 'offset must be a non-negative number');
  }
  return Math.floor(value);
}

export function createMemoryInboxOperations(
  deps: {
    defaultScopeId: string;
    OperationError: OperationErrorCtor;
  },
): Operation[] {
  const get_memory_candidate_entry: Operation = {
    name: 'get_memory_candidate_entry',
    description: 'Get one canonical memory-inbox candidate by id.',
    params: {
      id: { type: 'string', required: true, description: 'Memory candidate entry id' },
    },
    handler: async (ctx, p) => {
      return ctx.engine.getMemoryCandidateEntry(String(p.id));
    },
    cliHints: { name: 'get-memory-candidate' },
  };

  const list_memory_candidate_entries: Operation = {
    name: 'list_memory_candidate_entries',
    description: 'List canonical memory-inbox candidates.',
    params: {
      scope_id: { type: 'string', description: `Memory candidate scope id (default: ${deps.defaultScopeId})` },
      status: {
        type: 'string',
        description: 'Optional candidate status filter',
        enum: [...MEMORY_CANDIDATE_STATUS_VALUES],
      },
      candidate_type: {
        type: 'string',
        description: 'Optional candidate type filter',
        enum: [...MEMORY_CANDIDATE_TYPE_VALUES],
      },
      target_object_type: {
        type: 'string',
        description: 'Optional target object type filter',
        enum: [...MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES],
      },
      limit: { type: 'number', description: `Max results (default 20, cap ${MAX_MEMORY_CANDIDATE_LIMIT})` },
      offset: { type: 'number', description: 'Offset for pagination (default 0)' },
    },
    handler: async (ctx, p) => {
      return ctx.engine.listMemoryCandidateEntries({
        scope_id: String(p.scope_id ?? deps.defaultScopeId),
        status: optionalEnumValue(deps, 'status', p.status, MEMORY_CANDIDATE_STATUS_VALUES),
        candidate_type: optionalEnumValue(deps, 'candidate_type', p.candidate_type, MEMORY_CANDIDATE_TYPE_VALUES),
        target_object_type: optionalEnumValue(deps, 'target_object_type', p.target_object_type, MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES),
        limit: normalizeLimit(deps, p.limit),
        offset: normalizeOffset(deps, p.offset),
      });
    },
    cliHints: { name: 'list-memory-candidates', aliases: { n: 'limit' } },
  };

  const create_memory_candidate_entry: Operation = {
    name: 'create_memory_candidate_entry',
    description: 'Create one canonical memory-inbox candidate in captured state by default.',
    params: {
      id: { type: 'string', description: 'Optional memory candidate id (generated when omitted)' },
      scope_id: { type: 'string', description: `Memory candidate scope id (default: ${deps.defaultScopeId})` },
      candidate_type: {
        type: 'string',
        required: true,
        description: 'Memory candidate type',
        enum: [...MEMORY_CANDIDATE_TYPE_VALUES],
      },
      proposed_content: { type: 'string', required: true, description: 'Candidate claim or proposed change content' },
      source_ref: { type: 'string', description: 'Optional single provenance string' },
      source_refs: {
        type: 'array',
        description: 'Optional provenance strings for multi-source attribution',
        items: { type: 'string' },
      },
      generated_by: {
        type: 'string',
        description: 'Candidate generation source',
        enum: [...MEMORY_CANDIDATE_GENERATED_BY_VALUES],
      },
      extraction_kind: {
        type: 'string',
        description: 'Candidate extraction kind',
        enum: [...MEMORY_CANDIDATE_EXTRACTION_KIND_VALUES],
      },
      confidence_score: { type: 'number', description: 'Confidence score (default 0.5)' },
      importance_score: { type: 'number', description: 'Importance score (default 0.5)' },
      recurrence_score: { type: 'number', description: 'Recurrence score (default 0)' },
      sensitivity: {
        type: 'string',
        description: 'Candidate sensitivity',
        enum: [...MEMORY_CANDIDATE_SENSITIVITY_VALUES],
      },
      status: {
        type: 'string',
        description: 'Initial candidate status (default captured)',
        enum: [...MEMORY_CANDIDATE_STATUS_VALUES],
      },
      target_object_type: {
        type: 'string',
        description: 'Optional target object type',
        enum: [...MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES],
      },
      target_object_id: { type: 'string', description: 'Optional target object id' },
      reviewed_at: { type: 'string', description: 'Optional ISO timestamp for review metadata' },
      review_reason: { type: 'string', description: 'Optional review reason or audit note' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const id = typeof p.id === 'string' ? p.id : crypto.randomUUID();
      const scopeId = String(p.scope_id ?? deps.defaultScopeId);
      const status = optionalEnumValue(deps, 'status', p.status, MEMORY_CANDIDATE_STATUS_VALUES) ?? 'captured';
      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'create_memory_candidate_entry',
          id,
          scope_id: scopeId,
          candidate_type: p.candidate_type,
          status,
        };
      }

      return ctx.engine.createMemoryCandidateEntry({
        id,
        scope_id: scopeId,
        candidate_type: requireEnumValue(deps, 'candidate_type', p.candidate_type, MEMORY_CANDIDATE_TYPE_VALUES),
        proposed_content: String(p.proposed_content),
        source_refs: normalizeSourceRefs(deps, p),
        generated_by: optionalEnumValue(deps, 'generated_by', p.generated_by, MEMORY_CANDIDATE_GENERATED_BY_VALUES) ?? 'manual',
        extraction_kind: optionalEnumValue(deps, 'extraction_kind', p.extraction_kind, MEMORY_CANDIDATE_EXTRACTION_KIND_VALUES) ?? 'manual',
        confidence_score: typeof p.confidence_score === 'number' ? p.confidence_score : 0.5,
        importance_score: typeof p.importance_score === 'number' ? p.importance_score : 0.5,
        recurrence_score: typeof p.recurrence_score === 'number' ? p.recurrence_score : 0,
        sensitivity: optionalEnumValue(deps, 'sensitivity', p.sensitivity, MEMORY_CANDIDATE_SENSITIVITY_VALUES) ?? 'work',
        status,
        target_object_type: optionalEnumValue(deps, 'target_object_type', p.target_object_type, MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES) ?? null,
        target_object_id: typeof p.target_object_id === 'string' ? p.target_object_id : null,
        reviewed_at: p.reviewed_at === null ? null : (typeof p.reviewed_at === 'string' ? p.reviewed_at : null),
        review_reason: typeof p.review_reason === 'string' ? p.review_reason : null,
      });
    },
    cliHints: { name: 'create-memory-candidate' },
  };

  const advance_memory_candidate_status: Operation = {
    name: 'advance_memory_candidate_status',
    description: 'Advance one memory-inbox candidate through the bounded early review lifecycle.',
    params: {
      id: { type: 'string', required: true, description: 'Memory candidate id' },
      next_status: {
        type: 'string',
        required: true,
        description: 'Next allowed candidate status; the exact transition still depends on the current stored status.',
        enum: [...MEMORY_CANDIDATE_ADVANCE_STATUS_VALUES],
      },
      reviewed_at: { type: 'string', description: 'Optional ISO timestamp for review metadata' },
      review_reason: { type: 'string', description: 'Optional review reason or audit note' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'advance_memory_candidate_status',
          id: p.id,
          next_status: p.next_status,
        };
      }

      try {
        return await advanceMemoryCandidateStatus(ctx.engine, {
          id: String(p.id),
          next_status: requireEnumValue(deps, 'next_status', p.next_status, MEMORY_CANDIDATE_ADVANCE_STATUS_VALUES),
          reviewed_at: p.reviewed_at === null ? null : (typeof p.reviewed_at === 'string' ? p.reviewed_at : undefined),
          review_reason: typeof p.review_reason === 'string' ? p.review_reason : undefined,
        });
      } catch (error) {
        if (error instanceof MemoryInboxServiceError) {
          if (error.code === 'memory_candidate_not_found') {
            throw new deps.OperationError('memory_candidate_not_found', error.message);
          }
          throw new deps.OperationError('invalid_params', error.message);
        }
        throw error;
      }
    },
    cliHints: { name: 'advance-memory-candidate-status' },
  };

  return [
    get_memory_candidate_entry,
    list_memory_candidate_entries,
    create_memory_candidate_entry,
    advance_memory_candidate_status,
  ];
}
