/**
 * The one callability predicate (agent operator contract v1, A2): tools/list
 * on stdio and HTTP and dispatch all ask the same question, and fixes/notices
 * name an MCP tool only when it answers true for the caller
 * (`RenderContext.isCallable`). Pure: the caller resolves its own scopes,
 * publish gates and bound-tool allow-set first.
 */
import { opError, type OperationMeta, type OperationError } from './contract.ts';
import type { Surface, Transport } from '../agent-output.ts';
import { operationScopesAllowed } from '../scope.ts';
import { filterOpsForSurface } from '../../mcp/surface.ts';

export interface CallableContext {
  transport: Transport;
  surface: Surface;
  /** Verified scopes for this connection (HTTP token / stdio registration grant). Ignored on cli. */
  scopes: readonly string[];
  /** Resolved publish gates keyed by `Operation.publishGateKey`; a missing key is off (fail-closed). */
  publishGates: Record<string, boolean>;
  /** Extra fail-closed allow-set (read-only stdio, bound-client tool list). */
  allowedOps?: ReadonlySet<string>;
}

/** The one predicate behind tools/list AND dispatch. */
export function isCallable(op: OperationMeta, ctx: CallableContext): boolean {
  if (ctx.allowedOps && !ctx.allowedOps.has(op.name)) return false;
  if (filterOpsForSurface([op], ctx.surface).length === 0) return false;
  if (ctx.transport === 'cli') return true;
  if (op.cliOnly) return false;
  if (op.localOnly && ctx.transport !== 'stdio') return false;
  if (op.publishGateKey && ctx.publishGates[op.publishGateKey] !== true) return false;
  if (ctx.transport === 'http') return operationScopesAllowed(ctx.scopes, op);
  return !op.requiredScopes?.length || operationScopesAllowed(ctx.scopes, op);
}

/**
 * Publish gates keyed by gate key from the resolver's disabled-op set
 * (`disabledOpsForPublishGates`): a gate is on when none of its ops is disabled.
 */
export function publishGatesFromDisabled(ops: readonly OperationMeta[], disabled: ReadonlySet<string>): Record<string, boolean> {
  const gates: Record<string, boolean> = {};
  for (const op of ops) {
    if (!op.publishGateKey) continue;
    gates[op.publishGateKey] = (gates[op.publishGateKey] ?? true) && !disabled.has(op.name);
  }
  return gates;
}

/**
 * F5: the refusal for a `cliOnly` op called over MCP (it is never listed
 * there): the exact CLI command as the fix, relayed to the user. `error`
 * keeps the historical `permission_denied`.
 */
export function cliOnlyRefusal(op: OperationMeta): OperationError {
  const argv = [...(op.cliOnly?.argv ?? ['gbrain', '--help'])];
  const inputs = argv.filter(a => /^<[a-z_]+>$/.test(a)).map(a => ({ name: a.slice(1, -1), how: `The ${a.slice(1, -1)} value from your ${op.name} call.` }));
  return opError('trusted_local_only', `${op.name} runs only from the trusted local CLI on the brain host, not over MCP.`,
    `Ask the user to run \`${argv.join(' ')}\` on the brain host.`, {
      legacy_error: 'permission_denied',
      fix: { argv, consent: [], actor: 'user', requires_exclusive: false, why: `${op.name} is owner-only (filesystem, credentials or review authority), so no MCP connection can call it.`, ...(inputs.length ? { inputs } : {}) },
    });
}
