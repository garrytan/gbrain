import { createHash } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import type {
  ContextAtlasEntry,
  ContextMapEntry,
  MemoryCandidateEntry,
  MemoryMutationTargetKind,
  MemoryRealm,
  MemorySession,
  MemorySessionAttachment,
  PersonalEpisodeEntry,
  ProfileMemoryEntry,
  TaskThread,
  TaskWorkingSet,
} from '../types.ts';
import { contentHash, parseValidIsoTimestamp } from '../utils.ts';

export type SupportedTargetSnapshotKind =
  | 'page'
  | 'memory_realm'
  | 'memory_session'
  | 'memory_session_attachment'
  | 'profile_memory'
  | 'personal_episode'
  | 'memory_candidate'
  | 'task_thread'
  | 'context_map'
  | 'context_atlas'
  | 'working_set';

export type TargetSnapshotHashSource =
  | 'page.content_hash'
  | 'page.content_hash_fallback'
  | 'canonical_json';

export interface TargetSnapshotHashInput {
  target_kind: MemoryMutationTargetKind | string;
  target_id: string;
}

export interface TargetSnapshotHashResult {
  target_kind: SupportedTargetSnapshotKind;
  target_id: string;
  target_snapshot_hash: string;
  hash_source: TargetSnapshotHashSource;
}

export class UnsupportedTargetSnapshotKindError extends Error {
  constructor(targetKind: string) {
    super(`unsupported target_kind: ${targetKind}`);
    this.name = 'UnsupportedTargetSnapshotKindError';
  }
}

const VOLATILE_STORAGE_KEYS = new Set([
  'created_at',
  'updated_at',
  'generated_at',
  'last_indexed_at',
  'attached_at',
  'fetched_at',
  'embedded_at',
  'snapshot_at',
]);
const MEMORY_SESSION_ATTACHMENT_TARGET_ID_PREFIX = 'memory_session_attachment:v1:';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeForHash(value));
}

export function hashCanonicalJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function memorySessionAttachmentTargetId(input: {
  session_id: string;
  realm_id: string;
}): string {
  return [
    MEMORY_SESSION_ATTACHMENT_TARGET_ID_PREFIX,
    encodeURIComponent(input.session_id),
    ':',
    encodeURIComponent(input.realm_id),
  ].join('');
}

export async function resolveTargetSnapshotHash(
  engine: BrainEngine,
  input: TargetSnapshotHashInput,
): Promise<TargetSnapshotHashResult | null> {
  switch (input.target_kind) {
    case 'page':
      return pageTargetSnapshotHash(engine, input.target_id);
    case 'memory_realm':
      return canonicalTargetSnapshotHash(
        input.target_kind,
        input.target_id,
        await engine.getMemoryRealm(input.target_id),
        memoryRealmPayload,
      );
    case 'memory_session':
      return canonicalTargetSnapshotHash(
        input.target_kind,
        input.target_id,
        await engine.getMemorySession(input.target_id),
        memorySessionPayload,
      );
    case 'memory_session_attachment':
      return memorySessionAttachmentTargetSnapshotHash(engine, input.target_id);
    case 'profile_memory':
      return canonicalTargetSnapshotHash(
        input.target_kind,
        input.target_id,
        await engine.getProfileMemoryEntry(input.target_id),
        profileMemoryPayload,
      );
    case 'personal_episode':
      return canonicalTargetSnapshotHash(
        input.target_kind,
        input.target_id,
        await engine.getPersonalEpisodeEntry(input.target_id),
        personalEpisodePayload,
      );
    case 'memory_candidate':
      return canonicalTargetSnapshotHash(
        input.target_kind,
        input.target_id,
        await engine.getMemoryCandidateEntry(input.target_id),
        memoryCandidatePayload,
      );
    case 'task_thread':
      return canonicalTargetSnapshotHash(
        input.target_kind,
        input.target_id,
        await engine.getTaskThread(input.target_id),
        taskThreadPayload,
      );
    case 'context_map':
      return canonicalTargetSnapshotHash(
        input.target_kind,
        input.target_id,
        await engine.getContextMapEntry(input.target_id),
        contextMapPayload,
      );
    case 'context_atlas':
      return canonicalTargetSnapshotHash(
        input.target_kind,
        input.target_id,
        await engine.getContextAtlasEntry(input.target_id),
        contextAtlasPayload,
      );
    case 'working_set':
      return canonicalTargetSnapshotHash(
        input.target_kind,
        input.target_id,
        await engine.getTaskWorkingSet(input.target_id),
        taskWorkingSetPayload,
      );
    default:
      throw new UnsupportedTargetSnapshotKindError(input.target_kind);
  }
}

