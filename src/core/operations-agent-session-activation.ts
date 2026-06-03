import type { Operation } from './operations.ts';
import { planAgentSessionActivation } from './services/agent-session-activation-planner-service.ts';

type OperationErrorCtor = new (
  code: 'invalid_params',
  message: string,
  suggestion?: string,
  docs?: string,
) => Error;

const REQUESTED_SCOPES = ['personal', 'work', 'mixed'] as const;
const MEMORY_SCENARIOS = [
  'coding_continuation',
  'project_qa',
  'knowledge_qa',
  'auto_accumulation',
  'personal_recall',
  'mixed',
] as const;

export function createAgentSessionActivationOperations(
  deps: { OperationError: OperationErrorCtor },
): Operation[] {
  return [{
    name: 'plan_agent_session_activation',
    description: 'Plan authority-aware activation for future agent sessions using profile, episode, task, and candidate memory.',
    params: {
      query: { type: 'string', required: true, description: 'Future-session request or continuation prompt' },
      requested_scope: { type: 'string', description: 'personal, work, or mixed', enum: [...REQUESTED_SCOPES] },
      scenario: { type: 'string', description: 'Optional memory scenario', enum: [...MEMORY_SCENARIOS] },
      task_id: { type: 'string', description: 'Optional active task id' },
      limit: { type: 'number', description: 'Maximum artifacts to return' },
    },
    mutating: false,
    handler: async (ctx, params) => planAgentSessionActivation(ctx.engine, {
      query: requireString(deps, params.query, 'query'),
      requested_scope: optionalEnum(deps, params.requested_scope, 'requested_scope', REQUESTED_SCOPES),
      scenario: optionalEnum(deps, params.scenario, 'scenario', MEMORY_SCENARIOS),
      task_id: optionalString(deps, params.task_id, 'task_id'),
      limit: optionalNumber(deps, params.limit, 'limit'),
    }),
    cliHints: {
      name: 'agent-session-activate',
      positional: ['query'],
      aliases: { n: 'limit', scope: 'requested_scope' },
    },
  }];
}

function requireString(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
  label: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new deps.OperationError('invalid_params', `${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
  label: string,
): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') {
    throw new deps.OperationError('invalid_params', `${label} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalNumber(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
  label: string,
): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new deps.OperationError('invalid_params', `${label} must be a number`);
  }
  return value;
}

function optionalEnum<T extends string>(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
  label: string,
  allowed: readonly T[],
): T | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new deps.OperationError('invalid_params', `${label} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}
