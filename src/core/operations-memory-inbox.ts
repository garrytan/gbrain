import type { Operation } from './operations.ts';
import type { BrainEngine } from './engine.ts';
import { importFromContent } from './import-file.ts';
import { parseMarkdown, serializeMarkdown } from './markdown.ts';
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
import {
  reviewDuplicateMemory,
  type DuplicateMemorySubjectKind,
} from './services/duplicate-memory-review-service.ts';
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
import { contentHash, importContentHash } from './utils.ts';
import type {
  MemoryCandidateEntry,
  MemoryMutationTargetKind,
  MemoryPatchOperationState,
  Page,
  PageType,
} from './types.ts';

type OperationErrorCtor = new (
  code: any,
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
const DUPLICATE_MEMORY_SUBJECT_KIND_VALUES = ['page', 'memory_candidate', 'proposed_memory'] as const satisfies readonly DuplicateMemorySubjectKind[];
const CANONICAL_HANDOFF_TARGET_OBJECT_TYPE_VALUES = ['curated_note', 'procedure', 'profile_memory', 'personal_episode'] as const;
const MEMORY_CANDIDATE_CONTRADICTION_OUTCOME_VALUES = ['rejected', 'unresolved', 'superseded'] as const;
const PAGE_TYPE_VALUES = [
  'person',
  'company',
  'deal',
  'yc',
  'civic',
  'project',
  'concept',
  'source',
  'media',
  'system',
] as const satisfies readonly PageType[];
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
const MEMORY_PATCH_REVIEW_DECISION_VALUES = ['approve', 'reject'] as const;
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

function normalizeOptionalStringArray(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)) {
    throw invalidParams(deps, `${field} must be an array of non-empty strings`);
  }
  return value.map((entry) => entry.trim());
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

async function assertActiveReadWriteMemorySession(
  deps: { OperationError: OperationErrorCtor },
  engine: BrainEngine,
  input: {
    sessionId: string;
    realmId: string;
    scopeId: string;
  },
): Promise<void> {
  const session = await engine.getMemorySession(input.sessionId);
  if (!session || session.status !== 'active') {
    throw invalidParams(deps, `memory session is not active: ${input.sessionId}`);
  }
  const realm = await engine.getMemoryRealm(input.realmId);
  if (!realm || realm.archived_at) {
    throw invalidParams(deps, `memory realm is not active: ${input.realmId}`);
  }
  const attachment = (await engine.listMemorySessionAttachments({
    session_id: input.sessionId,
    realm_id: input.realmId,
    limit: 1,
  }))[0] ?? null;
  if (!attachment || attachment.access !== 'read_write') {
    throw invalidParams(deps, `memory realm is not attached read-write to session: ${input.realmId}`);
  }
  if (!isScopeAllowedForRealm(realm.scope, input.scopeId)) {
    throw invalidParams(deps, `scope_id ${input.scopeId} is outside realm scope ${realm.scope}`);
  }
}

function appendPatchLedgerEventId(
  candidate: Pick<MemoryCandidateEntry, 'patch_ledger_event_ids'>,
  eventId: string,
): string[] {
  const existing = candidate.patch_ledger_event_ids ?? [];
  return existing.includes(eventId) ? existing : [...existing, eventId];
}

function requirePatchCandidate(
  deps: { OperationError: OperationErrorCtor },
  candidate: MemoryCandidateEntry | null,
  candidateId: string,
): MemoryCandidateEntry {
  if (!candidate) {
    throw new deps.OperationError('memory_candidate_not_found', `Memory patch candidate not found: ${candidateId}`);
  }
  if (
    !candidate.patch_target_kind
    || !candidate.patch_target_id
    || !candidate.patch_format
    || !candidate.patch_operation_state
    || candidate.patch_body == null
  ) {
    throw invalidParams(deps, `memory candidate is not a reviewable patch candidate: ${candidateId}`);
  }
  return candidate;
}

function unsupportedPatchApplySurfaceReason(
  candidate: Pick<MemoryCandidateEntry, 'patch_target_kind' | 'patch_format'>,
): string | null {
  if (candidate.patch_target_kind !== 'page') {
    return `apply_memory_patch_candidate currently supports page targets only; got ${candidate.patch_target_kind ?? 'none'}`;
  }
  if (candidate.patch_format !== 'merge_patch') {
    return `apply_memory_patch_candidate currently supports merge_patch format only; got ${candidate.patch_format ?? 'none'}`;
  }
  return null;
}

