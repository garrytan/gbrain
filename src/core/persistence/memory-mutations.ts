import { randomUUID } from 'node:crypto';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError, verbError } from '../ops/contract.ts';
import { enforceClientSlugFence, enforceSubagentSlugFence, validatePageSlug } from '../ops/context.ts';
import { isNullLikeEntity } from '../facts/write-single.ts';
import { recordFactWithdrawal } from '../facts/withdrawal.ts';
import { initializeLocalPersistence, requestPrincipalForContext } from './page-mutations.ts';
import { authorizeStoredRequest, submissionAuthority } from './authority.ts';
import { admitWrite, admitWriteInTransaction, assertPageRequestIdentity, assertReplayIntent, completeWrite, getWriteRequest, intentDigest } from './journal.ts';
import { assertPersistenceAccepting, registerMutationPreparer, waitForWrite, writeResponse } from './service.ts';
import { claimWorktree, getWorktreeBinding } from './ownership.ts';
import { WRITER_INSPECTION_HINT } from './admin-intent.ts';
import { parseMutationPrecondition } from './preconditions.ts';
import { withCoordinatedWrite } from './context.ts';
import { isTerminal, type WriteRequest } from './model.ts';
import { prepareMemoryMutation } from './memory-prepare.ts';
import { retryWriteAdmission } from './admission-retry.ts';

export { prepareMemoryMutation } from './memory-prepare.ts';
/** Only semantic appends without an explicit caller revision can be recomputed. */
export function isSemanticMemoryMutation(row: WriteRequest): boolean {
  return row.operation === 'remember' && row.intent?.expected_revision === undefined;
}

/** Stable caller intent is checked before entity resolution, relative TTLs or providers. */
async function submission(ctx: OperationContext, operation: string, params: Record<string, unknown>) {
  assertPersistenceAccepting(ctx.engine);
  const p: Record<string, unknown> = { ...params, ...parseMutationPrecondition(params) };
  const requestId = typeof p.request_id === 'string' ? p.request_id : randomUUID();
  const sourceId = typeof p.source_id === 'string' ? p.source_id : ctx.sourceId ?? 'default';
  if (ctx.remote !== false && sourceId !== (ctx.auth?.sourceId ?? ctx.sourceId ?? 'default')) {
    throw new OperationError('permission_denied', 'This source is outside the current write grant.');
  }
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  await assertPageRequestIdentity(ctx.engine, principal, requestId);
  const callerIntent = { ...p }; delete callerIntent.request_id;
  const prior = await getWriteRequest(ctx.engine, principal, requestId);
  if (prior) {
    await submissionAuthority(ctx, prior.operation, prior.source_id, prior.source_incarnation, prior.slug);
    await authorizeStoredRequest(ctx.engine, prior);
    assertReplayIntent(prior, intentDigest({ operation, sourceId, slug: prior.slug, callerIntent }));
  }
  return { p, requestId, sourceId, principal, callerIntent, prior };
}

export async function submitRememberMutation(ctx: OperationContext, params: Record<string, unknown>, waitMs?: number): Promise<Record<string, unknown>> {
  registerMutationPreparer('remember', prepareMemoryMutation);
  const sub = await submission(ctx, 'remember', params);
  if (sub.prior) return writeResponse(await waitForWrite(ctx.engine, sub.prior, ctx.config, waitMs));
  const { p, sourceId, principal, callerIntent, requestId } = sub;
  const [source] = await ctx.engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null }>(
    'SELECT incarnation,archived,local_path FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) throw new OperationError('source_changed', 'The write source is not active.');
  const { parseTtlParam } = await import('../ops/facts.ts');
  const validUntil = parseTtlParam(p.ttl);
  const entity = typeof p.entity === 'string' && !isNullLikeEntity(p.entity) ? p.entity.trim() : null;
  const { resolveEntitySlugWithSource } = await import('../entities/resolve.ts');
  const resolved = entity ? await resolveEntitySlugWithSource(ctx.engine, sourceId, entity) : null;
  const entitySlug = resolved?.slug ?? null;
  // A source-scoped absent identity serializes subjectless facts. Bound writers
  // cannot use it to escape their namespace grant.
  const slug = entitySlug ?? 'memory/unattributed';
  validatePageSlug(slug);
  enforceClientSlugFence(ctx, slug, 'remember'); enforceSubagentSlugFence(ctx, slug, 'remember');
  const authority = await submissionAuthority(ctx, 'remember', sourceId, source.incarnation, slug);
  const snapshot = await ctx.engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  if (snapshot && (snapshot.page.deleted_at || ctx.remote !== false &&
    !await ctx.engine.readPageSnapshot(slug, { sourceId, excludePrivate: authority.excludePrivate }))) {
    throw new OperationError('page_not_found', 'The target entity is not writable by this caller.');
  }
  // Preserve the stub guard: a fallback name remains DB-only until a real
  // entity page exists. No placeholder page is created by remember.
  const fence = entitySlug !== null && snapshot !== null;
  let binding = fence ? await getWorktreeBinding(ctx.engine, sourceId) : null;
  const sandbox = ctx.viaSubagent === true && !(ctx.allowedSlugPrefixes?.length);
  const configuredWriteThrough = !/^(false|0|off|no)$/i.test(await ctx.engine.getConfig('sync.write_through') ?? 'true');
  const writeThrough = configuredWriteThrough && !sandbox;
  if (sandbox) authority.databaseOnlyReason = 'subagent_sandbox';
  else if (!configuredWriteThrough) authority.databaseOnlyReason = 'disabled_by_config';
  const root = source.local_path || (sourceId === 'default' ? await ctx.engine.getConfig('sync.repo_path') : null);
  if (fence && writeThrough && root && !binding) {
    if (ctx.engine.kind !== 'pglite') throw new OperationError('owner_unavailable', 'This source has no designated canonical owner.', WRITER_INSPECTION_HINT);
    binding = await claimWorktree(ctx.engine, sourceId, root);
  }
  const row = await admitWrite(ctx.engine, { principal, operation: 'remember', sourceId, sourceIncarnation: source.incarnation,
    slug, pageId: snapshot?.page.id ?? null, requestId, callerIntent,
    intent: { ...callerIntent, entity_slug: entitySlug, fence, valid_from: new Date().toISOString(), valid_until: validUntil?.toISOString() ?? null },
    authority, worktreeId: writeThrough ? binding?.worktree_id : null, topologyGeneration: writeThrough ? binding?.topology_generation : null });
  return writeResponse(await waitForWrite(ctx.engine, row, ctx.config, waitMs));
}