function canonicalizeForHash(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  if (value === undefined) {
    throw new Error('Cannot hash unsupported JSON value type: undefined');
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error('Cannot hash an invalid Date value');
    }
    return value.toISOString();
  }
  if (typeof value === 'string') {
    const parsed = parseValidIsoTimestamp(value);
    return parsed ? parsed.toISOString() : value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Cannot hash a non-finite number');
    }
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') {
    throw new Error('Cannot hash unsupported JSON value type: bigint');
  }
  if (Array.isArray(value)) return value.map((nested) => canonicalizeForHash(nested, depth + 1));
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      const name = value.constructor?.name ?? 'object';
      throw new Error(`Cannot hash unsupported object value: ${name}`);
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => depth > 0 || !VOLATILE_STORAGE_KEYS.has(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeForHash(nested, depth + 1)]),
    );
  }
  throw new Error(`Cannot hash unsupported JSON value type: ${typeof value}`);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function pageTargetSnapshotHash(
  engine: BrainEngine,
  targetId: string,
): Promise<TargetSnapshotHashResult | null> {
  const page = await engine.getPage(targetId);
  if (!page) return null;
  if (page.content_hash) {
    return targetSnapshotResult('page', targetId, page.content_hash, 'page.content_hash');
  }
  return targetSnapshotResult(
    'page',
    targetId,
    contentHash(page.compiled_truth, page.timeline || ''),
    'page.content_hash_fallback',
  );
}

