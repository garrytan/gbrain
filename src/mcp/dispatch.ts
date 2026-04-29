/**
 * Shared MCP tool-call dispatch — single source of truth for stdio + HTTP transports.
 *
 * Both transports validate the same params, build the same OperationContext shape,
 * and serialize errors identically. Drift between transports caused PR #483's reversed-args
 * + missing-context bugs; this module exists to prevent that recurring.
 */

import type { BrainEngine } from '../core/engine.ts';
import { operations, OperationError } from '../core/operations.ts';
import type { Operation, OperationContext } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface DispatchOpts {
  /** Defaults to true (remote/untrusted). Local CLI callers (`gbrain call`) pass false. */
  remote?: boolean;
  /** Override the default stderr logger (e.g. CLI uses console.* directly). */
  logger?: OperationContext['logger'];
}

/** Validate required params exist and have the expected type. Returns null on success, error message on failure. */
export function validateParams(op: Operation, params: Record<string, unknown>): string | null {
  for (const [key, def] of Object.entries(op.params)) {
    if (def.required && (params[key] === undefined || params[key] === null)) {
      return `Missing required parameter: ${key}`;
    }
    if (params[key] !== undefined && params[key] !== null) {
      const val = params[key];
      const expected = def.type;
      if (expected === 'string' && typeof val !== 'string') return `Parameter "${key}" must be a string`;
      if (expected === 'number' && typeof val !== 'number') return `Parameter "${key}" must be a number`;
      if (expected === 'boolean' && typeof val !== 'boolean') return `Parameter "${key}" must be a boolean`;
      if (expected === 'object' && (typeof val !== 'object' || Array.isArray(val))) return `Parameter "${key}" must be an object`;
      if (expected === 'array' && !Array.isArray(val)) return `Parameter "${key}" must be an array`;
    }
  }
  return null;
}

const stderrLogger: OperationContext['logger'] = {
  info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
  error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
};

export function buildOperationContext(
  engine: BrainEngine,
  params: Record<string, unknown>,
  opts: DispatchOpts = {},
): OperationContext {
  return {
    engine,
    config: loadConfig() || { engine: 'postgres' },
    logger: opts.logger || stderrLogger,
    dryRun: !!params.dry_run,
    remote: opts.remote ?? true,
  };
}

/**
 * Resolve operation, validate params, build context, invoke handler, format result.
 *
 * Returns a `ToolResult` with the same shape both MCP transports need:
 * `{ content: [{ type: 'text', text }], isError?: boolean }`.
 */
export async function dispatchToolCall(
  engine: BrainEngine,
  name: string,
  params: Record<string, unknown> | undefined,
  opts: DispatchOpts = {},
): Promise<ToolResult> {
  const op = operations.find(o => o.name === name);
  if (!op) {
    return { content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }], isError: true };
  }

  const safeParams = params || {};
  const validationError = validateParams(op, safeParams);
  if (validationError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_params', message: validationError }, null, 2) }],
      isError: true,
    };
  }

  const ctx = buildOperationContext(engine, safeParams, opts);

  try {
    const result = await op.handler(ctx, safeParams);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e: unknown) {
    if (e instanceof OperationError) {
      return { content: [{ type: 'text', text: JSON.stringify(e.toJSON(), null, 2) }], isError: true };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
}
