import type {
  MemoryRealm,
  MemoryRealmInput,
  MemoryRedactionPlanInput,
  MemoryRedactionPlanItemInput,
  MemoryRedactionPlanItemStatusPatch,
  MemoryRedactionPlanStatusPatch,
  MemorySession,
  MemorySessionAttachmentInput,
  MemorySessionInput,
} from '../types.ts';
import { hasOwn, parseValidIsoTimestamp } from './validation.ts';

export function normalizeMemoryRealmInput(input: MemoryRealmInput): MemoryRealmInput {
  const id = normalizeRequiredMemoryRealmString('id', input.id);
  const name = normalizeRequiredMemoryRealmString('name', input.name);
  if (!['work', 'personal', 'mixed'].includes(input.scope)) {
    throw new Error('memory realm scope must be one of: work, personal, mixed');
  }
  if (input.default_access !== undefined && !['read_only', 'read_write'].includes(input.default_access)) {
    throw new Error('memory realm default_access must be one of: read_only, read_write');
  }

  const normalized: MemoryRealmInput = {
    id,
    name,
    scope: input.scope,
  };

  if (input.description !== undefined) {
    normalized.description = normalizeOptionalMemoryRealmString('description', input.description);
  }
  if (input.default_access !== undefined) {
    normalized.default_access = input.default_access;
  }
  if (input.retention_policy !== undefined) {
    normalized.retention_policy = normalizeOptionalMemoryRealmString('retention_policy', input.retention_policy);
  }
  if (input.export_policy !== undefined) {
    normalized.export_policy = normalizeOptionalMemoryRealmString('export_policy', input.export_policy);
  }
  if (input.agent_instructions !== undefined) {
    normalized.agent_instructions = normalizeOptionalMemoryRealmString('agent_instructions', input.agent_instructions);
  }
  if (input.archived_at !== undefined) {
    normalized.archived_at = normalizeOptionalMemoryRealmTimestamp('archived_at', input.archived_at);
  }

  return normalized;
}

export function applyMemoryRealmUpsertDefaults(
  input: MemoryRealmInput,
  existing: MemoryRealm | null,
): Required<MemoryRealmInput> {
  return {
    id: input.id,
    name: input.name,
    description: hasOwn(input, 'description')
      ? input.description ?? ''
      : existing?.description ?? '',
    scope: input.scope,
    default_access: hasOwn(input, 'default_access')
      ? input.default_access ?? 'read_only'
      : existing?.default_access ?? 'read_only',
    retention_policy: hasOwn(input, 'retention_policy')
      ? input.retention_policy ?? 'retain'
      : existing?.retention_policy ?? 'retain',
    export_policy: hasOwn(input, 'export_policy')
      ? input.export_policy ?? 'private'
      : existing?.export_policy ?? 'private',
    agent_instructions: hasOwn(input, 'agent_instructions')
      ? input.agent_instructions ?? ''
      : existing?.agent_instructions ?? '',
    archived_at: hasOwn(input, 'archived_at')
      ? input.archived_at ?? null
      : existing?.archived_at ?? null,
  };
}

export function normalizeMemorySessionInput(input: MemorySessionInput): MemorySessionInput {
  const normalized: MemorySessionInput = {
    id: normalizeRequiredMemorySessionString('id', input.id),
  };
  if (input.task_id !== undefined) {
    normalized.task_id = normalizeOptionalMemorySessionString('task_id', input.task_id);
  }
  if (input.actor_ref !== undefined) {
    normalized.actor_ref = normalizeOptionalMemorySessionString('actor_ref', input.actor_ref);
  }
  if (input.expires_at !== undefined) {
    normalized.expires_at = normalizeOptionalMemorySessionTimestamp('expires_at', input.expires_at);
  }
  return normalized;
}

export function applyMemorySessionCreateDefaults(input: MemorySessionInput): {
  id: string;
  task_id: string | null;
  status: MemorySession['status'];
  actor_ref: string | null;
  expires_at: Date | null;
} {
  const expiresAt = input.expires_at === undefined
    ? null
    : normalizeOptionalMemorySessionTimestamp('expires_at', input.expires_at);
  return {
    id: input.id,
    task_id: input.task_id ?? null,
    status: effectiveMemorySessionStatus('active', expiresAt),
    actor_ref: input.actor_ref ?? null,
    expires_at: expiresAt,
  };
}

