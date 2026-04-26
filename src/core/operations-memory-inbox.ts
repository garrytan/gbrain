import type { Operation } from './operations.ts';
import type { BrainEngine } from './engine.ts';
import {
  advanceMemoryCandidateStatus,
  createMemoryCandidateEntryWithStatusEvent,
  MemoryInboxServiceError,
  preflightPromoteMemoryCandidate,
  rejectMemoryCandidateEntry,
} from './services/memory-inbox-service.ts';
import { rankMemoryCandidateEntries } from './services/memory-candidate-scoring-service.ts';
import { captureMapDerivedCandidates } from './services/map-derived-candidate-service.ts';
import { getStructuralContextMapReport } from './services/context-map-report-service.ts';
import { buildMemoryCandidateReviewBacklog } from './services/memory-candidate-dedup-service.ts';
import { recordCanonicalHandoff } from './services/canonical-handoff-service.ts';
import { assessHistoricalValidity } from './services/historical-validity-service.ts';
import { resolveMemoryCandidateContradiction } from './services/memory-inbox-contradiction-service.ts';
import { promoteMemoryCandidateEntry } from './services/memory-inbox-promotion-service.ts';
import { supersedeMemoryCandidateEntry } from './services/memory-inbox-supersession-service.ts';
import { runDreamCycleMaintenance } from './services/dream-cycle-maintenance-service.ts';
import { recordMemoryMutationEvent } from './services/memory-mutation-ledger-service.ts';
import {
  resolveTargetSnapshotHash,
  UnsupportedTargetSnapshotKindError,
} from './services/target-snapshot-hash-service.ts';
import type { MemoryMutationTargetKind, MemoryPatchOperationState } from './types.ts';

type OperationErrorCtor = new (
  code: 'memory_candidate_not_found' | 'invalid_params',
  message: string,
  suggestion?: string,
  docs?: string,
) => Error;
type MemoryCandidateListFilters = NonNullable<Parameters<BrainEngine['listMemoryCandidateEntries']>[0]>;

const MEMORY_CANDIDATE_EARLY_STATUS_VALUES = ['captured', 'candidate', 'staged_for_review'] as const;
const MEMORY_CANDIDATE_STATUS_VALUES = ['captured', 'candidate', 'staged_for_review', 'rejected', 'promoted', 'superseded'] as const;
const MEMORY_CANDIDATE_STATUS_EVENT_KIND_VALUES = ['created', 'advanced', 'promoted', 'rejected', 'superseded'] as const;
const MEMORY_CANDIDATE_ADVANCE_STATUS_VALUES = ['candidate', 'staged_for_review'] as const;
const MEMORY_CANDIDATE_TYPE_VALUES = ['fact', 'relationship', 'note_update', 'procedure', 'profile_update', 'open_question', 'rationale'] as const;
const MEMORY_CANDIDATE_GENERATED_BY_VALUES = ['agent', 'map_analysis', 'dream_cycle', 'manual', 'import'] as const;
const MEMORY_CANDIDATE_EXTRACTION_KIND_VALUES = ['extracted', 'inferred', 'ambiguous', 'manual'] as const;
const MEMORY_CANDIDATE_SENSITIVITY_VALUES = ['public', 'work', 'personal', 'secret', 'unknown'] as const;
const MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES = ['curated_note', 'procedure', 'profile_memory', 'personal_episode', 'other'] as const;
const CANONICAL_HANDOFF_TARGET_OBJECT_TYPE_VALUES = ['curated_note', 'procedure', 'profile_memory', 'personal_episode'] as const;
const MEMORY_CANDIDATE_CONTRADICTION_OUTCOME_VALUES = ['rejected', 'unresolved', 'superseded'] as const;
const MEMORY_MUTATION_TARGET_KIND_VALUES = [
  'page',
  'source_record',
  'task_thread',
  'working_set',
  'task_event',
  'task_episode',
  'attempt',
  'decision',
  'procedure',
  'memory_candidate',
  'memory_patch_candidate',
  'profile_memory',
  'personal_episode',
  'memory_realm',
  'memory_session',
  'memory_session_attachment',
  'context_map',
  'context_atlas',
  'file_artifact',
  'export_artifact',
  'ledger_event',
] as const satisfies readonly MemoryMutationTargetKind[];
const MEMORY_PATCH_TARGET_KIND_VALUES = [
  'page',
  'task_thread',
  'working_set',
  'memory_candidate',
  'profile_memory',
  'personal_episode',
  'memory_realm',
  'memory_session',
  'memory_session_attachment',
  'context_map',
  'context_atlas',
] as const satisfies readonly MemoryMutationTargetKind[];
const MEMORY_PATCH_FORMAT_VALUES = ['merge_patch', 'json_patch', 'unified_diff', 'whole_record', 'operation'] as const;
const MEMORY_PATCH_OPERATION_STATE_VALUES = [
  'proposed',
  'dry_run_validated',
  'approved_for_apply',
  'apply_in_progress',
  'applied',
  'conflicted',
  'failed',
] as const;
const MEMORY_PATCH_RISK_CLASS_VALUES = ['low', 'medium', 'high', 'critical', 'unknown'] as const;
const MEMORY_PATCH_FIELD_NAMES = [
  'patch_target_kind',
  'patch_target_id',
  'patch_base_target_snapshot_hash',
  'patch_body',
  'patch_format',
  'patch_operation_state',
  'patch_risk_class',
  'patch_expected_resulting_target_snapshot_hash',
  'patch_provenance_summary',
  'patch_actor',
  'patch_originating_session_id',
  'patch_ledger_event_ids',
] as const;
const ISO_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

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
    if (params.source_refs.some((entry) => entry.trim().length === 0)) {
      throw invalidParams(deps, 'source_refs entries must be non-empty strings');
    }
    return params.source_refs.map((entry) => entry.trim());
  }
  if (typeof params.source_ref === 'string') {
    if (params.source_ref.trim().length === 0) {
      throw invalidParams(deps, 'source_ref must be a non-empty string');
    }
    return [params.source_ref.trim()];
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

async function listAllFilteredMemoryCandidateEntries(
  engine: BrainEngine,
  filters: {
    scope_id: string;
    status?: (typeof MEMORY_CANDIDATE_STATUS_VALUES)[number];
    candidate_type?: (typeof MEMORY_CANDIDATE_TYPE_VALUES)[number];
    target_object_type?: (typeof MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES)[number];
  },
  batchSize = MAX_MEMORY_CANDIDATE_LIMIT,
) {
  const entries = [];
  for (let offset = 0; ; offset += batchSize) {
    const batch = await engine.listMemoryCandidateEntries({
      ...filters,
      limit: batchSize,
      offset,
    });
    entries.push(...batch);
    if (batch.length < batchSize) {
      break;
    }
  }
  return entries;
}

function normalizeOptionalTargetObjectId(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidParams(deps, 'target_object_id must be a non-empty string');
  }
  return value.trim();
}

