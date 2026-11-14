import { throwIfHeld } from '../trust/gate-outcomes.ts';
import { assertStorageSourceWriter } from '../storage-manifest/door.ts';
import { forgetRequiresOwner, guardRemoteForget, remoteForgetRaced, supersessionGuarded } from '../trust/supersede-handlers.ts';
import { storedTrustTier } from '../trust/tier.ts';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { OperationContext } from '../ops/contract.ts';
import { opError, OperationError, verbError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { enforceClientSlugFence, enforceSubagentSlugFence, validatePageSlug } from '../ops/context.ts';
import { isNullLikeEntity } from '../facts/write-single.ts';
import { isFactWithdrawn, planFactWithdrawal } from '../facts/withdrawal.ts';
import { inferFactSubject, isEntityInferenceEnabled, type InferredVia } from '../facts/subject-infer.ts';
import { isHoldingSlug, parseFactsFence, UNATTRIBUTED_MEMORY_SLUG } from '../facts-fence.ts';
import { isSegmentedPage, withoutBody } from '../page-body/page-shape.ts';
import { segmentedRememberRefusal, type RememberCarry } from './verb-errors.ts';
import { materializedPage, segmentedOverCeiling } from './segmented-apply.ts';
import { excludesPrivateWrites, storedOwnerSpeaksForItself } from './page-visibility.ts';
import { emitFenceNotice, initializeLocalPersistence, requestPrincipalForContext } from './page-mutations.ts';
import { authorizeStoredRequest, submissionAuthority } from './authority.ts';
import { admitWrite, assertPageRequestIdentity, assertReplayIntent, getWriteRequest, intentDigest } from './journal.ts';
import { assertPersistenceAccepting, registerMutationPreparer, waitForWrite, writeResponse } from './service.ts';
import { claimWorktree, getWorktreeBinding } from './ownership.ts';
import { resolveFactWriteTarget } from './fact-write-target.ts';
import { clientRequestIdOf, parseMutationPrecondition } from './preconditions.ts';
import { grantedWriteSource, writeGrantRefusal } from './write-grant.ts';
import type { WriteRequest } from './model.ts';
import { prepareMemoryMutation } from './memory-prepare.ts';
import { ownerReachesFact, readForgetTarget, refuseForgetReachingOtherCopies } from './forget-prepare.ts';
import { callerIsOwner, currentCallerAccess, privateProvenanceFilterUnderPolicy, resolveExcludePrivatePages, withFolderRestricted } from '../search/private-visibility.ts';
import { projectionEligibleSql } from '../eligibility/sql.ts';
import { resolveReadEligibility } from '../eligibility/policy.ts';
import { callerMember, factVisibilitySql, memberFactPage, memberPageIsOwn, memberPageNotOwned, memberPageSlug, ownMemberFactIds, scopePageIsShared, scopePageNotShared, SCOPE_PAGE_SLUG } from '../access/member-facts.ts';
import { perCallWriteSource } from '../access/attest-sources.ts';
import { isGitCheckoutRoot } from '../git-checkout.ts';
import { entityPageMissingNotice } from '../interop-notices.ts';

import { ownerSpeaksForItself } from '../access/member-facts.ts';
import { isDerivationPrivate } from '../search/private-visibility.ts';

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
async function submission(ctx: OperationContext, operation: string, params: Record<string, unknown>, retryArguments?: Record<string, unknown>) {
  assertPersistenceAccepting(ctx.engine);
  const p: Record<string, unknown> = { ...params, ...parseMutationPrecondition(params) };
  const requestId = typeof p.request_id === 'string' ? p.request_id : randomUUID();
  const sourceId = typeof p.source_id === 'string' ? p.source_id : ctx.sourceId ?? 'default';
  const granted = grantedWriteSource(ctx);
  if (ctx.remote !== false && sourceId !== granted && !perCallWriteSource(ctx, sourceId)) {
    throw writeGrantRefusal(ctx,
      `This connection may write only to source ${granted}. Omit source_id to write there, or ask the brain host's operator to grant source ${sourceId}.`,
      retryArguments ? { tool: operation, arguments: retryArguments } : undefined);
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
  return { p, requestId, clientRequestId: clientRequestIdOf(params.request_id), sourceId, principal, callerIntent, prior };
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
  inferred: { fact: string; visibility: string } | null, call: RememberCall, memberPage: string | null = null) {
  // GST-359 C2: a member's remote fact goes to its own member page, created by the first one; the entity is metadata only.
  const slug = memberPage ?? entitySlug ?? 'memory/unattributed';
  validatePageSlug(slug);
  enforceClientSlugFence(ctx, slug, 'remember'); enforceSubagentSlugFence(ctx, slug, 'remember');
  const authority = await submissionAuthority(ctx, 'remember', sourceId, source.incarnation, slug);
  const snapshot = await ctx.engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  if (snapshot && (snapshot.page.deleted_at || ctx.remote !== false &&
    !await ctx.engine.readPageSnapshot(slug, { sourceId, excludePrivate: authority.excludePrivate }))) {
    throw opError('page_not_found', 'The target entity is not writable by this caller.',
      `Entity page ${slug} in source ${sourceId} is deleted or not visible to this caller, so nothing was saved. Remember the fact against a visible entity, or without an entity (it is then filed under memory/unattributed).`);
  }
  if (memberPage === SCOPE_PAGE_SLUG) { if (snapshot && !await scopePageIsShared(ctx.engine, { ...withoutBody(snapshot.page), source_id: sourceId, slug })) throw scopePageNotShared(sourceId); }
  else if (memberPage && snapshot && !memberPageIsOwn(memberPage, snapshot.page.frontmatter)) throw memberPageNotOwned(memberPage);
  if (inferred && !snapshot) throw new InferredTargetRejected('NO_ENTITY');
  // Wave B: a segmented entity page over the single-string ceiling cannot take a fence row; named or inferred, the save refuses
  // before admission instead of misfiling it. Below the ceiling an inferred target's checks read the page back whole, as preparation does.
  if ((entitySlug !== null || memberPage) && snapshot && segmentedOverCeiling(snapshot.page)) {
    throw segmentedRememberRefusal(slug, sourceId, inferred !== null, await rememberCarry(ctx, call, snapshot.page));
  }
  const whole = inferred && snapshot && isSegmentedPage(snapshot.page) ? await materializedPage(ctx.engine, snapshot.page) : snapshot?.page;
  if (inferred && (await isFactWithdrawn(ctx.engine, sourceId, inferred.visibility, inferred.fact, slug)
    || parseFactsFence(whole!.compiled_truth).warnings.length)) throw new InferredTargetRejected('ENTITY_LINK_FAILED');
  // Preserve the stub guard: a fallback name remains DB-only until a real
  // entity page exists. No placeholder entity page is created by remember; a
  // fact without an entity is a row of memory/unattributed, created on first use (GBRA-190 G4),
  // and a member's fact goes to its own member page (GST-359 C2).
  const unattributed = memberPage === null && entitySlug === null;
  let fence = memberPage !== null || unattributed || snapshot !== null;
  const sandbox = ctx.viaSubagent === true && !(ctx.allowedSlugPrefixes?.length);
  const configuredWriteThrough = !/^(false|0|off|no)$/i.test(await ctx.engine.getConfig('sync.write_through') ?? 'true');
  const writeThrough = configuredWriteThrough && !sandbox;
  if (sandbox) authority.databaseOnlyReason = 'subagent_sandbox';
  else if (!configuredWriteThrough) authority.databaseOnlyReason = 'disabled_by_config';
  // GST-2492: on a strict source (Git is the record) a named entity with no page holds its fact in Git, as a row of a
  // holding page that names the entity, until the entity's page exists: memory/unattributed, or for an entity under a
  // folder access rule its folder's holding page, which every rule covering the entity covers by path. The fences and the
  // authority above ran on the entity (decision D1); the holding row is gbrain's own companion write, authorized as a write
  // to that entity. A folder's holding page takes the folder's storage class (database-only under storage.db_only or a path
  // Git ignores, as the entity's own page would be); a shared one kept out of Git keeps the fact database-only, as before.
  const { holdingHome, refuseUnheldFact } = await import('../facts/held-fact-move.ts');
  const home = !inferred && memberPage === null && entitySlug !== null && !snapshot && writeThrough ? await holdingHome(ctx.engine, sourceId, entitySlug) : null;
  // An exact page rule on the entity, or an access state this role cannot read: no holding page carries those readers.
  if (home && 'refused' in home) await refuseUnheldFact(ctx.engine, sourceId, entitySlug!, home.refused, ctx.remote !== false);
  const holdingSlug = home && 'slug' in home ? home.slug : null;
  const holding = holdingSlug ? await ctx.engine.readPageSnapshot(holdingSlug, { sourceId, includeDeleted: true }) ?? 'absent' : null;
  const held = holding !== null && (holding === 'absent' || !holding.page.deleted_at && (Boolean(holding.page.source_path) || holdingSlug !== UNATTRIBUTED_MEMORY_SLUG));
  const page = held && holding !== 'absent' ? holding : snapshot;
  if (held) fence = true;
  // An inferred link never designates an owner or reports a missing one.
  const target = fence ? await resolveFactWriteTarget(ctx.engine, sourceId, source,
    { sandbox, fileBacked: page ? Boolean(page.page.source_path) : unattributed || held, remote: ctx.remote !== false }).catch((error: unknown) => {
    if (inferred && error instanceof OperationError) throw new InferredTargetRejected('ENTITY_LINK_FAILED');
    // A source that refuses a new canonical file keeps the subjectless (or held) fact database-only, as before memory/unattributed had a page.
    if ((unattributed || held) && !page && error instanceof OperationError) return null;
    throw error;
  }) : null;
  if ((unattributed || held) && !page && !target) fence = false;
  if (held && fence) authority.heldFor = entitySlug!;
  // GST-2446: a named entity with no page keeps its fact out of every file. Where the source has a checkout the reason
  // is the missing page, never a missing repository.
  if (!fence && entitySlug !== null && writeThrough) {
    const root = source.local_path || (sourceId === 'default' ? await ctx.engine.getConfig('sync.repo_path') : null);
    authority.databaseOnlyReason = root && isAbsolute(root) || await getWorktreeBinding(ctx.engine, sourceId) ? 'entity_page_missing' : 'no_repo_configured';
  }
  let binding = target?.kind === 'publish' ? target.binding : null;
  if (target?.kind === 'publish' && target.databaseOnlyReason) authority.databaseOnlyReason = target.databaseOnlyReason;
  if (target?.kind === 'unbound') {
    if (inferred) throw new InferredTargetRejected('ENTITY_LINK_FAILED');
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
        serializePageToMarkdown(whole!, snapshot.tags));
    } catch {
      throw new InferredTargetRejected('ENTITY_LINK_FAILED');
    }
  }
  return held && fence ? { slug: holdingSlug!, authority, snapshot: page, fence, binding, writeThrough, heldFor: entitySlug }
    : { slug, authority, snapshot, fence, binding, writeThrough, heldFor: null };
}

