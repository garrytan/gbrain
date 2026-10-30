/** Own-write receipt controls. UUID knowledge alone never grants access. */
import { OperationError, opError, type Operation, type OperationContext } from './contract.ts';
import { invalidParam, readFix } from './op-fix.ts';
import { isValidSourceId } from '../source-id.ts';
import { enforceBoundClientOpAllowList, enforceClientSlugFence, enforceSubagentSlugFence, normalizeSlugPrefix, parseSourceIdParam, readPolicyOpts, resolveRequestedScope } from './context.ts';
import { hasScope } from '../scope.ts';
import { normalizeTokenScopes } from '../legacy-token-scope.ts';
import { parseWriteRequestId } from '../persistence/preconditions.ts';
import { publicWriteReceipt, isWriteErrorCode } from '../persistence/types.ts';
import type { Principal, WriteRequest } from '../persistence/model.ts';
import type { LocalGrant } from '../persistence/identity.ts';
import type { WriteHealthFacts } from '../persistence/health.ts';

const RECEIPT_NAMES = ['get_write_request', 'list_write_requests', 'cancel_write_request'] as const;
type ReceiptOperation = typeof RECEIPT_NAMES[number];
const denied = () => opError('permission_denied', 'This writer grant does not include the requested receipt operation.',
  'Explicitly regrant the required receipt operation. Existing operation snapshots do not expand during upgrades.');
function callerSource(ctx: OperationContext): string | undefined {
  const id = ctx.auth?.sourceId ?? ctx.sourceId;
  return isValidSourceId(id) ? id : undefined;
}
/** Foreign, missing and inaccessible requests share one answer (anti-enumeration); the fix lists the caller's own receipts. */
const missing = (sourceId?: string) => opError('not_found', 'No accessible write request has that request_id.',
  'Check the request_id; list_write_requests shows the receipts this connection can read in its source, newest first.',
  { fix: readFix('Lists your own write receipts in this source, newest first.', {
    argv: ['gbrain', 'write-requests', ...(sourceId ? ['--source', sourceId] : [])],
    mcp: { tool: 'list_write_requests', arguments: sourceId ? { source_id: sourceId } : {} },
  }) });

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
  const { receiptDeliveredHint } = await import('../persistence/connector-errors.ts');
  const { CHECKPOINT_VALIDATION_TIMEOUT, checkpointTimeoutHint } = await import('../persistence/checkpoint-validation.ts');
  const { writeFailureDiagnostic } = await import('../persistence/verb-errors.ts');
  const intent = row.intent as Pick<import('../persistence/sync-prepare.ts').SyncIntent, 'processingOptions' | 'syncOptions' | 'repoPath'> | null;
  const checkpoint = row.error_code === CHECKPOINT_VALIDATION_TIMEOUT ? await checkpointTimeoutHint(ctx.engine, { requestId: row.request_id, sourceId: row.source_id,
    processingOptions: intent?.processingOptions, syncOptions: intent?.syncOptions, repoPath: intent?.repoPath }) : null;
  // #5929: a trusted local reader learns when the owner that ran the attempt is on another build.
  const mismatch = ctx.remote === false ? (await import('../persistence/publication-failure.ts')).ownerBuildMismatch(row.error_detail, (await import('../../version.ts')).VERSION) : null;
  const withdrawn = (await import('../facts/withdrawal.ts')).withdrawnFromDetail(row.error_detail);
  const diagnostic = isWriteErrorCode(row.error_code) ? writeFailureDiagnostic(row.error_code, row.error_message) : null;
  // #6650: the classification the receipt's own columns support, with the structured next step (verify is read-only).
  const terminal = isTerminalOrRecovering(row) ? (await import('../persistence/terminal-classify.ts')).classifyTerminal({ request_id: row.request_id, source_id: row.source_id,
    slug: row.slug, operation: row.operation, state: row.state, error_code: row.error_code, error_detail: row.error_detail ?? null, recovery: row.recovery,
    blocked_reason: row.blocked_reason, compacted: row.compacted, publication_started: row.publication_started, error_message: row.error_message,
    intent_kind: typeof row.intent?.kind === 'string' ? row.intent.kind : null, build: (row as { admitter_version?: string | null }).admitter_version ?? null,
    schema_behind: await (await import('../persistence/schema-admission.ts')).readSchemaBehind(ctx.engine) }) : null;
  const { cliRenderContext, renderAction } = await import('../agent-output.ts');
  const render = ctx.remote === false ? cliRenderContext() : { transport: 'stdio' as const, isCallable: () => false, preapproved: () => false };
  const { liveSearchable } = await import('../persistence/searchable.ts');
  return {
    ...publicWriteReceipt(receiptFor(row, facts)),
    operation: row.operation, source_id: row.source_id, slug: row.slug,
    ...await liveSearchable(ctx, { request_id: row.request_id, state: row.state, source_id: row.source_id, slug: row.slug, searchable: row.outcome?.searchable }),
    ...(mismatch ? { owner_build: mismatch } : {}),
    // #7112: the owner-side detail (an owner exception's class, errno, frame, redacted database error text and statement) for a trusted local reader only.
    ...(ctx.remote === false && row.error_detail ? { error_detail: row.error_detail } : {}),
    ...(diagnostic ? { write_error: row.error_code, write_error_message: diagnostic.message, write_error_reason: diagnostic.reason, suggestion: diagnostic.suggestion } : {}),
    ...(terminal ? { diagnosis: { category: terminal.category, public_category: terminal.public_category, code: terminal.code, class: terminal.class, safe_actions: terminal.safe_actions, needs_human: terminal.needs_human,
      ...(terminal.human_reason ? { human_reason: terminal.human_reason } : {}), escalate: terminal.escalate, historical: terminal.historical,
      fix: renderAction(terminal.action, render) } } : {}),
    ...(withdrawn ? { withdrawn } : {}),
    ...(checkpoint ? { detail: checkpoint.detail, suggestion: checkpoint.suggestion, docs: checkpoint.docs } : {}),
    effects: (await publicEffectsForRequest(ctx.engine, row.id)).map(effect => {
      const hint = effect.reason ? receiptDeliveredHint({ error_code: effect.reason, source_id: row.source_id, slug: row.slug }) : null;
      return hint ? { ...effect, suggestion: hint.suggestion, docs: hint.docs } : effect;
    }),
  };
}

