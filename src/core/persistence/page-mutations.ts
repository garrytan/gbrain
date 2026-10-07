import { randomUUID } from 'node:crypto';
import { fenceNormalizedNotice, type FencesNormalized } from '../fence-repair/report.ts';
import { parseFenceRepairReceipt } from '../fence-repair/receipt.ts';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { VERSION } from '../../version.ts';
import { ownerBuildMismatch } from './publication-failure.ts';
import { enforceClientSlugFence, enforceSubagentSlugFence, normalizeSlugPrefix, parseSourceIdParam, requireWritablePage, validatePageSlug } from '../ops/context.ts';
import { suffixedSlugAdmission } from './suffixed-slug.ts';
import { defaultSlug, detectBinaryNullByte, explicitCaptureType, mergeCaptureFrontmatter, normalizeForHash } from '../capture-content.ts';
import { computeContentHash } from '../ingestion/types.ts';
import { resolveSlugForPath } from '../sync.ts';
import { scannerSlugRootMode, scannerSourcePath } from '../write-through.ts';
import { sha256 } from './digest.ts';
import { assertPersistenceAccepting, estimatedRetryAfterMs, waitForWrite, writeResponse } from './service.ts';
import { parseWireWriteWaitMs } from './write-wait.ts';
import { assertTimelineNotOmitted, isTimelineSection, timelineSectionOf, type TimelineSection } from './timeline-omission.ts';
import { admitWrite, assertPageRequestIdentity, assertReplayIntent, getWriteRequest, intentDigest, type WriteAdmission } from './journal.ts';
import { submissionAuthority, authorizeStoredRequest } from './authority.ts';
import { currentVerifiedLocalWriter, localHostId, readLocalWriter, registerLocalWriter, withVerifiedLocalRegistration } from './identity.ts';
import type { BrainEngine } from '../engine.ts';
import { claimWorktree, getWorktreeBinding, managedPersistenceEnabled } from './ownership.ts';
import { parseMutationPrecondition } from './preconditions.ts';
import { assertPurgeParams } from './purge-params.ts';
import type { Principal, WriteRequest } from './model.ts';
import { normalizeSubagentPageInput, undeclaredPageTypeWarning, type PageTypeWarning } from './page-input.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';
import { isUnboundSourcePage, readUnboundWritePolicy, unboundSourceError } from './unbound-source.ts';
import { colonSlugWindowsRefusal, isWindowsColonTarget } from './native-file-target.ts';
import { publishesDatabaseOnly } from './page-prepare.ts';
import { isMirrorOnlyPage, sourceMirrorReadOnly } from './mirror-read-only.ts';
import { isConnectorSourceKind } from './connector-identity.ts';

export async function requestPrincipalForContext(ctx: OperationContext): Promise<Principal> {
  // #5994: a failed-writes replay is admitted under the original writer.
  if (ctx.replayAuthority) return { ...ctx.replayAuthority.principal };
  if (ctx.auth?.principal) return { ...ctx.auth.principal };
  const verified = currentVerifiedLocalWriter();
  if (verified) return verified.principal;
  const lane = ctx.remote === false ? 'cli' : 'stdio';
  const local = await readLocalWriter(ctx.engine, lane);
  return { kind: lane === 'cli' ? 'local_cli' : 'local_stdio', id: local.id };
}
/** A local installation registers once; revoked records are never silently replaced. */
export async function initializeLocalPersistence(ctx: OperationContext): Promise<void> {
  if (!ctx.auth && !currentVerifiedLocalWriter()) await registerLocalWriter(ctx.engine, ctx.remote === false ? 'cli' : 'stdio');
}
const flatSql = (sql: string) => sql.replace(/\s+/g, ' ').trim();
/**
 * Pre-admission reads every page of one batch makes with the same arguments:
 * the source row, the worktree binding, the writer registration, the shared
 * skillpack roots, the persistence identity and config values. All of them
 * are rechecked under lock by the admission transaction.
 */
