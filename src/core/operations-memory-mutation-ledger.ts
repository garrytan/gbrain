import { randomUUID } from 'crypto';
import type { Operation } from './operations.ts';
import { recordMemoryMutationEvent } from './services/memory-mutation-ledger-service.ts';
import type {
  MemoryMutationEventFilters,
  MemoryMutationEventInput,
  MemoryMutationOperationName,
  MemoryMutationRedactionVisibility,
  MemoryMutationResult,
  MemoryMutationTargetKind,
} from './types.ts';

type OperationErrorCtor = new (
  code: 'invalid_params',
  message: string,
  suggestion?: string,
  docs?: string,
) => Error;

const MEMORY_MUTATION_RESULTS = [
  'dry_run',
  'staged_for_review',
  'applied',
  'conflict',
  'denied',
  'failed',
  'redacted',
] as const satisfies readonly MemoryMutationResult[];

const MEMORY_MUTATION_REDACTION_VISIBILITIES = [
  'visible',
  'partially_redacted',
  'tombstoned',
] as const satisfies readonly MemoryMutationRedactionVisibility[];

const MEMORY_MUTATION_TARGET_KINDS = [
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

const MEMORY_MUTATION_OPERATION_NAMES = [
  'create_memory_session',
  'close_memory_session',
  'expire_memory_session',
  'revoke_memory_session',
  'dry_run_memory_mutation',
  'list_memory_mutation_events',
  'record_memory_mutation_event',
  'create_memory_patch_candidate',
  'dry_run_memory_patch_candidate',
  'review_memory_patch_candidate',
  'apply_memory_patch_candidate',
  'create_redaction_plan',
  'dry_run_redaction_plan',
  'execute_redaction_plan',
  'put_page',
  'delete_page',
  'upsert_profile_memory_entry',
  'write_profile_memory_entry',
  'delete_profile_memory_entry',
  'record_personal_episode',
  'write_personal_episode_entry',
  'delete_personal_episode_entry',
  'upsert_memory_realm',
  'attach_memory_realm_to_session',
  'create_memory_candidate_entry',
  'advance_memory_candidate_status',
  'reject_memory_candidate_entry',
  'delete_memory_candidate_entry',
  'promote_memory_candidate_entry',
  'supersede_memory_candidate_entry',
  'export_memory_artifact',
  'sync_memory_artifact',
  'repair_memory_ledger',
  'physical_delete_memory_record',
] as const satisfies readonly MemoryMutationOperationName[];

const ISO_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function invalidParams(
  deps: { OperationError: OperationErrorCtor },
  message: string,
): Error {
  return new deps.OperationError('invalid_params', message);
}

function requiredString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidParams(deps, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | undefined {
  if (value == null) return undefined;
  return requiredString(deps, field, value);
}

function optionalNullableString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | null | undefined {
  if (value === null) return null;
  return optionalString(deps, field, value);
}

function enumValue<T extends string>(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
  allowed: readonly T[],
  required = false,
): T | undefined {
  if (value == null) {
    if (required) {
      throw invalidParams(deps, `${field} must be one of: ${allowed.join(', ')}`);
    }
    return undefined;
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw invalidParams(deps, `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function isoDate(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): Date | undefined {
  if (value == null) return undefined;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== 'string' || !isValidIsoDatetime(value)) {
    throw invalidParams(deps, `${field} must be an ISO timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw invalidParams(deps, `${field} must be a valid ISO timestamp`);
  }
  return parsed;
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

function integerParam(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
  options: { defaultValue: number; min: number; max?: number },
): number {
  if (value == null) return options.defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < options.min) {
    throw invalidParams(deps, `${field} must be an integer greater than or equal to ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw invalidParams(deps, `${field} must be less than or equal to ${options.max}`);
  }
  return value;
}

function optionalBoolean(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'boolean') {
    throw invalidParams(deps, `${field} must be a boolean`);
  }
  return value;
}

function optionalObject(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalidParams(deps, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredSourceRefs(
  deps: { OperationError: OperationErrorCtor },
  params: Record<string, unknown>,
): string[] {
  const rawRefs = params.source_refs;
  if (Array.isArray(rawRefs)) {
    if (rawRefs.length === 0) {
      throw invalidParams(deps, 'source_refs must contain at least one provenance reference');
    }
    return rawRefs.map((ref, index) => requiredString(deps, `source_refs[${index}]`, ref));
  }
  throw invalidParams(deps, 'source_refs must be a non-empty array of strings');
}

function listFilters(
  deps: { OperationError: OperationErrorCtor },
  p: Record<string, unknown>,
): MemoryMutationEventFilters {
  return {
    session_id: optionalString(deps, 'session_id', p.session_id),
    realm_id: optionalString(deps, 'realm_id', p.realm_id),
    actor: optionalString(deps, 'actor', p.actor),
    operation: enumValue(deps, 'operation', p.operation, MEMORY_MUTATION_OPERATION_NAMES),
    target_kind: enumValue(deps, 'target_kind', p.target_kind, MEMORY_MUTATION_TARGET_KINDS),
    target_id: optionalString(deps, 'target_id', p.target_id),
    scope_id: optionalString(deps, 'scope_id', p.scope_id),
    result: enumValue(deps, 'result', p.result, MEMORY_MUTATION_RESULTS),
    created_since: isoDate(deps, 'created_since', p.created_since),
    created_until: isoDate(deps, 'created_until', p.created_until),
    limit: integerParam(deps, 'limit', p.limit, { defaultValue: 20, min: 0, max: 100 }),
    offset: integerParam(deps, 'offset', p.offset, { defaultValue: 0, min: 0 }),
  };
}

function recordInput(
  deps: {
    OperationError: OperationErrorCtor;
    allowPrivilegedLedgerRecord?: () => boolean;
  },
  p: Record<string, unknown>,
): MemoryMutationEventInput & { privileged_reason: string } {
  if (p.privileged !== true) {
    throw invalidParams(deps, 'record_memory_mutation_event requires privileged: true');
  }
  const privilegedReason = requiredString(deps, 'privileged_reason', p.privileged_reason);
  if (deps.allowPrivilegedLedgerRecord?.() !== true) {
    throw invalidParams(deps, 'record_memory_mutation_event requires runtime privileged ledger recording to be enabled');
  }
  const metadata = optionalObject(deps, 'metadata', p.metadata) ?? {};
  const result = enumValue(deps, 'result', p.result, MEMORY_MUTATION_RESULTS, true)!;
  const mutationDryRun = optionalBoolean(deps, 'mutation_dry_run', p.mutation_dry_run);
  if (result === 'dry_run' && mutationDryRun === false) {
    throw invalidParams(deps, 'mutation_dry_run cannot be false when result is dry_run');
  }
  if (result !== 'dry_run' && mutationDryRun === true) {
    throw invalidParams(deps, 'mutation_dry_run can only be true when result is dry_run');
  }

  return {
    privileged_reason: privilegedReason,
    id: optionalString(deps, 'id', p.id) ?? randomUUID(),
    session_id: requiredString(deps, 'session_id', p.session_id),
    realm_id: requiredString(deps, 'realm_id', p.realm_id),
    actor: requiredString(deps, 'actor', p.actor),
    operation: enumValue(deps, 'operation', p.operation, MEMORY_MUTATION_OPERATION_NAMES, true)!,
    target_kind: enumValue(deps, 'target_kind', p.target_kind, MEMORY_MUTATION_TARGET_KINDS, true)!,
    target_id: requiredString(deps, 'target_id', p.target_id),
    scope_id: optionalNullableString(deps, 'scope_id', p.scope_id),
    source_refs: requiredSourceRefs(deps, p),
    expected_target_snapshot_hash: optionalNullableString(deps, 'expected_target_snapshot_hash', p.expected_target_snapshot_hash),
    current_target_snapshot_hash: optionalNullableString(deps, 'current_target_snapshot_hash', p.current_target_snapshot_hash),
    result,
    conflict_info: optionalObject(deps, 'conflict_info', p.conflict_info),
    dry_run: result === 'dry_run',
    metadata: { ...metadata, privileged_reason: privilegedReason },
    redaction_visibility: enumValue(deps, 'redaction_visibility', p.redaction_visibility, MEMORY_MUTATION_REDACTION_VISIBILITIES),
    created_at: isoDate(deps, 'created_at', p.created_at),
    decided_at: isoDate(deps, 'decided_at', p.decided_at),
    applied_at: isoDate(deps, 'applied_at', p.applied_at),
  };
}

export function createMemoryMutationLedgerOperations(
  deps: {
    OperationError: OperationErrorCtor;
    allowPrivilegedLedgerRecord?: () => boolean;
  },
): Operation[] {
  const list_memory_mutation_events: Operation = {
    name: 'list_memory_mutation_events',
    description: 'List memory mutation ledger events. Read-only audit operation for import/repair and transactional-service observability.',
    params: {
      session_id: { type: 'string' },
      realm_id: { type: 'string' },
      actor: { type: 'string' },
      operation: { type: 'string', enum: [...MEMORY_MUTATION_OPERATION_NAMES] },
      target_kind: { type: 'string', enum: [...MEMORY_MUTATION_TARGET_KINDS] },
      target_id: { type: 'string' },
      scope_id: { type: 'string' },
      result: { type: 'string', enum: [...MEMORY_MUTATION_RESULTS] },
      created_since: { type: 'string', description: 'Inclusive ISO timestamp lower bound.' },
      created_until: { type: 'string', description: 'Exclusive ISO timestamp upper bound.' },
      limit: { type: 'number', default: 20, description: 'Page size. Default 20, max 100.' },
      offset: { type: 'number', default: 0, description: 'Pagination offset. Default 0.' },
    },
    mutating: false,
    handler: async (ctx, p) => ctx.engine.listMemoryMutationEvents(listFilters(deps, p)),
    cliHints: { name: 'memory-mutation-events-list', aliases: { n: 'limit' } },
  };

  const record_memory_mutation_event: Operation = {
    name: 'record_memory_mutation_event',
    description: 'Privileged import/repair/transactional-service ledger recording only. This is not a normal user memory mutation write path and requires privileged: true plus privileged_reason.',
    params: {
      privileged: { type: 'boolean', required: true, description: 'Must be true to make the privileged import/repair boundary explicit.' },
      privileged_reason: { type: 'string', required: true, description: 'Non-empty reason for privileged import/repair/transactional-service recording.' },
      id: { type: 'string', description: 'Optional ledger event id. Generated when omitted.' },
      session_id: { type: 'string', required: true },
      realm_id: { type: 'string', required: true },
      actor: { type: 'string', required: true },
      operation: { type: 'string', required: true, enum: [...MEMORY_MUTATION_OPERATION_NAMES] },
      target_kind: { type: 'string', required: true, enum: [...MEMORY_MUTATION_TARGET_KINDS] },
      target_id: { type: 'string', required: true },
      scope_id: { type: 'string' },
      source_refs: { type: 'array', required: true, items: { type: 'string' }, description: 'Required provenance references.' },
      expected_target_snapshot_hash: { type: 'string' },
      current_target_snapshot_hash: { type: 'string' },
      result: { type: 'string', required: true, enum: [...MEMORY_MUTATION_RESULTS] },
      conflict_info: { type: 'object' },
      dry_run: { type: 'boolean', description: 'Preview recording without inserting a ledger event.' },
      mutation_dry_run: { type: 'boolean', description: 'Whether the underlying memory mutation result being recorded was a dry run. Must match result=dry_run.' },
      metadata: { type: 'object', description: 'Additional event metadata. privileged_reason is added here.' },
      redaction_visibility: { type: 'string', enum: [...MEMORY_MUTATION_REDACTION_VISIBILITIES] },
      created_at: { type: 'string', description: 'Optional ISO timestamp.' },
      decided_at: { type: 'string', description: 'Optional ISO timestamp.' },
      applied_at: { type: 'string', description: 'Optional ISO timestamp.' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const preview = ctx.dryRun || optionalBoolean(deps, 'dry_run', p.dry_run) === true;
      const input = recordInput(deps, p);
      const { privileged_reason: _privilegedReason, ...eventInput } = input;
      if (preview) {
        return {
          action: 'record_memory_mutation_event',
          dry_run: true,
          event: eventInput,
        };
      }
      return recordMemoryMutationEvent(ctx.engine, eventInput);
    },
    cliHints: { name: 'memory-mutation-event-record' },
  };

  return [list_memory_mutation_events, record_memory_mutation_event];
}
