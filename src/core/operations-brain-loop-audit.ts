import type { Operation } from './operations.ts';
import { auditBrainLoop } from './services/brain-loop-audit-service.ts';
import { computeMemoryStrengthReport } from './services/memory-strength-service.ts';
import type { ScopeGateScope } from './types.ts';

type OperationErrorCtor = new (
  code: 'invalid_params',
  message: string,
  suggestion?: string,
  docs?: string,
) => Error;

const AUDIT_SCOPE_VALUES = ['work', 'personal', 'mixed', 'unknown'] as const satisfies readonly ScopeGateScope[];
const RELATIVE_WINDOW_PATTERN = /^\d+[hd]$/;
const MAX_AUDIT_BACKLOG_LIMIT = 500;

function invalidParams(
  deps: { OperationError: OperationErrorCtor },
  message: string,
): Error {
  return new deps.OperationError('invalid_params', message);
}

function optionalString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidParams(deps, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalAuditDate(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | undefined {
  const normalized = optionalString(deps, field, value);
  if (normalized === undefined) {
    return undefined;
  }
  if (RELATIVE_WINDOW_PATTERN.test(normalized)) {
    return normalized;
  }
  if (Number.isNaN(new Date(normalized).getTime())) {
    throw invalidParams(deps, `${field} must be an ISO timestamp or relative window such as 24h or 7d`);
  }
  return normalized;
}

function normalizeAuditDateForValidation(
  input: string | undefined,
  fallback: Date,
): Date {
  if (input === undefined) {
    return fallback;
  }
  const relative = input.match(/^(\d+)([hd])$/);
  if (relative) {
    const amount = Number(relative[1]);
    const millis = relative[2] === 'h'
      ? amount * 60 * 60 * 1000
      : amount * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - millis);
  }
  return new Date(input);
}

function validateAuditWindow(
  deps: { OperationError: OperationErrorCtor },
  input: {
    since?: string;
    until?: string;
  },
): void {
  const now = new Date();
  const until = normalizeAuditDateForValidation(input.until, now);
  const since = normalizeAuditDateForValidation(input.since, new Date(until.getTime() - 24 * 60 * 60 * 1000));
  if (since >= until) {
    throw invalidParams(deps, 'since must be before until');
  }
}

function optionalScope(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): ScopeGateScope | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'string' || !AUDIT_SCOPE_VALUES.includes(value as ScopeGateScope)) {
    throw invalidParams(deps, `scope must be one of: ${AUDIT_SCOPE_VALUES.join(', ')}`);
  }
  return value as ScopeGateScope;
}

function optionalLimit(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw invalidParams(deps, 'limit must be a positive number');
  }
  return Math.min(Math.floor(value), MAX_AUDIT_BACKLOG_LIMIT);
}

function optionalBoolean(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): boolean | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw invalidParams(deps, `${field} must be a boolean`);
  }
  return value;
}

export function createBrainLoopAuditOperations(
  deps: {
    OperationError: OperationErrorCtor;
  },
): Operation[] {
  const audit_brain_loop: Operation = {
    name: 'audit_brain_loop',
    description: 'Audit whether the brain-agent loop executed in a window.',
    params: {
      since: {
        type: 'string',
        description: 'ISO timestamp or relative window such as 24h or 7d. Default: now-24h.',
      },
      until: { type: 'string', description: 'ISO timestamp. Default: now.' },
      task_id: { type: 'string' },
      scope: { type: 'string', enum: [...AUDIT_SCOPE_VALUES] },
      limit: { type: 'number', description: 'Backlog cap. Default 50, max 500.' },
      json: { type: 'boolean', description: 'Accepted for CLI parity; operation always returns structured data.' },
    },
    mutating: false,
    handler: async (ctx, p) => {
      const input = {
        since: optionalAuditDate(deps, 'since', p.since),
        until: optionalAuditDate(deps, 'until', p.until),
        task_id: optionalString(deps, 'task_id', p.task_id),
        scope: optionalScope(deps, p.scope),
        limit: optionalLimit(deps, p.limit),
      };
      validateAuditWindow(deps, input);
      const json = optionalBoolean(deps, 'json', p.json);

      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'audit_brain_loop',
          ...input,
          json,
        };
      }

      return auditBrainLoop(ctx.engine, input);
    },
    cliHints: { name: 'audit-brain-loop', aliases: { n: 'limit' } },
  };

  const get_memory_strength_report: Operation = {
    name: 'get_memory_strength_report',
    description: 'Report outcome-aware memory strength from retrieval traces: top load-bearing, fading, and never-used pages.',
    params: {
      window_days: { type: 'number', description: 'Trace window in days. Default 30, max 365.' },
      limit: { type: 'number', description: 'Entries per list. Default 20, max 100.' },
      now: { type: 'string', description: 'Optional ISO timestamp for deterministic reports.' },
    },
    mutating: false,
    handler: async (ctx, p) => {
      const input = {
        window_days: optionalPositiveNumber(deps, 'window_days', p.window_days),
        limit: optionalLimit(deps, p.limit),
        now: optionalIsoTimestamp(deps, 'now', p.now),
      };

      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'get_memory_strength_report',
          ...input,
        };
      }

      return computeMemoryStrengthReport(ctx.engine, input);
    },
    cliHints: { name: 'memory-strength-report', aliases: { n: 'limit' } },
  };

  return [audit_brain_loop, get_memory_strength_report];
}

function optionalPositiveNumber(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw invalidParams(deps, `${field} must be a positive number`);
  }
  return value;
}

function optionalIsoTimestamp(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | undefined {
  const normalized = optionalString(deps, field, value);
  if (normalized === undefined) {
    return undefined;
  }
  if (Number.isNaN(new Date(normalized).getTime())) {
    throw invalidParams(deps, `${field} must be a valid ISO timestamp`);
  }
  return normalized;
}
