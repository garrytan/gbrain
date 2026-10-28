import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { ALL_SOURCES, NO_SOURCES } from '../source-id.ts';

/** The one source a remote caller may write: its grant's source, else the connection's, else default. */
export function grantedWriteSource(ctx: OperationContext): string {
  return ctx.auth?.sourceId ?? ctx.sourceId ?? 'default';
}

/**
 * GBRA-200: the refusal for a write naming a source outside the caller's write grant. It names the sources the
 * caller's own grant lets it write (`writable_source_ids`, empty when the grant holds a sentinel) and never another
 * source, so the envelope is identical whether the named source exists or not. `retry`, when given, is the same
 * call aimed at the writable source, rendered as the fix.
 */
export function writeGrantRefusal(ctx: OperationContext, suggestion: string, retry?: { tool: string; arguments: Record<string, unknown> }): OperationError {
  const granted = grantedWriteSource(ctx);
  const writable = granted === ALL_SOURCES || granted === NO_SOURCES ? [] : [granted];
  const e = new OperationError('permission_denied', 'This source is outside the current write grant.', suggestion);
  e.writableSourceIds = writable;
  if (retry && writable.length === 1) {
    const args: Record<string, unknown> = { ...retry.arguments, source_id: writable[0] };
    delete args.request_id;
    e.fix = { mcp: { tool: retry.tool, arguments: args }, consent: [], actor: 'agent', requires_exclusive: false,
      why: `Repeats the call against ${writable[0]}, the source this connection may write.` };
  }
  return e;
}