function normalizeOptionalNonEmptyString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidParams(deps, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOptionalSnapshotHash(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | null {
  const normalized = normalizeOptionalNonEmptyString(deps, field, value);
  if (normalized == null) return null;
  if (!SHA256_HEX_PATTERN.test(normalized)) {
    throw invalidParams(deps, `${field} must be a lowercase sha256 hex string`);
  }
  return normalized;
}

function normalizeOptionalPatchBody(
  deps: { OperationError: OperationErrorCtor },
  format: (typeof MEMORY_PATCH_FORMAT_VALUES)[number] | null,
  value: unknown,
): Record<string, unknown> | unknown[] | null {
  if (value == null) return null;
  if (format === 'json_patch') {
    if (!Array.isArray(value)) {
      throw invalidParams(deps, 'patch_body must be an array for json_patch format');
    }
    JSON.stringify(value);
    return value;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalidParams(deps, 'patch_body must be an object');
  }
  JSON.stringify(value);
  return value as Record<string, unknown>;
}

function normalizeStringArray(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)) {
    throw invalidParams(deps, `${field} must be an array of non-empty strings`);
  }
  return value.map((entry) => entry.trim());
}

function normalizePatchCandidateFields(
  deps: { OperationError: OperationErrorCtor },
  p: Record<string, unknown>,
  options: { requirePatchBody?: boolean; operationStates?: readonly MemoryPatchOperationState[] } = {},
) {
  const patchFormat = optionalEnumValue(deps, 'patch_format', p.patch_format, MEMORY_PATCH_FORMAT_VALUES) ?? null;
  const patchBody = normalizeOptionalPatchBody(deps, patchFormat, p.patch_body);
  if (options.requirePatchBody && patchBody == null) {
    throw invalidParams(deps, patchFormat === 'json_patch' ? 'patch_body must be an array' : 'patch_body must be an object');
  }
  return {
    patch_target_kind: optionalEnumValue(deps, 'patch_target_kind', p.patch_target_kind, MEMORY_MUTATION_TARGET_KIND_VALUES) ?? null,
    patch_target_id: normalizeOptionalNonEmptyString(deps, 'patch_target_id', p.patch_target_id),
    patch_base_target_snapshot_hash: normalizeOptionalSnapshotHash(deps, 'patch_base_target_snapshot_hash', p.patch_base_target_snapshot_hash),
    patch_body: patchBody,
    patch_format: patchFormat,
    patch_operation_state: optionalEnumValue(
      deps,
      'patch_operation_state',
      p.patch_operation_state,
      options.operationStates ?? MEMORY_PATCH_OPERATION_STATE_VALUES,
    ) ?? null,
    patch_risk_class: optionalEnumValue(deps, 'patch_risk_class', p.patch_risk_class, MEMORY_PATCH_RISK_CLASS_VALUES) ?? null,
    patch_expected_resulting_target_snapshot_hash: normalizeOptionalSnapshotHash(
      deps,
      'patch_expected_resulting_target_snapshot_hash',
      p.patch_expected_resulting_target_snapshot_hash,
    ),
    patch_provenance_summary: normalizeOptionalNonEmptyString(deps, 'patch_provenance_summary', p.patch_provenance_summary),
    patch_actor: normalizeOptionalNonEmptyString(deps, 'patch_actor', p.patch_actor),
    patch_originating_session_id: normalizeOptionalNonEmptyString(deps, 'patch_originating_session_id', p.patch_originating_session_id),
    patch_ledger_event_ids: normalizeStringArray(deps, 'patch_ledger_event_ids', p.patch_ledger_event_ids),
  };
}

function assertNoPatchCandidateFields(
  deps: { OperationError: OperationErrorCtor },
  p: Record<string, unknown>,
): void {
  const field = MEMORY_PATCH_FIELD_NAMES.find((name) => Object.prototype.hasOwnProperty.call(p, name));
  if (field) {
    throw invalidParams(deps, `${field} is only accepted by create_memory_patch_candidate`);
  }
}

function assertNoPatchCandidateLifecycleOverrides(
  deps: { OperationError: OperationErrorCtor },
  p: Record<string, unknown>,
): void {
  for (const field of ['status', 'patch_operation_state', 'patch_ledger_event_ids'] as const) {
    if (Object.prototype.hasOwnProperty.call(p, field)) {
      throw invalidParams(deps, `${field} is managed by create_memory_patch_candidate`);
    }
  }
}