/** The caller's remember parameters and whether it named a visibility (the verb fills the v1 default otherwise). */
interface RememberCall { p: Record<string, unknown>; visibilityDefaulted: boolean }
type PageLabel = { type?: string | null; frontmatter?: unknown; source_id: string; slug: string };

/** The visibility a remember saves into `page`: the caller's own, or the resolved default that never widens a private target. */
async function rememberVisibility(ctx: OperationContext, call: RememberCall, page: PageLabel | null | undefined): Promise<'world' | 'private'> {
  if (!call.visibilityDefaulted) return call.p.visibility === 'private' ? 'private' : 'world';
  const { resolveRememberVisibility } = await import('../facts/visibility.ts');
  return resolveRememberVisibility(ctx.engine, page && await withFolderRestricted(ctx.engine, page));
}

/** GST-2346 D1: whether the owner's default save stays on its member page: it replaces a fact there, or the target page or the brain's default keeps facts private. */
async function ownerDefaultKeptPrivate(ctx: OperationContext, sourceId: string, slug: string | null, replaces: unknown): Promise<boolean> {
  const id = Number(replaces);
  if (replaces !== undefined && replaces !== null && Number.isSafeInteger(id) && (await ownMemberFactIds(ctx.engine, sourceId, [id])).has(id)) return true;
  const snapshot = slug ? await ctx.engine.readPageSnapshot(slug, { sourceId }) : null;
  return await rememberVisibility(ctx, { p: {}, visibilityDefaulted: true }, snapshot && { ...withoutBody(snapshot.page), source_id: sourceId, slug: slug! }) === 'private';
}

