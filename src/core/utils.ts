import { createHash } from 'crypto';
import type {
  Page,
  PageType,
  NoteManifestEntry,
  NoteManifestHeading,
  NoteSectionEntry,
  ContextMapEntry,
  ContextAtlasEntry,
  MemoryCandidateEntry,
  MemoryCandidateContradictionEntry,
  MemoryMutationEvent,
  MemoryMutationEventInput,
  MemoryRealm,
  MemoryRealmInput,
  MemorySession,
  MemorySessionAttachment,
  MemorySessionAttachmentInput,
  MemorySessionInput,
  MemoryCandidateStatusEvent,
  MemoryCandidateSupersessionEntry,
  CanonicalHandoffEntry,
  ProfileMemoryEntry,
  PersonalEpisodeEntry,
  Chunk,
  SearchResult,
  TaskAttempt,
  TaskDecision,
  TaskThread,
  TaskWorkingSet,
  RetrievalTrace,
} from './types.ts';

export interface ImportContentHashInput {
  title: string;
  type: PageType;
  compiled_truth: string;
  timeline?: string;
  frontmatter?: Record<string, unknown>;
  tags?: string[];
}

/**
 * Validate and normalize a slug. Slugs are lowercased repo-relative paths.
 * Rejects empty slugs, path traversal (..), and leading /.
 */
export function validateSlug(slug: string): string {
  if (!slug || /(^|\/)\.\.($|\/)/.test(slug) || /^\//.test(slug)) {
    throw new Error(`Invalid slug: "${slug}". Slugs cannot be empty, start with /, or contain path traversal.`);
  }
  return slug.toLowerCase();
}

/**
 * SHA-256 hash of compiled_truth + timeline, used for low-level page writes.
 */
export function contentHash(compiledTruth: string, timeline: string): string {
  return createHash('sha256').update(compiledTruth + '\n---\n' + timeline).digest('hex');
}

/**
 * Hash contract for markdown imports and re-import idempotency.
 */
export function importContentHash(input: ImportContentHashInput): string {
  return createHash('sha256')
    .update(JSON.stringify({
      title: input.title,
      type: input.type,
      compiled_truth: input.compiled_truth,
      timeline: input.timeline ?? '',
      frontmatter: canonicalizeJsonValue(input.frontmatter ?? {}),
      tags: [...(input.tags ?? [])].sort(),
    }))
    .digest('hex');
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeJsonValue(nested)])
    );
  }
  return value;
}