const BATCH_SHARED_READS = new Set([
  "SELECT incarnation,archived,local_path,config->>'kind' AS kind FROM sources WHERE id=$1",
  'SELECT s.source_id,s.source_incarnation,s.worktree_id,s.relative_path, s.topology_generation::text AS topology_generation,w.owner_host_id,w.owner_epoch::text AS owner_epoch,w.state, h.local_path,h.coordination_path FROM persistence_source_bindings s JOIN persistence_worktrees w ON w.id=s.worktree_id LEFT JOIN persistence_host_bindings h ON h.worktree_id=w.id AND h.host_id=$2::uuid WHERE s.source_id=$1',
  'SELECT lane,revoked_at,grant_ceiling FROM persistence_local_writers WHERE id=$1::uuid',
  'SELECT local_path FROM sources WHERE id=$1 AND incarnation=$2::uuid',
  'SELECT brain_id FROM persistence_brain WHERE singleton=1',
  'SELECT value FROM config WHERE key=$1',
]);
function batchSharedReads(engine: BrainEngine): BrainEngine {
  const reads = new Map<string, Promise<unknown>>();
  const once = <T>(id: string, read: () => Promise<T>): Promise<T> => {
    let value = reads.get(id) as Promise<T> | undefined;
    if (!value) { value = read(); reads.set(id, value); value.catch(() => reads.delete(id)); }
    return value;
  };
  return new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return (sql: string, params?: unknown[], opts?: { signal?: AbortSignal }) =>
      BATCH_SHARED_READS.has(flatSql(sql)) ? once(JSON.stringify([flatSql(sql), params ?? null]), () => target.executeRaw(sql, params, opts)) : target.executeRaw(sql, params, opts);
    if (key === 'getConfig') return (name: string) => once(`config:${name}`, () => target.getConfig(name));
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
/**
 * #6007: prepares one batch's page admissions under one writer verification
 * and one read snapshot. `run` gets the caller's context (for a page that may
 * claim the source's worktree) and a context whose engine answers the batch's
 * shared pre-admission reads once; the local writer is verified once for the
 * whole call instead of once per page.
 */
export async function withBatchAdmission<T>(ctx: OperationContext, run: (own: OperationContext, shared: OperationContext) => Promise<T>): Promise<T> {
  const shared: OperationContext = { ...ctx, engine: batchSharedReads(ctx.engine) };
  if (ctx.auth || currentVerifiedLocalWriter()) return run(ctx, shared);
  await initializeLocalPersistence(ctx);
  const registration = await readLocalWriter(ctx.engine, ctx.remote === false ? 'cli' : 'stdio');
  return withVerifiedLocalRegistration(ctx.engine, registration, () => run(ctx, shared));
}
/** Validate explicit routing before any admission, including dry-run adapters. */
export function pageMutationSource(ctx: OperationContext, params: Record<string, unknown>, operation: string): string {
  const sourceId = parseSourceIdParam(params.source_id, operation) ?? ctx.sourceId ?? 'default';
  if (sourceId === '__all__') {
    throw new OperationError('invalid_params', 'A mutation must target exactly one source.',
      `Pass source_id as one source (for example ${ctx.sourceId && ctx.sourceId !== '__all__' ? ctx.sourceId : 'default'}); writes never fan out across sources.`);
  }
  const granted = ctx.auth?.sourceId ?? ctx.sourceId ?? 'default';
  if (ctx.remote !== false && sourceId !== granted) {
    throw new OperationError('permission_denied', 'This source is outside the current write grant.',
      `This connection writes only to source ${granted}. Pass source_id ${granted} (or omit it), or ask the brain host's operator to grant write access to ${sourceId}.`);
  }
  return sourceId;
}
/**
 * #5622: a trusted `capture --file` path becomes a source-relative physical path
 * or 'cli-file'; the host path is never stored. Returns the slug sync would give
 * that file, so only a capture under that slug binds the file as its origin.
 */
async function resolveCaptureFile(ctx: OperationContext, sourceId: string, p: Record<string, unknown>): Promise<string | null> {
  if (Object.hasOwn(p, 'capture_path')) {
    throw new OperationError('invalid_params', 'capture_path is reserved for the capture owner.', 'Drop capture_path and pass the text as content; gbrain sets the capture path itself.');
  }
  if (p.local_file === undefined) return null;
  if (ctx.remote !== false || typeof p.local_file !== 'string' || !isAbsolute(p.local_file)) {
    throw new OperationError('invalid_params', 'Capture file paths are accepted only from the trusted local CLI.',
      'Read the file yourself and pass its content; file capture runs through the gbrain capture command on the brain host.');
  }
  const file = p.local_file;
  delete p.local_file;
  const [source] = await ctx.engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [sourceId]);
  const binding = await getWorktreeBinding(ctx.engine, sourceId);
  const root = binding ? binding.owner_host_id === localHostId() && binding.local_path ? join(binding.local_path, binding.relative_path) : null
    : source?.local_path || (sourceId === 'default' ? await ctx.engine.getConfig('sync.repo_path') : null);
  let origin: string | null = null;
  try { if (root) origin = relative(realpathSync(root), realpathSync(file)); } catch { /* unreadable or absent root */ }
  if (!root || !origin || isAbsolute(origin) || origin === '..' || origin.startsWith(`..${sep}`) || !/\.mdx?$/i.test(origin)) {
    p.source_uri = 'cli-file';
    return null;
  }
  const capturePath = origin.split(sep).join('/');
  p.capture_path = capturePath;
  const canonicalRoot = realpathSync(root);
  return resolveSlugForPath(scannerSourcePath(canonicalRoot, join(canonicalRoot, capturePath), await scannerSlugRootMode(ctx.engine, sourceId, canonicalRoot)));
}