async function rememberCarry(ctx: OperationContext, call: RememberCall, page: PageLabel): Promise<RememberCarry> {
  const { p } = call;
  return { visibility: await rememberVisibility(ctx, call, page), ...(typeof p.kind === 'string' ? { kind: p.kind } : {}),
    ...(typeof p.ttl === 'string' ? { ttl: p.ttl } : {}), ...(typeof p.valid_from === 'string' ? { valid_from: p.valid_from } : {}) };
}

/**
 * #5836: a fact saved without an entity names its subject from an exact
 * mention, before admission. Any check the inferred target fails falls back
 * to the unattributed save; `warning` is ENTITY_LINK_FAILED only once the
 * target passed every scope and readability check, so a hidden page is never revealed.
 */
async function inferRememberTarget(ctx: OperationContext, sourceId: string, source: RememberSource, call: RememberCall):
  Promise<{ target: Awaited<ReturnType<typeof planRememberTarget>>; via: InferredVia } | { warning: EntityWarning } | null> {
  const { p } = call;
  if (p.infer_entity === false || !(await isEntityInferenceEnabled(ctx.engine))) return null;
  const fact = String(p.fact).trim();
  const inferred = await inferFactSubject(ctx.engine, sourceId,
    { fact, mode: 'write', excludePrivate: await excludesPrivateWrites(ctx.engine, ctx.remote !== false) });
  if (inferred.slug === null) return null;
  try {
    const target = await planRememberTarget(ctx, sourceId, source, inferred.slug, { fact, visibility: String(p.visibility ?? 'world') }, call);
    return { target, via: inferred.via };
  } catch (error) {
    if (error instanceof InferredTargetRejected) return { warning: error.warning };
    if (error instanceof OperationError && error.canonicalCode === 'page_body_segmented') throw error;
    if (error instanceof OperationError) return null;
    throw error;
  }
}

