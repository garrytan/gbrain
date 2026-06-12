import type {
  AutoPromoteVerdictRow,
  CanonicalHandoffEntry,
  Chunk,
  ContextAtlasEntry,
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
  NoteManifestEntry,
  NoteManifestHeading,
  NoteSectionEntry,
  Page,
  PageType,
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

export function rowToChunk(row: Record<string, unknown>, includeEmbedding = false): Chunk {
  return {
    id: row.id as number,
    page_id: row.page_id as number,
    chunk_index: row.chunk_index as number,
    chunk_text: row.chunk_text as string,
    chunk_source: row.chunk_source as Chunk['chunk_source'],
    chunk_content_hash: String(row.chunk_content_hash ?? ''),
    embedding: includeEmbedding && row.embedding ? row.embedding as Float32Array : null,
    model: row.model as string,
    token_count: row.token_count as number | null,
    embedded_at: row.embedded_at ? new Date(row.embedded_at as string) : null,
  };
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
    score: Number(row.score),
    stale: Boolean(row.stale),
    ...searchResultDerivedFields(row),
  };
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
