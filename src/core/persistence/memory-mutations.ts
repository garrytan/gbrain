import { randomUUID } from 'node:crypto';
import type { OperationContext } from '../ops/contract.ts';
import { opError, OperationError, verbError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { enforceClientSlugFence, enforceSubagentSlugFence, validatePageSlug } from '../ops/context.ts';
import { isNullLikeEntity } from '../facts/write-single.ts';
import { isFactWithdrawn, recordFactWithdrawal, type WithdrawalCommit } from '../facts/withdrawal.ts';
import { rebuildPendingPageProjections } from '../page-state/projections.ts';
import { inferFactSubject, isEntityInferenceEnabled, type InferredVia } from '../facts/subject-infer.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { excludesPrivateWrites } from './page-visibility.ts';
import { emitFenceNotice, initializeLocalPersistence, requestPrincipalForContext } from './page-mutations.ts';
import { authorizeStoredRequest, submissionAuthority } from './authority.ts';
import { admitWrite, admitWriteInTransaction, assertPageRequestIdentity, assertReplayIntent, completeWrite, getWriteRequest, intentDigest } from './journal.ts';
import { assertPersistenceAccepting, registerMutationPreparer, waitForWrite, writeResponse } from './service.ts';
import { claimWorktree } from './ownership.ts';
import { declareDurablePersistence } from './protocol.ts';
import { resolveFactWriteTarget } from './fact-write-target.ts';
import { WRITER_INSPECTION_HINT } from './admin-intent.ts';
import { parseMutationPrecondition } from './preconditions.ts';
import { withCoordinatedWrite } from './context.ts';
import { requestAttribution } from './attribution.ts';
import { isTerminal, type WriteRequest } from './model.ts';
import { prepareMemoryMutation } from './memory-prepare.ts';
import { retryWriteAdmission } from './admission-retry.ts';

export { prepareMemoryMutation } from './memory-prepare.ts';
/** Only semantic appends without an explicit caller revision can be recomputed. */
function sourceInactive(sourceId: string): OperationError {
  return opError('source_changed', 'The write source is not active.',
    `Source ${sourceId} is archived or missing, so nothing was saved. Write to an active source, or ask the user to restore ${sourceId}.`,
    { fix: readFix('Lists sources with their archived state, read-only.', { argv: ['gbrain', 'sources', 'list', '--json'], mcp: { tool: 'sources_list', arguments: {} } }) });
}

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
    throw opError('permission_denied', 'This source is outside the current write grant.',
      `This connection may write only to source ${ctx.auth?.sourceId ?? ctx.sourceId ?? 'default'}. Omit source_id to write there, or ask the brain host's operator to grant source ${sourceId}.`);
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

type RememberSource = { incarnation: string; archived: boolean; local_path: string | null; kind: string | null };
type EntityWarning = 'NO_ENTITY' | 'ENTITY_LINK_FAILED';
/** An inferred entity that fails a preflight the explicit path would throw on; the save falls back to unattributed. */
class InferredTargetRejected extends Error { constructor(readonly warning: EntityWarning) { super(warning); } }

/**
 * Every admission check for one target slug. An explicit or unattributed
 * target throws exactly as before; an inferred one (`inferred` set) runs the
 * same checks as predicates and additionally refuses withdrawn claims,
 * malformed fences and any owner claim, so it can fall back instead.
 */
async function planRememberTarget(ctx: OperationContext, sourceId: string, source: RememberSource, entitySlug: string | null,
  inferred: { fact: string; visibility: string } | null) {
  const slug = entitySlug ?? 'memory/unattributed';
  validatePageSlug(slug);
  enforceClientSlugFence(ctx, slug, 'remember'); enforceSubagentSlugFence(ctx, slug, 'remember');
  const authority = await submissionAuthority(ctx, 'remember', sourceId, source.incarnation, slug);
  const snapshot = await ctx.engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  if (snapshot && (snapshot.page.deleted_at || ctx.remote !== false &&
    !await ctx.engine.readPageSnapshot(slug, { sourceId, excludePrivate: authority.excludePrivate }))) {
    throw opError('page_not_found', 'The target entity is not writable by this caller.',
      `Entity page ${slug} in source ${sourceId} is deleted or not visible to this caller, so nothing was saved. Remember the fact against a visible entity, or without an entity (it is then filed under memory/unattributed).`);
  }
  if (inferred && !snapshot) throw new InferredTargetRejected('NO_ENTITY');
  if (inferred && (await isFactWithdrawn(ctx.engine, sourceId, inferred.visibility, inferred.fact, slug)
    || parseFactsFence(snapshot!.page.compiled_truth).warnings.length)) throw new InferredTargetRejected('ENTITY_LINK_FAILED');
  // Preserve the stub guard: a fallback name remains DB-only until a real
  // entity page exists. No placeholder page is created by remember.
  const fence = entitySlug !== null && snapshot !== null;
  const sandbox = ctx.viaSubagent === true && !(ctx.allowedSlugPrefixes?.length);
  const configuredWriteThrough = !/^(false|0|off|no)$/i.test(await ctx.engine.getConfig('sync.write_through') ?? 'true');
  const writeThrough = configuredWriteThrough && !sandbox;
  if (sandbox) authority.databaseOnlyReason = 'subagent_sandbox';
  else if (!configuredWriteThrough) authority.databaseOnlyReason = 'disabled_by_config';
  const target = fence ? await resolveFactWriteTarget(ctx.engine, sourceId, source, { sandbox }) : null;
  let binding = target?.kind === 'publish' ? target.binding : null;
  if (target?.kind === 'publish' && target.databaseOnlyReason) authority.databaseOnlyReason = target.databaseOnlyReason;
  if (target?.kind === 'unbound') {
    // An inferred link never designates an owner or reports a missing one.
    if (inferred) throw new InferredTargetRejected('ENTITY_LINK_FAILED');
    if (ctx.engine.kind !== 'pglite') throw new OperationError('owner_unavailable', 'This source has no designated canonical owner.', WRITER_INSPECTION_HINT);
    binding = await claimWorktree(ctx.engine, sourceId, target.root, undefined, undefined, { automatic: true });
  }
  // An inferred link is optional: a canonical file it could not publish (missing,
  // or carrying an uncoordinated edit) falls back to the unattributed save
  // instead of failing the whole remember at preparation.
  if (inferred && binding && snapshot) {
    const { prepareFileTarget } = await import('./page-prepare.ts');
    const { serializePageToMarkdown } = await import('../markdown.ts');
    try {
      await prepareFileTarget(ctx.engine, { source_id: sourceId, worktree_id: binding.worktree_id, slug }, snapshot,
        serializePageToMarkdown(snapshot.page, snapshot.tags));
    } catch {
      throw new InferredTargetRejected('ENTITY_LINK_FAILED');
    }
  }
  return { slug, authority, snapshot, fence, binding, writeThrough };
}

/**
 * #5836: a fact saved without an entity names its subject from an exact
 * mention, before admission. Any check the inferred target fails falls back
 * to the unattributed save; `warning` is ENTITY_LINK_FAILED only once the
 * target passed every scope and readability check, so a hidden page is never revealed.
 */
async function inferRememberTarget(ctx: OperationContext, sourceId: string, source: RememberSource, p: Record<string, unknown>):
  Promise<{ target: Awaited<ReturnType<typeof planRememberTarget>>; via: InferredVia } | { warning: EntityWarning } | null> {
  if (p.infer_entity === false || !(await isEntityInferenceEnabled(ctx.engine))) return null;
  const fact = String(p.fact).trim();
  const inferred = await inferFactSubject(ctx.engine, sourceId,
    { fact, mode: 'write', excludePrivate: await excludesPrivateWrites(ctx.engine, ctx.remote !== false) });
  if (inferred.slug === null) return null;
  try {
    const target = await planRememberTarget(ctx, sourceId, source, inferred.slug, { fact, visibility: String(p.visibility ?? 'world') });
    return { target, via: inferred.via };
  } catch (error) {
    if (error instanceof InferredTargetRejected) return { warning: error.warning };
    if (error instanceof OperationError) return null;
    throw error;
  }
}

export async function submitRememberMutation(ctx: OperationContext, params: Record<string, unknown>, waitMs?: number): Promise<Record<string, unknown>> {
  registerMutationPreparer('remember', prepareMemoryMutation);
  const sub = await submission(ctx, 'remember', params);
  if (sub.prior) return writeResponse(await waitForWrite(ctx.engine, sub.prior, ctx.config, waitMs ?? ctx.writeWaitMs));
  const { p, sourceId, principal, callerIntent, requestId } = sub;
  const [source] = await ctx.engine.executeRaw<RememberSource>(
    "SELECT incarnation,archived,local_path,config->>'kind' AS kind FROM sources WHERE id=$1", [sourceId]);
  if (!source || source.archived) throw sourceInactive(sourceId);
  const { parseTtlParam } = await import('../ops/facts.ts');
  const validUntil = parseTtlParam(p.ttl);
  const entity = typeof p.entity === 'string' && !isNullLikeEntity(p.entity) ? p.entity.trim() : null;
  const { resolveEntitySlugWithSource } = await import('../entities/resolve.ts');
  const resolved = entity ? await resolveEntitySlugWithSource(ctx.engine, sourceId, entity) : null;
  const inference = entity === null ? await inferRememberTarget(ctx, sourceId, source, p) : null;
  const linked = inference && 'target' in inference ? inference : null;
  const entitySlug = linked?.target.slug ?? resolved?.slug ?? null;
  // A source-scoped absent identity serializes subjectless facts. Bound writers
  // cannot use it to escape their namespace grant.
  const { slug, authority, snapshot, fence, binding, writeThrough } = linked?.target ?? await planRememberTarget(ctx, sourceId, source, entitySlug, null);
  if (p.replaces !== undefined && p.replaces !== null) {
    // Fail fast on an invalid target; the coordinator re-checks it under the row lock before publishing.
    const { decideReplacement } = await import('../facts/single-prepare.ts');
    await decideReplacement(ctx.engine, sourceId, { fact: String(p.fact).trim(), kind: (p.kind ?? 'fact') as never,
      visibility: (p.visibility ?? 'world') as never, entity_slug: entitySlug }, Number(p.replaces), { pageSlug: slug, remote: ctx.remote !== false });
  }
  const row = await admitWrite(ctx.engine, { principal, operation: 'remember', sourceId, sourceIncarnation: source.incarnation,
    slug, pageId: snapshot?.page.id ?? null, requestId, callerIntent,
    // The transport's session (MCP `_meta.session_id`) is recorded on the fact, as extract_facts records
    // it, so recall's session_id filter finds single facts too. Identity only — never a trust surface.
    intent: { ...callerIntent, entity_slug: entitySlug, fence, valid_from: new Date().toISOString(), valid_until: validUntil?.toISOString() ?? null,
      ...(linked ? { entity_inferred: linked.via } : {}), ...(inference && 'warning' in inference ? { entity_warning: inference.warning } : {}),
      session_id: ctx.sessionId ?? null },
    authority, worktreeId: writeThrough ? binding?.worktree_id : null, topologyGeneration: writeThrough ? binding?.topology_generation : null });
  const response = writeResponse(await waitForWrite(ctx.engine, row, ctx.config, waitMs ?? ctx.writeWaitMs));
  emitFenceNotice(ctx, response, row.slug);
  return response;
}

interface WithdrawalTarget { id: number; entity_slug: string | null; source_markdown_slug: string | null; expired_at: Date | null; }

/** Withdrawal commits independently of filesystem ownership and request FIFO. */
export async function submitForgetMutation(ctx: OperationContext, operation: 'forget' | 'forget_fact', params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sub = await submission(ctx, operation, params);
  if (sub.prior) return withSimilarActive(ctx, operation, sub.sourceId, sub.p, writeResponse(sub.prior));
  const { p, sourceId, principal, callerIntent, requestId } = sub;
  const semanticReview = p.semantic_review !== false;
  const id = Number(p.id);
  const rawId = String(p.id).trim();
  const reason = typeof p.reason === 'string' && p.reason.trim() ? p.reason.trim() : null;
  if (!Number.isSafeInteger(id) || id <= 0) throw verbError(operation === 'forget' ? 'not_found' : 'fact_not_found',
    `No fact with id "${rawId}".`, 'Pass the fact id returned by remember or recall.');
  // Retry the whole withdrawal, so source/principal guards and the connection
  // are released before backoff. Admission must not retry a nested savepoint.
  let withdrawn: WithdrawalCommit['pages'] = [];
  const done = await retryWriteAdmission(requestId, remaining => ctx.engine.transaction(async tx => {
    withdrawn = [];
    await declareDurablePersistence(tx, `${Math.min(1000, remaining)}ms`, `${remaining}ms`);
    // Brain row -> source -> current grant -> counters/request -> sorted page keys -> facts.
    // Do not acquire a shared source lock first and upgrade it after admission.
    const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>(
      'SELECT incarnation,archived FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
    if (!source || source.archived) throw sourceInactive(sourceId);
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
      withdrawn = (await recordFactWithdrawal(tx, id, sourceId, ctx.remote !== false, { requestId: row.id, semanticReview })).pages;
      if (reason) await tx.executeRaw(`UPDATE facts SET context=concat_ws(' | ',NULLIF(context,''),$3::text)
        WHERE id=$1 AND source_id=$2`, [id, sourceId, `forgotten: ${reason}`]);
      if (operation === 'forget_fact' && fact.expired_at !== null) {
        return completeWrite(tx, row, 'failed', {}, { code: 'fact_already_expired', message: `Fact id ${id} already expired.` });
      }
      const outcome = operation === 'forget'
        ? { id: rawId, expired: fact.expired_at === null, reason, protocol_version: 1 }
        : { id, expired: true, path: 'legacy_db', reason: reason ?? 'forgotten' };
      return completeWrite(tx, row, 'committed', { ...outcome, persistence: { mode: 'database' } });
    }, requestAttribution(row));
  }), undefined, error => ctx.engine.reconnect({ error }));
  // The commit removed the withdrawn pages' chunks. Rebuild them before
  // acknowledging: a CLI process exits without a resident projection worker.
  // A failed rebuild stays queued as durable projection work.
  const slugs = withdrawn.map(page => page.slug);
  for (let start = 0; start < slugs.length; start += 100) {
    await rebuildPendingPageProjections(ctx.engine, 100, { pages: { sourceId, slugs: slugs.slice(start, start + 100) } }).catch(() => undefined);
  }
  return withSimilarActive(ctx, operation, sourceId, p, writeResponse(done));
}

/** `forget` responses carry `similar_active` (ids and scores only, zero model calls); best-effort, never fails the forget. */
async function withSimilarActive(ctx: OperationContext, operation: 'forget' | 'forget_fact', sourceId: string,
  p: Record<string, unknown>, response: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (operation !== 'forget') return response;
  const factId = Number(p.id);
  if (!Number.isSafeInteger(factId)) return response;
  try {
    const { similarActiveAfterForget } = await import('../facts/similar-active.ts');
    const committed = (response.write_request as { state?: string } | undefined)?.state === 'committed' || response.state === 'committed';
    return { ...response, similar_active: await similarActiveAfterForget(ctx.engine, {
      sourceId, factId, remote: ctx.remote !== false, committed, semanticReview: p.semantic_review !== false }) };
  } catch { return response; }
}