export async function submitRememberMutation(ctx: OperationContext, params: Record<string, unknown>, waitMs?: number,
  opts: { visibilityDefaulted?: boolean } = {}): Promise<Record<string, unknown>> {
  registerMutationPreparer('remember', prepareMemoryMutation);
  const { visibility: _defaulted, ...withoutDefault } = params;
  const sub = await submission(ctx, 'remember', params, opts.visibilityDefaulted ? withoutDefault : params);
  if (sub.prior) { const prior = sub.prior; const settled = await waitForWrite(ctx.engine, prior, ctx.config, waitMs ?? ctx.writeWaitMs); return rememberLanded(ctx, settled, throwIfHeld(withRememberTarget(prior, () => writeResponse(settled)))); }
  const { p, sourceId, principal, callerIntent, requestId, clientRequestId } = sub;
  const [source] = await ctx.engine.executeRaw<RememberSource & { role: string | null }>(
    "SELECT incarnation,archived,local_path,config->>'kind' AS kind,config->>'role' AS role FROM sources WHERE id=$1", [sourceId]);
  if (!source || source.archived) throw sourceInactive(sourceId);
  assertStorageSourceWriter(ctx, sourceId, source.role, {});
  const { parseTtlParam } = await import('../ops/facts.ts');
  const validUntil = parseTtlParam(p.ttl);
  const entity = typeof p.entity === 'string' && !isNullLikeEntity(p.entity) ? p.entity.trim() : null;
  const resolved = entity ? await resolveRememberEntity(ctx, sourceId, entity) : null;
  // GST-359 C2: a remote member's fact is private, on its member page, and never inferred onto another page.
  // GST-1113: an attested memory_write that named a scope source saves world facts on that source's scope page instead.
  // GST-2243: share: true saves a member's fact as anyone else's, on the subject's page for every reader of the source.
  const scopePage = perCallWriteSource(ctx, sourceId);
  const ownPage = scopePage ? null : memberFactPage(ctx);
  // GST-2346 D1: the brain owner speaking for itself saves as a caller with no member page does, unless it asks for private.
  const ownerShares = ownPage !== null && p.share !== true && ownerSpeaksForItself(ctx) && (opts.visibilityDefaulted === true
    ? !await ownerDefaultKeptPrivate(ctx, sourceId, resolved?.slug ?? null, p.replaces) : p.visibility !== 'private');
  let memberPage = scopePage ? SCOPE_PAGE_SLUG : p.share === true || ownerShares ? null : ownPage;
  let call: RememberCall = memberPage ? { p: { ...p, visibility: scopePage ? 'world' : 'private', infer_entity: false }, visibilityDefaulted: false }
    : { p, visibilityDefaulted: opts.visibilityDefaulted === true || p.share === true };
  let inference = entity === null && !memberPage ? await inferRememberTarget(ctx, sourceId, source, call) : null;
  let linked = inference && 'target' in inference ? inference : null;
  let entitySlug = linked?.target.slug ?? resolved?.slug ?? null;
  // A source-scoped absent identity serializes subjectless facts. Bound writers
  // cannot use it to escape their namespace grant.
  let { slug, authority, snapshot, fence, binding, writeThrough } = linked?.target ?? await planRememberTarget(ctx, sourceId, source, entitySlug, null, call, memberPage);
  const { assertFactNotWithdrawn, decideReplacement, replacementVisibility } = await import('../facts/single-prepare.ts');
  const defaultedVisibility = await rememberVisibility(ctx, call, snapshot?.page);
  const visibility = call.visibilityDefaulted && p.replaces !== undefined && p.replaces !== null
    ? await replacementVisibility(ctx.engine, sourceId, Number(p.replaces), defaultedVisibility, { remote: ctx.remote !== false })
    : defaultedVisibility;
  // D1: a default save the page or the brain's default keeps private goes to the owner's own member page, as a member's does.
  if (ownerShares && visibility === 'private') {
    memberPage = ownPage; call = { p: { ...p, visibility: 'private', infer_entity: false }, visibilityDefaulted: false };
    inference = null; linked = null; entitySlug = resolved?.slug ?? null;
    ({ slug, authority, snapshot, fence, binding, writeThrough } = await planRememberTarget(ctx, sourceId, source, entitySlug, null, call, memberPage));
  }
  // D1: the owner's explicit visibility "world" onto a page whose facts are kept private is refused like share: true.
  const ownerWorldRestricted = ownerShares && !call.visibilityDefaulted && snapshot !== null && isDerivationPrivate(await withFolderRestricted(ctx.engine, { ...withoutBody(snapshot.page), source_id: sourceId, slug }));
  if (p.share === true && visibility !== 'world' || ownerWorldRestricted) {
    throw Object.assign(verbError('invalid_params', `remember: ${p.share === true ? 'share: true' : 'visibility "world"'} cannot share a fact on ${slug}, whose facts are kept private (restricted page or the brain's private fact default); nothing was saved.`,
      p.share === true ? 'Share it on a page every reader of this source can read, or drop share to keep the fact on your own page.'
        : 'Share it on a page every reader of this source can read, or pass visibility "private" to keep the fact on your own page.'), { reason: 'share_target_restricted' });
  }
  const factIntent = { fact: String(p.fact).trim(), kind: (p.kind ?? 'fact') as never, visibility, entity_slug: entitySlug, ...(memberPage ? { page_slug: memberPage } : {}) };
  // Fail fast on an invalid target or a withdrawn claim; the coordinator re-checks both under its locks before publishing.
  if (p.replaces !== undefined && p.replaces !== null) {
    // Fail fast on an invalid target; the coordinator re-checks it under the row lock before publishing.
    await decideReplacement(ctx.engine, sourceId, factIntent, Number(p.replaces),
      { pageSlug: slug, remote: ctx.remote !== false, excludePrivate: await resolveExcludePrivatePages(ctx.engine, ctx.remote), slugPrefixes: authority.slugPrefixes });
  }
  await assertFactNotWithdrawn(ctx.engine, sourceId, factIntent, { excludePrivate: await resolveExcludePrivatePages(ctx.engine, ctx.remote), remote: ctx.remote !== false });
  const row = await admitWrite(ctx.engine, { origin: ctx.admissionOrigin, principal, operation: 'remember', sourceId, sourceIncarnation: source.incarnation,
    slug, pageId: snapshot?.page.id ?? null, requestId, clientRequestId, callerIntent,
    // The transport's session (MCP `_meta.session_id`) is recorded on the fact, as extract_facts records
    // it, so recall's session_id filter finds single facts too. Identity only — never a trust surface.
    intent: { ...callerIntent, entity_slug: entitySlug, fence, valid_from: typeof p.valid_from === 'string' ? new Date(p.valid_from).toISOString() : new Date().toISOString(), valid_until: validUntil?.toISOString() ?? null,
      visibility, ...(call.visibilityDefaulted ? { visibility_defaulted: true } : {}), ...(scopePage ? { scope_page: true } : memberPage ? { member_page: true } : {}),
      ...(linked ? { entity_inferred: linked.via } : {}), ...(inference && 'warning' in inference ? { entity_warning: inference.warning } : {}),
      session_id: ctx.sessionId ?? null },
    authority, worktreeId: writeThrough ? binding?.worktree_id : null, topologyGeneration: writeThrough ? binding?.topology_generation : null, deferrable: true });
  const written = await waitForWrite(ctx.engine, row, ctx.config, waitMs ?? ctx.writeWaitMs);
  const response = throwIfHeld(withRememberTarget(row, () => writeResponse(written)));
  emitFenceNotice(ctx, response, row.slug);
  return rememberLanded(ctx, written, response);
}

