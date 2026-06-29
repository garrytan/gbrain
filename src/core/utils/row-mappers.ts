import type {
  AutoPromoteVerdictRow,
  CanonicalHandoffEntry,
  CanonicalTargetProposalEntry,
  CanonicalTargetProposalStatusEvent,
  Chunk,
  ContextAtlasEntry,
  ContextEvalAssertion,
  ContextEvalCorrection,
  ContextEvalRun,
  ContextMapEntry,
  DerivedIndexState,
  DerivedJob,
  MemoryCandidateContradictionEntry,
  MemoryCandidateEntry,
  MemoryCandidateEntryInput,
  MemoryCandidateStatusEvent,
  MemoryCandidateSupersessionEntry,
  MemoryMutationEvent,
  MemoryMutationEventInput,
  MemoryPatchBody,
  MemoryRealm,
  MemoryRedactionPlan,
  MemoryRedactionPlanItem,
  MemorySession,
  MemorySessionAttachment,
  MemoryWriteSession,
  MemoryWriteSessionConsumePatch,
  MemoryWriteSessionInput,
  NoteManifestEntry,
  NoteManifestHeading,
  NoteResolverMetadata,
  NoteSectionEntry,
  Page,
  PageType,
  PageVersion,
  PersonalEpisodeEntry,
  ProfileMemoryEntry,
  RetrievalTrace,
  SearchResult,
  TaskAttempt,
  TaskDecision,
  TaskThread,
  TaskWorkingSet,
} from '../types.ts';

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

export function rowToPageVersion(row: Record<string, unknown>): PageVersion {
  return {
    id: Number(row.id),
    page_id: Number(row.page_id),
    compiled_truth: String(row.compiled_truth),
    frontmatter: parseJsonObject(row.frontmatter),
    snapshot_at: new Date(String(row.snapshot_at)),
  };
}

export function rowToChunk(row: Record<string, unknown>, includeEmbedding = false): Chunk {
  return {
    id: row.id as number,
    page_id: row.page_id as number,
    chunk_index: row.chunk_index as number,
    chunk_text: row.chunk_text as string,
    chunk_source: row.chunk_source as Chunk['chunk_source'],
    chunk_content_hash: String(row.chunk_content_hash ?? ''),
    embedding: includeEmbedding ? vectorValueToFloat32(row.embedding) : null,
    model: row.model as string,
    token_count: row.token_count as number | null,
    embedded_at: row.embedded_at ? new Date(row.embedded_at as string) : null,
  };
}

export function vectorValueToFloat32(value: unknown): Float32Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Float32Array) return value;
  if (Array.isArray(value)) return float32FromNumbers(value);

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const body = trimmed.startsWith('[') && trimmed.endsWith(']')
      ? trimmed.slice(1, -1)
      : trimmed;
    if (body.length === 0) return new Float32Array(0);

    return float32FromNumbers(body.split(',').map((entry) => Number(entry.trim())));
  }

  return null;
}

function float32FromNumbers(values: unknown[]): Float32Array | null {
  const numbers = values.map((entry) => Number(entry));
  if (numbers.some((entry) => !Number.isFinite(entry))) return null;
  return new Float32Array(numbers);
}