export function normalizeMemorySessionAttachmentInput(
  input: MemorySessionAttachmentInput,
): Required<MemorySessionAttachmentInput> {
  const access = input.access;
  if (!['read_only', 'read_write'].includes(access)) {
    throw new Error('memory session attachment access must be one of: read_only, read_write');
  }
  return {
    session_id: normalizeRequiredMemorySessionString('session_id', input.session_id),
    realm_id: normalizeRequiredMemorySessionString('realm_id', input.realm_id),
    access,
    instructions: input.instructions === undefined
      ? ''
      : normalizeMemorySessionAttachmentInstructions(input.instructions),
  };
}

const MEMORY_REDACTION_PLAN_STATUSES = ['draft', 'approved', 'applied', 'rejected'] as const;
const MEMORY_REDACTION_TARGET_TYPES = [
  'page',
  'page_version',
  'profile_memory',
  'personal_episode',
  'memory_candidate',
  'retrieval_trace',
  'ingest_log',
] as const;
const MEMORY_REDACTION_ITEM_STATUSES = ['planned', 'applied', 'unsupported'] as const;

export function normalizeMemoryRedactionPlanInput(
  input: MemoryRedactionPlanInput,
): Required<MemoryRedactionPlanInput> {
  const status = input.status ?? 'draft';
  if (!MEMORY_REDACTION_PLAN_STATUSES.includes(status)) {
    throw new Error('memory redaction plan status must be one of: draft, approved, applied, rejected');
  }
  return {
    id: normalizeRequiredMemoryRedactionString('plan id', input.id),
    scope_id: normalizeRequiredMemoryRedactionString('scope_id', input.scope_id),
    query: normalizeRequiredMemoryRedactionString('query', input.query),
    replacement_text: input.replacement_text === undefined
      ? '[REDACTED]'
      : normalizeMemoryRedactionText('replacement_text', input.replacement_text),
    status,
    requested_by: normalizeNullableMemoryRedactionString('requested_by', input.requested_by ?? null),
    review_reason: normalizeNullableMemoryRedactionString('review_reason', input.review_reason ?? null),
    created_at: normalizeNullableMemoryRedactionTimestamp('created_at', input.created_at ?? null),
    reviewed_at: normalizeNullableMemoryRedactionTimestamp('reviewed_at', input.reviewed_at ?? null),
    applied_at: normalizeNullableMemoryRedactionTimestamp('applied_at', input.applied_at ?? null),
  };
}

export function normalizeMemoryRedactionPlanStatusPatch(
  patch: MemoryRedactionPlanStatusPatch,
): MemoryRedactionPlanStatusPatch {
  if (!MEMORY_REDACTION_PLAN_STATUSES.includes(patch.status)) {
    throw new Error('memory redaction plan status must be one of: draft, approved, applied, rejected');
  }
  if (
    patch.expected_current_status !== undefined
    && !MEMORY_REDACTION_PLAN_STATUSES.includes(patch.expected_current_status)
  ) {
    throw new Error('memory redaction plan expected_current_status must be one of: draft, approved, applied, rejected');
  }
  return {
    status: patch.status,
    ...(patch.expected_current_status !== undefined
      ? { expected_current_status: patch.expected_current_status }
      : {}),
    ...(patch.query !== undefined
      ? { query: normalizeRequiredMemoryRedactionString('query', patch.query) }
      : {}),
    ...(patch.replacement_text !== undefined
      ? { replacement_text: normalizeMemoryRedactionText('replacement_text', patch.replacement_text) }
      : {}),
    ...(patch.review_reason !== undefined
      ? { review_reason: normalizeNullableMemoryRedactionString('review_reason', patch.review_reason) }
      : {}),
    ...(patch.reviewed_at !== undefined
      ? { reviewed_at: normalizeNullableMemoryRedactionTimestamp('reviewed_at', patch.reviewed_at) }
      : {}),
    ...(patch.applied_at !== undefined
      ? { applied_at: normalizeNullableMemoryRedactionTimestamp('applied_at', patch.applied_at) }
      : {}),
  };
}

