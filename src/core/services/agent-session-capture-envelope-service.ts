import {
  AGENT_SESSION_EVENT_KINDS,
  AGENT_SESSION_SOURCE_KINDS,
  type AgentSessionActor,
  type AgentSessionCaptureOperationInput,
  type AgentSessionEventInput,
  type AgentSessionEventKind,
  type AgentSessionSourceKind,
} from '../types.ts';

export interface AgentSessionInheritedEnvelopeMetadata {
  source_kind: AgentSessionSourceKind;
  session_id: string;
  client_name?: string;
  repo_path?: string | null;
  workspace_id?: string | null;
}

export function normalizeAgentSessionCaptureEnvelope(
  input: unknown,
): AgentSessionCaptureOperationInput {
  const envelope = requireRecord(input, 'capture envelope');
  const sourceKind = requireEnum(
    envelope.source_kind,
    'source_kind',
    AGENT_SESSION_SOURCE_KINDS,
  );
  const sessionId = requireNonEmptyString(envelope.session_id, 'session_id');
  const inherited: AgentSessionInheritedEnvelopeMetadata = {
    source_kind: sourceKind,
    session_id: sessionId,
    client_name: optionalString(envelope.client_name, 'client_name'),
    repo_path: optionalNullableString(envelope.repo_path, 'repo_path'),
    workspace_id: optionalNullableString(envelope.workspace_id, 'workspace_id'),
  };
  const events = normalizeEvents(envelope.events, inherited);

  return {
    ...inherited,
    events,
    now: optionalString(envelope.captured_at, 'captured_at'),
  };
}

export function parseAgentSessionEventJsonl(
  text: string,
  inherited: AgentSessionInheritedEnvelopeMetadata,
): AgentSessionEventInput[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`JSONL line ${index + 1} must be valid JSON`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`JSONL line ${index + 1} must be an object`);
      }
      return normalizeEvent(parsed as Record<string, unknown>, inherited);
    });
}

function normalizeEvents(
  input: unknown,
  inherited: AgentSessionInheritedEnvelopeMetadata,
): AgentSessionEventInput[] {
  if (!Array.isArray(input)) throw new Error('events must be an array');
  return input.map((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error(`events[${index}] must be an object`);
    }
    return normalizeEvent(event as Record<string, unknown>, inherited);
  });
}

function normalizeEvent(
  event: Record<string, unknown>,
  inherited: AgentSessionInheritedEnvelopeMetadata,
): AgentSessionEventInput {
  const sourceKind = optionalEnum(event.source_kind, 'source_kind', AGENT_SESSION_SOURCE_KINDS)
    ?? inherited.source_kind;
  const sessionId = optionalString(event.session_id, 'session_id') ?? inherited.session_id;
  if (sourceKind !== inherited.source_kind) {
    throw new Error('event source_kind must match capture source_kind');
  }
  if (sessionId !== inherited.session_id) {
    throw new Error('event session_id must match capture session_id');
  }
  const eventKind = requireEnum(event.event_kind, 'event_kind', AGENT_SESSION_EVENT_KINDS);
  const text = requireNonEmptyString(event.text, 'text');

  return {
    source_kind: sourceKind,
    session_id: sessionId,
    event_kind: eventKind,
    text,
    event_id: optionalString(event.event_id, 'event_id'),
    actor: optionalEnum(event.actor, 'actor', ['user', 'assistant', 'tool', 'subagent', 'system'] as const)
      ?? defaultActor(eventKind),
    client_name: optionalString(event.client_name, 'client_name') ?? inherited.client_name,
    repo_path: optionalNullableString(event.repo_path, 'repo_path') ?? inherited.repo_path,
    workspace_id: optionalNullableString(event.workspace_id, 'workspace_id') ?? inherited.workspace_id,
    occurred_at: optionalString(event.occurred_at, 'occurred_at'),
    metadata: optionalRecord(event.metadata, 'metadata'),
  };
}

function defaultActor(eventKind: AgentSessionEventKind): AgentSessionActor {
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalNullableString(value: unknown, label: string): string | null | undefined {
  if (value == null) return value as null | undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string or null`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireEnum<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function optionalEnum<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T | undefined {
  if (value == null) return undefined;
  return requireEnum(value, label, allowed);
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
