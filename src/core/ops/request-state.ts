import { opError, type OperationContext, type OperationRequestState } from './contract.ts';
import { federatedSearchScope, sourceScopeOpts } from './context.ts';
import { isValidSourceId } from '../source-id.ts';

// Object identity, not a caller-supplied marker, attests a server-created request.
const serverStates = new WeakSet<OperationRequestState>();

export function createOperationRequestState(): OperationRequestState {
  const state: OperationRequestState = {};
  serverStates.add(state);
  return state;
}

/** A response stamp is not a grant: recheck it against current authority before any metadata work. */
export function effectiveReadSourceId(ctx: OperationContext): string | undefined {
  if (!ctx.requestState || !serverStates.has(ctx.requestState)) return undefined;
  const source = ctx.requestState.effectiveReadSourceId;
  if (source === undefined) return undefined;
  if (!isValidSourceId(source)) throw opError('permission_denied', 'Invalid response source', 'Read an authorized page again.');
  if (ctx.auth && (ctx.auth.allowedSources !== undefined || ctx.auth.hasSourceGrant !== false)) {
    const scope = sourceScopeOpts(ctx);
    if (!(scope.sourceIds ? scope.sourceIds.includes(source) : scope.sourceId === source)) {
      throw opError('permission_denied', 'Response source is outside your granted sources', 'Read a page within your current grant.');
    }
  } else {
    // Preserve trusted-local and stdio explicit-read admission; the existing resolver owns that policy.
    federatedSearchScope(ctx, source);
  }
  return source;
}