function pendingAwareResponse(ctx: OperationContext, row: WriteRequest): Record<string, unknown> {
  try { return writeResponse(row, { retryAfterMs: estimatedRetryAfterMs(ctx.engine, 1) }); } catch (error) {
    // #5929: a trusted local caller is told when an owner on another build ran the failed attempt.
    const mismatch = ctx.remote === false ? ownerBuildMismatch(row.error_detail, VERSION) : null;
    if (mismatch && error instanceof OperationError) { error.why = mismatch.why; error.fix = mismatch.fix; }
    throw error;
  }
}

/** #6188 (D21): a write whose fence Tier 1 rewrote carries one `fence_normalized` coaching notice. */
export function emitFenceNotice(ctx: Pick<OperationContext, 'emitNotice'>, response: Record<string, unknown>, slug?: string): void {
  const report = response.fences_normalized as FencesNormalized | undefined;
  if (report) ctx.emitNotice?.(fenceNormalizedNotice(report, slug));
}

/** Owner-internal `put_page` kinds the trusted local file writers (import, frontmatter repair) submit; every other caller is refused them. */
const OWNER_FILE_INTENTS: ReadonlySet<string> = new Set(['managed_file_import', 'managed_file_repair']);

/** #6007: a `put_pages` child: its batch, its position and the batch size are part of its identity. */
export interface PageBatchMember { id: string; index: number; size: number; requestId: string }

export async function submitPageMutation(ctx: OperationContext,
  input: { operation: string; params: Record<string, unknown>; waitMs?: number; managedFileImport?: true; timelineSection?: TimelineSection }): Promise<Record<string, unknown>> {
  assertPersistenceAccepting(ctx.engine);
  // #6007: wait_ms is a reply deadline from arrival, never part of the write's identity.
  const arrived = performance.now();
  const { wait_ms: wireWait, ...params } = input.params;
  const wireWaitMs = parseWireWriteWaitMs(wireWait);
  const waitMs = () => wireWaitMs !== undefined ? Math.max(0, wireWaitMs - (performance.now() - arrived)) : input.waitMs ?? ctx.writeWaitMs;
  const prepared = await preparePageAdmission(ctx, { ...input, params });
  if (prepared.prior) return pendingAwareResponse(ctx, await waitForWrite(ctx.engine, prepared.prior, ctx.config, waitMs()));
  const row = await admitWrite(ctx.engine, prepared.admission);
  const response = pendingAwareResponse(ctx, await waitForWrite(ctx.engine, row, ctx.config, waitMs()));
  emitFenceNotice(ctx, response, row.slug);
  return { ...response, ...(prepared.typeWarning ? { type_warning: prepared.typeWarning } : {}), ...(prepared.slugAdvisory ? { slug_advisory: prepared.slugAdvisory } : {}) };
}

/**
 * Every check a page mutation passes before it is journaled, without admitting
 * it: either the authorized prior request with this request_id (a replay), or
 * the admission to submit. `put_pages` admits several of these together.
 */
