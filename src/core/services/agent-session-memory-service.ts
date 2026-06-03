import { createHash } from 'crypto';
import {
  buildRawIngestPlan,
  type RawIngestPlan,
  type SecretRisk,
} from '../source-registry/raw-ingest.ts';
import { getDefaultSourcePolicy } from '../source-registry/source-policy.ts';
import type {
  AgentSessionActor,
  AgentSessionEventInput,
  AgentSessionNormalizedEvent,
  AgentSessionSourceKind,
} from '../types.ts';

export interface AgentSessionCapturePlanInput {
  source_kind: AgentSessionSourceKind;
  session_id: string;
  client_name?: string;
  source_id?: string;
  repo_path?: string | null;
  workspace_id?: string | null;
  events: AgentSessionEventInput[];
  now?: string;
}

export interface AgentSessionCapturePlan {
  source_id: string;
  events: AgentSessionNormalizedEvent[];
  ingest_plan: RawIngestPlan;
  source_refs: string[];
  safety: {
    secret_risk: SecretRisk;
    prompt_injection_flagged: boolean;
    redacted: boolean;
  };
}

export function normalizeAgentSessionEvent(
  input: AgentSessionEventInput,
  now = new Date().toISOString(),
): AgentSessionNormalizedEvent {
  const occurredAt = input.occurred_at ?? now;
  const sourceKind = input.source_kind ?? 'agent_session';
  const sessionId = requireNonEmpty('session_id', input.session_id ?? '');
  const clientName = input.client_name ?? defaultClientName(sourceKind);
  const actor = input.actor ?? defaultActor(input.event_kind);
  const eventId = input.event_id ?? stableId(
    'agent-session-event',
    sourceKind,
    sessionId,
    input.event_kind,
    occurredAt,
    input.text,
  );

  return {
    source_kind: sourceKind,
    session_id: sessionId,
    event_kind: input.event_kind,
    text: input.text,
    event_id: eventId,
    actor,
    client_name: clientName,
    repo_path: input.repo_path ?? null,
    workspace_id: input.workspace_id ?? null,
    occurred_at: occurredAt,
    metadata: input.metadata ?? {},
  };
}

export function buildAgentSessionCapturePlan(input: AgentSessionCapturePlanInput): AgentSessionCapturePlan {
  const now = input.now ?? new Date().toISOString();
  const sessionId = requireNonEmpty('session_id', input.session_id);
  const clientName = input.client_name ?? defaultClientName(input.source_kind);
  const events = input.events.map((event) => {
    validateCaptureEvent(event, input.source_kind, sessionId);
    return normalizeAgentSessionEvent({
      ...event,
      source_kind: event.source_kind ?? input.source_kind,
      session_id: event.session_id ?? sessionId,
      client_name: event.client_name ?? clientName,
      repo_path: event.repo_path ?? input.repo_path ?? null,
      workspace_id: event.workspace_id ?? input.workspace_id ?? null,
    }, now);
  });
  const sourceId = input.source_id ?? stableId('source', input.source_kind, clientName);
  const policy = getDefaultSourcePolicy(input.source_kind);
  const chunkTexts = events.map(formatEventForChunk);
  const rawText = chunkTexts.join('\n\n');
  const ingestPlan = buildRawIngestPlan({
    source_id: sourceId,
    external_id: `${input.source_kind}:${sessionId}`,
    origin_event: 'session_capture',
    locator: `${input.source_kind}://${sessionId}`,
    title: `Agent session ${sessionId}`,
    chunk_texts: chunkTexts,
    raw_text: rawText,
    parser_version: 'agent-session:v1',
    extractor_version: 'agent-session-memory:v1',
    now,
  }, {
    consent_state: 'granted',
    enabled: true,
    raw_copy_mode: policy.raw_copy_mode,
    automatic_canonical_write_authority: policy.automatic_canonical_write_authority,
  });
  ingestPlan.item.metadata_json = {
    source_kind: input.source_kind,
    session_id: sessionId,
    client_name: clientName,
    repo_path: input.repo_path ?? null,
    workspace_id: input.workspace_id ?? null,
    event_ids: events.map((event) => event.event_id),
  };

  const chunks = ingestPlan.chunks;
  const redactedRawText = chunks.map((chunk) => chunk.redacted_text).join('\n\n');
  return {
    source_id: sourceId,
    events,
    ingest_plan: ingestPlan,
    source_refs: [
      `source_item:${ingestPlan.item.id}`,
      ...chunks.map((chunk) => `source_chunk:${chunk.id}`),
    ],
    safety: {
      secret_risk: chunks.some((chunk) => chunk.secret_risk !== 'none') ? 'flagged' : 'none',
      prompt_injection_flagged: ingestPlan.prompt_injection_flags.length > 0 || chunks.some((chunk) => chunk.prompt_injection_risk !== 'none'),
      redacted: rawText !== redactedRawText || chunks.some((chunk) => chunk.redacted_text !== chunk.chunk_text),
    },
  };
}

function formatEventForChunk(event: AgentSessionNormalizedEvent): string {
  return [
    `[${event.occurred_at}] ${event.actor} ${event.event_kind}`,
    event.text,
  ].join('\n');
}

function defaultClientName(sourceKind: AgentSessionSourceKind): string {
  if (sourceKind === 'codex_session') return 'codex';
  if (sourceKind === 'claude_session') return 'claude';
  return 'agent';
}

function defaultActor(eventKind: AgentSessionEventInput['event_kind'] | string): AgentSessionActor {
  switch (eventKind) {
    case 'tool_result':
    case 'tool_call':
    case 'tool_failure':
    case 'command_run':
    case 'search':
    case 'file_read':
    case 'file_write':
    case 'file_edit':
      return 'tool';
    case 'user_prompt':
    case 'explicit_memory_note':
      return 'user';
    case 'assistant_response':
    case 'subagent_result':
      return 'assistant';
    case 'session_start':
    case 'session_stop':
    default:
      return 'system';
  }
}

function validateCaptureEvent(
  event: AgentSessionEventInput,
  sourceKind: AgentSessionSourceKind,
  sessionId: string,
): void {
  if (event.source_kind !== undefined && event.source_kind !== sourceKind) {
    throw new Error('event source_kind must match capture source_kind');
  }
  if (event.session_id !== undefined && event.session_id !== sessionId) {
    throw new Error('event session_id must match capture session_id');
  }
}

function requireNonEmpty(field: string, value: string): string {
  if (value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;
}
