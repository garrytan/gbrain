/**
 * Public governed MCP dispatch seam for embedding gbrain operations in a
 * policy-owning gateway.
 *
 * This module deliberately does not expose either gbrain HTTP transport. The
 * embedding gateway owns authentication, authorization, rate limits, audit,
 * and transport framing; this seam owns the native operation schema,
 * validation, OperationContext construction, handler invocation, and MCP tool
 * result/error mapping.
 */

import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import type {
  AuthInfo,
  Logger,
  Operation,
  OperationContext,
} from '../core/operations.ts';
import {
  dispatchToolCall,
  SCRUBBED_INTERNAL_ERROR_MESSAGE,
  type ToolResult,
} from './dispatch.ts';
import {
  buildToolDefs,
  type McpToolDef,
} from './tool-defs.ts';

export type { ToolResult } from './dispatch.ts';

/** Stable caller-visible text for an unexpected, non-OperationError failure. */
export const GOVERNED_INTERNAL_ERROR_MESSAGE = SCRUBBED_INTERNAL_ERROR_MESSAGE;

/**
 * Dynamic policy resolver variant. `listOperations()` is snapshotted once at
 * construction for tool definitions and the maximum capability ceiling.
 * `resolveOperation()` may narrow that ceiling at call time, but it may return
 * only the exact Operation object advertised by `listOperations()`.
 */
export interface GovernedOperationResolver {
  listOperations(): readonly Operation[];
  resolveOperation(name: string): Operation | undefined;
}

export type GovernedOperationSource =
  | readonly Operation[]
  | GovernedOperationResolver;

export interface GovernedMcpDispatcherOptions {
  /** Explicit maximum operation ceiling. Duplicate names are rejected. */
  operations: GovernedOperationSource;
  /**
   * Process-level config, snapshotted and deeply frozen at construction.
   * Only plain objects, arrays, and primitive values are accepted.
   */
  config: Readonly<GBrainConfig>;
  /** Explicit logger; the public seam never falls back to process stderr. */
  logger: Logger;
}

export interface GovernedMcpCallContext {
  readonly engine: BrainEngine;
  /** Required source authority. There is no ambient/default source fallback. */
  readonly sourceId: string;
  readonly auth?: Readonly<AuthInfo>;
  readonly takesHoldersAllowList?: readonly string[];
  readonly metaHook?: (
    name: string,
    ctx: OperationContext,
  ) => Promise<Record<string, unknown> | undefined>;
}

export interface GovernedMcpDispatcher {
  /** Immutable definitions built from the same snapshotted ceiling used by dispatch. */
  listTools(): readonly McpToolDef[];
  dispatch(
    name: string,
    params: Record<string, unknown> | undefined,
    context: GovernedMcpCallContext,
  ): Promise<ToolResult>;
}

function isResolver(source: GovernedOperationSource): source is GovernedOperationResolver {
  return !Array.isArray(source);
}

/** Clone JSON-like config/auth data and freeze every container. */
function frozenDataSnapshot<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;

  const existing = seen.get(value as object);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(frozenDataSnapshot(item, seen));
    return Object.freeze(copy) as T;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError('governed MCP config/auth must contain only plain objects, arrays, and primitive values');
  }

  const copy: Record<string, unknown> = {};
  seen.set(value as object, copy);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = frozenDataSnapshot(item, seen);
  }
  return Object.freeze(copy) as T;
}

function immutableLogger(logger: Logger): Logger {
  return Object.freeze({
    info: (message: string) => logger.info(message),
    warn: (message: string) => logger.warn(message),
    error: (message: string) => logger.error(message),
  });
}

function internalErrorResult(): ToolResult {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: 'internal_error',
        message: GOVERNED_INTERNAL_ERROR_MESSAGE,
      }, null, 2),
    }],
    isError: true,
  };
}

/**
 * Construct a governed dispatcher with a fixed capability ceiling.
 *
 * The returned dispatcher always sets `remote: true`, requires an explicit
 * source ID, uses the supplied config snapshot, and scrubs unexpected errors.
 * Authentication/scope checks remain the embedding gateway's responsibility;
 * pass only operations already approved by that policy layer.
 */
export function createGovernedMcpDispatcher(
  options: GovernedMcpDispatcherOptions,
): GovernedMcpDispatcher {
  const resolver = isResolver(options.operations) ? options.operations : undefined;
  const advertised = resolver
    ? [...resolver.listOperations()]
    : [...options.operations as readonly Operation[]];

  const advertisedByName = new Map<string, Operation>();
  const operationByName = new Map<string, Operation>();
  for (const operation of advertised) {
    if (!operation || typeof operation.name !== 'string' || operation.name.length === 0) {
      throw new TypeError('governed MCP operations must have a non-empty name');
    }
    if (operationByName.has(operation.name)) {
      throw new TypeError(`duplicate governed MCP operation name: ${operation.name}`);
    }
    advertisedByName.set(operation.name, operation);
    // Snapshot the schema, metadata, and handler reference. Mutating an
    // Operation object after construction cannot change the advertised or
    // executable capability.
    operationByName.set(operation.name, frozenDataSnapshot(operation) as Operation);
  }

  Object.freeze(advertised);
  const listed = Object.freeze([...operationByName.values()]);
  const tools = frozenDataSnapshot(buildToolDefs(listed)) as readonly McpToolDef[];
  const config = frozenDataSnapshot(options.config) as GBrainConfig;
  const logger = immutableLogger(options.logger);

  const resolveOperation = (name: string): Operation | undefined => {
    const allowed = operationByName.get(name);
    if (!allowed) return undefined;
    if (!resolver) return allowed;

    const resolved = resolver.resolveOperation(name);
    // A resolver may dynamically deny an advertised operation, but it cannot
    // swap in a wider/different handler after the definitions were snapshotted.
    return resolved === advertisedByName.get(name) ? allowed : undefined;
  };

  const dispatcher: GovernedMcpDispatcher = {
    listTools: () => tools,
    dispatch: async (name, params, context) => {
      if (!context || typeof context.sourceId !== 'string' || context.sourceId.length === 0) {
        throw new TypeError('governed MCP dispatch requires a non-empty explicit sourceId');
      }

      const auth = context.auth
        ? frozenDataSnapshot(context.auth) as AuthInfo
        : undefined;
      const takesHoldersAllowList = context.takesHoldersAllowList
        ? Object.freeze([...context.takesHoldersAllowList]) as string[]
        : undefined;

      try {
        return await dispatchToolCall(context.engine, name, params, {
          remote: true,
          logger,
          config,
          sourceId: context.sourceId,
          auth,
          takesHoldersAllowList,
          metaHook: context.metaHook,
          resolveOperation,
          scrubUnexpectedErrors: true,
          freezeContext: true,
        });
      } catch {
        // Covers resolver/getter/programming failures outside the native
        // handler try/catch. No thrown value crosses the untrusted MCP seam.
        return internalErrorResult();
      }
    },
  };

  return Object.freeze(dispatcher);
}
