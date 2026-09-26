/** Own-write receipt controls. UUID knowledge alone never grants access. */
import { OperationError, type Operation, type OperationContext } from './contract.ts';
import { enforceBoundClientOpAllowList, enforceClientSlugFence, enforceSubagentSlugFence, normalizeSlugPrefix, parseSourceIdParam } from './context.ts';
import { hasScope } from '../scope.ts';
import { normalizeTokenScopes } from '../legacy-token-scope.ts';
import { parseWriteRequestId } from '../persistence/preconditions.ts';
import { publicWriteReceipt, isWriteErrorCode } from '../persistence/types.ts';
import type { Principal, WriteRequest } from '../persistence/model.ts';
import type { LocalGrant } from '../persistence/identity.ts';
import type { WriteHealthFacts } from '../persistence/health.ts';

const RECEIPT_NAMES = ['get_write_request', 'list_write_requests', 'cancel_write_request'] as const;
type ReceiptOperation = typeof RECEIPT_NAMES[number];
const denied = () => new OperationError('permission_denied', 'This writer grant does not include the requested receipt operation.',
  'Explicitly regrant the required receipt operation. Existing operation snapshots do not expand during upgrades.');
const missing = () => new OperationError('not_found', 'No accessible write request has that request_id.');

function operationAllowed(operations: unknown, operation: string): boolean {
  return operations == null || Array.isArray(operations) && operations.every(value => typeof value === 'string') && operations.includes(operation);
}
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