async function recordInvalidPatchLifecycleDenial(
  deps: { OperationError: OperationErrorCtor },
  tx: BrainEngine,
  input: {
    sessionId: string;
    realmId: string;
    actor: string;
    operation: 'review_memory_patch_candidate' | 'apply_memory_patch_candidate';
    targetKind: MemoryMutationTargetKind;
    targetId: string;
    candidate: MemoryCandidateEntry;
    sourceRefs: string[];
    message: string;
  },
): Promise<{ kind: 'denied'; message: string }> {
  const patchOperationState = input.candidate.patch_operation_state;
  if (!patchOperationState) {
    throw invalidParams(deps, `memory patch candidate has no patch operation state: ${input.candidate.id}`);
  }

  const event = await recordMemoryMutationEvent(tx, {
    session_id: input.sessionId,
    realm_id: input.realmId,
    actor: input.actor,
    operation: input.operation,
    target_kind: input.targetKind,
    target_id: input.targetId,
    scope_id: input.candidate.scope_id,
    source_refs: input.sourceRefs,
    result: 'denied',
    conflict_info: {
      reason: 'invalid_patch_candidate_lifecycle',
      candidate_id: input.candidate.id,
      message: input.message,
      current_status: input.candidate.status,
      current_patch_operation_state: patchOperationState,
    },
    metadata: {
      candidate_id: input.candidate.id,
      patch_target_kind: input.candidate.patch_target_kind,
      patch_target_id: input.candidate.patch_target_id,
      patch_format: input.candidate.patch_format,
      previous_status: input.candidate.status,
      previous_patch_operation_state: patchOperationState,
    },
  });
  const updated = await tx.updateMemoryCandidatePatchOperationState(input.candidate.id, {
    patch_operation_state: patchOperationState,
    expected_current_status: input.candidate.status,
    expected_current_patch_operation_state: patchOperationState,
    patch_ledger_event_ids: appendPatchLedgerEventId(input.candidate, event.id),
  });
  if (!updated) {
    throw invalidParams(deps, `memory patch candidate changed before lifecycle denial recording completed: ${input.candidate.id}`);
  }
  return {
    kind: 'denied',
    message: input.message,
  };
}

function pageSnapshotHash(page: Page): string {
  return page.content_hash ?? contentHash(page.compiled_truth, page.timeline || '');
}

const PAGE_MERGE_PATCH_FIELDS = new Set([
  'type',
  'title',
  'compiled_truth',
  'timeline',
  'frontmatter',
  'tags',
]);
const PAGE_FRONTMATTER_RESERVED_FIELDS = new Set(['type', 'title', 'tags', 'slug']);
const PAGE_SOURCE_ATTRIBUTION_RE = /\[Source:\s*([^\]\n]*)\]/g;
const PAGE_METADATA_MERGE_PATCH_FIELDS = ['type', 'title', 'frontmatter', 'tags'] as const;

function materializePageMergePatch(
  deps: { OperationError: OperationErrorCtor },
  page: Page,
  tags: string[],
  patchBody: unknown,
): { content: string; target_snapshot_hash: string } {
  if (!patchBody || typeof patchBody !== 'object' || Array.isArray(patchBody)) {
    throw invalidParams(deps, 'merge_patch patch_body must be an object');
  }
  const patch = patchBody as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    if (!PAGE_MERGE_PATCH_FIELDS.has(key)) {
      throw invalidParams(deps, `unsupported page merge_patch field: ${key}`);
    }
  }

  const next = {
    type: page.type,
    title: page.title,
    compiled_truth: page.compiled_truth,
    timeline: page.timeline || '',
    frontmatter: stripReservedPageFrontmatterFields(page.frontmatter ?? {}),
    tags: [...tags],
  };
  const changesPageMetadata = PAGE_METADATA_MERGE_PATCH_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(patch, field));
  const changesPageText = Object.prototype.hasOwnProperty.call(patch, 'compiled_truth')
    || Object.prototype.hasOwnProperty.call(patch, 'timeline');
  if (changesPageMetadata && !changesPageText) {
    throw invalidParams(
      deps,
      'page metadata merge_patch fields must include source-attributed compiled_truth or timeline context',
    );
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'type')) {
    next.type = requireEnumValue(deps, 'patch_body.type', patch.type, PAGE_TYPE_VALUES);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
    next.title = normalizeRequiredPatchString(deps, 'patch_body.title', patch.title);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'compiled_truth')) {
    next.compiled_truth = normalizeRequiredPatchString(deps, 'patch_body.compiled_truth', patch.compiled_truth);
    assertPatchFieldSourceAttribution(deps, 'patch_body.compiled_truth', next.compiled_truth);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'timeline')) {
    next.timeline = normalizeRequiredPatchString(deps, 'patch_body.timeline', patch.timeline);
    assertPatchFieldSourceAttribution(deps, 'patch_body.timeline', next.timeline);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'frontmatter')) {
    if (patch.frontmatter === null) {
      next.frontmatter = {};
    } else if (isPlainJsonObject(patch.frontmatter)) {
      assertNoReservedPageFrontmatterPatchFields(deps, patch.frontmatter);
      next.frontmatter = stripReservedPageFrontmatterFields(applyJsonMergePatch(next.frontmatter, patch.frontmatter));
    } else {
      throw invalidParams(deps, 'patch_body.frontmatter must be an object or null');
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'tags')) {
    if (!Array.isArray(patch.tags) || !patch.tags.every((tag) => typeof tag === 'string' && tag.trim().length > 0)) {
      throw invalidParams(deps, 'patch_body.tags must be an array of non-empty strings');
    }
    next.tags = patch.tags.map((tag) => tag.trim());
  }

  assertPagePatchSourceAttribution(deps, next.compiled_truth, next.timeline);

  const targetSnapshotHash = importContentHash({
    title: next.title,
    type: next.type,
    compiled_truth: next.compiled_truth,
    timeline: next.timeline,
    frontmatter: next.frontmatter,
    tags: next.tags,
  });
  const content = serializeMarkdown(next.frontmatter, next.compiled_truth, next.timeline, {
    type: next.type,
    title: next.title,
    tags: next.tags,
  });
  const parsedContentHash = importContentHash(parseMarkdown(content, `${page.slug}.md`));
  if (parsedContentHash !== targetSnapshotHash) {
    throw invalidParams(deps, 'page merge_patch materialized hash does not match serialized import hash');
  }
  return {
    content,
    target_snapshot_hash: targetSnapshotHash,
  };
}