export function normalizeMemoryRedactionPlanItemInput(
  input: MemoryRedactionPlanItemInput,
): Required<MemoryRedactionPlanItemInput> {
  const targetType = input.target_object_type;
  const status = input.status ?? 'planned';
  if (!MEMORY_REDACTION_TARGET_TYPES.includes(targetType)) {
    throw new Error('memory redaction item target_object_type is unsupported');
  }
  if (!MEMORY_REDACTION_ITEM_STATUSES.includes(status)) {
    throw new Error('memory redaction item status must be one of: planned, applied, unsupported');
  }
  return {
    id: normalizeRequiredMemoryRedactionString('item id', input.id),
    plan_id: normalizeRequiredMemoryRedactionString('plan_id', input.plan_id),
    target_object_type: targetType,
    target_object_id: normalizeRequiredMemoryRedactionString('target_object_id', input.target_object_id),
    field_path: normalizeRequiredMemoryRedactionString('field_path', input.field_path),
    before_hash: normalizeNullableMemoryRedactionString('before_hash', input.before_hash ?? null),
    after_hash: normalizeNullableMemoryRedactionString('after_hash', input.after_hash ?? null),
    status,
    preview_text: input.preview_text === undefined
      ? ''
      : normalizeMemoryRedactionText('preview_text', input.preview_text),
    created_at: normalizeNullableMemoryRedactionTimestamp('created_at', input.created_at ?? null),
    updated_at: normalizeNullableMemoryRedactionTimestamp('updated_at', input.updated_at ?? null),
  };
}

export function normalizeMemoryRedactionPlanItemStatusPatch(
  patch: MemoryRedactionPlanItemStatusPatch,
): MemoryRedactionPlanItemStatusPatch {
  if (!MEMORY_REDACTION_ITEM_STATUSES.includes(patch.status)) {
    throw new Error('memory redaction item status must be one of: planned, applied, unsupported');
  }
  if (
    patch.expected_current_status !== undefined
    && !MEMORY_REDACTION_ITEM_STATUSES.includes(patch.expected_current_status)
  ) {
    throw new Error('memory redaction item expected_current_status must be one of: planned, applied, unsupported');
  }
  return {
    status: patch.status,
    ...(patch.expected_current_status !== undefined
      ? { expected_current_status: patch.expected_current_status }
      : {}),
    ...(patch.before_hash !== undefined
      ? { before_hash: normalizeNullableMemoryRedactionString('before_hash', patch.before_hash) }
      : {}),
    ...(patch.after_hash !== undefined
      ? { after_hash: normalizeNullableMemoryRedactionString('after_hash', patch.after_hash) }
      : {}),
    ...(patch.updated_at !== undefined
      ? { updated_at: normalizeNullableMemoryRedactionTimestamp('updated_at', patch.updated_at) }
      : {}),
  };
}

function normalizeRequiredMemoryRealmString(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`memory realm ${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOptionalMemoryRealmString(field: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`memory realm ${field} must be a string`);
  }
  return value;
}

function normalizeRequiredMemorySessionString(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`memory session ${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOptionalMemorySessionString(field: string, value: unknown): string | null {
  if (value === null) return null;
  return normalizeRequiredMemorySessionString(field, value);
}

function normalizeOptionalMemorySessionTimestamp(
  field: string,
  value: Date | string | null,
): Date | null {
  if (value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`memory session ${field} must be a valid timestamp`);
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new Error(`memory session ${field} must be a valid timestamp`);
  }
  const parsed = parseValidIsoTimestamp(value);
  if (!parsed) {
    throw new Error(`memory session ${field} must be a valid timestamp`);
  }
  return parsed;
}

function effectiveMemorySessionStatus(
  status: MemorySession['status'],
  expiresAt: Date | null,
  now = new Date(),
): MemorySession['status'] {
  if (status === 'active' && expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  return status;
}

function normalizeMemorySessionAttachmentInstructions(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('memory session attachment instructions must be a string');
  }
  return value;
}

function normalizeRequiredMemoryRedactionString(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`memory redaction ${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeMemoryRedactionText(field: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`memory redaction ${field} must be a string`);
  }
  return value;
}

function normalizeNullableMemoryRedactionString(field: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return normalizeRequiredMemoryRedactionString(field, value);
}

function normalizeNullableMemoryRedactionTimestamp(
  field: string,
  value: Date | string | null,
): Date | null {
  if (value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`memory redaction ${field} must be a valid timestamp`);
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new Error(`memory redaction ${field} must be a valid timestamp`);
  }
  const parsed = parseValidIsoTimestamp(value);
  if (!parsed) {
    throw new Error(`memory redaction ${field} must be a valid timestamp`);
  }
  return parsed;
}

function normalizeOptionalMemoryRealmTimestamp(
  field: string,
  value: Date | string | null,
): Date | null {
  if (value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`memory realm ${field} must be a valid timestamp`);
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new Error(`memory realm ${field} must be a valid timestamp`);
  }
  const parsed = parseValidIsoTimestamp(value);
  if (!parsed) {
    throw new Error(`memory realm ${field} must be a valid timestamp`);
  }
  return parsed;
}
