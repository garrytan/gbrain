import type { Operation, OperationContext } from './operations.ts';
import { buildAgentSessionActivationArtifacts } from './services/agent-session-activation-service.ts';
import { classifyAgentSessionMemorySignals } from './services/agent-session-classifier-service.ts';
import {
  compressAgentSessionCapturePlan,
  summarizeAgentSessionObservations,
} from './services/agent-session-compression-service.ts';
import {
  buildAgentSessionCapturePlan,
  type AgentSessionCapturePlan,
} from './services/agent-session-memory-service.ts';
import { routeAgentSessionMemorySignals } from './services/agent-session-writeback-service.ts';
import {
  AGENT_SESSION_EVENT_KINDS,
  AGENT_SESSION_SOURCE_KINDS,
  type AgentSessionActor,
  type AgentSessionEventInput,
  type AgentSessionSourceKind,
  type AgentSessionWriteMode,
} from './types.ts';
import { persistRawIngestPlan } from './source-registry/raw-ingest-store.ts';

type OperationErrorCtor = new (
  code: 'invalid_params',
  message: string,
  suggestion?: string,
  docs?: string,
) => Error;

const AGENT_SESSION_WRITE_MODES = [
  'candidate_only',
  'direct_personal_when_allowed',
] as const satisfies readonly AgentSessionWriteMode[];

const AGENT_SESSION_ACTORS = [
  'user',
  'assistant',
  'tool',
  'subagent',
  'system',
] as const satisfies readonly AgentSessionActor[];

interface AgentSessionMemoryOperationParams {
  source_kind: AgentSessionSourceKind;
  session_id: string;
  events: AgentSessionEventInput[];
  client_name?: string;
  source_id?: string;
  repo_path?: string | null;
  workspace_id?: string | null;
  write_mode: AgentSessionWriteMode;
  apply: boolean;
  now?: string;
}

export function createAgentSessionMemoryOperations(
  deps: { OperationError: OperationErrorCtor },
): Operation[] {
  const preview_agent_session_memory: Operation = {
    name: 'preview_agent_session_memory',
    description: 'Preview deterministic agent session memory capture, signal routing, and activation artifacts.',
    params: agentSessionMemoryParams({ includeApplyControls: false }),
    mutating: false,
    handler: async (ctx, params) => runAgentSessionMemoryPipeline(deps, ctx, params, false),
    cliHints: { name: 'agent-session-preview' },
  };

  const capture_agent_session_memory: Operation = {
    name: 'capture_agent_session_memory',
    description: 'Capture deterministic agent session memory and apply governed writeback when requested.',
    params: agentSessionMemoryParams(),
    mutating: true,
    handler: async (ctx, params) => runAgentSessionMemoryPipeline(
      deps,
      ctx,
      params,
      params.apply === true && !ctx.dryRun,
    ),
    cliHints: { name: 'agent-session-capture' },
  };

  return [preview_agent_session_memory, capture_agent_session_memory];
}

function agentSessionMemoryParams(
  options: { includeApplyControls?: boolean } = {},
): Operation['params'] {
  const params: Operation['params'] = {
    source_kind: {
      type: 'string',
      required: true,
      enum: [...AGENT_SESSION_SOURCE_KINDS],
      description: 'Agent session source kind.',
    },
    session_id: {
      type: 'string',
      required: true,
      description: 'Stable agent session id.',
    },
    events: {
      type: ['array', 'string'],
      required: true,
      items: { type: 'object' },
      description: 'Agent session events as objects, or a JSON array string.',
    },
    client_name: {
      type: 'string',
      nullable: true,
      description: 'Optional client name.',
    },
    source_id: {
      type: 'string',
      nullable: true,
      description: 'Optional source registry id override.',
    },
    repo_path: {
      type: 'string',
      nullable: true,
      description: 'Optional repository path associated with the session.',
    },
    workspace_id: {
      type: 'string',
      nullable: true,
      description: 'Optional workspace id associated with the session.',
    },
    write_mode: {
      type: 'string',
      enum: [...AGENT_SESSION_WRITE_MODES],
      default: 'candidate_only',
      description: 'Governed writeback mode.',
    },
    now: {
      type: 'string',
      description: 'Optional ISO timestamp used for deterministic capture ids.',
    },
  };

  if (options.includeApplyControls !== false) {
    params.apply = {
      type: 'boolean',
      description: 'Apply governed writeback for capture when dry-run is false.',
    };
    params.dry_run = {
      type: 'boolean',
      description: 'Preview capture without mutating memory when the CLI maps this flag into the operation context.',
    };
  }

  return params;
}

async function runAgentSessionMemoryPipeline(
  deps: { OperationError: OperationErrorCtor },
  ctx: OperationContext,
  rawParams: Record<string, unknown>,
  apply: boolean,
): Promise<Record<string, unknown>> {
  const params = parseAgentSessionMemoryParams(deps, rawParams);
  const capture = buildAgentSessionCapturePlan({
    source_kind: params.source_kind,
    session_id: params.session_id,
    client_name: params.client_name,
    source_id: params.source_id,
    repo_path: params.repo_path,
    workspace_id: params.workspace_id,
    events: params.events,
    now: params.now,
  });
  const observations = compressAgentSessionCapturePlan(capture);
  const summary = summarizeAgentSessionObservations(observations);
  const signals = classifyAgentSessionMemorySignals({ observations, summary });
  const routes = apply
    ? await ctx.engine.transaction(async (tx) => {
        await persistRawIngestPlan(tx, capture.ingest_plan);
        return routeAgentSessionMemorySignals(tx, {
          signals,
          apply,
          write_mode: params.write_mode,
        });
      })
    : await routeAgentSessionMemorySignals(ctx.engine, {
        signals,
        apply,
        write_mode: params.write_mode,
      });
  const activationArtifacts = buildAgentSessionActivationArtifacts(routes);

  return {
    applied: routes.some((route) =>
      route.route?.applied === true || route.direct_write?.status === 'written'),
    dry_run: ctx.dryRun,
    capture: redactCaptureForResponse(capture),
    observations,
    summary,
    signals,
    routes,
    activation_artifacts: activationArtifacts,
  };
}