/** A receipt the terminal classifier reads: ended without committing, or holding a publication recovery record outside an in-flight claim (committed or parked `recovering`). */
function isTerminalOrRecovering(row: WriteRequest): boolean {
  return ['failed', 'conflict', 'cancelled'].includes(row.state) || ((row.state === 'committed' || row.state === 'recovering') && row.recovery != null);
}

function requiredRequestId(value: unknown): string {
  const id = parseWriteRequestId(value);
  if (!id) throw opError('invalid_params', 'request_id is required.', 'Pass the request_id you sent with the write, or the one its receipt shows; list_write_requests shows recent ones.');
  return id;
}

const requestParam = { type: 'string' as const, required: true, description: 'The id you sent, or the receipt\'s.' };

export const persistenceOperations: Operation[] = [
  {
    name: 'get_write_request',
    idempotent: true,
    outputRedaction: 'no_stored_text',
    description: 'Your write\'s receipt by request_id (after write_pending or a lost reply). Poll at retry_after_ms until final.',
    params: { request_id: requestParam,
      applied: { type: 'boolean', fullSurfaceOnly: true, description: 'Also return applied: searchable yet, the gap, the write watermark.' } },
    scope: 'write', mutating: false, area: 'pages',
    cliHints: { name: 'write-request', positional: ['request_id'] },
    handler: async (ctx, params) => {
      const id = requiredRequestId(params.request_id);
      const { principal } = await receiptAccess(ctx, 'get_write_request');
      const { getWriteRequest, writeHealthFacts } = await import('../persistence/journal.ts');
      const row = await getWriteRequest(ctx.engine, principal, id);
      if (!row || !await visible(ctx, row)) throw missing(callerSource(ctx));
      const receipt = await publicReceipt(ctx, row, (await writeHealthFacts(ctx.engine, [row])).get(row.id));
      if (params.applied !== true) return receipt;
      const applied = await (await import('../persistence/write-applied.ts')).readWriteApplied(ctx.engine, row).catch(() => null);
      return applied ? { ...receipt, applied } : receipt;
    },
  },
  {
    name: 'list_write_requests',
    idempotent: true,
    outputRedaction: 'no_stored_text',
    description: 'Your write receipts in one source, newest first (for a lost request_id).',
    params: {
      source_id: { type: 'string', description: 'Default: yours.' },
      limit: { type: 'number', default: 25, description: '1-100 (default 25).', fullSurfaceOnly: true },
      before: { type: 'string', description: "Previous page's next cursor." },
    },
    scope: 'write', mutating: false, area: 'pages',
    cliHints: { name: 'write-requests' },
    handler: async (ctx, params) => {
      const access = await receiptAccess(ctx, 'list_write_requests');
      const sourceId = parseSourceIdParam(params.source_id ?? ctx.sourceId, 'list_write_requests') ?? 'default';
      const limit = params.limit ?? 25;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw invalidParam(ctx, 'list_write_requests', 'limit', 'limit must be an integer from 1 to 100.', { example: 25 });
      if (params.before !== undefined && (typeof params.before !== 'string' || !/^\d{1,19}$/.test(params.before)
        || BigInt(params.before) > 9_223_372_036_854_775_807n)) throw opError('invalid_params', 'Invalid write request cursor.', 'Pass `before` exactly as the previous response\'s `next` value, or omit it to start from the newest receipt.');
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
    // #6643 (B0): the conflict pile grouped by slug. Database-derived fields only for remote callers, filtered by source grant, slug fence
    // and page visibility in the aggregating SQL; the live file check runs only for the trusted local CLI on the canonical owner host.
    name: 'list_write_conflicts',
    idempotent: true,
    outputRedaction: 'no_stored_text',
    description: 'Pages whose writes keep ending in a source_changed conflict, grouped by slug.',
    params: {
      source_id: { type: 'string', description: 'Default: yours.' },
      limit: { type: 'number', default: 25, description: '1-100 slugs (default 25).' },
      cursor: { type: 'string', description: "Previous page's next." },
    },
    scope: 'read', mutating: false, area: 'pages',
    cliHints: { name: 'write-conflicts' },
    handler: async (ctx, params) => {
      const sourceId = parseSourceIdParam(params.source_id ?? ctx.sourceId, 'list_write_conflicts') ?? 'default';
      // A remote caller naming a source outside its grant is refused like every source-scoped read (permission_denied, whether or not it exists).
      if (params.source_id !== undefined) resolveRequestedScope(ctx, sourceId);
      const limit = params.limit ?? 25;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw invalidParam(ctx, 'list_write_conflicts', 'limit', 'limit must be an integer from 1 to 100.', { example: 25 });
      if (params.cursor !== undefined && typeof params.cursor !== 'string') throw opError('invalid_params', 'Invalid conflict cursor.', "Pass `cursor` exactly as the previous response's `next` value.");
      const policy = await readPolicyOpts(ctx);
      const trusted = ctx.remote === false;
      const sourceIds = policy.sourceIds ?? (!trusted && policy.sourceId ? [policy.sourceId] : undefined);
      const subagent = ctx.viaSubagent !== true ? undefined : ctx.allowedSlugPrefixes?.length ? ctx.allowedSlugPrefixes
        : typeof ctx.subagentId === 'number' ? [`wiki/agents/${ctx.subagentId}/`] : [];
      const bound = ctx.auth?.boundSlugPrefixes?.map(normalizeSlugPrefix);
      // Both fences apply: a slug must sit under each confinement this caller carries.
      const slugPrefixes = bound && subagent ? intersectPrefixes(bound, subagent) : bound ?? subagent?.map(normalizeSlugPrefix);
      const { auditDriftConflicts } = await import('../persistence/drift-conflicts.ts');
      return auditDriftConflicts(ctx.engine, sourceId, { trusted, sourceIds, slugPrefixes, excludePrivate: policy.excludePrivate === true },
        { limit, cursor: params.cursor as string | undefined });
    },
  },
  {
    name: 'cancel_write_request',
    idempotent: true,
    outputRedaction: 'no_stored_text',
    description: 'Cancel your accepted write before it publishes; returns the receipt.',
    params: { request_id: requestParam },
    scope: 'write', mutating: true, area: 'pages',
    cliHints: { name: 'cancel-write-request', positional: ['request_id'] },
    handler: async (ctx, params) => {
      const id = requiredRequestId(params.request_id);
      const { principal } = await receiptAccess(ctx, 'cancel_write_request');
      const { getWriteRequest, writeHealthFacts } = await import('../persistence/journal.ts');
      const row = await getWriteRequest(ctx.engine, principal, id);
      if (!row || !await visible(ctx, row)) throw missing(callerSource(ctx));
      if (ctx.dryRun) return { dry_run: true, action: 'cancel_write_request', request_id: id, state: row.state };
      const { cancelWriteRequest } = await import('../persistence/control.ts');
      const cancelled = await cancelWriteRequest(ctx.engine, principal, id, {
        authorize: async (engine, current) => {
          const lockedCtx = { ...ctx, engine };
          await receiptAccess(lockedCtx, 'cancel_write_request', true);
          if (!await visible(lockedCtx, current)) throw missing(callerSource(ctx));
        },
      });
      if (!cancelled) throw missing(callerSource(ctx));
      return publicReceipt(ctx, cancelled, (await writeHealthFacts(ctx.engine, [cancelled])).get(cancelled.id));
    },
  },
];