async function memorySessionAttachmentTargetSnapshotHash(
  engine: BrainEngine,
  targetId: string,
): Promise<TargetSnapshotHashResult | null> {
  const matches: MemorySessionAttachment[] = [];
  const parsedTarget = parseMemorySessionAttachmentTargetIdCandidates(targetId);
  for (const parsed of parsedTarget.candidates) {
    const attachments = await engine.listMemorySessionAttachments({
      session_id: parsed.session_id,
      realm_id: parsed.realm_id,
      limit: 1,
    });
    if (attachments[0]) matches.push(attachments[0]);
  }
  if (matches.length === 0 && parsedTarget.encodedError) {
    throw parsedTarget.encodedError;
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous memory_session_attachment target_id: ${targetId}`);
  }
  const attachment = matches[0];
  if (!attachment) return null;
  return targetSnapshotResult(
    'memory_session_attachment',
    targetId,
    hashCanonicalJson(memorySessionAttachmentPayload(attachment)),
    'canonical_json',
  );
}

function canonicalTargetSnapshotHash<T>(
  targetKind: SupportedTargetSnapshotKind,
  targetId: string,
  record: T | null,
  payload: (record: T) => Record<string, unknown>,
): TargetSnapshotHashResult | null {
  if (!record) return null;
  return targetSnapshotResult(
    targetKind,
    targetId,
    hashCanonicalJson(payload(record)),
    'canonical_json',
  );
}

function targetSnapshotResult(
  targetKind: SupportedTargetSnapshotKind,
  targetId: string,
  hash: string,
  source: TargetSnapshotHashSource,
): TargetSnapshotHashResult {
  return {
    target_kind: targetKind,
    target_id: targetId,
    target_snapshot_hash: hash,
    hash_source: source,
  };
}

function memoryRealmPayload(realm: MemoryRealm): Record<string, unknown> {
  return {
    id: realm.id,
    name: realm.name,
    description: realm.description,
    scope: realm.scope,
    default_access: realm.default_access,
    retention_policy: realm.retention_policy,
    export_policy: realm.export_policy,
    agent_instructions: realm.agent_instructions,
    archived_at: realm.archived_at,
  };
}

function memorySessionPayload(session: MemorySession): Record<string, unknown> {
  return {
    id: session.id,
    task_id: session.task_id,
    status: session.status,
    actor_ref: session.actor_ref,
    closed_at: session.closed_at,
    expires_at: session.expires_at,
  };
}

function memorySessionAttachmentPayload(attachment: MemorySessionAttachment): Record<string, unknown> {
  return {
    session_id: attachment.session_id,
    realm_id: attachment.realm_id,
    access: attachment.access,
    instructions: attachment.instructions,
  };
}

function profileMemoryPayload(entry: ProfileMemoryEntry): Record<string, unknown> {
  return {
    id: entry.id,
    scope_id: entry.scope_id,
    profile_type: entry.profile_type,
    subject: entry.subject,
    content: entry.content,
    source_refs: entry.source_refs,
    sensitivity: entry.sensitivity,
    export_status: entry.export_status,
    last_confirmed_at: entry.last_confirmed_at,
    superseded_by: entry.superseded_by,
  };
}

function personalEpisodePayload(entry: PersonalEpisodeEntry): Record<string, unknown> {
  return {
    id: entry.id,
    scope_id: entry.scope_id,
    title: entry.title,
    start_time: entry.start_time,
    end_time: entry.end_time,
    source_kind: entry.source_kind,
    summary: entry.summary,
    source_refs: entry.source_refs,
    candidate_ids: entry.candidate_ids,
  };
}

function memoryCandidatePayload(entry: MemoryCandidateEntry): Record<string, unknown> {
  return {
    id: entry.id,
    scope_id: entry.scope_id,
    candidate_type: entry.candidate_type,
    proposed_content: entry.proposed_content,
    source_refs: entry.source_refs,
    generated_by: entry.generated_by,
    extraction_kind: entry.extraction_kind,
    confidence_score: entry.confidence_score,
    importance_score: entry.importance_score,
    recurrence_score: entry.recurrence_score,
    sensitivity: entry.sensitivity,
    status: entry.status,
    target_object_type: entry.target_object_type,
    target_object_id: entry.target_object_id,
    reviewed_at: entry.reviewed_at,
    review_reason: entry.review_reason,
  };
}

function taskThreadPayload(thread: TaskThread): Record<string, unknown> {
  return {
    id: thread.id,
    scope: thread.scope,
    title: thread.title,
    goal: thread.goal,
    status: thread.status,
    repo_path: thread.repo_path,
    branch_name: thread.branch_name,
    current_summary: thread.current_summary,
  };
}

function contextMapPayload(entry: ContextMapEntry): Record<string, unknown> {
  return {
    id: entry.id,
    scope_id: entry.scope_id,
    kind: entry.kind,
    title: entry.title,
    build_mode: entry.build_mode,
    status: entry.status,
    source_set_hash: entry.source_set_hash,
    extractor_version: entry.extractor_version,
    node_count: entry.node_count,
    edge_count: entry.edge_count,
    community_count: entry.community_count,
    graph_json: entry.graph_json,
    stale_reason: entry.stale_reason,
  };
}

function contextAtlasPayload(entry: ContextAtlasEntry): Record<string, unknown> {
  return {
    id: entry.id,
    map_id: entry.map_id,
    scope_id: entry.scope_id,
    kind: entry.kind,
    title: entry.title,
    freshness: entry.freshness,
    entrypoints: entry.entrypoints,
    budget_hint: entry.budget_hint,
  };
}

function taskWorkingSetPayload(workingSet: TaskWorkingSet): Record<string, unknown> {
  return {
    task_id: workingSet.task_id,
    active_paths: workingSet.active_paths,
    active_symbols: workingSet.active_symbols,
    blockers: workingSet.blockers,
    open_questions: workingSet.open_questions,
    next_steps: workingSet.next_steps,
    verification_notes: workingSet.verification_notes,
    last_verified_at: workingSet.last_verified_at,
  };
}

function parseMemorySessionAttachmentTargetIdCandidates(targetId: string): {
  candidates: Array<{
    session_id: string;
    realm_id: string;
  }>;
  encodedError?: Error;
} {
  let encodedError: Error | undefined;
  const candidates: Array<{ session_id: string; realm_id: string }> = [];
  if (targetId.startsWith(MEMORY_SESSION_ATTACHMENT_TARGET_ID_PREFIX)) {
    try {
      candidates.push(parseEncodedMemorySessionAttachmentTargetId(targetId));
    } catch (error) {
      encodedError = error instanceof Error ? error : new Error(String(error));
    }
  }

  // Ledger target ids currently use `${session_id}:${realm_id}`. Both ids may
  // contain colons, so resolution tries each legal split and accepts one match.
  for (let delimiter = targetId.indexOf(':'); delimiter !== -1; delimiter = targetId.indexOf(':', delimiter + 1)) {
    if (delimiter <= 0 || delimiter === targetId.length - 1) continue;
    candidates.push({
      session_id: targetId.slice(0, delimiter),
      realm_id: targetId.slice(delimiter + 1),
    });
  }
  if (candidates.length === 0) {
    throw new Error('memory_session_attachment target_id must use session_id:realm_id');
  }
  return {
    candidates: dedupeMemorySessionAttachmentTargetCandidates(candidates),
    encodedError,
  };
}

function dedupeMemorySessionAttachmentTargetCandidates(
  candidates: Array<{ session_id: string; realm_id: string }>,
): Array<{ session_id: string; realm_id: string }> {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.session_id}\0${candidate.realm_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseEncodedMemorySessionAttachmentTargetId(targetId: string): {
  session_id: string;
  realm_id: string;
} {
  const encoded = targetId.slice(MEMORY_SESSION_ATTACHMENT_TARGET_ID_PREFIX.length);
  const delimiter = encoded.indexOf(':');
  if (delimiter <= 0 || delimiter === encoded.length - 1 || delimiter !== encoded.lastIndexOf(':')) {
    throw new Error('encoded memory_session_attachment target_id must use memory_session_attachment:v1:{session_id}:{realm_id}');
  }
  try {
    const sessionId = decodeURIComponent(encoded.slice(0, delimiter));
    const realmId = decodeURIComponent(encoded.slice(delimiter + 1));
    if (sessionId.length === 0 || realmId.length === 0) {
      throw new Error('decoded memory_session_attachment target_id parts must be non-empty');
    }
    return {
      session_id: sessionId,
      realm_id: realmId,
    };
  } catch (error) {
    if (error instanceof URIError) {
      throw new Error('encoded memory_session_attachment target_id contains invalid URI encoding');
    }
    throw error;
  }
}