interface WithdrawalTarget { id: number; entity_slug: string | null; source_markdown_slug: string | null; expired_at: Date | null; }

/** Withdrawal commits independently of filesystem ownership and request FIFO. */
export async function submitForgetMutation(ctx: OperationContext, operation: 'forget' | 'forget_fact', params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sub = await submission(ctx, operation, params);
  if (sub.prior) return writeResponse(sub.prior);
  const { p, sourceId, principal, callerIntent, requestId } = sub;
  const id = Number(p.id);
  const rawId = String(p.id).trim();
  const reason = typeof p.reason === 'string' && p.reason.trim() ? p.reason.trim() : null;
  if (!Number.isSafeInteger(id) || id <= 0) throw verbError(operation === 'forget' ? 'not_found' : 'fact_not_found',
    `No fact with id "${rawId}".`, 'Pass the fact id returned by remember or recall.');
  // Retry the whole withdrawal, so source/principal guards and the connection
  // are released before backoff. Admission must not retry a nested savepoint.
  const done = await retryWriteAdmission(requestId, remaining => ctx.engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
      [`${Math.min(1000, remaining)}ms`, `${remaining}ms`]);
    // Source -> current grant -> counters/request -> sorted page keys -> facts.
    // Do not acquire a shared source lock first and upgrade it after admission.
    const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>(
      'SELECT incarnation,archived FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
    if (!source || source.archived) throw new OperationError('source_changed', 'The write source is not active.');
    // Another same-ID caller may have completed while we waited for the source.
    const prior = await getWriteRequest(tx, principal, requestId);
    if (prior) {
      await submissionAuthority({ ...ctx, engine: tx }, operation, sourceId, source.incarnation, prior.slug);
      await authorizeStoredRequest(tx, prior, true);
      assertReplayIntent(prior, intentDigest({ operation, sourceId, slug: prior.slug, callerIntent }));
      return prior;
    }
    const [fact] = await tx.executeRaw<WithdrawalTarget>(`SELECT id,entity_slug,source_markdown_slug,expired_at FROM facts
      WHERE id=$1 AND source_id=$2 AND ($3::boolean=false OR visibility='world')`, [id, sourceId, ctx.remote !== false]);
    if (!fact) throw verbError(operation === 'forget' ? 'not_found' : 'fact_not_found',
      `No fact with id "${rawId}".`, 'Ids come from remember/recall. Recall the entity first to find the right fact.');
    const slug = fact.source_markdown_slug ?? fact.entity_slug ?? 'memory/unattributed';
    enforceClientSlugFence(ctx, slug, operation); enforceSubagentSlugFence(ctx, slug, operation);
    const authority = await submissionAuthority({ ...ctx, engine: tx }, operation, sourceId, source.incarnation, slug);
    const row = await admitWriteInTransaction(tx, { principal, operation, sourceId, sourceIncarnation: source.incarnation,
      slug, requestId, callerIntent, intent: { ...callerIntent, reason }, authority });
    if (isTerminal(row)) return row;
    return withCoordinatedWrite(tx, [sourceId], async () => {
      // Even an expired legacy fact acquires a ledger so a stale import cannot
      // reactivate it. Internal affected-page identities never enter the receipt.
      await recordFactWithdrawal(tx, id, sourceId, ctx.remote !== false, { requestId: row.id });
      if (reason) await tx.executeRaw(`UPDATE facts SET context=concat_ws(' | ',NULLIF(context,''),$3::text)
        WHERE id=$1 AND source_id=$2`, [id, sourceId, `forgotten: ${reason}`]);
      if (operation === 'forget_fact' && fact.expired_at !== null) {
        return completeWrite(tx, row, 'failed', {}, { code: 'fact_already_expired', message: `Fact id ${id} already expired.` });
      }
      const outcome = operation === 'forget'
        ? { id: rawId, expired: fact.expired_at === null, reason, protocol_version: 1 }
        : { id, expired: true, path: 'legacy_db', reason: reason ?? 'forgotten' };
      return completeWrite(tx, row, 'committed', { ...outcome, persistence: { mode: 'database' } });
    });
  }));
  return writeResponse(done);
}
