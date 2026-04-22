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
    verification: parseJsonStringArray(row.verification),
    outcome: (row.outcome as string | null) ?? '',
    created_at: new Date(row.created_at as string),
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return value as Record<string, unknown>;
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