export async function preparePageAdmission(ctx: OperationContext,
  input: { operation: string; params: Record<string, unknown>; managedFileImport?: true; batch?: PageBatchMember; timelineSection?: TimelineSection }
): Promise<{ prior: WriteRequest; admission?: undefined; typeWarning?: undefined; slugAdvisory?: undefined } | { prior?: undefined; admission: WriteAdmission; typeWarning: PageTypeWarning | null; slugAdvisory: string | null }> {
  if (input.operation === 'put_page' && ['kind', 'preview', 'backup_reference'].some(key => Object.hasOwn(input.params, key))) {
    if (ctx.remote !== false || input.managedFileImport !== true || !OWNER_FILE_INTENTS.has(String(input.params.kind)) ||
      ['preview', 'backup_reference'].some(key => Object.hasOwn(input.params, key))) {
      throw new OperationError('invalid_params', 'Reserved persistence fields cannot be submitted through put_page. Use trusted local reconciliation administration.',
        'Drop kind, preview and backup_reference from put_page; reconciling a canonical file runs through gbrain sources reconcile on the brain host.');
    }
  }
  // #6188: a fence repair's receipt is recorded only by the trusted local fence repair, never by a caller.
  if (Object.hasOwn(input.params, 'fence_repair') && (input.operation !== 'put_page' || ctx.remote !== false || !parseFenceRepairReceipt(input.params.fence_repair))) {
    throw new OperationError('invalid_params', 'fence_repair is reserved for the trusted fence repair.',
      'Drop fence_repair and submit the page without it; gbrain repair fences records its own receipt on the brain host. To fix a malformed facts or takes fence, correct it in content (or write facts with remember and takes with takes_add); a held file is repaired by the brain host operator with gbrain repair fences, so ask the user to run it.');
  }
  const { page_batch: _forged, timeline_section: _section, ...params } = input.params;
  const p: Record<string, unknown> = { ...params, ...parseMutationPrecondition(params) };
  if (input.batch) p.page_batch = { id: input.batch.id, index: input.batch.index, size: input.batch.size };
  const requestId = input.batch ? input.batch.requestId : typeof p.request_id === 'string' ? p.request_id : randomUUID();
  const sourceId = pageMutationSource(ctx, p, input.operation);
  await initializeLocalPersistence(ctx);
  const captureSlug = input.operation === 'capture' ? await resolveCaptureFile(ctx, sourceId, p) : null;
  const principal = await requestPrincipalForContext(ctx);
  await assertPageRequestIdentity(ctx.engine, principal, requestId);
  const prior = await getWriteRequest(ctx.engine, principal, requestId);
  const callerIntent = { ...p };
  delete callerIntent.request_id;
  if (prior) {
    await submissionAuthority(ctx, prior.operation, prior.source_id, prior.source_incarnation, prior.slug);
    await authorizeStoredRequest(ctx.engine, prior);
    assertReplayIntent(prior, intentDigest({ operation: input.operation, sourceId, slug: prior.slug, callerIntent }));
    return { prior };
  }
  if (input.operation === 'delete_page') assertPurgeParams(p, ctx.remote);
  const [source] = await ctx.engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null; kind: string | null }>(
    "SELECT incarnation,archived,local_path,config->>'kind' AS kind FROM sources WHERE id=$1", [sourceId]);
  if (!source || source.archived) {
    throw new OperationError('source_changed', 'The write source is not active.',
      `Source ${sourceId} is archived or not registered, so nothing was written. Write to an active source (sources_list shows them).`);
  }
  let slug = typeof p.slug === 'string' ? p.slug.toLowerCase() : '';
  const intent = ['takes_add','takes_update','takes_supersede','takes_resolve','takes_remove'].includes(input.operation)
    ? await (await import('./takes-prepare.ts')).normalizeTakesIntent(ctx,p) : { ...p };
  delete intent.request_id;
  // #5969 (D3): read before normalization; a replay carries the section its first admission read.
  if (input.operation === 'put_page' && input.managedFileImport !== true && p.kind === undefined && typeof p.content === 'string') {
    intent.timeline_section = isTimelineSection(input.timelineSection) ? input.timelineSection : timelineSectionOf(p.content, slug);
  }
  if (input.operation === 'put_page') await normalizeSubagentPageInput(ctx, intent);
  const typeWarning = input.operation === 'put_page' && input.managedFileImport !== true
    ? await undeclaredPageTypeWarning(ctx, { ...intent, slug }, sourceId) : null;
  if (input.operation === 'capture') {
    if (typeof p.content !== 'string' || !normalizeForHash(p.content) || detectBinaryNullByte(Buffer.from(p.content)) !== -1) {
      throw new OperationError('invalid_params', 'Capture requires nonempty text without binary NUL bytes.',
        'Pass content as non-empty text; binary files are not captured (store them with file_upload instead).');
    }
    const explicitType = explicitCaptureType(p.content, typeof p.type === 'string' ? p.type : undefined);
    if (explicitType) {
      const { loadActivePackForWriteVocabulary, packDeclaresPageType, undeclaredPageTypeMessage, undeclaredPageTypeSuggestion } = await import('../schema-pack/write-vocabulary.ts');
      const pack = await loadActivePackForWriteVocabulary(ctx);
      if (pack && !packDeclaresPageType(pack, explicitType)) throw new OperationError('invalid_params', undeclaredPageTypeMessage(explicitType, pack, 'capture'), undeclaredPageTypeSuggestion(pack));
    }
    const type = explicitType ?? 'note';
    if (!slug) {
      slug = defaultSlug(normalizeForHash(p.content), new Date(), type);
      if (ctx.auth?.boundSlugPrefixes?.length) slug = `${normalizeSlugPrefix(ctx.auth.boundSlugPrefixes[0]).replace(/\/$/, '')}/${slug}`;
    }
    intent.content = mergeCaptureFrontmatter(p.content, { type, capturedVia: ctx.remote === false ? 'capture-cli' : 'capture-mcp',
      ...Object.fromEntries(['who','what','where','kind','depth'].filter(key => typeof p[key] === 'string').map(key => [key, p[key]])) });
    intent.capture_hash = computeContentHash(normalizeForHash(p.content));
    // Only a file whose own path names this slug can be the page's origin; sync keys origins by path.
    if (typeof intent.capture_path === 'string' && captureSlug !== slug) {
      delete intent.capture_path;
      intent.source_uri = 'cli-file';
    }
    if (typeof intent.capture_path === 'string') intent.capture_file_hash = sha256(p.content);
  }
  validatePageSlug(slug);
  enforceClientSlugFence(ctx, slug, input.operation);
  enforceSubagentSlugFence(ctx, slug, input.operation);
  // Preserve same-source diagnostics for new timeline writes without making
  // terminal replay depend on a page that may have since been purged.
  if (input.operation === 'add_timeline_entry') await requireWritablePage({ ...ctx, sourceId }, slug, input.operation, 'page');
  intent.slug = slug;
  if (ctx.remote !== false) Object.assign(intent, { source_kind: `mcp:${input.operation}`, source_uri: null, ingested_via: `mcp:${input.operation}` });
  const authority = await submissionAuthority(ctx, input.operation, sourceId, source.incarnation, slug);
  await assertKnowledgePublicationAllowed(ctx.engine, { source_id: sourceId, source_incarnation: source.incarnation, slug });
  const snapshot = await ctx.engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  if (typeof intent.content === 'string' && (typeof p.expected_revision !== 'string' || p.expected_revision === snapshot?.revision)) {
    await assertTimelineNotOmitted(ctx.engine, { intent, remote: ctx.remote !== false, writer: typeof p.expected_revision === 'string' ? 'editing' : 'preserving',
      slug, sourceId, content: intent.content, prior: snapshot });
  }
  const slugAdvisory = input.operation === 'put_page' && input.managedFileImport !== true
    ? suffixedSlugAdmission(ctx, slug, !!snapshot && !snapshot.page.deleted_at) : null;
  // #5616: typed edit refusals before admission; publication repeats them on the locked snapshot.
  if (input.operation === 'edit_page') {
    const { applyPageEdits, assertEditRevision, parsePageEdits } = await import('./page-edit.ts');
    if (!snapshot || snapshot.page.deleted_at) throw new OperationError('page_not_found', `Page not found: ${slug}`, 'edit_page changes an existing page; create it with put_page.');
    assertEditRevision(snapshot.revision, p.expected_revision);
    applyPageEdits(snapshot.page, snapshot.tags, ctx.remote !== false, parsePageEdits(p.edits));
  }
  let binding = await getWorktreeBinding(ctx.engine, sourceId);
  const sandbox = ctx.viaSubagent === true && !(ctx.allowedSlugPrefixes?.length);
  const configuredWriteThrough = !/^(false|0|off|no)$/i.test(await ctx.engine.getConfig('sync.write_through') ?? 'true');
  const writeThrough = configuredWriteThrough && !sandbox;
  const root = source.local_path || (sourceId === 'default' ? await ctx.engine.getConfig('sync.repo_path') : null);
  if (sandbox) authority.databaseOnlyReason = 'subagent_sandbox';
  else if (!configuredWriteThrough) authority.databaseOnlyReason = 'disabled_by_config';
  else if (!root && !binding) authority.databaseOnlyReason = 'no_repo_configured';
  if (p.local_dir !== undefined) {
    // Checkout paths belong to a host binding; sources.local_path may name
    // another host's original checkout after a verified ownership transfer.
    const localRoot = binding ? binding.owner_host_id === localHostId() && binding.local_path
      ? join(binding.local_path, binding.relative_path) : null : root;
    let matches = false;
    if (ctx.remote === false && typeof p.local_dir === 'string' && localRoot) {
      try { matches = realpathSync(resolve(p.local_dir)) === realpathSync(resolve(localRoot)); } catch { /* missing local binding */ }
    }
    if (!matches) throw new OperationError('invalid_params', 'The CLI directory must match the selected source canonical root.',
      'Register the source canonical path, then omit --dir or use that same path.');
  }
  // A connector source without a canonical owner is database-only by design
  // (connector_database): a page write never claims it or refuses as unbound.
  if (writeThrough && root && !binding && isConnectorSourceKind(source.kind)) authority.databaseOnlyReason = 'connector_database';
  else if (writeThrough && root && !binding) {
    if (ctx.engine.kind === 'pglite') binding = await claimWorktree(ctx.engine, sourceId, root, undefined, undefined, { automatic: true });
    else {
      // #5393: the opt-in covers every page mutation whose target has no
      // recorded canonical file; a revert is also judged on the version it writes.
      const fileBacked = Boolean(snapshot?.page.source_path) || (input.operation === 'revert_version' && snapshot
        && (await ctx.engine.executeRaw<{ source_path: string | null }>('SELECT source_path FROM page_versions WHERE id=$1 AND page_id=$2',
          [p.version_id, snapshot.page.id]))[0]?.source_path);
      if (fileBacked || await readUnboundWritePolicy(ctx.engine) !== 'database_only') {
        throw unboundSourceError(sourceId, ctx.remote === false ? root : null, fileBacked ? 'file_backed' : 'database_only_eligible', !await managedPersistenceEnabled(ctx.engine));
      }
      authority.databaseOnlyReason = 'unbound_source';
    }
  }
  // #5032: this host publishes the canonical file, and on Windows a ':' in its
  // name cannot be stored; refuse before admission. Database-only writes pass,
  // including read-only mirror sources and pages created while one (#5409).
  if (writeThrough && binding?.owner_host_id === localHostId() && binding.local_path && isWindowsColonTarget(snapshot?.page.source_path ?? `${slug}.md`)
    && !(snapshot && !snapshot.page.source_path && await isUnboundSourcePage(ctx.engine, sourceId, slug))
    && !await sourceMirrorReadOnly(ctx.engine, sourceId)
    && !(snapshot && !snapshot.page.source_path && await isMirrorOnlyPage(ctx.engine, sourceId, slug))
    && !publishesDatabaseOnly(join(binding.local_path, binding.relative_path), slug, snapshot)) {
    throw colonSlugWindowsRefusal(slug, sourceId);
  }
  return { typeWarning, slugAdvisory, admission: { principal, operation: input.operation, sourceId, sourceIncarnation: source.incarnation,
    slug, pageId: snapshot?.page.id ?? null, requestId, callerIntent, intent, authority,
    ...(input.operation === 'edit_page' ? { terminalReservation: Math.max(16_384, Buffer.byteLength(JSON.stringify(authority)) + 8192)
      + (await import('./page-edit.ts')).EDIT_PAGE_RECEIPT_RESERVE } : {}),
    worktreeId: writeThrough ? binding?.worktree_id : null, topologyGeneration: writeThrough ? binding?.topology_generation : null } };
}