async function resolveCurrentPatchTargetSnapshotHash(
  deps: { OperationError: OperationErrorCtor },
  engine: BrainEngine,
  targetKind: MemoryMutationTargetKind,
  targetId: string,
): Promise<string | null> {
  try {
    const current = await resolveTargetSnapshotHash(engine, {
      target_kind: targetKind,
      target_id: targetId,
    });
    return current?.target_snapshot_hash ?? null;
  } catch (error) {
    if (error instanceof UnsupportedTargetSnapshotKindError) {
      throw invalidParams(deps, error.message);
    }
    throw error;
  }
}

function isScopeAllowedForRealm(scope: 'work' | 'personal' | 'mixed', scopeId: string): boolean {
  if (scope === 'mixed') return true;
  const personal = scopeId === 'personal' || scopeId.startsWith('personal:');
  const mixed = scopeId === 'mixed' || scopeId.startsWith('mixed:');
  if (scope === 'personal') return personal;
  return !personal && !mixed;
}

function targetObjectTypeForPatchTarget(
  targetKind: MemoryMutationTargetKind,
): (typeof MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES)[number] {
  switch (targetKind) {
    case 'page':
      return 'curated_note';
    case 'profile_memory':
      return 'profile_memory';
    case 'personal_episode':
      return 'personal_episode';
    case 'procedure':
      return 'procedure';
    default:
      return 'other';
  }
}