interface ReceiptAccess { principal: Principal; operations?: string[]; slugPrefixes?: string[]; sourceIds?: string[]; }
function intersection(a: string[] | undefined, b: string[] | null | undefined): string[] | undefined {
  return b == null ? a : a === undefined ? [...b] : a.filter(value => b.includes(value));
}
function intersectPrefixes(a: string[] | undefined, b: string[] | null | undefined): string[] | undefined {
  if (b == null) return a;
  const normalized = b.map(normalizeSlugPrefix).filter(Boolean);
  if (a === undefined) return normalized;
  const contains = (outer: string, inner: string) => outer === inner || inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`);
  return [...new Set(a.flatMap(left => normalized.flatMap(right => contains(left, right) ? [right] : contains(right, left) ? [left] : [])))];
}

/** Receipt permissions are current capabilities, independent of the original write snapshot. */
async function receiptAccess(ctx: OperationContext, operation: ReceiptOperation, lock = false): Promise<ReceiptAccess> {
  enforceBoundClientOpAllowList(ctx.auth, { name: operation, scope: 'write', mutating: operation === 'cancel_write_request' });
  if (ctx.auth?.scopes && !hasScope(ctx.auth.scopes, 'write')) throw denied();
  const { requestPrincipalForContext } = await import('../persistence/page-mutations.ts');
  const principal = await requestPrincipalForContext(ctx);
  const access: ReceiptAccess = { principal,
    operations: ctx.auth?.allowedOperations ?? undefined,
    slugPrefixes: ctx.auth?.boundSlugPrefixes?.map(normalizeSlugPrefix),
    sourceIds: ctx.auth?.sourceId ? [ctx.auth.sourceId]
      : ctx.remote !== false && ctx.sourceId ? [ctx.sourceId] : undefined,
  };
  const suffix = lock ? ' FOR SHARE' : '';
  if (principal.kind === 'oauth_client') {
    const [row] = await ctx.engine.executeRaw<{ scope: string; deleted_at: unknown; allowed_operations: string[] | null; source_id: string | null; bound_slug_prefixes: string[] | null }>(
      `SELECT scope,deleted_at,allowed_operations,source_id,bound_slug_prefixes FROM oauth_clients WHERE client_id=$1${suffix}`, [principal.id]);
    if (!row || row.deleted_at != null || typeof row.scope !== 'string' || !hasScope(row.scope.split(/\s+/), 'write')
      || !operationAllowed(row.allowed_operations, operation)
      || row.bound_slug_prefixes != null && !stringArray(row.bound_slug_prefixes)) throw denied();
    access.operations = intersection(access.operations, row.allowed_operations);
    access.slugPrefixes = intersectPrefixes(access.slugPrefixes, row.bound_slug_prefixes);
    access.sourceIds = intersection(access.sourceIds, row.source_id ? [row.source_id] : []);
  } else if (principal.kind === 'legacy_token') {
    const [row] = await ctx.engine.executeRaw<{ scopes: unknown; revoked_at: unknown }>(
      `SELECT scopes,revoked_at FROM access_tokens WHERE id=$1${suffix}`, [principal.id]);
    if (!row || row.revoked_at != null || !hasScope(normalizeTokenScopes(row.scopes) ?? ['read', 'write', 'admin'], 'write')) throw denied();
  } else if (principal.kind === 'local_cli' || principal.kind === 'local_stdio') {
    const [row] = await ctx.engine.executeRaw<{ lane: string; revoked_at: unknown; grant_ceiling: LocalGrant }>(
      `SELECT lane,revoked_at,grant_ceiling FROM persistence_local_writers WHERE id=$1::uuid${suffix}`, [principal.id]);
    const lane = principal.kind === 'local_cli' ? 'cli' : 'stdio';
    if (!row || row.revoked_at != null || row.lane !== lane || (ctx.remote !== false) !== (lane === 'stdio')
      || !stringArray(row.grant_ceiling?.scopes) || !hasScope(row.grant_ceiling.scopes, 'write')
      || !stringArray(row.grant_ceiling.sourceIds)
      || row.grant_ceiling.slugPrefixes != null && !stringArray(row.grant_ceiling.slugPrefixes)
      || !operationAllowed(row.grant_ceiling.operations, operation)) throw denied();
    access.operations = intersection(access.operations, row.grant_ceiling.operations);
    access.slugPrefixes = intersectPrefixes(access.slugPrefixes, row.grant_ceiling.slugPrefixes);
    access.sourceIds = intersection(access.sourceIds, row.grant_ceiling.sourceIds.includes('*') ? undefined : row.grant_ceiling.sourceIds);
  } else throw denied();
  return access;
}

async function visible(ctx: OperationContext, row: WriteRequest): Promise<boolean> {
  const { ownRequestAccessible } = await import('../persistence/authority.ts');
  if (!await ownRequestAccessible(ctx, row)) return false;
  try {
    enforceClientSlugFence(ctx, row.slug, 'write_request');
    enforceSubagentSlugFence(ctx, row.slug, 'write_request');
    return true;
  } catch (error) {
    if (error instanceof OperationError && error.code === 'permission_denied') return false;
    throw error;
  }
}

async function publicReceipt(ctx: OperationContext, row: WriteRequest, facts?: WriteHealthFacts): Promise<Record<string, unknown>> {
  const { receiptFor } = await import('../persistence/journal.ts');
  const { publicEffectsForRequest } = await import('../persistence/effect-journal.ts');
  return {
    ...publicWriteReceipt(receiptFor(row, facts)),
    operation: row.operation, source_id: row.source_id, slug: row.slug,
    ...(isWriteErrorCode(row.error_code) ? { write_error: row.error_code } : {}),
    effects: await publicEffectsForRequest(ctx.engine, row.id),
  };
}

function requiredRequestId(value: unknown): string {
  const id = parseWriteRequestId(value);
  if (!id) throw new OperationError('invalid_params', 'request_id is required.');
  return id;
}

const requestParam = { type: 'string' as const, required: true, description: 'The original request UUID. Only this principal’s currently authorized requests are accessible.' };

export const persistenceOperations: Operation[] = [
  {
    name: 'get_write_request',
    description: 'Read your durable write receipt by request_id. Requires write scope and this operation in the current grant. Foreign, missing, and no-longer-accessible requests return the same not_found error; private journal input and recovery bytes are never returned.',
    params: { request_id: requestParam },
    scope: 'write', mutating: false, area: 'pages',
    cliHints: { name: 'write-request', positional: ['request_id'] },
    handler: async (ctx, params) => {
      const id = requiredRequestId(params.request_id);
      const { principal } = await receiptAccess(ctx, 'get_write_request');
      const { getWriteRequest, writeHealthFacts } = await import('../persistence/journal.ts');
      const row = await getWriteRequest(ctx.engine, principal, id);
      if (!row || !await visible(ctx, row)) throw missing();
      return publicReceipt(ctx, row, (await writeHealthFacts(ctx.engine, [row])).get(row.id));
    },
  },
  {
    name: 'list_write_requests',
    description: 'List your currently authorized write receipts in one source, newest first. Useful when an acknowledgment was lost. Results and pagination exclude other principals and inaccessible targets; no private payloads or cross-principal queue counts are exposed.',
    params: {
      source_id: { type: 'string', description: 'Source to inspect. Defaults to the caller’s resolved source.' },
      limit: { type: 'number', default: 25, description: 'Number of visible receipts, 1–100. Default 25.' },
      before: { type: 'string', description: 'Opaque next cursor from the previous response.' },
    },
    scope: 'write', mutating: false, area: 'pages',
    cliHints: { name: 'write-requests' },
    handler: async (ctx, params) => {
      const access = await receiptAccess(ctx, 'list_write_requests');
      const sourceId = parseSourceIdParam(params.source_id ?? ctx.sourceId, 'list_write_requests') ?? 'default';
      const limit = params.limit ?? 25;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new OperationError('invalid_params', 'limit must be an integer from 1 to 100.');
      if (params.before !== undefined && (typeof params.before !== 'string' || !/^\d{1,19}$/.test(params.before)
        || BigInt(params.before) > 9_223_372_036_854_775_807n)) throw new OperationError('invalid_params', 'Invalid write request cursor.');
      if (access.sourceIds && !access.sourceIds.includes(sourceId)) return { requests: [], next: null };
      const { listWriteRequests } = await import('../persistence/control.ts');
      const slugAllowList = ctx.viaSubagent !== true ? undefined : ctx.allowedSlugPrefixes?.length ? ctx.allowedSlugPrefixes
        : typeof ctx.subagentId === 'number' ? [`wiki/agents/${ctx.subagentId}/*`] : [];
      const result = await listWriteRequests(ctx.engine, access.principal, {
        sourceId, before: params.before as string | undefined, limit,
        slugPrefixes: access.slugPrefixes, operations: access.operations, slugAllowList,
        authorize: row => visible(ctx, row),
      });
      const { writeHealthFacts } = await import('../persistence/journal.ts');
      const facts = await writeHealthFacts(ctx.engine, result.requests);
      return { requests: await Promise.all(result.requests.map(row => publicReceipt(ctx, row, facts.get(row.id)))), next: result.next };
    },
  },
  {
    name: 'cancel_write_request',
    description: 'Cancel your accepted write before publication starts. Returns the actual receipt: running/recovering or already-terminal requests may remain unchanged. Cancellation cannot undo published bytes or a committed fact withdrawal.',
    params: { request_id: requestParam },
    scope: 'write', mutating: true, area: 'pages',
    cliHints: { name: 'cancel-write-request', positional: ['request_id'] },
    handler: async (ctx, params) => {
      const id = requiredRequestId(params.request_id);
      const { principal } = await receiptAccess(ctx, 'cancel_write_request');
      const { getWriteRequest, writeHealthFacts } = await import('../persistence/journal.ts');
      const row = await getWriteRequest(ctx.engine, principal, id);
      if (!row || !await visible(ctx, row)) throw missing();
      if (ctx.dryRun) return { dry_run: true, action: 'cancel_write_request', request_id: id, state: row.state };
      const { cancelWriteRequest } = await import('../persistence/control.ts');
      const cancelled = await cancelWriteRequest(ctx.engine, principal, id, {
        authorize: async (engine, current) => {
          const lockedCtx = { ...ctx, engine };
          await receiptAccess(lockedCtx, 'cancel_write_request', true);
          if (!await visible(lockedCtx, current)) throw missing();
        },
      });
      if (!cancelled) throw missing();
      return publicReceipt(ctx, cancelled, (await writeHealthFacts(ctx.engine, [cancelled])).get(cancelled.id));
    },
  },
];