function redactCaptureForResponse(capture: AgentSessionCapturePlan): AgentSessionCapturePlan {
  return {
    ...capture,
    events: capture.events.map((event, index) => ({
      ...event,
      text: redactedEventText(capture.ingest_plan.chunks[index]?.redacted_text ?? ''),
    })),
    ingest_plan: {
      ...capture.ingest_plan,
      chunks: capture.ingest_plan.chunks.map((chunk) => ({
        ...chunk,
        chunk_text: chunk.redacted_text,
      })),
    },
  };
}

function redactedEventText(redactedChunkText: string): string {
  const lines = redactedChunkText.split(/\r?\n/);
  return (lines.length > 1 ? lines.slice(1).join('\n') : redactedChunkText).trim();
}

function parseAgentSessionMemoryParams(
  deps: { OperationError: OperationErrorCtor },
  params: Record<string, unknown>,
): AgentSessionMemoryOperationParams {
  const sourceKind = requireEnumValue(deps, 'source_kind', params.source_kind, AGENT_SESSION_SOURCE_KINDS);
  const sessionId = requireNonEmptyString(deps, 'session_id', params.session_id);
  const clientName = optionalNullableString(deps, 'client_name', params.client_name) ?? undefined;
  const sourceId = optionalNullableString(deps, 'source_id', params.source_id) ?? undefined;
  const repoPath = optionalNullableString(deps, 'repo_path', params.repo_path);
  const workspaceId = optionalNullableString(deps, 'workspace_id', params.workspace_id);
  const writeMode = optionalEnumValue(deps, 'write_mode', params.write_mode, AGENT_SESSION_WRITE_MODES)
    ?? 'candidate_only';

  return {
    source_kind: sourceKind,
    session_id: sessionId,
    events: parseEvents(deps, params.events, sourceKind, sessionId),
    client_name: clientName,
    source_id: sourceId,
    repo_path: repoPath,
    workspace_id: workspaceId,
    write_mode: writeMode,
    apply: optionalBoolean(deps, 'apply', params.apply) ?? false,
    now: optionalString(deps, 'now', params.now),
  };
}

function parseEvents(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
  sourceKind: AgentSessionSourceKind,
  sessionId: string,
): AgentSessionEventInput[] {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw invalidParams(deps, 'events must be valid JSON when passed as an array string');
    }
  }

  if (!Array.isArray(parsed)) {
    throw invalidParams(deps, 'events must be an array or JSON array string');
  }

  return parsed.map((event, index) => parseEvent(deps, event, index, sourceKind, sessionId));
}

function parseEvent(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
  index: number,
  sourceKind: AgentSessionSourceKind,
  sessionId: string,
): AgentSessionEventInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidParams(deps, `events[${index}] must be an object`);
  }
  const event = value as Record<string, unknown>;
  const eventKind = requireEnumValue(deps, `events[${index}].event_kind`, event.event_kind, AGENT_SESSION_EVENT_KINDS);
  const text = requireNonEmptyString(deps, `events[${index}].text`, event.text);
  const eventSourceKind = optionalEnumValue(deps, `events[${index}].source_kind`, event.source_kind, AGENT_SESSION_SOURCE_KINDS)
    ?? sourceKind;
  if (eventSourceKind !== sourceKind) {
    throw invalidParams(deps, `events[${index}].source_kind must match source_kind`);
  }
  const eventSessionId = optionalString(deps, `events[${index}].session_id`, event.session_id) ?? sessionId;
  if (eventSessionId !== sessionId) {
    throw invalidParams(deps, `events[${index}].session_id must match session_id`);
  }
  const actor = optionalEnumValue(deps, `events[${index}].actor`, event.actor, AGENT_SESSION_ACTORS);
  const eventId = optionalString(deps, `events[${index}].event_id`, event.event_id);
  const clientName = optionalString(deps, `events[${index}].client_name`, event.client_name);
  const repoPath = optionalNullableString(deps, `events[${index}].repo_path`, event.repo_path);
  const workspaceId = optionalNullableString(deps, `events[${index}].workspace_id`, event.workspace_id);
  const occurredAt = optionalString(deps, `events[${index}].occurred_at`, event.occurred_at);
  const metadata = optionalObject(deps, `events[${index}].metadata`, event.metadata) ?? {};

  return {
    source_kind: eventSourceKind,
    session_id: eventSessionId,
    event_kind: eventKind,
    text,
    event_id: eventId,
    actor,
    client_name: clientName,
    repo_path: repoPath,
    workspace_id: workspaceId,
    occurred_at: occurredAt,
    metadata,
  };
}

function requireNonEmptyString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidParams(deps, `${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw invalidParams(deps, `${field} must be a string`);
  }
  return value;
}

function optionalNullableString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw invalidParams(deps, `${field} must be a string or null`);
  }
  return value;
}

function optionalBoolean(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
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
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalidParams(deps, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireEnumValue<T extends string>(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
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
  if (value === undefined || value === null) return undefined;
  return requireEnumValue(deps, field, value, allowed);
}

function invalidParams(
  deps: { OperationError: OperationErrorCtor },
  message: string,
): Error {
  return new deps.OperationError('invalid_params', message);
}