/**
 * GST-2243: every remember reply names the page the fact went to and who can recall it. GST-2446: a fact saved for an
 * entity with no page is on no page, so the reply names none; where the source's pages are in Git, one notice gives
 * the call that creates the page (a brain with no repository keeps the database as its record and is told nothing).
 * GST-2492: on a strict git-canonical source the fact is held on memory/unattributed instead (`authority.heldFor`), so
 * the reply names that page and the notice says it is committed and when it moves.
 */
async function rememberLanded<T extends Record<string, unknown>>(ctx: OperationContext, row: WriteRequest, response: T): Promise<T> {
  const intent = row.intent as { visibility?: unknown; fence?: unknown; entity_slug?: unknown } | null;
  if (row.authority.heldFor) ctx.emitNotice?.(entityPageMissingNotice(row.source_id, row.authority.heldFor,
    { slug: row.slug, committed: (response.persistence as { mode?: unknown } | undefined)?.mode === 'filesystem' }));
  if ((response.write_through as { skipped?: unknown } | undefined)?.skipped === 'entity_page_missing' && typeof intent?.entity_slug === 'string') {
    const binding = await getWorktreeBinding(ctx.engine, row.source_id);
    const root = binding?.local_path || (await ctx.engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [row.source_id]))[0]?.local_path
      || (row.source_id === 'default' ? await ctx.engine.getConfig('sync.repo_path') : null);
    // The checkout itself must be the repository: a folder that merely sits under one (a home directory kept in Git) is not.
    if (binding?.canonical_git === true || binding?.git_durability === 'enabled' || root && isGitCheckoutRoot(root)) {
      ctx.emitNotice?.(entityPageMissingNotice(row.source_id, intent.entity_slug));
    }
  }
  return { ...response, ...(intent?.fence === true ? { page: row.slug } : {}), ...(intent?.visibility === 'world' || intent?.visibility === 'private' ? { visibility: intent.visibility } : {}) };
}