function normalizeRequiredPatchString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidParams(deps, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function assertPagePatchSourceAttribution(
  deps: { OperationError: OperationErrorCtor },
  compiledTruth: string,
  timeline: string,
): void {
  if (hasPageSourceAttribution(`${compiledTruth}\n${timeline}`)) return;
  throw invalidParams(deps, 'page patch result must include at least one non-empty [Source: ...] attribution');
}

function assertPatchFieldSourceAttribution(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  content: string,
): void {
  if (hasPageSourceAttribution(content)) return;
  throw invalidParams(deps, `${field} must include a non-empty [Source: ...] attribution`);
}

function hasPageSourceAttribution(content: string): boolean {
  PAGE_SOURCE_ATTRIBUTION_RE.lastIndex = 0;
  for (const match of content.matchAll(PAGE_SOURCE_ATTRIBUTION_RE)) {
    if ((match[1] ?? '').trim()) return true;
  }
  return false;
}

function assertNoReservedPageFrontmatterPatchFields(
  deps: { OperationError: OperationErrorCtor },
  frontmatterPatch: Record<string, unknown>,
): void {
  for (const key of Object.keys(frontmatterPatch)) {
    if (PAGE_FRONTMATTER_RESERVED_FIELDS.has(key)) {
      throw invalidParams(deps, `patch_body.frontmatter must not include reserved page metadata field: ${key}`);
    }
  }
}

function stripReservedPageFrontmatterFields(
  frontmatter: Record<string, unknown>,
): Record<string, unknown> {
  const stripped = { ...frontmatter };
  for (const key of PAGE_FRONTMATTER_RESERVED_FIELDS) {
    delete stripped[key];
  }
  return stripped;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function applyJsonMergePatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    const current = result[key];
    if (isPlainJsonObject(current) && isPlainJsonObject(value)) {
      result[key] = applyJsonMergePatch(current, value);
      continue;
    }
    JSON.stringify(value);
    result[key] = value;
  }
  return result;
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
      patch_operation_state: {
        type: 'string',
        description: 'Optional patch operation state filter',
        enum: [...MEMORY_PATCH_OPERATION_STATE_VALUES],
      },
      patch_target_kind: {
        type: 'string',
        description: 'Optional patch target kind filter',
        enum: [...MEMORY_PATCH_TARGET_KIND_VALUES],
      },
      patch_target_id: { type: 'string', description: 'Optional patch target id filter' },
      limit: { type: 'number', description: `Max results (default 20, cap ${MAX_MEMORY_CANDIDATE_LIMIT})` },
      offset: { type: 'number', description: 'Offset for pagination (default 0)' },
    },
    handler: async (ctx, p) => {
      return ctx.engine.listMemoryCandidateEntries({
        scope_id: String(p.scope_id ?? deps.defaultScopeId),
        status: optionalEnumValue(deps, 'status', p.status, MEMORY_CANDIDATE_STATUS_VALUES),
        candidate_type: optionalEnumValue(deps, 'candidate_type', p.candidate_type, MEMORY_CANDIDATE_TYPE_VALUES),
        target_object_type: optionalEnumValue(deps, 'target_object_type', p.target_object_type, MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES),
        patch_operation_state: optionalEnumValue(deps, 'patch_operation_state', p.patch_operation_state, MEMORY_PATCH_OPERATION_STATE_VALUES),
        patch_target_kind: optionalEnumValue(deps, 'patch_target_kind', p.patch_target_kind, MEMORY_PATCH_TARGET_KIND_VALUES),
        patch_target_id: normalizeOptionalNonEmptyString(deps, 'patch_target_id', p.patch_target_id) ?? undefined,
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

  const review_duplicate_memory: Operation = {
    name: 'review_duplicate_memory',
    description: 'Review proposed or existing memory against near matches without mutating memory.',
    params: {
      scope_id: { type: 'string', description: `Memory candidate scope id (default: ${deps.defaultScopeId})` },
      subject_kind: {
        type: 'string',
        required: true,
        description: 'Memory subject kind to review',
        enum: [...DUPLICATE_MEMORY_SUBJECT_KIND_VALUES],
      },
      subject_id: { type: 'string', description: 'Optional existing subject id to exclude from matches' },
      title: { type: 'string', description: 'Optional subject title for matching' },
      content: { type: 'string', required: true, description: 'Subject content to compare against existing memory' },
      page_type: { type: 'string', description: 'Optional page type context', enum: [...PAGE_TYPE_VALUES] },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for match scoring' },
      source_refs: { type: 'array', items: { type: 'string' }, description: 'Optional provenance strings for match scoring' },
      candidate_type: { type: 'string', description: 'Optional candidate type context', enum: [...MEMORY_CANDIDATE_TYPE_VALUES] },
      target_object_type: {
        type: 'string',
        description: 'Optional target object type context',
        enum: [...MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES],
      },
      target_object_id: { type: 'string', description: 'Optional target object id context' },
      include_pages: { type: 'boolean', description: 'Whether to include canonical page matches (default true)' },
      include_candidates: { type: 'boolean', description: 'Whether to include memory candidate matches (default true)' },
      limit: { type: 'number', description: `Max results (default 20, cap ${MAX_MEMORY_CANDIDATE_LIMIT})` },
      exclude_ids: { type: 'array', items: { type: 'string' }, description: 'Optional match ids to exclude' },
    },
    handler: async (ctx, p) => {
      const content = normalizeOptionalNonEmptyString(deps, 'content', p.content);
      if (!content) {
        throw invalidParams(deps, 'content must be a non-empty string');
      }
      optionalEnumValue(deps, 'page_type', p.page_type, PAGE_TYPE_VALUES);
      return reviewDuplicateMemory(ctx.engine, {
        scope_id: normalizeOptionalNonEmptyString(deps, 'scope_id', p.scope_id) ?? deps.defaultScopeId,
        subject_kind: requireEnumValue(deps, 'subject_kind', p.subject_kind, DUPLICATE_MEMORY_SUBJECT_KIND_VALUES),
        subject_id: normalizeOptionalNonEmptyString(deps, 'subject_id', p.subject_id) ?? undefined,
        title: normalizeOptionalNonEmptyString(deps, 'title', p.title) ?? undefined,
        content,
        tags: normalizeOptionalStringArray(deps, 'tags', p.tags),
        source_refs: normalizeOptionalStringArray(deps, 'source_refs', p.source_refs),
        candidate_type: optionalEnumValue(deps, 'candidate_type', p.candidate_type, MEMORY_CANDIDATE_TYPE_VALUES),
        target_object_type: optionalEnumValue(deps, 'target_object_type', p.target_object_type, MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES),
        target_object_id: normalizeOptionalTargetObjectId(deps, p.target_object_id) ?? undefined,
        include_pages: p.include_pages !== false,
        include_candidates: p.include_candidates !== false,
        limit: normalizeLimit(deps, p.limit),
        exclude_ids: normalizeOptionalStringArray(deps, 'exclude_ids', p.exclude_ids),
      });
    },
    cliHints: { name: 'review-duplicate-memory', aliases: { n: 'limit' } },
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
      include_duplicate_review: { type: 'boolean', description: 'Include a duplicate review result with the created candidate' },
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

      const created = await createMemoryCandidateEntryWithStatusEvent(ctx.engine, {
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
      if (p.include_duplicate_review !== true) {
        return created;
      }
      const duplicateReview = await reviewDuplicateMemory(ctx.engine, {
        scope_id: created.scope_id,
        subject_kind: 'memory_candidate',
        subject_id: created.id,
        content: created.proposed_content,
        source_refs: created.source_refs,
        candidate_type: created.candidate_type,
        target_object_type: created.target_object_type ?? undefined,
        target_object_id: created.target_object_id ?? undefined,
        include_pages: true,
        include_candidates: true,
        limit: 5,
        exclude_ids: [created.id],
      });
      return {
        candidate: created,
        duplicate_review: duplicateReview,
      };
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

      const outcome = await ctx.engine.transaction(async (txBase) => {
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
      return outcome;
    },
    cliHints: { name: 'create-memory-patch-candidate' },
  };

  const review_memory_patch_candidate: Operation = {
    name: 'review_memory_patch_candidate',
    description: 'Approve or reject a reviewable memory patch candidate without applying it to canonical memory.',
    params: {
      candidate_id: { type: 'string', required: true, description: 'Memory patch candidate id' },
      session_id: { type: 'string', required: true, description: 'Active reviewing memory session id' },
      realm_id: { type: 'string', required: true, description: 'Active memory realm id attached read-write to the session' },
      actor: { type: 'string', required: true, description: 'Actor reviewing the patch candidate' },
      decision: {
        type: 'string',
        required: true,
        description: 'Patch review decision',
        enum: [...MEMORY_PATCH_REVIEW_DECISION_VALUES],
      },
      reviewed_at: { type: 'string', description: 'Optional ISO timestamp for review metadata' },
      review_reason: { type: 'string', description: 'Optional review reason for auditability' },
      source_refs: { type: 'array', required: true, items: { type: 'string' }, description: 'Required provenance strings for the review decision' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const candidateId = normalizeOptionalNonEmptyString(deps, 'candidate_id', p.candidate_id);
      const sessionId = normalizeOptionalNonEmptyString(deps, 'session_id', p.session_id);
      const realmId = normalizeOptionalNonEmptyString(deps, 'realm_id', p.realm_id);
      const actor = normalizeOptionalNonEmptyString(deps, 'actor', p.actor);
      if (!candidateId || !sessionId || !realmId || !actor) {
        throw invalidParams(deps, 'candidate_id, session_id, realm_id, and actor are required');
      }
      const decision = requireEnumValue(deps, 'decision', p.decision, MEMORY_PATCH_REVIEW_DECISION_VALUES);
      const sourceRefs = normalizeSourceRefs(deps, p);
      if (sourceRefs.length === 0) {
        throw invalidParams(deps, 'source_refs must contain at least one provenance reference');
      }
      const reviewedAt = normalizeOptionalIsoTimestamp(deps, 'reviewed_at', p.reviewed_at);
      const reviewReason = normalizeOptionalNonEmptyString(deps, 'review_reason', p.review_reason);

      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'review_memory_patch_candidate',
          candidate_id: candidateId,
          decision,
        };
      }

      const outcome = await ctx.engine.transaction(async (txBase) => {
        const tx = txBase as BrainEngine;
        const candidate = requirePatchCandidate(
          deps,
          await tx.getMemoryCandidateEntry(candidateId),
          candidateId,
        );
        await assertActiveReadWriteMemorySession(deps, tx, {
          sessionId,
          realmId,
          scopeId: candidate.scope_id,
        });
        if (candidate.status !== 'staged_for_review') {
          return recordInvalidPatchLifecycleDenial(deps, tx, {
            sessionId,
            realmId,
            actor,
            operation: 'review_memory_patch_candidate',
            targetKind: 'memory_candidate',
            targetId: candidate.id,
            candidate,
            sourceRefs,
            message: `memory patch candidate must be staged_for_review before review: ${candidateId}`,
          });
        }
        if (candidate.patch_operation_state !== 'proposed' && candidate.patch_operation_state !== 'dry_run_validated') {
          return recordInvalidPatchLifecycleDenial(deps, tx, {
            sessionId,
            realmId,
            actor,
            operation: 'review_memory_patch_candidate',
            targetKind: 'memory_candidate',
            targetId: candidate.id,
            candidate,
            sourceRefs,
            message: `memory patch candidate cannot be reviewed from state: ${candidate.patch_operation_state ?? 'none'}`,
          });
        }
        const unsupportedApplySurfaceReason = decision === 'approve'
          ? unsupportedPatchApplySurfaceReason(candidate)
          : null;
        if (unsupportedApplySurfaceReason) {
          const event = await recordMemoryMutationEvent(tx, {
            session_id: sessionId,
            realm_id: realmId,
            actor,
            operation: 'review_memory_patch_candidate',
            target_kind: 'memory_candidate',
            target_id: candidate.id,
            scope_id: candidate.scope_id,
            source_refs: sourceRefs,
            result: 'denied',
            conflict_info: {
              reason: 'unsupported_patch_apply_surface',
              candidate_id: candidate.id,
              message: unsupportedApplySurfaceReason,
            },
            metadata: {
              decision,
              patch_target_kind: candidate.patch_target_kind,
              patch_target_id: candidate.patch_target_id,
              patch_base_target_snapshot_hash: candidate.patch_base_target_snapshot_hash,
              patch_format: candidate.patch_format,
              previous_patch_operation_state: candidate.patch_operation_state,
            },
          });
          const updated = await tx.updateMemoryCandidatePatchOperationState(candidate.id, {
            patch_operation_state: candidate.patch_operation_state,
            expected_current_status: 'staged_for_review',
            expected_current_patch_operation_state: candidate.patch_operation_state,
            patch_ledger_event_ids: appendPatchLedgerEventId(candidate, event.id),
            reviewed_at: reviewedAt,
            review_reason: reviewReason ?? unsupportedApplySurfaceReason,
          });
          if (!updated) {
            throw invalidParams(deps, `memory patch candidate changed before review denial recording completed: ${candidateId}`);
          }
          return {
            kind: 'denied' as const,
            message: unsupportedApplySurfaceReason,
          };
        }

        const event = await recordMemoryMutationEvent(tx, {
          session_id: sessionId,
          realm_id: realmId,
          actor,
          operation: 'review_memory_patch_candidate',
          target_kind: 'memory_candidate',
          target_id: candidate.id,
          scope_id: candidate.scope_id,
          source_refs: sourceRefs,
          result: decision === 'approve' ? 'applied' : 'denied',
          metadata: {
            decision,
            patch_target_kind: candidate.patch_target_kind,
            patch_target_id: candidate.patch_target_id,
            patch_base_target_snapshot_hash: candidate.patch_base_target_snapshot_hash,
            patch_format: candidate.patch_format,
            previous_patch_operation_state: candidate.patch_operation_state,
          },
        });

        if (decision === 'approve') {
          const updated = await tx.updateMemoryCandidatePatchOperationState(candidate.id, {
            patch_operation_state: 'approved_for_apply',
            expected_current_status: 'staged_for_review',
            expected_current_patch_operation_state: candidate.patch_operation_state,
            patch_ledger_event_ids: appendPatchLedgerEventId(candidate, event.id),
            reviewed_at: reviewedAt,
            review_reason: reviewReason,
          });
          if (!updated) {
            throw invalidParams(deps, `memory patch candidate changed before review completed: ${candidateId}`);
          }
          return { kind: 'updated' as const, candidate: updated };
        }

        await rejectMemoryCandidateEntry(tx, {
          id: candidate.id,
          reviewed_at: reviewedAt,
          review_reason: reviewReason ?? 'Reviewer rejected the patch candidate.',
        });
        const updated = await tx.updateMemoryCandidatePatchOperationState(candidate.id, {
          patch_operation_state: 'failed',
          expected_current_status: 'rejected',
          expected_current_patch_operation_state: candidate.patch_operation_state,
          patch_ledger_event_ids: appendPatchLedgerEventId(candidate, event.id),
          reviewed_at: reviewedAt,
          review_reason: reviewReason ?? 'Reviewer rejected the patch candidate.',
        });
        if (!updated) {
          throw invalidParams(deps, `memory patch candidate changed before rejection completed: ${candidateId}`);
        }
        return { kind: 'updated' as const, candidate: updated };
      });
      if (outcome.kind === 'denied') {
        throw invalidParams(deps, outcome.message);
      }
      return outcome.candidate;
    },
    cliHints: { name: 'review-memory-patch-candidate' },
  };

  const apply_memory_patch_candidate: Operation = {
    name: 'apply_memory_patch_candidate',
    description: 'Apply an approved page merge patch candidate after rechecking the target snapshot hash.',
    params: {
      candidate_id: { type: 'string', required: true, description: 'Approved memory patch candidate id' },
      session_id: { type: 'string', required: true, description: 'Active applying memory session id' },
      realm_id: { type: 'string', required: true, description: 'Active memory realm id attached read-write to the session' },
      actor: { type: 'string', required: true, description: 'Actor applying the patch candidate' },
      reviewed_at: { type: 'string', description: 'Optional ISO timestamp for apply metadata' },
      review_reason: { type: 'string', description: 'Optional apply reason for auditability' },
      source_refs: { type: 'array', required: true, items: { type: 'string' }, description: 'Required provenance strings for the apply decision' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const candidateId = normalizeOptionalNonEmptyString(deps, 'candidate_id', p.candidate_id);
      const sessionId = normalizeOptionalNonEmptyString(deps, 'session_id', p.session_id);
      const realmId = normalizeOptionalNonEmptyString(deps, 'realm_id', p.realm_id);
      const actor = normalizeOptionalNonEmptyString(deps, 'actor', p.actor);
      if (!candidateId || !sessionId || !realmId || !actor) {
        throw invalidParams(deps, 'candidate_id, session_id, realm_id, and actor are required');
      }
      const sourceRefs = normalizeSourceRefs(deps, p);
      if (sourceRefs.length === 0) {
        throw invalidParams(deps, 'source_refs must contain at least one provenance reference');
      }
      const reviewedAt = normalizeOptionalIsoTimestamp(deps, 'reviewed_at', p.reviewed_at);
      const reviewReason = normalizeOptionalNonEmptyString(deps, 'review_reason', p.review_reason);

      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'apply_memory_patch_candidate',
          candidate_id: candidateId,
        };
      }

      const outcome = await ctx.engine.transaction(async (txBase) => {
        const tx = txBase as BrainEngine;
        const candidate = requirePatchCandidate(
          deps,
          await tx.getMemoryCandidateEntry(candidateId),
          candidateId,
        );
        await assertActiveReadWriteMemorySession(deps, tx, {
          sessionId,
          realmId,
          scopeId: candidate.scope_id,
        });
        const candidateTargetKind = candidate.patch_target_kind as MemoryMutationTargetKind;
        const candidateTargetId = candidate.patch_target_id as string;
        if (candidate.status !== 'staged_for_review') {
          return recordInvalidPatchLifecycleDenial(deps, tx, {
            sessionId,
            realmId,
            actor,
            operation: 'apply_memory_patch_candidate',
            targetKind: candidateTargetKind,
            targetId: candidateTargetId,
            candidate,
            sourceRefs,
            message: `memory patch candidate must be staged_for_review before apply: ${candidateId}`,
          });
        }
        if (candidate.patch_operation_state !== 'approved_for_apply') {
          return recordInvalidPatchLifecycleDenial(deps, tx, {
            sessionId,
            realmId,
            actor,
            operation: 'apply_memory_patch_candidate',
            targetKind: candidateTargetKind,
            targetId: candidateTargetId,
            candidate,
            sourceRefs,
            message: `memory patch candidate must be approved_for_apply before apply: ${candidateId}`,
          });
        }
        const unsupportedApplySurfaceReason = unsupportedPatchApplySurfaceReason(candidate);
        if (unsupportedApplySurfaceReason) {
          const event = await recordMemoryMutationEvent(tx, {
            session_id: sessionId,
            realm_id: realmId,
            actor,
            operation: 'apply_memory_patch_candidate',
            target_kind: candidateTargetKind,
            target_id: candidateTargetId,
            scope_id: candidate.scope_id,
            source_refs: sourceRefs,
            expected_target_snapshot_hash: candidate.patch_base_target_snapshot_hash,
            current_target_snapshot_hash: null,
            result: 'failed',
            conflict_info: {
              reason: 'unsupported_patch_apply_surface',
              candidate_id: candidate.id,
              message: unsupportedApplySurfaceReason,
            },
            metadata: {
              candidate_id: candidate.id,
              patch_format: candidate.patch_format,
              previous_patch_operation_state: candidate.patch_operation_state,
            },
          });
          const updated = await tx.updateMemoryCandidatePatchOperationState(candidate.id, {
            patch_operation_state: 'failed',
            expected_current_status: 'staged_for_review',
            expected_current_patch_operation_state: 'approved_for_apply',
            patch_ledger_event_ids: appendPatchLedgerEventId(candidate, event.id),
            reviewed_at: reviewedAt,
            review_reason: reviewReason ?? unsupportedApplySurfaceReason,
          });
          if (!updated) {
            throw invalidParams(deps, `memory patch candidate changed before unsupported apply recording completed: ${candidateId}`);
          }
          return {
            kind: 'failed' as const,
            message: unsupportedApplySurfaceReason,
          };
        }

        const targetId = candidate.patch_target_id as string;
        const page = await tx.getPageForUpdate(targetId);
        const currentTargetSnapshotHash = page ? pageSnapshotHash(page) : null;
        const expectedTargetSnapshotHash = candidate.patch_base_target_snapshot_hash ?? null;

        if (expectedTargetSnapshotHash !== currentTargetSnapshotHash) {
          const event = await recordMemoryMutationEvent(tx, {
            session_id: sessionId,
            realm_id: realmId,
            actor,
            operation: 'apply_memory_patch_candidate',
            target_kind: 'page',
            target_id: targetId,
            scope_id: candidate.scope_id,
            source_refs: sourceRefs,
            expected_target_snapshot_hash: expectedTargetSnapshotHash,
            current_target_snapshot_hash: currentTargetSnapshotHash,
            result: 'conflict',
            conflict_info: {
              reason: 'target_snapshot_hash_mismatch',
              candidate_id: candidate.id,
              expected_target_snapshot_hash: expectedTargetSnapshotHash,
              current_target_snapshot_hash: currentTargetSnapshotHash,
            },
            metadata: {
              candidate_id: candidate.id,
              patch_format: candidate.patch_format,
              previous_patch_operation_state: candidate.patch_operation_state,
            },
          });
          const updated = await tx.updateMemoryCandidatePatchOperationState(candidate.id, {
            patch_operation_state: 'conflicted',
            expected_current_status: 'staged_for_review',
            expected_current_patch_operation_state: 'approved_for_apply',
            patch_ledger_event_ids: appendPatchLedgerEventId(candidate, event.id),
            reviewed_at: reviewedAt,
            review_reason: reviewReason ?? 'Patch target snapshot hash conflicted at apply time.',
          });
          if (!updated) {
            throw invalidParams(deps, `memory patch candidate changed before conflict recording completed: ${candidateId}`);
          }
          return {
            kind: 'conflict' as const,
            targetId,
          };
        }

        if (!page) {
          const event = await recordMemoryMutationEvent(tx, {
            session_id: sessionId,
            realm_id: realmId,
            actor,
            operation: 'apply_memory_patch_candidate',
            target_kind: 'page',
            target_id: targetId,
            scope_id: candidate.scope_id,
            source_refs: sourceRefs,
            expected_target_snapshot_hash: expectedTargetSnapshotHash,
            current_target_snapshot_hash: null,
            result: 'failed',
            conflict_info: {
              reason: 'missing_page_apply_not_supported',
              candidate_id: candidate.id,
            },
            metadata: {
              candidate_id: candidate.id,
              patch_format: candidate.patch_format,
              previous_patch_operation_state: candidate.patch_operation_state,
            },
          });
          const updated = await tx.updateMemoryCandidatePatchOperationState(candidate.id, {
            patch_operation_state: 'failed',
            expected_current_status: 'staged_for_review',
            expected_current_patch_operation_state: 'approved_for_apply',
            patch_ledger_event_ids: appendPatchLedgerEventId(candidate, event.id),
            reviewed_at: reviewedAt,
            review_reason: reviewReason ?? 'Applying patches to missing page targets is not supported yet.',
          });
          if (!updated) {
            throw invalidParams(deps, `memory patch candidate changed before missing-target apply recording completed: ${candidateId}`);
          }
          return {
            kind: 'failed' as const,
            message: 'applying patches to missing page targets is not supported yet',
          };
        }

        let materialized: { content: string; target_snapshot_hash: string };
        try {
          materialized = materializePageMergePatch(
            deps,
            page,
            await tx.getTags(targetId),
            candidate.patch_body,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : 'patch materialization failed';
          const event = await recordMemoryMutationEvent(tx, {
            session_id: sessionId,
            realm_id: realmId,
            actor,
            operation: 'apply_memory_patch_candidate',
            target_kind: 'page',
            target_id: targetId,
            scope_id: candidate.scope_id,
            source_refs: sourceRefs,
            expected_target_snapshot_hash: expectedTargetSnapshotHash,
            current_target_snapshot_hash: currentTargetSnapshotHash,
            result: 'failed',
            conflict_info: {
              reason: 'patch_materialization_failed',
              candidate_id: candidate.id,
              error: message,
            },
            metadata: {
              candidate_id: candidate.id,
              patch_format: candidate.patch_format,
              previous_patch_operation_state: candidate.patch_operation_state,
            },
          });
          const updated = await tx.updateMemoryCandidatePatchOperationState(candidate.id, {
            patch_operation_state: 'failed',
            expected_current_status: 'staged_for_review',
            expected_current_patch_operation_state: 'approved_for_apply',
            patch_ledger_event_ids: appendPatchLedgerEventId(candidate, event.id),
            reviewed_at: reviewedAt,
            review_reason: reviewReason ?? 'Patch materialization failed before page write.',
          });
          if (!updated) {
            throw invalidParams(deps, `memory patch candidate changed before materialization failure recording completed: ${candidateId}`);
          }
          return {
            kind: 'failed' as const,
            message,
          };
        }
        if (
          candidate.patch_expected_resulting_target_snapshot_hash
          && candidate.patch_expected_resulting_target_snapshot_hash !== materialized.target_snapshot_hash
        ) {
          const event = await recordMemoryMutationEvent(tx, {
            session_id: sessionId,
            realm_id: realmId,
            actor,
            operation: 'apply_memory_patch_candidate',
            target_kind: 'page',
            target_id: targetId,
            scope_id: candidate.scope_id,
            source_refs: sourceRefs,
            expected_target_snapshot_hash: expectedTargetSnapshotHash,
            current_target_snapshot_hash: currentTargetSnapshotHash,
            result: 'failed',
            conflict_info: {
              reason: 'expected_resulting_target_snapshot_hash_mismatch',
              candidate_id: candidate.id,
              expected_resulting_target_snapshot_hash: candidate.patch_expected_resulting_target_snapshot_hash,
              materialized_target_snapshot_hash: materialized.target_snapshot_hash,
            },
            metadata: {
              candidate_id: candidate.id,
              patch_format: candidate.patch_format,
              previous_patch_operation_state: candidate.patch_operation_state,
            },
          });
          const updated = await tx.updateMemoryCandidatePatchOperationState(candidate.id, {
            patch_operation_state: 'failed',
            expected_current_status: 'staged_for_review',
            expected_current_patch_operation_state: 'approved_for_apply',
            patch_ledger_event_ids: appendPatchLedgerEventId(candidate, event.id),
            reviewed_at: reviewedAt,
            review_reason: reviewReason ?? 'Patch materialized to an unexpected target snapshot hash.',
          });
          if (!updated) {
            throw invalidParams(deps, `memory patch candidate changed before failed apply recording completed: ${candidateId}`);
          }
          return {
            kind: 'failed' as const,
            message: 'patch materialized to an unexpected target snapshot hash',
          };
        }

        const importResult = await importFromContent(tx, targetId, materialized.content);
        const finalPage = await tx.getPage(targetId);
        if (importResult.error || !finalPage?.content_hash) {
          const event = await recordMemoryMutationEvent(tx, {
            session_id: sessionId,
            realm_id: realmId,
            actor,
            operation: 'apply_memory_patch_candidate',
            target_kind: 'page',
            target_id: targetId,
            scope_id: candidate.scope_id,
            source_refs: sourceRefs,
            expected_target_snapshot_hash: expectedTargetSnapshotHash,
            current_target_snapshot_hash: currentTargetSnapshotHash,
            result: 'failed',
            metadata: {
              candidate_id: candidate.id,
              patch_format: candidate.patch_format,
              import_status: importResult.status,
              error: importResult.error ?? 'missing final page content hash',
            },
          });
          const updated = await tx.updateMemoryCandidatePatchOperationState(candidate.id, {
            patch_operation_state: 'failed',
            expected_current_status: 'staged_for_review',
            expected_current_patch_operation_state: 'approved_for_apply',
            patch_ledger_event_ids: appendPatchLedgerEventId(candidate, event.id),
            reviewed_at: reviewedAt,
            review_reason: reviewReason ?? 'Patch apply failed while writing the page.',
          });
          if (!updated) {
            throw invalidParams(deps, `memory patch candidate changed before failed apply recording completed: ${candidateId}`);
          }
          return {
            kind: 'failed' as const,
            message: importResult.error ?? 'missing final page content hash',
          };
        }
        if (finalPage.content_hash !== materialized.target_snapshot_hash) {
          throw invalidParams(deps, 'imported page content hash does not match materialized patch hash');
        }

        const event = await recordMemoryMutationEvent(tx, {
          session_id: sessionId,
          realm_id: realmId,
          actor,
          operation: 'apply_memory_patch_candidate',
          target_kind: 'page',
          target_id: targetId,
          scope_id: candidate.scope_id,
          source_refs: sourceRefs,
          expected_target_snapshot_hash: expectedTargetSnapshotHash,
          current_target_snapshot_hash: finalPage.content_hash,
          result: 'applied',
          metadata: {
            candidate_id: candidate.id,
            patch_format: candidate.patch_format,
            previous_target_snapshot_hash: currentTargetSnapshotHash,
            import_status: importResult.status,
            chunks: importResult.chunks,
          },
        });
        const patchedCandidate = await tx.updateMemoryCandidatePatchOperationState(candidate.id, {
          patch_operation_state: 'applied',
          expected_current_status: 'staged_for_review',
          expected_current_patch_operation_state: 'approved_for_apply',
          patch_ledger_event_ids: appendPatchLedgerEventId(candidate, event.id),
          reviewed_at: reviewedAt,
          review_reason: reviewReason ?? 'Applied approved patch candidate.',
        });
        if (!patchedCandidate) {
          throw invalidParams(deps, `memory patch candidate changed before apply completed: ${candidateId}`);
        }
        const promoted = await promoteMemoryCandidateEntry(tx, {
          id: candidate.id,
          reviewed_at: reviewedAt,
          review_reason: reviewReason ?? 'Applied approved patch candidate.',
        });
        return {
          kind: 'applied' as const,
          candidate: promoted,
          target_id: targetId,
          previous_target_snapshot_hash: currentTargetSnapshotHash,
          current_target_snapshot_hash: finalPage.content_hash,
          ledger_event_id: event.id,
        };
      });

      if (outcome.kind === 'conflict') {
        throw new deps.OperationError('write_conflict', `target snapshot hash mismatch for ${outcome.targetId}`);
      }
      if (outcome.kind === 'denied') {
        throw new deps.OperationError('invalid_params', outcome.message);
      }
      if (outcome.kind === 'failed') {
        throw new deps.OperationError('invalid_params', outcome.message);
      }
      return {
        status: 'applied',
        candidate: outcome.candidate,
        target_kind: 'page',
        target_id: outcome.target_id,
        previous_target_snapshot_hash: outcome.previous_target_snapshot_hash,
        current_target_snapshot_hash: outcome.current_target_snapshot_hash,
        ledger_event_id: outcome.ledger_event_id,
      };
    },
    cliHints: { name: 'apply-memory-patch-candidate' },
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
    review_duplicate_memory,
    create_memory_candidate_entry,
    create_memory_patch_candidate,
    review_memory_patch_candidate,
    apply_memory_patch_candidate,
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