function normalizeOptionalIsoTimestamp(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw invalidParams(deps, `${field} must be a string or null`);
  }
  if (!isValidIsoDatetime(value)) {
    throw invalidParams(deps, `${field} must be a valid ISO datetime string`);
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

  const list_memory_candidate_status_events: Operation = {
    name: 'list_memory_candidate_status_events',
    description: 'List append-only memory-candidate lifecycle status events.',
    params: {
      candidate_id: { type: 'string', description: 'Optional candidate id filter' },
      scope_id: { type: 'string', description: 'Optional candidate storage scope id filter (default omitted)' },
      event_kind: {
        type: 'string',
        description: 'Optional status-event kind filter',
        enum: [...MEMORY_CANDIDATE_STATUS_EVENT_KIND_VALUES],
      },
      to_status: {
        type: 'string',
        description: 'Optional resulting candidate status filter',
        enum: [...MEMORY_CANDIDATE_STATUS_VALUES],
      },
      interaction_id: { type: 'string', description: 'Optional retrieval trace id filter' },
      limit: { type: 'number', description: `Max results (default 20, cap ${MAX_MEMORY_CANDIDATE_LIMIT})` },
      offset: { type: 'number', description: 'Offset for pagination (default 0)' },
    },
    handler: async (ctx, p) => {
      return ctx.engine.listMemoryCandidateStatusEvents({
        candidate_id: normalizeOptionalNonEmptyString(deps, 'candidate_id', p.candidate_id) ?? undefined,
        scope_id: normalizeOptionalNonEmptyString(deps, 'scope_id', p.scope_id) ?? undefined,
        event_kind: optionalEnumValue(deps, 'event_kind', p.event_kind, MEMORY_CANDIDATE_STATUS_EVENT_KIND_VALUES),
        to_status: optionalEnumValue(deps, 'to_status', p.to_status, MEMORY_CANDIDATE_STATUS_VALUES),
        interaction_id: normalizeOptionalNonEmptyString(deps, 'interaction_id', p.interaction_id) ?? undefined,
        limit: normalizeLimit(deps, p.limit),
        offset: normalizeOffset(deps, p.offset),
      });
    },
    cliHints: { name: 'list-memory-candidate-status-events', aliases: { n: 'limit' } },
  };

  const delete_memory_candidate_entry: Operation = {
    name: 'delete_memory_candidate_entry',
    description: 'Delete one memory-inbox candidate by id.',
    params: {
      id: { type: 'string', required: true, description: 'Memory candidate entry id' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const id = normalizeOptionalNonEmptyString(deps, 'id', p.id);
      if (!id) {
        throw invalidParams(deps, 'id must be a non-empty string');
      }
      if (ctx.dryRun) {
        return { dry_run: true, action: 'delete_memory_candidate_entry', id };
      }
      await ctx.engine.deleteMemoryCandidateEntry(id);
      return { status: 'deleted', id };
    },
    cliHints: { name: 'delete-memory-candidate', positional: ['id'] },
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
        enum: [...MEMORY_CANDIDATE_EARLY_STATUS_VALUES],
      },
      target_object_type: {
        type: 'string',
        description: 'Optional target object type',
        enum: [...MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES],
      },
      target_object_id: { type: 'string', description: 'Optional target object id' },
      reviewed_at: { type: 'string', description: 'Optional ISO timestamp for review metadata' },
      review_reason: { type: 'string', description: 'Optional review reason or audit note' },
      interaction_id: { type: 'string', description: 'Optional retrieval trace id for lifecycle event attribution' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      assertNoPatchCandidateFields(deps, p);
      const id = typeof p.id === 'string' ? p.id : crypto.randomUUID();
      const scopeId = String(p.scope_id ?? deps.defaultScopeId);
      const status = optionalEnumValue(deps, 'status', p.status, MEMORY_CANDIDATE_EARLY_STATUS_VALUES) ?? 'captured';
      const interactionId = normalizeOptionalNonEmptyString(deps, 'interaction_id', p.interaction_id);
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

      return createMemoryCandidateEntryWithStatusEvent(ctx.engine, {
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
        target_object_id: normalizeOptionalTargetObjectId(deps, p.target_object_id),
        reviewed_at: normalizeOptionalIsoTimestamp(deps, 'reviewed_at', p.reviewed_at) ?? null,
        review_reason: typeof p.review_reason === 'string' ? p.review_reason : null,
        interaction_id: interactionId,
      });
    },
    cliHints: { name: 'create-memory-candidate' },
  };

  const create_memory_patch_candidate: Operation = {
    name: 'create_memory_patch_candidate',
    description: 'Stage a reviewable patch candidate in the Memory Inbox without applying the patch to canonical memory.',
    params: {
      id: { type: 'string', description: 'Optional memory candidate id (generated when omitted)' },
      session_id: { type: 'string', required: true, description: 'Active originating memory session id' },
      realm_id: { type: 'string', required: true, description: 'Active memory realm id attached read-write to the session' },
      actor: { type: 'string', required: true, description: 'Actor proposing the patch candidate' },
      scope_id: { type: 'string', description: `Memory candidate scope id (default: ${deps.defaultScopeId})` },
      target_kind: { type: 'string', required: true, description: 'Canonical memory target kind for the proposed patch', enum: [...MEMORY_PATCH_TARGET_KIND_VALUES] },
      target_id: { type: 'string', required: true, description: 'Canonical memory target id for the proposed patch' },
      base_target_snapshot_hash: { type: 'string', required: true, nullable: true, description: 'Target snapshot hash observed before staging the patch; null only when the target is intentionally absent' },
      patch_body: { type: ['object', 'array'], required: true, description: 'Structured patch body to review later; json_patch accepts an RFC 6902 operation array.' },
      patch_format: { type: 'string', required: true, description: 'Patch body format', enum: [...MEMORY_PATCH_FORMAT_VALUES] },
      risk_class: { type: 'string', description: 'Patch review risk class', enum: [...MEMORY_PATCH_RISK_CLASS_VALUES] },
      expected_resulting_target_snapshot_hash: { type: 'string', nullable: true, description: 'Optional expected target snapshot hash after applying the patch' },
      provenance_summary: { type: 'string', description: 'Optional human-readable provenance summary for reviewers' },
      candidate_type: { type: 'string', description: 'Candidate type (default note_update)', enum: [...MEMORY_CANDIDATE_TYPE_VALUES] },
      proposed_content: { type: 'string', description: 'Review queue summary for this patch candidate' },
      source_refs: { type: 'array', required: true, items: { type: 'string' }, description: 'Required provenance strings' },
      generated_by: { type: 'string', description: 'Candidate generation source', enum: [...MEMORY_CANDIDATE_GENERATED_BY_VALUES] },
      extraction_kind: { type: 'string', description: 'Candidate extraction kind', enum: [...MEMORY_CANDIDATE_EXTRACTION_KIND_VALUES] },
      confidence_score: { type: 'number', description: 'Confidence score (default 0.5)' },
      importance_score: { type: 'number', description: 'Importance score (default 0.5)' },
      recurrence_score: { type: 'number', description: 'Recurrence score (default 0)' },
      sensitivity: { type: 'string', description: 'Candidate sensitivity', enum: [...MEMORY_CANDIDATE_SENSITIVITY_VALUES] },
      interaction_id: { type: 'string', description: 'Optional retrieval trace id for lifecycle event attribution' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      assertNoPatchCandidateLifecycleOverrides(deps, p);
      const id = typeof p.id === 'string' && p.id.trim().length > 0 ? p.id.trim() : crypto.randomUUID();
      const sessionId = normalizeOptionalNonEmptyString(deps, 'session_id', p.session_id);
      const realmId = normalizeOptionalNonEmptyString(deps, 'realm_id', p.realm_id);
      const actor = normalizeOptionalNonEmptyString(deps, 'actor', p.actor);
      if (!sessionId || !realmId || !actor) {
        throw invalidParams(deps, 'session_id, realm_id, and actor are required');
      }
      const scopeId = String(p.scope_id ?? deps.defaultScopeId);
      const targetKind = requireEnumValue(deps, 'target_kind', p.target_kind, MEMORY_PATCH_TARGET_KIND_VALUES);
      const targetId = normalizeOptionalNonEmptyString(deps, 'target_id', p.target_id);
      if (!targetId) {
        throw invalidParams(deps, 'target_id must be a non-empty string');
      }
      if (!Object.prototype.hasOwnProperty.call(p, 'base_target_snapshot_hash')) {
        throw invalidParams(deps, 'base_target_snapshot_hash is required; use null only for intentionally missing targets');
      }
      const sourceRefs = normalizeSourceRefs(deps, p);
      if (sourceRefs.length === 0) {
        throw invalidParams(deps, 'source_refs must contain at least one provenance reference');
      }
      const patchFields = normalizePatchCandidateFields(deps, {
        patch_target_kind: targetKind,
        patch_target_id: targetId,
        patch_base_target_snapshot_hash: p.base_target_snapshot_hash,
        patch_body: p.patch_body,
        patch_format: p.patch_format,
        patch_operation_state: 'proposed',
        patch_risk_class: p.risk_class ?? 'unknown',
        patch_expected_resulting_target_snapshot_hash: p.expected_resulting_target_snapshot_hash,
        patch_provenance_summary: p.provenance_summary,
        patch_actor: actor,
        patch_originating_session_id: sessionId,
      }, {
        requirePatchBody: true,
        operationStates: ['proposed'],
      });
      if (!patchFields.patch_format) {
        throw invalidParams(deps, 'patch_format must be one of: ' + MEMORY_PATCH_FORMAT_VALUES.join(', '));
      }

      const session = await ctx.engine.getMemorySession(sessionId);
      if (!session || session.status !== 'active') {
        throw invalidParams(deps, `memory session is not active: ${sessionId}`);
      }
      const realm = await ctx.engine.getMemoryRealm(realmId);
      if (!realm || realm.archived_at) {
        throw invalidParams(deps, `memory realm is not active: ${realmId}`);
      }
      const attachment = (await ctx.engine.listMemorySessionAttachments({
        session_id: sessionId,
        realm_id: realmId,
        limit: 1,
      }))[0] ?? null;
      if (!attachment || attachment.access !== 'read_write') {
        throw invalidParams(deps, `memory realm is not attached read-write to session: ${realmId}`);
      }
      if (!isScopeAllowedForRealm(realm.scope, scopeId)) {
        throw invalidParams(deps, `scope_id ${scopeId} is outside realm scope ${realm.scope}`);
      }

      const currentTargetSnapshotHash = await resolveCurrentPatchTargetSnapshotHash(deps, ctx.engine, targetKind, targetId);
      if (patchFields.patch_base_target_snapshot_hash !== currentTargetSnapshotHash) {
        throw invalidParams(deps, 'base_target_snapshot_hash does not match the current target snapshot hash');
      }

      const interactionId = normalizeOptionalNonEmptyString(deps, 'interaction_id', p.interaction_id);
      const candidateInput = {
        id,
        scope_id: scopeId,
        candidate_type: optionalEnumValue(deps, 'candidate_type', p.candidate_type, MEMORY_CANDIDATE_TYPE_VALUES) ?? 'note_update',
        proposed_content: typeof p.proposed_content === 'string' && p.proposed_content.trim().length > 0
          ? p.proposed_content
          : `Reviewable ${targetKind} patch for ${targetId}.`,
        source_refs: sourceRefs,
        generated_by: optionalEnumValue(deps, 'generated_by', p.generated_by, MEMORY_CANDIDATE_GENERATED_BY_VALUES) ?? 'agent',
        extraction_kind: optionalEnumValue(deps, 'extraction_kind', p.extraction_kind, MEMORY_CANDIDATE_EXTRACTION_KIND_VALUES) ?? 'manual',
        confidence_score: typeof p.confidence_score === 'number' ? p.confidence_score : 0.5,
        importance_score: typeof p.importance_score === 'number' ? p.importance_score : 0.5,
        recurrence_score: typeof p.recurrence_score === 'number' ? p.recurrence_score : 0,
        sensitivity: optionalEnumValue(deps, 'sensitivity', p.sensitivity, MEMORY_CANDIDATE_SENSITIVITY_VALUES) ?? 'work',
        status: 'staged_for_review' as const,
        target_object_type: targetObjectTypeForPatchTarget(targetKind),
        target_object_id: targetId,
        reviewed_at: null,
        review_reason: patchFields.patch_provenance_summary ?? null,
        ...patchFields,
      };

      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'create_memory_patch_candidate',
          candidate: candidateInput,
          ledger_recorded: false,
        };
      }

      return ctx.engine.transaction(async (txBase) => {
        const tx = txBase as BrainEngine;
        const event = await recordMemoryMutationEvent(tx, {
          session_id: sessionId,
          realm_id: realmId,
          actor,
          operation: 'create_memory_patch_candidate',
          target_kind: 'memory_candidate',
          target_id: id,
          scope_id: scopeId,
          source_refs: sourceRefs,
          result: 'staged_for_review',
          metadata: {
            patch_target_kind: targetKind,
            patch_target_id: targetId,
            patch_base_target_snapshot_hash: patchFields.patch_base_target_snapshot_hash,
            patch_current_target_snapshot_hash: currentTargetSnapshotHash,
            patch_expected_resulting_target_snapshot_hash: patchFields.patch_expected_resulting_target_snapshot_hash,
            patch_format: patchFields.patch_format,
            patch_operation_state: patchFields.patch_operation_state,
            patch_risk_class: patchFields.patch_risk_class,
          },
        });
        return createMemoryCandidateEntryWithStatusEvent(tx, {
          ...candidateInput,
          patch_ledger_event_ids: [event.id],
          interaction_id: interactionId,
        });
      });
    },
    cliHints: { name: 'create-memory-patch-candidate' },
  };

  const rank_memory_candidate_entries: Operation = {
    name: 'rank_memory_candidate_entries',
    description: 'Rank memory-inbox candidates deterministically for review ordering without mutating inbox state.',
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
      limit: { type: 'number', description: `Max results after ranking (default 20, cap ${MAX_MEMORY_CANDIDATE_LIMIT})` },
      offset: { type: 'number', description: 'Offset after ranking (default 0)' },
    },
    handler: async (ctx, p) => {
      const limit = normalizeLimit(deps, p.limit);
      const offset = normalizeOffset(deps, p.offset);
      const filters = {
        scope_id: String(p.scope_id ?? deps.defaultScopeId),
        status: optionalEnumValue(deps, 'status', p.status, MEMORY_CANDIDATE_STATUS_VALUES),
        candidate_type: optionalEnumValue(deps, 'candidate_type', p.candidate_type, MEMORY_CANDIDATE_TYPE_VALUES),
        target_object_type: optionalEnumValue(deps, 'target_object_type', p.target_object_type, MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES),
      };
      const candidates = await listAllRankableMemoryCandidates(ctx.engine, filters);

      return rankMemoryCandidateEntries(candidates).slice(offset, offset + limit);
    },
    cliHints: { name: 'rank-memory-candidates', aliases: { n: 'limit' } },
  };

  const capture_map_derived_candidates: Operation = {
    name: 'capture_map_derived_candidates',
    description: 'Capture context-map recommended reads as bounded inbox candidates without mutating canonical notes.',
    params: {
      map_id: { type: 'string', description: 'Optional explicit context-map id' },
      scope_id: { type: 'string', description: `Optional scope id when selecting the default map (default: ${deps.defaultScopeId})` },
      limit: { type: 'number', description: 'Optional smaller capture limit; defaults to the report read limit' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const mapId = typeof p.map_id === 'string' ? p.map_id : undefined;
      const scopeId = typeof p.scope_id === 'string' ? p.scope_id : undefined;
      const limit = p.limit == null ? undefined : normalizeLimit(deps, p.limit);
      if (ctx.dryRun) {
        const resolvedScopeId = mapId && !scopeId
          ? ((await getStructuralContextMapReport(ctx.engine, { map_id: mapId })).report?.scope_id ?? deps.defaultScopeId)
          : (scopeId ?? deps.defaultScopeId);
        return {
          dry_run: true,
          action: 'capture_map_derived_candidates',
          map_id: mapId ?? null,
          scope_id: resolvedScopeId,
          limit: limit ?? null,
        };
      }
      return captureMapDerivedCandidates(ctx.engine, {
        map_id: mapId,
        scope_id: scopeId,
        limit,
      });
    },
    cliHints: { name: 'capture-map-derived-candidates', aliases: { n: 'limit' } },
  };

  const list_memory_candidate_review_backlog: Operation = {
    name: 'list_memory_candidate_review_backlog',
    description: 'List a deduped memory-candidate review backlog without mutating stored candidates.',
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
      limit: { type: 'number', description: `Max backlog groups after dedup (default 20, cap ${MAX_MEMORY_CANDIDATE_LIMIT})` },
      offset: { type: 'number', description: 'Offset after dedup grouping (default 0)' },
    },
    handler: async (ctx, p) => {
      const limit = normalizeLimit(deps, p.limit);
      const offset = normalizeOffset(deps, p.offset);
      const candidates = await listAllFilteredMemoryCandidateEntries(ctx.engine, {
        scope_id: String(p.scope_id ?? deps.defaultScopeId),
        status: optionalEnumValue(deps, 'status', p.status, MEMORY_CANDIDATE_STATUS_VALUES),
        candidate_type: optionalEnumValue(deps, 'candidate_type', p.candidate_type, MEMORY_CANDIDATE_TYPE_VALUES),
        target_object_type: optionalEnumValue(deps, 'target_object_type', p.target_object_type, MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES),
      });
      return buildMemoryCandidateReviewBacklog(candidates).slice(offset, offset + limit);
    },
    cliHints: { name: 'list-memory-candidate-review-backlog', aliases: { n: 'limit' } },
  };

  const record_canonical_handoff: Operation = {
    name: 'record_canonical_handoff',
    description: 'Record one explicit canonical handoff row for a promoted memory candidate without mutating the canonical target.',
    params: {
      candidate_id: { type: 'string', required: true, description: 'Promoted memory candidate id' },
      reviewed_at: { type: 'string', description: 'Optional ISO timestamp for handoff review metadata' },
      review_reason: { type: 'string', description: 'Optional handoff review reason for auditability' },
      interaction_id: { type: 'string', description: 'Optional retrieval trace id for handoff attribution' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      if (typeof p.candidate_id !== 'string' || p.candidate_id.trim().length === 0) {
        throw invalidParams(deps, 'candidate_id must be a non-empty string');
      }
      if (p.review_reason != null && typeof p.review_reason !== 'string') {
        throw invalidParams(deps, 'review_reason must be a string or null');
      }
      const interactionId = normalizeOptionalNonEmptyString(deps, 'interaction_id', p.interaction_id);
      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'record_canonical_handoff',
          candidate_id: p.candidate_id,
          interaction_id: interactionId ?? null,
        };
      }

      try {
        return await recordCanonicalHandoff(ctx.engine, {
          candidate_id: p.candidate_id,
          reviewed_at: normalizeOptionalIsoTimestamp(deps, 'reviewed_at', p.reviewed_at),
          review_reason: typeof p.review_reason === 'string' ? p.review_reason : undefined,
          interaction_id: interactionId,
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
    cliHints: { name: 'record-canonical-handoff' },
  };

  const list_canonical_handoff_entries: Operation = {
    name: 'list_canonical_handoff_entries',
    description: 'List explicit canonical handoff records for auditability and downstream canonicalization.',
    params: {
      scope_id: { type: 'string', description: `Canonical handoff scope id (default: ${deps.defaultScopeId})` },
      candidate_id: { type: 'string', description: 'Optional memory candidate id filter' },
      target_object_type: {
        type: 'string',
        description: 'Optional canonical handoff target type filter',
        enum: [...CANONICAL_HANDOFF_TARGET_OBJECT_TYPE_VALUES],
      },
      limit: { type: 'number', description: `Max results (default 20, cap ${MAX_MEMORY_CANDIDATE_LIMIT})` },
      offset: { type: 'number', description: 'Offset for pagination (default 0)' },
    },
    handler: async (ctx, p) => {
      if (p.scope_id != null && (typeof p.scope_id !== 'string' || p.scope_id.trim().length === 0)) {
        throw invalidParams(deps, 'scope_id must be a non-empty string');
      }
      if (p.candidate_id != null && (typeof p.candidate_id !== 'string' || p.candidate_id.trim().length === 0)) {
        throw invalidParams(deps, 'candidate_id must be a non-empty string');
      }
      return ctx.engine.listCanonicalHandoffEntries({
        scope_id: String(p.scope_id ?? deps.defaultScopeId),
        candidate_id: typeof p.candidate_id === 'string' ? p.candidate_id : undefined,
        target_object_type: optionalEnumValue(
          deps,
          'target_object_type',
          p.target_object_type,
          CANONICAL_HANDOFF_TARGET_OBJECT_TYPE_VALUES,
        ),
        limit: normalizeLimit(deps, p.limit),
        offset: normalizeOffset(deps, p.offset),
      });
    },
    cliHints: { name: 'list-canonical-handoffs', aliases: { n: 'limit' } },
  };

  const assess_historical_validity: Operation = {
    name: 'assess_historical_validity',
    description: 'Assess whether a handed-off promoted candidate still represents current evidence for canonical consolidation.',
    params: {
      candidate_id: { type: 'string', required: true, description: 'Promoted memory candidate id' },
    },
    handler: async (ctx, p) => {
      if (typeof p.candidate_id !== 'string' || p.candidate_id.trim().length === 0) {
        throw invalidParams(deps, 'candidate_id must be a non-empty string');
      }
      try {
        return await assessHistoricalValidity(ctx.engine, {
          candidate_id: p.candidate_id,
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
    cliHints: { name: 'assess-historical-validity' },
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
      interaction_id: { type: 'string', description: 'Optional retrieval trace id for lifecycle event attribution' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const interactionId = normalizeOptionalNonEmptyString(deps, 'interaction_id', p.interaction_id);
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
          interaction_id: interactionId,
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

  const reject_memory_candidate_entry: Operation = {
    name: 'reject_memory_candidate_entry',
    description: 'Reject one staged memory-inbox candidate as an explicit governance outcome.',
    params: {
      id: { type: 'string', required: true, description: 'Memory candidate id' },
      reviewed_at: { type: 'string', description: 'Optional ISO timestamp for rejection metadata' },
      review_reason: { type: 'string', required: true, description: 'Explicit rejection reason for auditability' },
      interaction_id: { type: 'string', description: 'Optional retrieval trace id for lifecycle event attribution' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const reviewReason = typeof p.review_reason === 'string'
        ? p.review_reason
        : (() => { throw invalidParams(deps, 'review_reason must be a string'); })();
      const interactionId = normalizeOptionalNonEmptyString(deps, 'interaction_id', p.interaction_id);

      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'reject_memory_candidate_entry',
          id: p.id,
          review_reason: reviewReason,
        };
      }

      try {
        return await rejectMemoryCandidateEntry(ctx.engine, {
          id: String(p.id),
          reviewed_at: p.reviewed_at === null ? null : (typeof p.reviewed_at === 'string' ? p.reviewed_at : undefined),
          review_reason: reviewReason,
          interaction_id: interactionId,
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
    cliHints: { name: 'reject-memory-candidate' },
  };

  const preflight_promote_memory_candidate: Operation = {
    name: 'preflight_promote_memory_candidate',
    description: 'Run the deterministic governance preflight for promoting one staged memory candidate.',
    params: {
      id: { type: 'string', required: true, description: 'Memory candidate id' },
    },
    handler: async (ctx, p) => {
      if (typeof p.id !== 'string' || p.id.trim().length === 0) {
        throw invalidParams(deps, 'id must be a non-empty string');
      }
      try {
        return await preflightPromoteMemoryCandidate(ctx.engine, {
          id: p.id,
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
    cliHints: { name: 'preflight-promote-memory-candidate' },
  };

  const promote_memory_candidate_entry: Operation = {
    name: 'promote_memory_candidate_entry',
    description: 'Promote one staged memory-inbox candidate after deterministic promotion preflight passes.',
    params: {
      id: { type: 'string', required: true, description: 'Memory candidate id' },
      reviewed_at: { type: 'string', description: 'Optional ISO timestamp for promotion metadata' },
      review_reason: { type: 'string', description: 'Optional promotion reason for auditability' },
      interaction_id: { type: 'string', description: 'Optional retrieval trace id for lifecycle event attribution' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      if (typeof p.id !== 'string' || p.id.trim().length === 0) {
        throw invalidParams(deps, 'id must be a non-empty string');
      }
      if (p.reviewed_at != null && typeof p.reviewed_at !== 'string') {
        throw invalidParams(deps, 'reviewed_at must be a string or null');
      }
      if (p.review_reason != null && typeof p.review_reason !== 'string') {
        throw invalidParams(deps, 'review_reason must be a string or null');
      }
      const interactionId = normalizeOptionalNonEmptyString(deps, 'interaction_id', p.interaction_id);
      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'promote_memory_candidate_entry',
          id: p.id,
          review_reason: typeof p.review_reason === 'string' ? p.review_reason : null,
        };
      }

      try {
        return await promoteMemoryCandidateEntry(ctx.engine, {
          id: p.id,
          reviewed_at: p.reviewed_at === null ? null : (typeof p.reviewed_at === 'string' ? p.reviewed_at : undefined),
          review_reason: typeof p.review_reason === 'string' ? p.review_reason : undefined,
          interaction_id: interactionId,
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
    cliHints: { name: 'promote-memory-candidate' },
  };

  const supersede_memory_candidate_entry: Operation = {
    name: 'supersede_memory_candidate_entry',
    description: 'Record one explicit supersession outcome linking an older candidate to a newer promoted replacement.',
    params: {
      superseded_candidate_id: { type: 'string', required: true, description: 'Candidate id being superseded' },
      replacement_candidate_id: { type: 'string', required: true, description: 'Promoted replacement candidate id' },
      reviewed_at: { type: 'string', description: 'Optional ISO timestamp for supersession metadata' },
      review_reason: { type: 'string', description: 'Optional supersession reason for auditability' },
      interaction_id: { type: 'string', description: 'Optional retrieval trace id for lifecycle event attribution' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      if (typeof p.superseded_candidate_id !== 'string' || p.superseded_candidate_id.trim().length === 0) {
        throw invalidParams(deps, 'superseded_candidate_id must be a non-empty string');
      }
      if (typeof p.replacement_candidate_id !== 'string' || p.replacement_candidate_id.trim().length === 0) {
        throw invalidParams(deps, 'replacement_candidate_id must be a non-empty string');
      }
      if (p.review_reason != null && typeof p.review_reason !== 'string') {
        throw invalidParams(deps, 'review_reason must be a string or null');
      }
      const interactionId = normalizeOptionalNonEmptyString(deps, 'interaction_id', p.interaction_id);
      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'supersede_memory_candidate_entry',
          superseded_candidate_id: p.superseded_candidate_id,
          replacement_candidate_id: p.replacement_candidate_id,
          review_reason: typeof p.review_reason === 'string' ? p.review_reason : null,
        };
      }

      try {
        return await supersedeMemoryCandidateEntry(ctx.engine, {
          superseded_candidate_id: p.superseded_candidate_id,
          replacement_candidate_id: p.replacement_candidate_id,
          reviewed_at: normalizeOptionalIsoTimestamp(deps, 'reviewed_at', p.reviewed_at),
          review_reason: typeof p.review_reason === 'string' ? p.review_reason : undefined,
          interaction_id: interactionId,
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
    cliHints: { name: 'supersede-memory-candidate' },
  };

  const resolve_memory_candidate_contradiction: Operation = {
    name: 'resolve_memory_candidate_contradiction',
    description: 'Resolve one contradiction between a challenger candidate and an existing challenged candidate.',
    params: {
      candidate_id: { type: 'string', required: true, description: 'Challenger candidate id' },
      challenged_candidate_id: { type: 'string', required: true, description: 'Existing challenged candidate id' },
      outcome: {
        type: 'string',
        required: true,
        description: 'Contradiction outcome',
        enum: [...MEMORY_CANDIDATE_CONTRADICTION_OUTCOME_VALUES],
      },
      reviewed_at: { type: 'string', description: 'Optional ISO timestamp for contradiction review metadata' },
      review_reason: { type: 'string', description: 'Optional contradiction review reason' },
      interaction_id: { type: 'string', description: 'Optional retrieval trace id for lifecycle event attribution' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      if (typeof p.candidate_id !== 'string' || p.candidate_id.trim().length === 0) {
        throw invalidParams(deps, 'candidate_id must be a non-empty string');
      }
      if (typeof p.challenged_candidate_id !== 'string' || p.challenged_candidate_id.trim().length === 0) {
        throw invalidParams(deps, 'challenged_candidate_id must be a non-empty string');
      }
      const outcome = requireEnumValue(
        deps,
        'outcome',
        p.outcome,
        MEMORY_CANDIDATE_CONTRADICTION_OUTCOME_VALUES,
      );
      if (p.review_reason != null && typeof p.review_reason !== 'string') {
        throw invalidParams(deps, 'review_reason must be a string or null');
      }
      const interactionId = normalizeOptionalNonEmptyString(deps, 'interaction_id', p.interaction_id);
      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'resolve_memory_candidate_contradiction',
          candidate_id: p.candidate_id,
          challenged_candidate_id: p.challenged_candidate_id,
          outcome,
        };
      }

      try {
        return await resolveMemoryCandidateContradiction(ctx.engine, {
          candidate_id: p.candidate_id,
          challenged_candidate_id: p.challenged_candidate_id,
          outcome,
          reviewed_at: normalizeOptionalIsoTimestamp(deps, 'reviewed_at', p.reviewed_at),
          review_reason: typeof p.review_reason === 'string' ? p.review_reason : undefined,
          interaction_id: interactionId,
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
    cliHints: { name: 'resolve-memory-candidate-contradiction' },
  };

  const run_dream_cycle_maintenance: Operation = {
    name: 'run_dream_cycle_maintenance',
    description: 'Run bounded dream-cycle maintenance and emit candidate-only Memory Inbox suggestions.',
    params: {
      scope_id: { type: 'string', description: `Memory candidate scope id (default: ${deps.defaultScopeId})` },
      now: { type: 'string', description: 'Optional ISO datetime used for stale-claim checks' },
      limit: { type: 'number', description: `Max emitted suggestions (default 20, cap ${MAX_MEMORY_CANDIDATE_LIMIT})` },
    },
    mutating: true,
    handler: async (ctx, p) => {
      if (p.scope_id != null && (typeof p.scope_id !== 'string' || p.scope_id.trim().length === 0)) {
        throw invalidParams(deps, 'scope_id must be a non-empty string');
      }
      const now = normalizeOptionalIsoTimestamp(deps, 'now', p.now);
      try {
        return await runDreamCycleMaintenance(ctx.engine, {
          scope_id: String(p.scope_id ?? deps.defaultScopeId),
          now: now ?? undefined,
          limit: normalizeLimit(deps, p.limit),
          write_candidates: !ctx.dryRun,
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
    cliHints: { name: 'run-dream-cycle-maintenance', aliases: { n: 'limit' } },
  };

  return [
    get_memory_candidate_entry,
    list_memory_candidate_entries,
    list_memory_candidate_status_events,
    delete_memory_candidate_entry,
    create_memory_candidate_entry,
    create_memory_patch_candidate,
    rank_memory_candidate_entries,
    capture_map_derived_candidates,
    list_memory_candidate_review_backlog,
    record_canonical_handoff,
    list_canonical_handoff_entries,
    assess_historical_validity,
    advance_memory_candidate_status,
    reject_memory_candidate_entry,
    preflight_promote_memory_candidate,
    promote_memory_candidate_entry,
    supersede_memory_candidate_entry,
    resolve_memory_candidate_contradiction,
    run_dream_cycle_maintenance,
  ];
}

async function listAllRankableMemoryCandidates(
  engine: BrainEngine,
  filters: Omit<MemoryCandidateListFilters, 'limit' | 'offset'>,
) {
  const candidates: Awaited<ReturnType<BrainEngine['listMemoryCandidateEntries']>> = [];
  for (let offset = 0; ; offset += MAX_MEMORY_CANDIDATE_LIMIT) {
    const page = await engine.listMemoryCandidateEntries({
      ...filters,
      limit: MAX_MEMORY_CANDIDATE_LIMIT,
      offset,
    });
    candidates.push(...page);
    if (page.length < MAX_MEMORY_CANDIDATE_LIMIT) {
      return candidates;
    }
  }
}