/**
 * #7248: a pending (or refused) remember names the page its fact goes to and
 * the entity it is keyed under, so a caller can tell a misfile at once and
 * poll the right receipt.
 */
function withRememberTarget<T>(row: WriteRequest, reply: () => T): T {
  try { return reply(); } catch (error) {
    if (error instanceof OperationError && error.writeRequest) {
      const entity = (row.intent as { entity_slug?: unknown } | null)?.entity_slug;
      error.writeRequest.target = { slug: (row.intent as { fence?: unknown } | null)?.fence === true && row.slug || null, entity_slug: typeof entity === 'string' ? entity : null };
    }
    throw error;
  }
}

/**
 * #7248: an explicit entity names its page. A reference with a folder keeps
 * the lenient resolution (an existing page, else that exact slug for a page
 * not written yet); a folder-less one must resolve to exactly one readable
 * entity page by identity evidence, else the call is refused with the pages
 * it could mean instead of keying the fact under a bare slug no page carries.
 * A name no page resembles keeps its slugified key, as a fact about an entity
 * with no page yet always has.
 */
async function resolveRememberEntity(ctx: OperationContext, sourceId: string, entity: string): Promise<{ slug: string }> {
  const { entityReferenceCandidates, resolveEntitySlugWithSource, resolveStrictEntityReference } = await import('../entities/resolve.ts');
  if (entity.includes('/')) return (await resolveEntitySlugWithSource(ctx.engine, sourceId, entity))!;
  const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
  const strict = await resolveStrictEntityReference(ctx.engine, sourceId, entity, { sameName: true, excludePrivate, forCaller: true });
  if (strict.slug !== null) return { slug: strict.slug };
  const candidates = await entityReferenceCandidates(ctx.engine, sourceId, entity, { excludePrivate, forCaller: true });
  if (strict.miss === 'no_page' && !candidates.length) {
    const unnamed = await resolveEntitySlugWithSource(ctx.engine, sourceId, entity);
    if (unnamed?.source === 'fallback_slugify') return { slug: unnamed.slug };
  }
  const named = candidates.length ? ` It could mean: ${candidates.join(', ')}.` : '';
  const what = {
    ambiguous: `entity "${entity}" matches more than one page.`,
    unverified: `entity "${entity}" is not a page name; it only begins one.`,
    not_entity: `entity "${entity}" names a page that is not a person, company or other entity.`,
    no_page: `No page is named "${entity}".`,
  }[strict.miss];
  const example = candidates[0] ?? `people/${entity.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  const error = verbError('invalid_params', `${what}${named} Nothing was saved.`,
    `Pass entity as the page slug with its folder, e.g. entity: "${example}". A slug with a folder saves under that page, even one not written yet; a name without one must match exactly one page.`);
  error.reason = `entity_${strict.miss}`;
  if (candidates.length) error.detail = `candidates: ${candidates.join(', ')}`;
  throw error;
}

/**
 * GBRA-190 G4: a withdrawal is a coordinated page publication (forget-prepare.ts): the files that carry the claim are
 * struck and committed first, then the ledger row, expiries and chunk invalidation commit in its transaction. The
 * checks here fail fast before admission; preparation and publication repeat them under their locks.
 */
export async function submitForgetMutation(ctx: OperationContext, operation: 'forget' | 'forget_fact', params: Record<string, unknown>, waitMs?: number): Promise<Record<string, unknown>> {
  const sub = await submission(ctx, operation, params);
  if (sub.prior) return withSimilarActive(ctx, operation, sub.sourceId, sub.p, writeResponse(await waitForWrite(ctx.engine, sub.prior, ctx.config, waitMs ?? ctx.writeWaitMs)));
  const { p, sourceId, principal, callerIntent, requestId, clientRequestId } = sub;
  const id = Number(p.id);
  const rawId = String(p.id).trim();
  const reason = typeof p.reason === 'string' && p.reason.trim() ? p.reason.trim() : null;
  const missing = () => verbError(operation === 'forget' ? 'not_found' : 'fact_not_found',
    `No fact with id "${rawId}".`, 'Ids come from remember/recall. Recall the entity first to find the right fact.');
  if (!Number.isSafeInteger(id) || id <= 0) throw verbError(operation === 'forget' ? 'not_found' : 'fact_not_found',
    `No fact with id "${rawId}".`, 'Pass the fact id returned by remember or recall.');
  const remote = ctx.remote !== false;
  const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
  // GST-359 D: a remote caller that is one member (an attested person or a member-bound credential) withdraws only facts
  // on its own member page, and only there (the page is the withdrawal's subject), so another member's copy of the same
  // claim stays active and rememberable. Ownership is judged first: any other fact is not_found before a trust check,
  // so no owner proposal is filed and its tier is never disclosed.
  const member = remote ? callerMember() : null;
  const mine = member !== null && (await ownMemberFactIds(ctx.engine, sourceId, [id])).has(id);
  // GST-2346 D1: the owner speaking for itself withdraws a fact off its member page as a caller with no member page does.
  const asOwner = member !== null && !mine && ownerSpeaksForItself(ctx) && await readForgetTarget(ctx.engine, id, sourceId, remote, excludePrivate) !== null;
  let ownPage = member && !asOwner ? memberPageSlug(member) : null;
  const hostWithdraws = () => verbError('permission_denied', ownerSpeaksForItself(ctx)
    ? `Fact #${rawId} is one this credential reads but cannot withdraw. Nothing was forgotten.`
    : `Fact #${rawId} is not on your member page ${ownPage}, so this credential cannot withdraw it. Nothing was forgotten.`,
  ownerSpeaksForItself(ctx)
    ? `The brain owner's credential withdraws shared facts, facts on its member page and other facts it reads on pages it can write. The brain host withdraws this one with gbrain forget ${rawId}.`
    : `A member credential withdraws only the facts on its own member page. The brain host withdraws this one with gbrain forget ${rawId}.`);
  let ownerReach = false;
  if (ownPage && !mine) {
    // #9101: a fact the caller reads (one it shared, or a teammate's shared fact) is refused by name; a fact it cannot read stays not_found.
    // An attested QM actor keeps not_found for every fact off its page, as QM memory-provider contract v3 states.
    if (currentCallerAccess().actor) throw missing();
    const readable = callerIsOwner() ? 'TRUE' : factVisibilitySql('facts', ['world']);
    const eligible = projectionEligibleSql('facts', 'facts', await resolveReadEligibility(ctx));
    const readsUnder = async (provenance: string) => (await ctx.engine.executeRaw(`SELECT 1 FROM facts WHERE id=$1 AND source_id=$2 AND ${readable} AND ${eligible}${provenance}`, [id, sourceId])).length > 0;
    const reads = await readsUnder(excludePrivate ? ` AND ${privateProvenanceFilterUnderPolicy('facts')}` : '');
    // GST-2346 D1: the owner speaking for itself also withdraws a fact it reads on a page its credential may write: a
    // private one the brain host wrote, or one on a page whose readers name the owner (GST-2490's owner read rule, for
    // this withdrawal only). Preparation judges the owner and the page again from the stored principal.
    const access = currentCallerAccess();
    ownerReach = ownerSpeaksForItself(ctx) && await ownerReachesFact(ctx.engine, id, sourceId, { identity: access.identity, satisfied: access.satisfiedRuleIds })
      && (reads || await readsUnder(''));
    if (!reads && !ownerReach) throw missing();
    if (!ownerReach) throw hostWithdraws();
    ownPage = null;
  }
  // The owner's withdrawal judged the fact itself (ownerReachesFact) and never reaches a copy on a page kept from remote writers.
  const worldOnly = remote && !ownerReach;
  const targetHidden = !ownerReach && excludePrivate;
  const hidePrivate = ownerReach || excludePrivate;
  // #5575 I3: a remote caller cannot forget a fact more trusted than its own writes; the owner is asked instead.
  if (remote) await guardRemoteForget(ctx.engine, { sourceId, factId: id, principal, reason, excludePrivate });
  const [source] = await ctx.engine.executeRaw<RememberSource & { role: string | null }>(
    "SELECT incarnation,archived,local_path,config->>'kind' AS kind,config->>'role' AS role FROM sources WHERE id=$1", [sourceId]);
  if (!source || source.archived) throw sourceInactive(sourceId);
  assertStorageSourceWriter(ctx, sourceId, source.role, {});
  const fact = await readForgetTarget(ctx.engine, id, sourceId, worldOnly, targetHidden, false, ownPage);
  if (!fact) throw missing();
  if (remote && supersessionGuarded('agent_written', fact.trust_tier)) {
    // guardRemoteForget reads shared facts only: a more trusted private fact the owner reaches asks the owner the same way.
    throw ownerReach ? await forgetRequiresOwner(ctx.engine, { sourceId, factId: id, principal, reason, factTier: storedTrustTier(fact.trust_tier), writerTier: 'agent_written' }) : remoteForgetRaced(id);
  }
  if (!ownPage) await refuseForgetReachingOtherCopies(ctx.engine, sourceId, fact, worldOnly, hidePrivate);
  const slug = fact.source_markdown_slug ?? fact.entity_slug ?? UNATTRIBUTED_MEMORY_SLUG;
  enforceClientSlugFence(ctx, slug, operation); enforceSubagentSlugFence(ctx, slug, operation);
  // A page the fact is about that turned private since is one this credential may not write: the brain host withdraws that fact.
  const authority = await submissionAuthority(ctx, operation, sourceId, source.incarnation, slug)
    .catch((error: unknown) => { throw ownerReach && error instanceof OperationError && error.code === 'page_not_found' ? hostWithdraws() : error; });
  if (ownerReach && !await storedOwnerSpeaksForItself(ctx.engine, authority)) throw hostWithdraws();
  const snapshot = await ctx.engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  const sandbox = ctx.viaSubagent === true && !(ctx.allowedSlugPrefixes?.length);
  // The pages a withdrawal strikes publish through the source's canonical worktree, as remember's do. A source whose
  // root has no owner refuses when a canonical file carries the claim (Git is the parent: a database-only withdrawal
  // would come back on a rebuild from Git); a claim only database-only pages carry is withdrawn database-only.
  const plan = await planFactWithdrawal(ctx.engine, id, sourceId, worldOnly, ownPage ? undefined : targetHidden, ownPage);
  // GST-2492: a fact held on a holding page for an entity with no page is struck there too (its row names the entity).
  const heldOn = isHoldingSlug(fact.source_markdown_slug) && fact.entity_slug !== null ? fact.source_markdown_slug : null;
  const struck = plan ? plan.slugs.filter(page => plan.subject === '*' || plan.subject === page || page === heldOn) : [];
  const fileBacked = struck.length > 0 && (await ctx.engine.executeRaw(
    'SELECT 1 FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL AND source_path IS NOT NULL LIMIT 1', [sourceId, struck])).length > 0;
  const target = await resolveFactWriteTarget(ctx.engine, sourceId, source, { sandbox, fileBacked, remote })
    .catch((error: unknown) => { if (!fileBacked && error instanceof OperationError) return null; throw error; });
  // Likewise with sync.write_through off or from a sandboxed subagent: the struck file would not be written, so the claim
  // would come back from Git.
  if (fileBacked && target?.kind === 'publish' && target.databaseOnlyReason === 'subagent_sandbox') {
    throw verbError('scope_denied', 'A sandboxed subagent cannot strike the claim in the page files that carry it.',
      'Forget the fact from the main session instead; nothing was withdrawn.', 'subagent_sandbox');
  }
  if (fileBacked && target?.kind === 'publish' && target.databaseOnlyReason === 'disabled_by_config') {
    throw verbError('unavailable', 'This brain has sync.write_through off, so forget cannot strike the claim in the page files that carry it.',
      'Turn write-through back on (gbrain config set sync.write_through true), then forget the fact again; nothing was withdrawn.', 'sync_write_through_off');
  }
  if (target?.kind === 'publish' && target.databaseOnlyReason) authority.databaseOnlyReason = target.databaseOnlyReason;
  const binding = target?.kind === 'unbound' ? await claimWorktree(ctx.engine, sourceId, target.root, undefined, undefined, { automatic: true })
    : target?.binding ?? null;
  // GST-359 D: a member's own-page withdrawal is recorded for that page alone and queues no semantic review.
  const row = await admitWrite(ctx.engine, { origin: ctx.admissionOrigin, principal, operation, sourceId, sourceIncarnation: source.incarnation,
    slug, pageId: snapshot?.page.id ?? null, requestId, clientRequestId, callerIntent,
    intent: { ...callerIntent, reason, semantic_review: !ownPage && p.semantic_review !== false, ...(ownPage ? { member_page: ownPage } : {}), ...(ownerReach ? { owner_reach: true } : {}) }, authority,
    worktreeId: binding?.worktree_id ?? null, topologyGeneration: binding?.topology_generation ?? null, deferrable: true });
  const written = await waitForWrite(ctx.engine, row, ctx.config, waitMs ?? ctx.writeWaitMs);
  return withSimilarActive(ctx, operation, sourceId, p, writeResponse(written));
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
      sourceId, factId, remote: ctx.remote !== false, committed, semanticReview: p.semantic_review !== false,
      excludePrivate: await resolveExcludePrivatePages(ctx.engine, ctx.remote) }) };
  } catch { return response; }
}