export function rowToPage(row: Record<string, unknown>): Page {
  return {
    id: row.id as number,
    slug: row.slug as string,
    type: row.type as PageType,
    title: row.title as string,
    compiled_truth: row.compiled_truth as string,
    timeline: row.timeline as string,
    frontmatter: (typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter) as Record<string, unknown>,
    content_hash: row.content_hash as string | undefined,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

export function rowToChunk(row: Record<string, unknown>, includeEmbedding = false): Chunk {
  return {
    id: row.id as number,
    page_id: row.page_id as number,
    chunk_index: row.chunk_index as number,
    chunk_text: row.chunk_text as string,
    chunk_source: row.chunk_source as Chunk['chunk_source'],
    embedding: includeEmbedding && row.embedding ? row.embedding as Float32Array : null,
    model: row.model as string,
    token_count: row.token_count as number | null,
    embedded_at: row.embedded_at ? new Date(row.embedded_at as string) : null,
  };
}

export function rowToSearchResult(row: Record<string, unknown>): SearchResult {
  return {
    slug: row.slug as string,
    page_id: row.page_id as number,
    title: row.title as string,
    type: row.type as PageType,
    chunk_text: row.chunk_text as string,
    chunk_source: row.chunk_source as SearchResult['chunk_source'],
    score: Number(row.score),
    stale: Boolean(row.stale),
  };
}

export function rowToNoteManifestEntry(row: Record<string, unknown>): NoteManifestEntry {
  return {
    scope_id: row.scope_id as string,
    page_id: Number(row.page_id),
    slug: row.slug as string,
    path: row.path as string,
    page_type: row.page_type as PageType,
    title: row.title as string,
    frontmatter: parseJsonObject(row.frontmatter),
    aliases: parseJsonStringArray(row.aliases),
    tags: parseJsonStringArray(row.tags),
    outgoing_wikilinks: parseJsonStringArray(row.outgoing_wikilinks),
    outgoing_urls: parseJsonStringArray(row.outgoing_urls),
    source_refs: parseJsonStringArray(row.source_refs),
    heading_index: parseNoteManifestHeadings(row.heading_index),
    content_hash: row.content_hash as string,
    extractor_version: row.extractor_version as string,
    last_indexed_at: new Date(row.last_indexed_at as string),
  };
}

export function rowToNoteSectionEntry(row: Record<string, unknown>): NoteSectionEntry {
  return {
    scope_id: row.scope_id as string,
    page_id: Number(row.page_id),
    page_slug: row.page_slug as string,
    page_path: row.page_path as string,
    section_id: row.section_id as string,
    parent_section_id: row.parent_section_id == null ? null : String(row.parent_section_id),
    heading_slug: row.heading_slug as string,
    heading_path: parseJsonStringArray(row.heading_path),
    heading_text: row.heading_text as string,
    depth: Number(row.depth),
    line_start: Number(row.line_start),
    line_end: Number(row.line_end),
    section_text: row.section_text as string,
    outgoing_wikilinks: parseJsonStringArray(row.outgoing_wikilinks),
    outgoing_urls: parseJsonStringArray(row.outgoing_urls),
    source_refs: parseJsonStringArray(row.source_refs),
    content_hash: row.content_hash as string,
    extractor_version: row.extractor_version as string,
    last_indexed_at: new Date(row.last_indexed_at as string),
  };
}

export function rowToContextMapEntry(row: Record<string, unknown>): ContextMapEntry {
  return {
    id: row.id as string,
    scope_id: row.scope_id as string,
    kind: row.kind as string,
    title: row.title as string,
    build_mode: row.build_mode as string,
    status: row.status as string,
    source_set_hash: row.source_set_hash as string,
    extractor_version: row.extractor_version as string,
    node_count: Number(row.node_count),
    edge_count: Number(row.edge_count),
    community_count: Number(row.community_count ?? 0),
    graph_json: parseJsonObject(row.graph_json),
    generated_at: new Date(row.generated_at as string),
    stale_reason: row.stale_reason == null ? null : String(row.stale_reason),
  };
}

export function rowToContextAtlasEntry(row: Record<string, unknown>): ContextAtlasEntry {
  return {
    id: row.id as string,
    map_id: row.map_id as string,
    scope_id: row.scope_id as string,
    kind: row.kind as string,
    title: row.title as string,
    freshness: row.freshness as string,
    entrypoints: parseJsonStringArray(row.entrypoints),
    budget_hint: Number(row.budget_hint),
    generated_at: new Date(row.generated_at as string),
  };
}

export function rowToProfileMemoryEntry(row: Record<string, unknown>): ProfileMemoryEntry {
  return {
    id: row.id as string,
    scope_id: row.scope_id as string,
    profile_type: row.profile_type as ProfileMemoryEntry['profile_type'],
    subject: row.subject as string,
    content: row.content as string,
    source_refs: parseJsonStringArray(row.source_refs),
    sensitivity: row.sensitivity as ProfileMemoryEntry['sensitivity'],
    export_status: row.export_status as ProfileMemoryEntry['export_status'],
    last_confirmed_at: row.last_confirmed_at ? new Date(row.last_confirmed_at as string) : null,
    superseded_by: (row.superseded_by as string | null) ?? null,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

export function rowToPersonalEpisodeEntry(row: Record<string, unknown>): PersonalEpisodeEntry {
  return {
    id: row.id as string,
    scope_id: row.scope_id as string,
    title: row.title as string,
    start_time: new Date(row.start_time as string),
    end_time: row.end_time ? new Date(row.end_time as string) : null,
    source_kind: row.source_kind as PersonalEpisodeEntry['source_kind'],
    summary: row.summary as string,
    source_refs: parseJsonStringArray(row.source_refs),
    candidate_ids: parseJsonStringArray(row.candidate_ids),
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

export function rowToMemoryCandidateEntry(row: Record<string, unknown>): MemoryCandidateEntry {
  return {
    id: row.id as string,
    scope_id: row.scope_id as string,
    candidate_type: row.candidate_type as MemoryCandidateEntry['candidate_type'],
    proposed_content: row.proposed_content as string,
    source_refs: parseJsonStringArray(row.source_refs),
    generated_by: row.generated_by as MemoryCandidateEntry['generated_by'],
    extraction_kind: row.extraction_kind as MemoryCandidateEntry['extraction_kind'],
    confidence_score: Number(row.confidence_score),
    importance_score: Number(row.importance_score),
    recurrence_score: Number(row.recurrence_score),
    sensitivity: row.sensitivity as MemoryCandidateEntry['sensitivity'],
    status: row.status as MemoryCandidateEntry['status'],
    target_object_type: (row.target_object_type as MemoryCandidateEntry['target_object_type'] | null) ?? null,
    target_object_id: (row.target_object_id as string | null) ?? null,
    reviewed_at: row.reviewed_at ? new Date(row.reviewed_at as string) : null,
    review_reason: (row.review_reason as string | null) ?? null,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

export function rowToMemoryCandidateStatusEvent(
  row: Record<string, unknown>,
): MemoryCandidateStatusEvent {
  return {
    id: row.id as string,
    candidate_id: row.candidate_id as string,
    scope_id: row.scope_id as string,
    from_status: (row.from_status as MemoryCandidateStatusEvent['from_status']) ?? null,
    to_status: row.to_status as MemoryCandidateStatusEvent['to_status'],
    event_kind: row.event_kind as MemoryCandidateStatusEvent['event_kind'],
    interaction_id: row.interaction_id == null ? null : String(row.interaction_id),
    reviewed_at: row.reviewed_at ? new Date(row.reviewed_at as string) : null,
    review_reason: (row.review_reason as string | null) ?? null,
    created_at: new Date(row.created_at as string),
  };
}

export function rowToMemoryMutationEvent(row: Record<string, unknown>): MemoryMutationEvent {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    realm_id: row.realm_id as string,
    actor: row.actor as string,
    operation: row.operation as MemoryMutationEvent['operation'],
    target_kind: row.target_kind as MemoryMutationEvent['target_kind'],
    target_id: normalizeRequiredMemoryMutationString('target_id', row.target_id),
    scope_id: (row.scope_id as string | null) ?? null,
    source_refs: normalizeMemoryMutationSourceRefs(parseJsonStringArray(row.source_refs)),
    expected_target_snapshot_hash: (row.expected_target_snapshot_hash as string | null) ?? null,
    current_target_snapshot_hash: (row.current_target_snapshot_hash as string | null) ?? null,
    result: row.result as MemoryMutationEvent['result'],
    conflict_info: parseNullableJsonObject(row.conflict_info),
    dry_run: Boolean(row.dry_run),
    metadata: parseJsonObject(row.metadata),
    redaction_visibility: row.redaction_visibility as MemoryMutationEvent['redaction_visibility'],
    created_at: new Date(row.created_at as string),
    decided_at: row.decided_at == null ? null : new Date(row.decided_at as string),
    applied_at: row.applied_at == null ? null : new Date(row.applied_at as string),
  };
}

export function normalizeMemoryMutationEventInput(input: MemoryMutationEventInput): MemoryMutationEventInput {
  const targetId = normalizeRequiredMemoryMutationString('target_id', input.target_id);
  const sourceRefs = normalizeMemoryMutationSourceRefs(input.source_refs);

  if (input.result === 'dry_run' && input.dry_run === false) {
    throw new Error('memory mutation dry_run cannot be false when result is dry_run');
  }
  if (input.result !== 'dry_run' && input.dry_run === true) {
    throw new Error('memory mutation dry_run can only be true when result is dry_run');
  }

  return {
    ...input,
    target_id: targetId,
    source_refs: sourceRefs,
    dry_run: input.result === 'dry_run',
  };
}

export function rowToMemoryRealm(row: Record<string, unknown>): MemoryRealm {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? '',
    scope: row.scope as MemoryRealm['scope'],
    default_access: row.default_access as MemoryRealm['default_access'],
    retention_policy: (row.retention_policy as string | null) ?? 'retain',
    export_policy: (row.export_policy as string | null) ?? 'private',
    agent_instructions: (row.agent_instructions as string | null) ?? '',
    archived_at: row.archived_at == null ? null : new Date(row.archived_at as string),
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

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

export function hasOwn(value: object, field: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
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

export function rowToMemorySession(row: Record<string, unknown>): MemorySession {
  const expiresAt = row.expires_at == null ? null : new Date(row.expires_at as string);
  return {
    id: row.id as string,
    task_id: (row.task_id as string | null) ?? null,
    status: row.status as MemorySession['status'],
    actor_ref: (row.actor_ref as string | null) ?? null,
    created_at: new Date(row.created_at as string),
    closed_at: row.closed_at == null ? null : new Date(row.closed_at as string),
    expires_at: expiresAt,
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

export function rowToMemorySessionAttachment(row: Record<string, unknown>): MemorySessionAttachment {
  return {
    session_id: row.session_id as string,
    realm_id: row.realm_id as string,
    access: row.access as MemorySessionAttachment['access'],
    instructions: (row.instructions as string | null) ?? '',
    attached_at: new Date(row.attached_at as string),
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

const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

export function parseValidIsoTimestamp(value: string): Date | null {
  const match = ISO_TIMESTAMP_RE.exec(value);
  if (!match) return null;

  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, millisecondRaw = '', zoneRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (zoneRaw !== 'Z') {
    const offsetHour = Number(zoneRaw.slice(1, 3));
    const offsetMinute = Number(zoneRaw.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  if (zoneRaw === 'Z') {
    const milliseconds = millisecondRaw.padEnd(3, '0');
    const normalized = `${yearRaw}-${monthRaw}-${dayRaw}T${hourRaw}:${minuteRaw}:${secondRaw}.${milliseconds}Z`;
    if (parsed.toISOString() !== normalized) return null;
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

function normalizeMemoryMutationSourceRefs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('memory mutation source_refs must be a non-empty array of strings');
  }
  return value.map((ref, index) =>
    normalizeRequiredMemoryMutationString(`source_refs[${index}]`, ref),
  );
}

function normalizeRequiredMemoryMutationString(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`memory mutation ${field} must be a non-empty string`);
  }
  return value.trim();
}

export function rowToMemoryCandidateSupersessionEntry(
  row: Record<string, unknown>,
): MemoryCandidateSupersessionEntry {
  return {
    id: row.id as string,
    scope_id: row.scope_id as string,
    superseded_candidate_id: row.superseded_candidate_id as string,
    replacement_candidate_id: row.replacement_candidate_id as string,
    reviewed_at: row.reviewed_at ? new Date(row.reviewed_at as string) : null,
    review_reason: (row.review_reason as string | null) ?? null,
    interaction_id: row.interaction_id == null ? null : String(row.interaction_id),
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

export function rowToMemoryCandidateContradictionEntry(
  row: Record<string, unknown>,
): MemoryCandidateContradictionEntry {
  return {
    id: row.id as string,
    scope_id: row.scope_id as string,
    candidate_id: row.candidate_id as string,
    challenged_candidate_id: row.challenged_candidate_id as string,
    outcome: row.outcome as MemoryCandidateContradictionEntry['outcome'],
    supersession_entry_id: (row.supersession_entry_id as string | null) ?? null,
    reviewed_at: row.reviewed_at ? new Date(row.reviewed_at as string) : null,
    review_reason: (row.review_reason as string | null) ?? null,
    interaction_id: row.interaction_id == null ? null : String(row.interaction_id),
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

export function rowToCanonicalHandoffEntry(
  row: Record<string, unknown>,
): CanonicalHandoffEntry {
  return {
    id: row.id as string,
    scope_id: row.scope_id as string,
    candidate_id: row.candidate_id as string,
    target_object_type: row.target_object_type as CanonicalHandoffEntry['target_object_type'],
    target_object_id: row.target_object_id as string,
    source_refs: parseJsonStringArray(row.source_refs),
    reviewed_at: row.reviewed_at ? new Date(row.reviewed_at as string) : null,
    review_reason: (row.review_reason as string | null) ?? null,
    interaction_id: row.interaction_id == null ? null : String(row.interaction_id),
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

export function rowToTaskThread(row: Record<string, unknown>): TaskThread {
  return {
    id: row.id as string,
    scope: row.scope as TaskThread['scope'],
    title: row.title as string,
    goal: (row.goal as string | null) ?? '',
    status: row.status as TaskThread['status'],
    repo_path: (row.repo_path as string | null) ?? null,
    branch_name: (row.branch_name as string | null) ?? null,
    current_summary: (row.current_summary as string | null) ?? '',
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

export function rowToTaskWorkingSet(row: Record<string, unknown>): TaskWorkingSet {
  return {
    task_id: row.task_id as string,
    active_paths: parseJsonStringArray(row.active_paths),
    active_symbols: parseJsonStringArray(row.active_symbols),
    blockers: parseJsonStringArray(row.blockers),
    open_questions: parseJsonStringArray(row.open_questions),
    next_steps: parseJsonStringArray(row.next_steps),
    verification_notes: parseJsonStringArray(row.verification_notes),
    last_verified_at: row.last_verified_at ? new Date(row.last_verified_at as string) : null,
    updated_at: new Date(row.updated_at as string),
  };
}

export function rowToTaskAttempt(row: Record<string, unknown>): TaskAttempt {
  return {
    id: row.id as string,
    task_id: row.task_id as string,
    summary: row.summary as string,
    outcome: row.outcome as TaskAttempt['outcome'],
    applicability_context: parseJsonObject(row.applicability_context),
    evidence: parseJsonStringArray(row.evidence),
    created_at: new Date(row.created_at as string),
  };
}

export function rowToTaskDecision(row: Record<string, unknown>): TaskDecision {
  return {
    id: row.id as string,
    task_id: row.task_id as string,
    summary: row.summary as string,
    rationale: (row.rationale as string | null) ?? '',
    consequences: parseJsonStringArray(row.consequences),
    validity_context: parseJsonObject(row.validity_context),
    created_at: new Date(row.created_at as string),
  };
}

export function rowToRetrievalTrace(row: Record<string, unknown>): RetrievalTrace {
  return {
    id: row.id as string,
    task_id: (row.task_id as string | null) ?? null,
    scope: row.scope as RetrievalTrace['scope'],
    route: parseJsonStringArray(row.route),
    source_refs: parseJsonStringArray(row.source_refs),
    derived_consulted: parseJsonStringArray(row.derived_consulted),
    verification: parseJsonStringArray(row.verification),
    write_outcome: (row.write_outcome as RetrievalTrace['write_outcome'] | null) ?? 'no_durable_write',
    selected_intent: (row.selected_intent as RetrievalTrace['selected_intent'] | null) ?? null,
    scope_gate_policy: (row.scope_gate_policy as RetrievalTrace['scope_gate_policy'] | null) ?? null,
    scope_gate_reason: (row.scope_gate_reason as string | null) ?? null,
    outcome: (row.outcome as string | null) ?? '',
    created_at: new Date(row.created_at as string),
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function parseNullableJsonObject(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  return parseJsonObject(value);
}

function parseJsonStringArray(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return JSON.parse(value) as string[];
  return value as string[];
}

function parseNoteManifestHeadings(value: unknown): NoteManifestHeading[] {
  if (!value) return [];
  const headings = typeof value === 'string'
    ? JSON.parse(value) as Array<Record<string, unknown>>
    : value as Array<Record<string, unknown>>;
  return headings.map((heading) => ({
    slug: String(heading.slug ?? ''),
    text: String(heading.text ?? ''),
    depth: Number(heading.depth ?? 0),
    line_start: Number(heading.line_start ?? 0),
  }));
}