export function rowToSearchResult(row: Record<string, unknown>, query?: string): SearchResult {
  return {
    slug: row.slug as string,
    page_id: row.page_id as number,
    title: row.title as string,
    type: row.type as PageType,
    chunk_text: query
      ? boundedSearchSnippet(String(row.chunk_text ?? ''), query)
      : row.chunk_text as string,
    chunk_source: row.chunk_source as SearchResult['chunk_source'],
    chunk_index: nullableNumber(row.chunk_index),
    chunk_content_hash: nullableString(row.chunk_content_hash),
    score: Number(row.score),
    stale: Boolean(row.stale),
    ...searchResultDerivedFields(row),
  };
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

export function boundedSearchSnippet(text: string, query: string, maxChars = 320): string {
  if (text.length <= maxChars) return text;
  const terms = query
    .split(/[^\p{L}\p{N}_+.-]+/u)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const lower = text.toLowerCase();
  const firstMatch = terms
    .map((term) => lower.indexOf(term))
    .filter((idx) => idx >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, firstMatch - Math.floor(maxChars / 3));
  const end = Math.min(text.length, start + maxChars);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

export function searchResultDerivedFields(row: Record<string, unknown>): Pick<
  SearchResult,
  | 'derived_artifact_kind'
  | 'derived_status'
  | 'derived_target_content_hash'
  | 'derived_indexed_content_hash'
  | 'derived_warning'
> {
  if (row.derived_status == null || row.derived_artifact_kind == null) return {};

  const artifactKind = String(row.derived_artifact_kind) as SearchResult['derived_artifact_kind'];
  const status = String(row.derived_status) as SearchResult['derived_status'];
  const targetContentHash = row.derived_target_content_hash == null
    ? null
    : String(row.derived_target_content_hash);
  const indexedContentHash = row.derived_indexed_content_hash == null
    ? null
    : String(row.derived_indexed_content_hash);
  const staleReady = status === 'ready'
    && targetContentHash !== null
    && indexedContentHash !== targetContentHash;
  const warning = status !== 'ready' || staleReady
    ? `${artifactKind} derived index is ${status}; canonical page-level match returned until derived data is current.`
    : undefined;

  return {
    derived_artifact_kind: artifactKind,
    derived_status: status,
    derived_target_content_hash: targetContentHash,
    derived_indexed_content_hash: indexedContentHash,
    ...(warning ? { derived_warning: warning } : {}),
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
    resolver_metadata: parseNoteResolverMetadata(row.resolver_metadata),
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

// Mirrors the listNoteSectionEntries SQL ordering:
// ORDER BY page_slug ASC, line_start ASC, section_id ASC
export function compareNoteSectionEntries(a: NoteSectionEntry, b: NoteSectionEntry): number {
  if (a.page_slug !== b.page_slug) return a.page_slug < b.page_slug ? -1 : 1;
  if (a.line_start !== b.line_start) return a.line_start - b.line_start;
  if (a.section_id !== b.section_id) return a.section_id < b.section_id ? -1 : 1;
  return 0;
}

export function rowToDerivedJob(row: Record<string, unknown>): DerivedJob {
  return {
    id: row.id as string,
    scope_id: row.scope_id as string,
    slug: row.slug as string,
    artifact_kind: row.artifact_kind as DerivedJob['artifact_kind'],
    target_content_hash: row.target_content_hash as string,
    manifest_path: row.manifest_path == null ? null : String(row.manifest_path),
    derived_parameters: parseJsonObject(row.derived_parameters),
    status: row.status as DerivedJob['status'],
    attempts: Number(row.attempts),
    last_error: row.last_error == null ? null : String(row.last_error),
    lease_owner: row.lease_owner == null ? null : String(row.lease_owner),
    lease_expires_at: row.lease_expires_at == null ? null : new Date(row.lease_expires_at as string),
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

export function rowToDerivedIndexState(row: Record<string, unknown>): DerivedIndexState {
  return {
    scope_id: row.scope_id as string,
    slug: row.slug as string,
    artifact_kind: row.artifact_kind as DerivedIndexState['artifact_kind'],
    target_content_hash: row.target_content_hash as string,
    indexed_content_hash: row.indexed_content_hash == null ? null : String(row.indexed_content_hash),
    status: row.status as DerivedIndexState['status'],
    extractor_version: row.extractor_version as string,
    derived_schema_version: row.derived_schema_version as string,
    last_error: row.last_error == null ? null : String(row.last_error),
    updated_at: new Date(row.updated_at as string),
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

export function rowToAutoPromoteVerdict(row: Record<string, unknown>): AutoPromoteVerdictRow {
  const judgedAt = row.judged_at;
  return {
    candidate_id: row.candidate_id as string,
    content_hash: row.content_hash as string,
    runner_kind: row.runner_kind as string,
    prompt_version: row.prompt_version as string,
    decision: row.decision as string,
    confidence: Number(row.confidence),
    reasoning: (row.reasoning as string | null) ?? '',
    judged_at: judgedAt instanceof Date ? judgedAt.toISOString() : String(judgedAt),
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
    verification_status: (row.verification_status as MemoryCandidateEntry['verification_status'] | null) ?? 'unverified',
    verification_method: (row.verification_method as MemoryCandidateEntry['verification_method'] | null) ?? null,
    verification_evidence: (row.verification_evidence as string | null) ?? null,
    verification_source_refs: parseJsonStringArray(row.verification_source_refs),
    verified_at: row.verified_at ? new Date(row.verified_at as string) : null,
    patch_target_kind: (row.patch_target_kind as MemoryCandidateEntry['patch_target_kind'] | null) ?? null,
    patch_target_id: (row.patch_target_id as string | null) ?? null,
    patch_base_target_snapshot_hash: (row.patch_base_target_snapshot_hash as string | null) ?? null,
    patch_body: parseNullableJsonValue(row.patch_body) as MemoryPatchBody | null,
    patch_format: (row.patch_format as MemoryCandidateEntry['patch_format'] | null) ?? null,
    patch_operation_state: (row.patch_operation_state as MemoryCandidateEntry['patch_operation_state'] | null) ?? null,
    patch_risk_class: (row.patch_risk_class as MemoryCandidateEntry['patch_risk_class'] | null) ?? null,
    patch_expected_resulting_target_snapshot_hash: (row.patch_expected_resulting_target_snapshot_hash as string | null) ?? null,
    patch_provenance_summary: (row.patch_provenance_summary as string | null) ?? null,
    patch_actor: (row.patch_actor as string | null) ?? null,
    patch_originating_session_id: (row.patch_originating_session_id as string | null) ?? null,
    patch_ledger_event_ids: parseJsonStringArray(row.patch_ledger_event_ids),
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

export function hasMemoryCandidatePatchInput(input: MemoryCandidateEntryInput): boolean {
  return input.patch_target_kind != null
    || input.patch_target_id != null
    || input.patch_base_target_snapshot_hash != null
    || input.patch_body != null
    || input.patch_format != null
    || input.patch_operation_state != null
    || input.patch_risk_class != null
    || input.patch_expected_resulting_target_snapshot_hash != null
    || input.patch_provenance_summary != null
    || input.patch_actor != null
    || input.patch_originating_session_id != null
    || (input.patch_ledger_event_ids?.length ?? 0) > 0;
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

export function rowToCanonicalTargetProposalEntry(row: Record<string, unknown>): CanonicalTargetProposalEntry {
  return {
    id: row.id as string,
    scope_id: row.scope_id as string,
    source_candidate_id: row.source_candidate_id as string,
    linked_candidate_ids: parseJsonStringArray(row.linked_candidate_ids),
    status: row.status as CanonicalTargetProposalEntry['status'],
    status_reason: (row.status_reason as string | null) ?? null,
    proposal_kind: row.proposal_kind as CanonicalTargetProposalEntry['proposal_kind'],
    target_object_type: row.target_object_type as CanonicalTargetProposalEntry['target_object_type'],
    proposed_slug: row.proposed_slug as string,
    proposed_title: row.proposed_title as string,
    proposed_page_type: row.proposed_page_type as CanonicalTargetProposalEntry['proposed_page_type'],
    proposed_repo_path: (row.proposed_repo_path as string | null) ?? null,
    confidence_score: Number(row.confidence_score),
    importance_score: Number(row.importance_score),
    rationale: row.rationale as string,
    filing_basis: parseJsonObject(row.filing_basis),
    source_refs: parseJsonStringArray(row.source_refs),
    candidate_snapshot: parseJsonObject(row.candidate_snapshot),
    duplicate_review: parseJsonObject(row.duplicate_review),
    slug_quality_warnings: parseJsonStringArray(row.slug_quality_warnings),
    approval_actor: (row.approval_actor as string | null) ?? null,
    approved_at: row.approved_at == null ? null : new Date(row.approved_at as string),
    approval_reason: (row.approval_reason as string | null) ?? null,
    bound_candidate_ids: parseJsonStringArray(row.bound_candidate_ids),
    stub_patch_candidate_id: (row.stub_patch_candidate_id as string | null) ?? null,
    stub_patch_state: (row.stub_patch_state as string | null) ?? null,
    rejected_at: row.rejected_at == null ? null : new Date(row.rejected_at as string),
    rejection_reason: (row.rejection_reason as string | null) ?? null,
    superseded_by: (row.superseded_by as string | null) ?? null,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

export function rowToCanonicalTargetProposalStatusEvent(
  row: Record<string, unknown>,
): CanonicalTargetProposalStatusEvent {
  return {
    id: row.id as string,
    proposal_id: row.proposal_id as string,
    scope_id: row.scope_id as string,
    from_status: (row.from_status as CanonicalTargetProposalStatusEvent['from_status']) ?? null,
    to_status: row.to_status as CanonicalTargetProposalStatusEvent['to_status'],
    event_kind: row.event_kind as CanonicalTargetProposalStatusEvent['event_kind'],
    actor: (row.actor as string | null) ?? null,
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

export function rowToMemorySessionAttachment(row: Record<string, unknown>): MemorySessionAttachment {
  return {
    session_id: row.session_id as string,
    realm_id: row.realm_id as string,
    access: row.access as MemorySessionAttachment['access'],
    instructions: (row.instructions as string | null) ?? '',
    attached_at: new Date(row.attached_at as string),
  };
}

export function rowToMemoryWriteSession(row: Record<string, unknown>): MemoryWriteSession {
  const status = row.status as MemoryWriteSession['status'];
  const expiresAt = new Date(row.expires_at as string);
  const effectiveStatus = status === 'open' && expiresAt.getTime() <= Date.now()
    ? 'expired'
    : status;
  return {
    id: normalizeRequiredMemoryMutationString('id', row.id),
    route_decision_id: normalizeRequiredMemoryMutationString('route_decision_id', row.route_decision_id),
    scope_id: normalizeRequiredMemoryMutationString('scope_id', row.scope_id),
    actor: normalizeRequiredMemoryMutationString('actor', row.actor),
    memory_session_id: (row.memory_session_id as string | null) ?? null,
    target_slug: normalizeRequiredMemoryMutationString('target_slug', row.target_slug),
    target_object_type: normalizeRequiredMemoryMutationString('target_object_type', row.target_object_type),
    expected_content_hash: (row.expected_content_hash as string | null) ?? null,
    source_refs: normalizeMemoryMutationSourceRefs(parseJsonStringArray(row.source_refs)),
    route_decision: row.route_decision as MemoryWriteSession['route_decision'],
    intended_operation: row.intended_operation as MemoryWriteSession['intended_operation'],
    route_reasons: parseJsonStringArray(row.route_reasons),
    missing_requirements: parseJsonStringArray(row.missing_requirements),
    governance_metadata: parseJsonObject(row.governance_metadata),
    status: effectiveStatus,
    status_reason: (row.status_reason as string | null) ?? null,
    consumed_by_event_id: (row.consumed_by_event_id as string | null) ?? null,
    created_at: new Date(row.created_at as string),
    expires_at: expiresAt,
    consumed_at: row.consumed_at == null ? null : new Date(row.consumed_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

export function normalizeMemoryWriteSessionInput(input: MemoryWriteSessionInput): MemoryWriteSessionInput {
  const id = normalizeRequiredMemoryMutationString('id', input.id);
  const routeDecisionId = normalizeRequiredMemoryMutationString('route_decision_id', input.route_decision_id);
  const scopeId = normalizeRequiredMemoryMutationString('scope_id', input.scope_id);
  const actor = normalizeRequiredMemoryMutationString('actor', input.actor);
  const targetSlug = normalizeRequiredMemoryMutationString('target_slug', input.target_slug);
  const targetObjectType = normalizeRequiredMemoryMutationString('target_object_type', input.target_object_type);
  const sourceRefs = normalizeMemoryMutationSourceRefs(input.source_refs);
  const routeReasons = input.route_reasons === undefined ? [] : normalizeOptionalStringArray('route_reasons', input.route_reasons);
  const missingRequirements = input.missing_requirements === undefined
    ? []
    : normalizeOptionalStringArray('missing_requirements', input.missing_requirements);

  if (input.route_decision !== 'canonical_write_allowed') {
    throw new Error('memory write session route_decision must be canonical_write_allowed');
  }
  if (input.intended_operation !== 'put_page') {
    throw new Error('memory write session intended_operation must be put_page');
  }
  if (input.memory_session_id != null) {
    normalizeRequiredMemoryMutationString('memory_session_id', input.memory_session_id);
  }
  if (input.expected_content_hash !== undefined && input.expected_content_hash !== null) {
    normalizeRequiredMemoryMutationString('expected_content_hash', input.expected_content_hash);
  }
  if (input.governance_metadata !== undefined && (typeof input.governance_metadata !== 'object' || Array.isArray(input.governance_metadata))) {
    throw new Error('memory write session governance_metadata must be an object');
  }
  const expiresAt = new Date(input.expires_at as string | Date);
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new Error('memory write session expires_at must be a valid date');
  }
  const createdAt = input.created_at == null ? input.created_at : new Date(input.created_at as string | Date);
  if (createdAt != null && !Number.isFinite(createdAt.getTime())) {
    throw new Error('memory write session created_at must be a valid date');
  }

  return {
    ...input,
    id,
    route_decision_id: routeDecisionId,
    scope_id: scopeId,
    actor,
    memory_session_id: input.memory_session_id == null ? null : String(input.memory_session_id).trim(),
    target_slug: targetSlug,
    target_object_type: targetObjectType,
    expected_content_hash: input.expected_content_hash ?? null,
    source_refs: sourceRefs,
    route_decision: 'canonical_write_allowed',
    intended_operation: 'put_page',
    route_reasons: routeReasons,
    missing_requirements: missingRequirements,
    governance_metadata: input.governance_metadata ?? {},
    created_at: createdAt == null ? createdAt : createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
}

export function normalizeMemoryWriteSessionConsumePatch(
  patch: MemoryWriteSessionConsumePatch,
): MemoryWriteSessionConsumePatch {
  if (
    patch.status !== 'applied'
    && patch.status !== 'superseded'
    && patch.status !== 'expired'
    && patch.status !== 'abandoned'
  ) {
    throw new Error('memory write session consume status must be terminal');
  }
  return {
    status: patch.status,
    consumed_by_event_id: patch.consumed_by_event_id == null
      ? null
      : normalizeRequiredMemoryMutationString('consumed_by_event_id', patch.consumed_by_event_id),
    status_reason: patch.status_reason == null
      ? null
      : normalizeRequiredMemoryMutationString('status_reason', patch.status_reason),
  };
}

export function rowToMemoryRedactionPlan(row: Record<string, unknown>): MemoryRedactionPlan {
  return {
    id: row.id as string,
    scope_id: row.scope_id as string,
    query: row.query as string,
    replacement_text: row.replacement_text as string,
    status: row.status as MemoryRedactionPlan['status'],
    requested_by: (row.requested_by as string | null) ?? null,
    review_reason: (row.review_reason as string | null) ?? null,
    created_at: new Date(row.created_at as string),
    reviewed_at: row.reviewed_at == null ? null : new Date(row.reviewed_at as string),
    applied_at: row.applied_at == null ? null : new Date(row.applied_at as string),
  };
}

export function rowToMemoryRedactionPlanItem(row: Record<string, unknown>): MemoryRedactionPlanItem {
  return {
    id: row.id as string,
    plan_id: row.plan_id as string,
    target_object_type: row.target_object_type as MemoryRedactionPlanItem['target_object_type'],
    target_object_id: row.target_object_id as string,
    field_path: row.field_path as string,
    before_hash: (row.before_hash as string | null) ?? null,
    after_hash: (row.after_hash as string | null) ?? null,
    status: row.status as MemoryRedactionPlanItem['status'],
    preview_text: (row.preview_text as string | null) ?? '',
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
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

export function rowToContextEvalRun(row: Record<string, unknown>): ContextEvalRun {
  return {
    id: String(row.id),
    fixture_id: String(row.fixture_id),
    fixture_mode: row.fixture_mode as ContextEvalRun['fixture_mode'],
    status: row.status as ContextEvalRun['status'],
    model_id: row.model_id == null ? null : String(row.model_id),
    skill_surface_hash: row.skill_surface_hash == null ? null : String(row.skill_surface_hash),
    agent_rules_version: row.agent_rules_version == null ? null : String(row.agent_rules_version),
    git_sha: row.git_sha == null ? null : String(row.git_sha),
    retrieval_trace_ids: parseJsonStringArray(row.retrieval_trace_ids),
    metrics: parseJsonObject(row.metrics),
    metadata: parseJsonObject(row.metadata),
    started_at: new Date(String(row.started_at)),
    completed_at: row.completed_at == null ? null : new Date(String(row.completed_at)),
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
  };
}

export function rowToContextEvalAssertion(row: Record<string, unknown>): ContextEvalAssertion {
  return {
    id: String(row.id),
    run_id: String(row.run_id),
    case_id: String(row.case_id),
    assertion_kind: String(row.assertion_kind),
    passed: typeof row.passed === 'boolean' ? row.passed : Boolean(Number(row.passed)),
    score: row.score == null ? null : Number(row.score),
    expected: parseNullableJsonValue(row.expected),
    actual: parseNullableJsonValue(row.actual),
    message: row.message == null ? null : String(row.message),
    retrieval_trace_id: row.retrieval_trace_id == null ? null : String(row.retrieval_trace_id),
    metadata: parseJsonObject(row.metadata),
    created_at: new Date(String(row.created_at)),
  };
}

export function rowToContextEvalCorrection(row: Record<string, unknown>): ContextEvalCorrection {
  return {
    id: String(row.id),
    trace_id: String(row.trace_id),
    run_id: row.run_id == null ? null : String(row.run_id),
    case_id: String(row.case_id),
    reason: String(row.reason),
    proposed_assertion_id: row.proposed_assertion_id == null ? null : String(row.proposed_assertion_id),
    metadata: parseJsonObject(row.metadata),
    created_at: new Date(String(row.created_at)),
  };
}

function normalizeMemoryMutationSourceRefs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('memory mutation source_refs must be a non-empty array of strings');
  }
  return value.map((ref, index) =>
    normalizeRequiredMemoryMutationString(`source_refs[${index}]`, ref),
  );
}

function normalizeOptionalStringArray(field: string, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`memory mutation ${field} must be an array of strings`);
  }
  return value.map((ref, index) =>
    normalizeRequiredMemoryMutationString(`${field}[${index}]`, ref),
  );
}

function normalizeRequiredMemoryMutationString(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`memory mutation ${field} must be a non-empty string`);
  }
  return value.trim();
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

function parseNullableJsonValue(value: unknown): unknown | null {
  if (value == null) return null;
  if (typeof value === 'string') return JSON.parse(value) as unknown;
  return value;
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

function parseNoteResolverMetadata(value: unknown): NoteResolverMetadata {
  const raw = parseJsonObject(value ?? {});
  const metadata: NoteResolverMetadata = {
    applies_to: parseStringArrayLike(raw.applies_to),
    excludes: parseStringArrayLike(raw.excludes),
    routing_triggers: parseStringArrayLike(raw.routing_triggers),
    gotchas: parseStringArrayLike(raw.gotchas),
  };
  if (typeof raw.canonical_subject_key === 'string') metadata.canonical_subject_key = raw.canonical_subject_key;
  if (typeof raw.definition_owner === 'string') metadata.definition_owner = raw.definition_owner;
  if (typeof raw.semantic_grain === 'string') metadata.semantic_grain = raw.semantic_grain;
  return metadata;
}

function parseStringArrayLike(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
