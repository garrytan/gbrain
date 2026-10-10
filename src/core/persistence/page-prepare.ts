import { isEmbedSkipped } from '../embed-skip.ts';
import { enterClaimStep, type ClaimPhaseClock } from './claim-phase.ts';
import { boundedReads } from './bounded-reads.ts';
import { isQuarantined, quarantineOutcome } from '../quarantine.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { Page, PageVersion } from '../types.ts';
import { importFromContent, verifyPageReadable, type ParsedPage } from '../import-file.ts';
import { frontmatterHoldMessageWithoutKeys, parseMarkdown, resolveParsedSubtype, serializePageToMarkdown, resolveSourceLocalFilePath, type ParseOpts } from '../markdown.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { isOpPageSlug } from '../ops/context.ts';
import { shellQuote, type Action } from '../agent-output.ts';
import type { RegistryCode } from '../error-registry.ts';
import { pageIdentityError } from './page-identity.ts';
import { contentRefusalError } from '../import-screen.ts';
import { ContentSanityBlockError } from '../content-sanity.ts';
import { assertPageRevision, type PageSnapshot } from '../page-state/types.ts';
import { gitHoldFix, readGitHold } from './sync-holds.ts';
import { hostOperatorFix, recordRoute } from './held-reads.ts';
import { heldFileMessage } from './verb-errors.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { recordedPathFromFileUri, scannerSlugRootMode, scannerSourcePath } from '../write-through.ts';
import { engineMutationPrecondition, parseMutationPrecondition } from './preconditions.ts';
import { assertPurgeParams } from './purge-params.ts';
import { authorizeWrite } from './authority.ts';
import { digest, sha256 } from './digest.ts';
import { getWorktreeBinding } from './ownership.ts';
import type { PreparedContentImport } from './prepared-import.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { SqlEngine, WriteRequest } from './model.ts';
import { isUnboundSourcePage } from './unbound-source.ts';
import { sealPageTextProjection } from '../page-state/projections.ts';
import { pipelined } from '../page-state/transactions.ts';
import { overlayCanonicalBodies } from '../page-state/snapshot.ts';
import { materializeTimeline, prepareCanonicalProjections, type TimelineRowsRemoved } from './canonical-projections.ts';
import { assertTimelineNotOmitted, timelineWritePolicy } from './timeline-omission.ts';
import { preserveProtectedTakes } from './protected-takes.ts';
import { isAutoLinkEnabled } from '../link-extraction.ts';
import { prepareAutomaticLinks } from './links-preparation.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { preparePageAdvisories, remoteLinkHint, pageNoopAdvisories, timelineRowsRemovedAdvisory } from './page-advisories.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';
import { colonSlugWindowsRefusal, isWindowsColonTarget, nativeFileTarget } from './native-file-target.ts';
import { isSourceDbOnlySlug } from './source-storage.ts';
import { isMirrorOnlyPage, sourceMirrorReadOnly } from './mirror-read-only.ts';
import { DERIVE_PHASE_DB_ONLY_DEFAULTS } from '../storage-config.ts';
import { SOURCE_CONFIG_OBJECT_SQL } from '../source-config-sql.ts';
import { readSlugRootMode } from '../sync-anchor.ts';
import { applyPageEdits, editDiff, parsePageEdits } from './page-edit.ts';
import { carryCoreMarking, prepareCoreGuard } from './core-guard.ts';
import { fenceWhere } from '../fence-repair/refusal.ts';
import { pageFencesNormalized } from '../fence-repair/report.ts';
import { parseFenceRepairReceipt } from '../fence-repair/receipt.ts';
import { fenceRepairCommit } from './effect-model.ts';
import { purgePageInTransaction } from './page-purge.ts';
import { withTrustKeep } from './context.ts';
import { isFenceEditWrite, pageGateTrust, pageWriteTrust, recordAgentPageLowering, stampPageTrustMarker, storedPageTier } from '../trust/page-write.ts';
import { suppliedTrustMarkerView } from '../trust/channel.ts';
import { gateField, gateInput } from '../trust/gate-outcomes.ts';


const ownerStatusFix = (sourceId: string): Action => readFix(`Shows source ${sourceId}'s canonical owner with its pending, failed and recovering requests, read-only.`,
  { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });
const pageFix = (sourceId: string, slug: string): Action => readFix(`Shows page ${slug} in source ${sourceId} as it is now, with its revision.`,
  { argv: ['gbrain', 'get', '--source', sourceId, '--', slug], mcp: { tool: 'get_page', arguments: { slug, source_id: sourceId } } });

/**
 * A refused page request. The journal keeps only code and message, so the
 * suggestion stands alone: the cause and next step, then the request to
 * inspect before anything is resubmitted.
 */
function pageRefusal(code: RegistryCode, message: string, row: WriteRequest, cause: string, fix?: Action): OperationError {
  return opError(code, message,
    `${cause} Request ${row.request_id} in source ${row.source_id} was refused; inspect it before resubmitting, and use a new request_id for any corrected write.`,
    { fix: fix ?? (row.principal_kind === 'local_cli'
      ? readFix(`Reads request ${row.request_id}'s durable receipt: its state and recorded error, read-only.`, { argv: ['gbrain', 'write-request', '--', row.request_id] })
      : ownerStatusFix(row.source_id)) });
}

/** The parser trims titles, so a stored title differing only in surrounding whitespace is not drift (#5635). */
function canonical(page: Pick<Page, 'type' | 'title' | 'compiled_truth' | 'timeline' | 'frontmatter'>, tags: string[]) {
  return { type: page.type, title: page.title.trim(), compiled_truth: page.compiled_truth, timeline: page.timeline ?? '',
    frontmatter: page.frontmatter, tags: [...new Set(tags)].sort() };
}
interface CanonicalProvenance { source_kind: string; ingested_via: string; ingested_at: string; }
/** Canonical stamps belong to the first write, never to a later preparation attempt. */
function putProvenance(row: WriteRequest, snapshot: PageSnapshot | null, parsed: ParsedPage): CanonicalProvenance | undefined {
  if (row.operation !== 'put_page' || !row.worktree_id) return undefined;
  const keys = ['source_kind', 'ingested_via', 'ingested_at'] as const;
  for (const key of keys) {
    delete parsed.frontmatter[key];
    if (snapshot?.page.frontmatter[key] !== undefined) parsed.frontmatter[key] = snapshot.page.frontmatter[key];
  }
  const tags = [...new Set([...(snapshot?.tags ?? []), ...parsed.tags])].sort();
  if (snapshot && !snapshot.page.deleted_at && digest(canonical(snapshot.page, snapshot.tags)) === digest(canonical(parsed, tags))) {
    return undefined;
  }
  const string = (value: unknown) => typeof value === 'string' && value ? value : undefined;
  const first = snapshot?.page;
  const via = row.authority.remote ? 'mcp:put_page' : 'put_page';
  // Historical frontmatter was caller-controlled. Only trusted provenance
  // columns may supply a prior channel or timestamp for the first-write record.
  const stamp: CanonicalProvenance = {
    source_kind: string(first?.source_kind) ?? string(row.intent?.source_kind) ?? via,
    ingested_via: string(first?.ingested_via) ?? string(row.intent?.ingested_via) ?? via,
    ingested_at: new Date(first?.ingested_at ?? row.created_at).toISOString(),
  };
  Object.assign(parsed.frontmatter, stamp);
  return stamp;
}
/** A derive-phase page (DERIVE_PHASE_DB_ONLY_DEFAULTS) that never recorded a canonical file. */
function isNeverFiledDerivedPage(slug: string, page: { source_path?: string | null; source_uri?: string | null }): boolean {
  return !page.source_path && !page.source_uri && DERIVE_PHASE_DB_ONLY_DEFAULTS.some(prefix => slug.startsWith(prefix));
}
/**
 * A live page whose canonical file is absent publishes to the database only
 * when its slug is a declared db_only path or a never-filed derive-phase page.
 */
export function publishesDatabaseOnly(root: string, slug: string, snapshot: PageSnapshot | null): boolean {
  if (!snapshot || snapshot.page.deleted_at) return false;
  return isSourceDbOnlySlug(root, slug, 'refuse') || isNeverFiledDerivedPage(slug, snapshot.page);
}
/**
 * Whether file bytes hold the snapshot's page: the canonical (format-insensitive)
 * comparison prepareFileTarget applies before replacing a canonical file. Lint
 * uses it to bind a repair to the revision it read before reading the file.
 */
export async function fileMatchesSnapshot(engine: BrainEngine, slug: string, bytes: string, snapshot: PageSnapshot,
  activePack?: ParseOpts['activePack']): Promise<boolean> {
  const parsed = parseMarkdown(bytes, slug, { activePack });
  // #5521 parity for subtype (#5928): a pack rule is not part of the file's bytes, so a file
  // without an explicit `subtype:` keeps the stored subtype (or none); the import still stamps it.
  delete parsed.inferredSubtype;
  resolveParsedSubtype(parsed, snapshot.page);
  // #1035 parity (#5521): a file without an explicit `type:` keeps the stored type on import.
  const type = parsed.typeExplicit ? parsed.type : snapshot.page.type;
  // Withdrawal overlays intentionally precede physical mirroring. The ledger
  // is applied by the import preparation and cannot be undone by this check.
  const actual = canonical({ ...parsed, type, ...await overlayCanonicalBodies(engine.executeRaw.bind(engine),
    parsed.compiled_truth, parsed.timeline ?? '', snapshot.withdrawals) }, parsed.tags);
  return digest(actual) === digest(canonical(snapshot.page, snapshot.tags));
}
export async function prepareFileTarget(engine: BrainEngine, row: Pick<WriteRequest, 'source_id' | 'worktree_id' | 'slug'>, snapshot: PageSnapshot | null,
  content: string | null, hostId?: string, options: { allowMissing?: boolean; deleting?: boolean; capture?: { path: string; hash: string }; activePack?: ParseOpts['activePack']; remote?: boolean } = {}): Promise<PreparedMutation['file']> {
  if (!row.worktree_id) return undefined;
  // #6212: a legacy slug (admitted only to delete or restore its existing row) never owns a file: its recorded
  // source_uri or source_path may name the file of another page, such as the one sync now slugs it to.
  if (!isOpPageSlug(row.slug)) return undefined;
  // #5409: a read-only mirror's checkout belongs to its Git remote; nothing is written or removed there.
  if (await sourceMirrorReadOnly(engine, row.source_id)) return undefined;
  if (snapshot && !snapshot.page.source_path && await isMirrorOnlyPage(engine, row.source_id, row.slug)) return undefined;
  // #5254: a page written while its source was unbound stays database-only in
  // every state (live, tombstone, restore, revert, delete, purge); any file at
  // its derived path is not its canonical file and is neither written nor removed.
  if (snapshot && !snapshot.page.source_path && await isUnboundSourcePage(engine, row.source_id, row.slug)) return undefined;
  const binding = await getWorktreeBinding(engine, row.source_id, hostId);
  if (!binding?.local_path) throw opError('owner_unavailable', 'The canonical worktree is unavailable on this host.',
    `This host does not hold source ${row.source_id}'s canonical worktree (or it has no local path), so the file of ${row.slug} was not written. Inspect the owner before resubmitting; the write publishes on the host that owns the source.`,
    { fix: ownerStatusFix(row.source_id) });
  const root = join(binding.local_path, binding.relative_path);
  // #5622: a new page captured from a file inside the source is published to that file.
  const capturedPath = !snapshot && options.capture ? options.capture.path : recordedPathFromFileUri(snapshot?.page.source_uri, root);
  const mode = snapshot?.page.source_path ? await scannerSlugRootMode(engine, row.source_id, root) : undefined;
  const candidate = resolveSourceLocalFilePath(root, snapshot?.page.source_path, row.slug, mode)
    ?? (capturedPath ? join(root, capturedPath) : join(root, `${row.slug}.md`));
  if (isWindowsColonTarget(relative(root, candidate))) {
    if (!options.allowMissing && publishesDatabaseOnly(root, row.slug, snapshot)) return undefined;
    throw colonSlugWindowsRefusal(row.slug, row.source_id);
  }
  const path = nativeFileTarget(root, candidate);
  if (!isWriteTargetContained(path, root)) throw opError('source_changed', 'The canonical file target is outside its registered source.',
    `The file of ${row.slug} resolves outside source ${row.source_id}'s registered root (a symlinked directory or a moved checkout), so nothing was written. Inspect the owner before resubmitting; how to repair the checkout is the user's decision.`,
    { fix: ownerStatusFix(row.source_id) });
  const before = existsSync(path) ? readFileSync(path) : null;
  if (!before && snapshot && !snapshot.page.deleted_at && !options.allowMissing) {
    // A declared db_only page has no canonical file by design and publishes to
    // the database only. gbrain.yml is consulted only here, where the write
    // would otherwise refuse, so an invalid config can only change the refusal.
    // Derive-phase output (atoms/, concepts/, ...) is database-only by design and
    // deliberately never declared in gbrain.yml. A page there that never recorded a
    // canonical file publishes to the database only; a recorded file that went
    // missing still refuses below.
    if (publishesDatabaseOnly(root, row.slug, snapshot)) return undefined;
    if (options.deleting === true && content === null && !snapshot.page.source_path && !capturedPath) return undefined;
    throw new OperationError('source_changed', 'The canonical file was removed outside coordinated publication.',
      'Import the local deletion or recover the canonical file before editing this page.');
  }
  // A normal edit may replace only the bytes represented by its read snapshot.
  // Unknown local edits require explicit import/recovery, even for force writes.
  if (before && snapshot) {
    if (!await fileMatchesSnapshot(engine, row.slug, before.toString('utf8'), snapshot, options.activePack)) {
      const held = await heldFileRefusal(engine, row, root, path, 'drift', options.remote === true);
      if (held) throw held;
      throw opError('source_changed', 'The canonical file contains an uncoordinated local edit.',
        `On the brain host, run gbrain sources reconcile ${row.source_id} ${row.slug} --brain <brain id, host by default> --preview, review and apply the resolved preview, then retry this write with a new request_id. Neither copy was overwritten.`,
        { detail: 'file_database_drift', fix: readFix(`Previews how page ${row.slug}'s canonical file and database copy reconcile; a preview never changes canonical content.`,
          { argv: ['gbrain', 'sources', 'reconcile', row.source_id, row.slug, '--brain', 'host', '--preview'] }) });
    }
  } else if (before && !snapshot && content !== null && sha256(before) !== sha256(content)
    && !(options.capture && sha256(before) === options.capture.hash)) {
    throw await heldFileRefusal(engine, row, root, path, 'occupied', options.remote === true)
      ?? new OperationError('source_changed', 'An unindexed file already occupies the canonical page path.', 'Import the file before replacing it.');
  }
  return { path, root, content, expectedBeforeHash: before ? sha256(before) : null };
}

/**
 * #5988: a drift or occupied-path refusal whose file sync holds names the hold
 * instead of reconciliation: the page stays read-only for put_page until the
 * file is repaired. Two point reads, only when the refusal already fires.
 */
async function heldFileRefusal(engine: BrainEngine, row: Pick<WriteRequest, 'source_id' | 'slug'>, root: string, path: string,
  kind: 'drift' | 'occupied', remote: boolean): Promise<OperationError | null> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [row.source_id]);
  const hold = source ? await readGitHold(engine, row.source_id, source.incarnation, relative(root, path).split(sep).join('/')) : null;
  if (!hold) return null;
  const effect = kind === 'drift' ? `page ${row.slug} keeps its last good revision and` : `page ${row.slug} does not exist yet and its path`;
  if (remote) {
    // Remote callers get the code and the host operator's command, never the held path or key.
    const error = opError('source_changed', heldFileMessage(kind, hold.code),
      `Sync holds this page's canonical file in source ${row.source_id} (${hold.code}${hold.meta.reason ? `, ${hold.meta.reason}` : ''}) because gbrain cannot import it, `
      + `so ${effect} is read-only for put_page until the brain host operator repairs the file; retrying this write refuses the same way. Relay the fix to the user, then submit the intended write with a new request_id. Neither copy was overwritten.`,
      { fix: hostOperatorFix([{ source_id: row.source_id, route: recordRoute(hold) }], `The canonical file of page ${row.slug} is held (${hold.code}): only the brain host operator can inspect and repair it.`) });
    if (kind === 'drift') error.detail = 'file_database_drift';
    return error;
  }
  const fix = gitHoldFix(hold);
  const where = [hold.meta.line !== undefined ? `line ${hold.meta.line}` : '', hold.meta.key ? `key "${hold.meta.key}"` : ''].filter(Boolean).join(', ');
  const error = opError('source_changed', heldFileMessage(kind, hold.code),
    `Sync holds ${hold.path} in source ${row.source_id} (${hold.code}${hold.meta.reason ? `, ${hold.meta.reason}` : ''}${where ? ` at ${where}` : ''}) because gbrain cannot import it, `
    + `so ${effect} is read-only for put_page until the file is repaired; retrying this write refuses the same way. `
    + `Repair the file first (${shellQuote(fix.argv ?? [])}: ${fix.why}), then submit the intended write with a new request_id. Neither copy was overwritten.`, { fix });
  if (kind === 'drift') error.detail = 'file_database_drift';
  return error;
}

/**
 * Receipt reason for a page write that publishes no file. Invariant: for a
 * bound row, prepareFileTarget returns no target only for a live declared
 * db_only page whose file is absent, a page of a read-only mirror source
 * (#5409), or a page written while its source was unbound (#5254) in any state; every other case returns a target or throws.
 */
export function databaseOnlyPublication(row: Pick<WriteRequest, 'worktree_id'>, file: PreparedMutation['file']): Pick<PreparedMutation, 'databaseOnlyReason'> {
  return row.worktree_id && !file ? { databaseOnlyReason: 'db_only' } : {};
}
async function pageDatabaseOnlyPublication(engine: SqlEngine, row: WriteRequest, file: PreparedMutation['file']): Promise<Pick<PreparedMutation, 'databaseOnlyReason'>> {
  const reason = databaseOnlyPublication(row, file);
  if (reason.databaseOnlyReason && (await sourceMirrorReadOnly(engine, row.source_id) || await isMirrorOnlyPage(engine, row.source_id, row.slug))) {
    return { databaseOnlyReason: 'mirror_read_only' };
  }
  return reason.databaseOnlyReason && await isUnboundSourcePage(engine, row.source_id, row.slug) ? { databaseOnlyReason: 'unbound_source' } : reason;
}

/**
 * Providers and parsing run before the OS lock and before any publication transaction.
 * `coordinated`: the caller publishes this mutation itself through the coordinator, whose
 * page guard and revision check on `row.slug` cover this import (the put_page apply diet).
 */
/**
 * `options.clock` (#6278): the claim's phase clock; each await boundary names its step through `enterClaimStep`, and the
 * preparation's raw reads run bounded by its remaining budget (`boundedReads`; a statement carrying the foreground `signal` keeps it).
 */
export async function preparePageMutation(unbounded: BrainEngine, row: WriteRequest, _config: GBrainConfig,
  preparedIntent?: { content: string; expectedRevision: string; tags?: string[] }, signal?: AbortSignal,
  options: { allowMissingFile?: boolean; coordinated?: boolean; clock?: ClaimPhaseClock } = {}): Promise<PreparedMutation> {
  signal?.throwIfAborted();
  const clock = options.clock;
  const engine = boundedReads(unbounded, clock);
  enterClaimStep(clock, 'page_snapshot', undefined, 'db');
  if (!row.intent) throw pageRefusal('storage_error', 'A pending write lost its normalized intent.', row,
    `The request has no stored intent for ${row.slug} (its payload was compacted or never recorded), so it cannot be published and wrote nothing.`);
  const p = row.intent;
  const source = { sourceId: row.source_id };
  // A coordinated (single-write) preparation sends its independent reads together; the first refusal in this order is reported.
  const together = options.coordinated ? engine : { kind: 'sequential' };
  const [, snapshot, pack] = await pipelined(together, [
    () => assertKnowledgePublicationAllowed(engine, row),
    () => engine.readPageSnapshot(row.slug, { ...source, includeDeleted: true }),
    () => loadActivePackForEngine(engine, { remote: row.authority.remote, sourceId: row.source_id }).catch(() => null),
  ]) as [unknown, PageSnapshot | null, Awaited<ReturnType<typeof loadActivePackForEngine>> | null];
  signal?.throwIfAborted();
  enterClaimStep(clock, 'revision_check');
  assertPageRevision(snapshot, preparedIntent ? { expectedRevision: preparedIntent.expectedRevision } : engineMutationPrecondition(parseMutationPrecondition(p)));
  if ((snapshot?.page.id ?? null) !== row.page_id) throw pageIdentityError(snapshot != null || row.page_id === null, 'The accepted page identity changed.');
  const observedRevision = snapshot?.revision ?? null;
  const activePack = pack?.manifest;
  if (row.operation === 'put_page' && p.allow_empty !== true && snapshot && !snapshot.page.deleted_at
    && typeof p.content === 'string' && `${snapshot.page.compiled_truth}\n${snapshot.page.timeline ?? ''}`.trim()) {
    const incoming = parseMarkdown(p.content, row.slug, { activePack });
    if (!`${incoming.compiled_truth}\n${incoming.timeline ?? ''}`.trim()) {
      throw new OperationError('invalid_params', `Refusing to overwrite existing non-empty page '${row.slug}' with empty content. Use capture --file PATH --slug SLUG for file input; set allow_empty:true to intentionally clear it.`,
        'Use capture --file PATH --slug SLUG for file input, or pass allow_empty:true with the expected revision to intentionally clear it.');
    }
  }
  if (row.operation === 'delete_page') {
    assertPurgeParams(p, row.authority.remote);
    if (!snapshot) throw pageRefusal('page_not_found', 'Page not found.', row,
      `Page ${row.slug} does not exist in source ${row.source_id}, so nothing was deleted. Check the slug and the source.`, pageFix(row.source_id, row.slug));
    const purge = p.purge === true;
    const noop = !purge && snapshot.page.deleted_at != null;
    // Always-loaded core pages: a remote caller cannot delete one (owner-only).
    if (!noop) { enterClaimStep(clock, 'core_guard', undefined, 'db'); await prepareCoreGuard(engine, { row, snapshot, incoming: null }); }
    enterClaimStep(clock, 'file_target', undefined, 'fs');
    // Tombstones still own their recorded artifact. Purge always attempts its
    // removal before the guarded hard-delete and receipt commit; failure rolls
    // back to the prior row, and replay survives the eventual absence of that row.
    const file = await prepareFileTarget(engine, row, snapshot, null, undefined, { allowMissing: purge || options.allowMissingFile, deleting: true, activePack, remote: row.authority.remote });
    return { observedRevision, noop, file, ...await pageDatabaseOnlyPublication(engine, row, file), apply: async tx => {
      if (purge) return purgePageInTransaction(tx, row, snapshot);
      if (!noop) { await tx.createVersion(row.slug, source); await tx.softDeletePage(row.slug, source); }
      return { status: 'soft_deleted', slug: row.slug, source_id: row.source_id, noop,
        recoverable_until: 'now + 72h via restore_page (remove immediately instead: gbrain delete <slug> --purge, local CLI only)' };
    } };
  }
  // #6188: a trusted local fence repair's receipt (admission refuses it from every other caller) rides the outcome and the file's commit.
  const fenceRepair = row.operation === 'put_page' && !row.authority.remote ? parseFenceRepairReceipt(p.fence_repair) : null;
  const fenceRepairOutcome = fenceRepair ? { fence_repair: fenceRepair } : {};
  // #5616: edits apply to the caller's view of the locked snapshot (revision checked above).
  const edited = row.operation === 'edit_page' ? editLockedPage(row, snapshot) : undefined;
  let content = edited?.content ?? preparedIntent?.content ?? p.content as string;
  let versionTags: string[] | undefined = preparedIntent?.tags;
  // A replacement/restore publishes a live page. Only a recorded version may
  // explicitly restore a tombstone; legacy versions leave this state unchanged.
  let targetDeleted = false;
  if (row.operation === 'restore_page' || row.operation === 'revert_version') {
    if (!snapshot) throw pageRefusal('page_not_found', 'Page not found.', row,
      `Page ${row.slug} does not exist in source ${row.source_id} (it was purged or never written), so nothing was ${row.operation === 'restore_page' ? 'restored' : 'reverted'}. Check the slug and the source.`,
      pageFix(row.source_id, row.slug));
    let page = snapshot.page;
    let tags = snapshot.tags;
    if (row.operation === 'revert_version') {
      const [version] = await engine.executeRaw<PageVersion>(
        'SELECT * FROM page_versions WHERE id=$1 AND page_id=$2', [p.version_id, page.id]);
      if (!version) throw pageRefusal('not_found', 'Version not found for this page.', row,
        `Version ${String(p.version_id)} is not in the history of page ${row.slug}, so nothing was reverted. List the page's versions (get_versions; CLI: gbrain history) and revert to one of them.`);
      targetDeleted = version.is_deleted ?? (snapshot.page.deleted_at != null);
      page = { ...page, compiled_truth: version.compiled_truth, frontmatter: version.frontmatter,
        ...(version.timeline !== null && version.timeline !== undefined ? { timeline: version.timeline } : {}),
        ...(version.title !== null && version.title !== undefined ? { title: version.title } : {}),
        ...(version.type !== null && version.type !== undefined ? { type: version.type } : {}) };
      if (version.tags !== null && version.tags !== undefined) tags = version.tags;
      versionTags = tags;
    }
    content = serializePageToMarkdown(page, tags);
  }
  if (row.authority.remote && row.operation !== 'remember' && !row.operation.startsWith('takes_') && typeof content==='string') {
    const parsed=parseMarkdown(content,row.slug,{ activePack });
    const compiled_truth=preserveProtectedTakes(parsed.compiled_truth,snapshot?.page.compiled_truth??'');
    const timeline=preserveProtectedTakes(parsed.timeline??'',snapshot?.page.timeline??'');
    if (compiled_truth!==parsed.compiled_truth || timeline!==(parsed.timeline??'')) content=serializePageToMarkdown({
      ...(snapshot?.page??{id:0,source_id:row.source_id,created_at:new Date(),updated_at:new Date()}),...parsed,compiled_truth,timeline},parsed.tags);
  }
  // Core marking is owner-only: a remote write that omits always_load or
  // core_priority keeps the stored values instead of silently un-coring the page.
  if (row.authority.remote && snapshot && !snapshot.page.deleted_at && typeof content === 'string'
    && (snapshot.page.frontmatter?.always_load !== undefined || snapshot.page.frontmatter?.core_priority !== undefined)) {
    const parsed = parseMarkdown(content, row.slug, { activePack });
    const carried = carryCoreMarking(snapshot.page.frontmatter, parsed.frontmatter ?? {});
    if (carried.always_load !== parsed.frontmatter?.always_load || carried.core_priority !== parsed.frontmatter?.core_priority) {
      content = serializePageToMarkdown({ ...snapshot.page, ...parsed, frontmatter: carried }, parsed.tags);
    }
  }
  const projected = !(row.operation === 'remember' || row.operation.startsWith('takes_') || (row.operation === 'extract_facts' && p.kind === 'managed_facts_entity'));
  const writer = (row.operation === 'put_page' || row.operation === 'edit_page') && p.kind !== 'managed_maintenance_page'
    && (preparedIntent !== undefined || typeof p.expected_revision === 'string') ? 'editing' : 'preserving';
  // #5969 (D3): only an ordinary put_page intent carries a timeline section; every other writer keeps the shared policy.
  const timelinePolicy = row.operation === 'put_page' ? timelineWritePolicy(p, row.authority.remote, writer) : undefined;
  enterClaimStep(clock, 'timeline_policy', undefined, 'db');
  if (timelinePolicy && typeof content === 'string') await assertTimelineNotOmitted(engine, { intent: p, remote: row.authority.remote, writer,
    slug: row.slug, sourceId: row.source_id, content, prior: snapshot });
  // #5567: database-only timeline rows are written back into the page before
  // the no-op check, digest, rendering and chunking see the body.
  if (projected && snapshot && typeof content === 'string') {
    const parsed = parseMarkdown(content,row.slug);
    enterClaimStep(clock, 'materialize_timeline', undefined, 'db');
    const { timeline, materialized } = await materializeTimeline(engine,parsed,row.slug,snapshot,writer,timelinePolicy);
    if (materialized) content = serializePageToMarkdown({...snapshot.page,...parsed,timeline,type:parsed.typeExplicit ? parsed.type : snapshot.page.type},parsed.tags);
  }
  const storedTier = snapshot ? await storedPageTier(engine, row.source_id, row.slug) : null;
  // Detect an exact canonical no-op before ingestion can invoke any provider.
  // Revision/identity checks above still apply to stale identical replacements.
  if (snapshot && (snapshot.page.deleted_at != null) === targetDeleted && typeof content === 'string') {
    const incoming = parseMarkdown(content,row.slug,{ activePack });
    resolveParsedSubtype(incoming, snapshot.page);
    const tags = versionTags ?? [...new Set([...snapshot.tags,...incoming.tags])].sort();
    if (digest(canonical(snapshot.page,snapshot.tags)) === digest(canonical(incoming,tags))) {
      const file=await prepareFileTarget(engine,row,snapshot,targetDeleted ? null : serializePageToMarkdown(snapshot.page,snapshot.tags),undefined,{ activePack, remote: row.authority.remote });
      return {observedRevision,noop:true,file,...await pageDatabaseOnlyPublication(engine,row,file),
        apply:async()=>({...pageNoopAdvisories(row),status:'skipped',slug:row.slug,source_id:row.source_id,noop:true,chunks:0,chunk_skip_reason:'write_skipped',
          ...(row.operation==='capture'?{channel:'capture',content_hash:p.capture_hash}:{}),...fenceRepairOutcome})};
    }
  }
  let prepared: PreparedContentImport | undefined;
  let provenance: CanonicalProvenance | undefined;
  let suppliedTrustMarker: unknown;
  // #5575: the page's tier, computed once before import so the write gate sees exactly it (ENG-18).
  const trust = pageWriteTrust(row, typeof content === 'string' && !isFenceEditWrite(row) ? parseMarkdown(content, row.slug, { activePack }).frontmatter : null);
  const gateTrust = pageGateTrust(row, trust, storedTier);
  // The apply diet: the publisher's locked read of row.slug is the import base, and one read after the
  // last page write serves the read-back check, the seal, the core notice and the receipt (as sync does).
  const lean = options.coordinated === true && !targetDeleted && row.operation !== 'restore_page' && !versionTags;
  enterClaimStep(clock, 'import_content', undefined, 'db');
  const result = await importFromContent(engine, row.slug, content, {
    ...source, noEmbed: true, remote: row.authority.remote, activePack, fences: projected ? 'coordinated' : 'lenient', coordinated: lean,
    ...(lean ? { existingSnapshot: snapshot } : {}),
    // #6259: only owner-tier intents keep gate-owned markers; an ordinary put_page, local or remote, has them stripped.
    preserveGateMarkers: !row.authority.remote && (p.kind === 'managed_maintenance_page' || p.kind === 'managed_quarantine_clear'),
    forceRechunk: row.operation === 'restore_page' || row.operation === 'revert_version',
    allowEmptyOverwrite: p.allow_empty === true || row.operation === 'restore_page' || row.operation === 'revert_version',
    source_kind: typeof p.source_kind === 'string' ? p.source_kind : null,
    source_uri: typeof p.source_uri === 'string' ? p.source_uri : null,
    ingested_via: typeof p.ingested_via === 'string' ? p.ingested_via : null,
    ...(gateTrust ? { writeGate: gateInput(gateTrust, row.id) } : {}),
    // Provenance compares the caller's page with the stored one, so it runs before the server's trust marker is stamped.
    prepareFrontmatter: page => {
      provenance = putProvenance(row, snapshot, page);
      suppliedTrustMarker = page.frontmatter.trust_tier;
      stampPageTrustMarker(row, page.frontmatter, trust, storedTier);
    },
    prepare: async value => { prepared = value; return value.result; },
  }).catch(error => {
    if (!(error instanceof ContentSanityBlockError)) throw error;
    throw contentRefusalError({ code: 'content_rejected', message: error.message },
      'The operator set content_sanity.junk_disposition to reject, so this content refuses on every retry. Remove the matched junk and submit the corrected content with a new request_id.');
  });
  signal?.throwIfAborted();
  if (!prepared) {
    // A remote caller's refusal names the line, never a key: keys can be private, and the receipt keeps the message.
    const refusal = result.refusal && row.authority.remote && result.refusal.code === 'invalid_frontmatter'
      ? { ...result.refusal, key: undefined, message: frontmatterHoldMessageWithoutKeys(result.refusal.message) } : result.refusal;
    if (refusal?.code === 'file_too_large') throw contentRefusalError(refusal, 'Split the content into smaller pages, then submit each with its own request_id.', { legacy_error: 'request_too_large' });
    if (refusal?.code === 'invalid_fence') throw contentRefusalError(refusal, `Page ${row.slug} was not written. Fix ${fenceWhere(refusal.fence)} as the message says (fence_issues lists every row and column; use the allowed values), `
      + 'or write facts with remember and takes with takes_add instead of a hand-built table, then submit the corrected content with a new request_id.', { legacy_error: 'invalid_params' });
    if (refusal) throw contentRefusalError(refusal, `Correct ${refusal.line !== undefined ? `frontmatter line ${refusal.line}${refusal.key ? ` (key "${refusal.key}")` : ''}` : 'the frontmatter'}: one line per key with its whole value quoted, then submit the corrected content with a new request_id.`,
      { legacy_error: 'invalid_params' });
    throw opError('invalid_params', 'The content was rejected before publication.', 'Check the content and frontmatter, then submit the corrected content with a new request_id.');
  }
  const ready = prepared;
  if (ready.observedRevision !== observedRevision) throw pageRefusal('revision_conflict', 'The page changed during import preparation.', row,
    `Page ${row.slug} was written by another request while this one was being prepared, so it published nothing. Read the current page and revision, then submit the intended change against it.`,
    pageFix(row.source_id, row.slug));
  if (ready.slug !== row.slug) {
    await authorizeWrite(engine, row.authority, row.operation, ready.slug);
    const duplicate = await engine.readPageSnapshot(ready.slug, { ...source, excludePrivate: row.authority.remote });
    if (!duplicate) throw pageRefusal('permission_denied', 'The duplicate is not readable by this writer.', row,
      `The content duplicates another page in source ${row.source_id} that this writer cannot read, so nothing was published. Write it under a different slug, or ask the user to make the write from a writer that can read the existing page.`);
    return { observedRevision, noop: true, additionalPageKeys:[{sourceId:row.source_id,slug:ready.slug}],validate: async tx => {
      await authorizeWrite(tx,row.authority,row.operation,ready.slug,true);
      const current=await tx.readPageSnapshot(ready.slug,{...source,excludePrivate:row.authority.remote});
      if (!current || current.page.id!==duplicate.page.id || current.revision!==duplicate.revision) throw pageRefusal('revision_conflict','The read-only duplicate changed during preparation.', row,
        `Page ${ready.slug}, which this content duplicates, changed while the write was being prepared, so nothing was published. Read it, then submit the write again if it is still needed.`,
        pageFix(row.source_id, ready.slug));
    },
      apply: async () => ({ status: 'duplicate', slug: duplicate.page.slug, duplicate_revision: duplicate.revision }) };
  }
  const tags = versionTags ?? [...new Set([...(snapshot?.tags ?? []), ...ready.parsedPage.tags])].sort();
  const renderedPage: Page = { ...(snapshot?.page ?? { id: 0, slug: row.slug, source_id: row.source_id, created_at: new Date(), updated_at: new Date() }), ...ready.parsedPage };
  const rendered = serializePageToMarkdown(renderedPage, tags);
  // CEO-21: the server-stamped trust marker alone never makes a write: unchanged as stamped or as the caller sent it.
  const callerPage = { ...ready.parsedPage, frontmatter: suppliedTrustMarkerView(ready.parsedPage.frontmatter, suppliedTrustMarker) };
  const logicalNoop = snapshot !== null && [ready.parsedPage, callerPage].some(page => digest(canonical(snapshot.page, snapshot.tags)) === digest(canonical(page, tags)));
  const noop = logicalNoop && (snapshot?.page.deleted_at != null) === targetDeleted;
  const ordinaryPage = ['put_page','capture','restore_page','revert_version','edit_page'].includes(row.operation);
  // A managed maintenance page (e.g. the dream write-back after grounding
  // quarantine) republishes a body; its automatic links follow that body.
  const autoLinkedPage = ordinaryPage || p.kind === 'managed_maintenance_page';
  const capture = row.operation === 'capture' && typeof p.capture_path === 'string' && typeof p.capture_file_hash === 'string'
    ? { path: p.capture_path, hash: p.capture_file_hash } : undefined;
  // Projections, advisories, link resolution (links-preparation.ts), the file target and the core guard go out together.
  enterClaimStep(clock, 'link_resolution', undefined, 'db');
  const [project, advisories, links, target, core] = await pipelined(together, [
    async () => projected ? prepareCanonicalProjections(engine,ready.parsedPage,row.slug,row.source_id,snapshot,writer,timelinePolicy) : undefined,
    async () => noop || targetDeleted ? pageNoopAdvisories(row) : !ordinaryPage ? remoteLinkHint(row) : preparePageAdvisories(engine,row,ready.parsedPage,snapshot),
    async () => !noop && !targetDeleted && autoLinkedPage && (row.authority.autoLinkTrusted ?? !row.authority.remote) && await isAutoLinkEnabled(engine)
      ? prepareAutomaticLinks(engine,row.slug,ready.parsedPage,row.source_id,options.coordinated === true) : undefined,
    () => prepareFileTarget(engine, row, snapshot, targetDeleted ? null : rendered, undefined, { capture, allowMissing: options.allowMissingFile, activePack, remote: row.authority.remote }),
    // Always-loaded core tier: owner-only marking, brain-wide budget, remote-edit policy (core-guard.ts).
    async () => noop ? null : prepareCoreGuard(engine, { row, snapshot, incoming: targetDeleted ? null : ready.parsedPage }),
  ]) as [Awaited<ReturnType<typeof prepareCanonicalProjections>> | undefined, Record<string, unknown>,
    Awaited<ReturnType<typeof prepareAutomaticLinks>> | undefined, PreparedMutation['file'], Awaited<ReturnType<typeof prepareCoreGuard>> | null];
  // #6188 (D12): what Tier 1 rewrote; a remote caller is never told about the takes fence it cannot read (preserved verbatim).
  const shownFixes = (ready.result.fences_normalized ?? []).filter(fix => !row.authority.remote || fix.fence !== 'takes');
  const fencesNormalized = shownFixes.length ? { fences_normalized: pageFencesNormalized({ sourceId: row.source_id, slug: row.slug, fixes: shownFixes,
    writer: row.principal_kind, path: snapshot?.page.source_path ?? null, remote: row.authority.remote }) } : {};
  const file = target && fenceRepair ? { ...target, commit: fenceRepairCommit(relative(target.root, target.path).split(sep).join('/'), fenceRepair.classes, fenceRepair.tier) } : target;
  enterClaimStep(clock, 'publication_mode', undefined, 'db');
  const [mintMode, databaseOnly] = await pipelined(together, [
    async () => file && !snapshot?.page.source_path ? scannerSlugRootMode(engine, row.source_id, file.root) : undefined,
    () => pageDatabaseOnlyPublication(engine, row, file),
  ]) as [Awaited<ReturnType<typeof scannerSlugRootMode>> | undefined, Pick<PreparedMutation, 'databaseOnlyReason'>];
  const sourcePath = file && mintMode ? scannerSourcePath(file.root, file.path, mintMode) : undefined;
  // An inferred mode is pinned with the first origin it mints, so later pages cannot flip the inference (#5610).
  const pinMode = sourcePath && mintMode && scannerSourcePath(file!.root, file!.root) && !await readSlugRootMode(engine, row.source_id) ? mintMode : undefined;
  const publication: PreparedMutation = { observedRevision, noop, additionalPageKeys:links?.pageKeys, file, ...databaseOnly,
    ...(core ? { exclusiveSources: core.exclusiveSources } : {}), ...(trust ? { trust } : {}),
    validate: async tx => { await ready.validate(tx); await core?.validate(tx); }, apply: async (tx, preimage) => {
    let autoLinks: Awaited<ReturnType<NonNullable<typeof links>['apply']>> | undefined;
    let removedTimeline: TimelineRowsRemoved | null = null;
    let lowered: { proposal_ref: string } | null = null;
    let contested: string[] = [];
    if (!noop) {
      const prior = snapshot ? await storedPageTier(tx, row.source_id, row.slug) : null;
      // ENG-1: a managed fence edit keeps the page's tier; CEO-12: an agent rewrite that lowers a page files a queue item.
      const applied = await (isFenceEditWrite(row) ? withTrustKeep(tx, ['pages'], () => ready.apply(tx, lean ? preimage : undefined)) : ready.apply(tx, lean ? preimage : undefined));
      lowered = prior ? await recordAgentPageLowering(tx, row, { tier: prior, revision: snapshot!.revision }) : null;
      // Mandatory metadata shares publication rollback; exact no-ops never heal it. These, and the
      // projections (facts, takes, timeline rows of the page the import just wrote live), are independent and sent together.
      const [, pinned] = await pipelined(tx, [
        async () => { if (sourcePath && !snapshot?.page.source_path) await tx.executeRaw(`UPDATE pages SET source_path = $1
          WHERE source_id=$2 AND slug=$3 AND source_path IS NULL`, [sourcePath, row.source_id, row.slug]); },
        async () => pinMode ? (await tx.executeRaw<{ mode: string | null }>(`UPDATE sources SET config=CASE WHEN config->>'slug_root_mode' IS NULL
          THEN jsonb_set(${SOURCE_CONFIG_OBJECT_SQL},'{slug_root_mode}',to_jsonb($2::text)) ELSE config END WHERE id=$1 RETURNING config->>'slug_root_mode' AS mode`,
        [row.source_id, pinMode]))[0] : undefined,
        async () => { if (provenance) await tx.executeRaw(`UPDATE pages SET source_kind=$3,ingested_via=$4,ingested_at=$5::timestamptz
          WHERE source_id=$1 AND slug=$2`, [row.source_id, row.slug, provenance.source_kind, provenance.ingested_via, provenance.ingested_at]); },
        async () => { if (lean) ({ removedTimeline, contested } = projectedRows(await project?.(tx, applied?.pageId))); },
      ]) as [unknown, { mode: string | null } | undefined, unknown, unknown];
      if (pinMode && pinned?.mode !== pinMode) throw pageRefusal('revision_conflict', 'The source slug-root mode changed during preparation.', row,
        `Another write pinned source ${row.source_id}'s slug-root mode while ${row.slug} was being prepared, so this publication rolled back. Once the request is final, submit the write again; it is prepared under the pinned mode.`);
      if (row.operation === 'restore_page') await tx.restorePage(row.slug, source);
      if (versionTags) {
        for (const tag of snapshot!.tags) if (!versionTags.includes(tag)) await tx.removeTag(row.slug, tag, source);
        for (const tag of versionTags) await tx.addTag(row.slug, tag, source);
      }
      // #6007: the page the import just wrote live is the page the projections describe; no re-read.
      if (!lean) ({ removedTimeline, contested } = projectedRows(await project?.(tx, row.operation === 'restore_page' ? undefined : applied?.pageId)));
      autoLinks = await links?.apply(tx);
      if (lean) {
        const final = await tx.readPageSnapshot(row.slug, { ...source, includeDeleted: true });
        const live = final && final.page.deleted_at == null ? final : null;
        await verifyPageReadable(tx, row.slug, ready.contentHash!, row.source_id, 'importFromContent', live?.page ?? null);
        if (live) await sealPageTextProjection(tx, row.slug, row.source_id, live);
        if (core) await core.record(tx, final?.revision ?? null);
        publication.postimage = final;
      } else {
        if (targetDeleted) await tx.softDeletePage(row.slug, source);
        // Index installation and terminal receipt share this transaction. The import sealed the projection
        // as its last revision-changing step; only a later revision change (restore, tags, links, delete) reseals.
        if (!(applied?.sealed && row.operation !== 'restore_page' && !versionTags && !links && !targetDeleted)) await sealPageTextProjection(tx, row.slug, row.source_id);
        if (core) await core.record(tx, (await tx.readPageSnapshot(row.slug, source))?.revision ?? null);
      }
    }
    const coreUsage = core?.usage();
    const gate = noop ? undefined : gateField(ready.result.gate, `p:${row.source_id}/${row.slug}`, null);
    return { ...advisories, ...(autoLinks ? {auto_links:autoLinks} : {}), ...(coreUsage ? { core: coreUsage } : {}),
      ...(removedTimeline ? { timeline_rows_removed: timelineRowsRemovedAdvisory(row, removedTimeline) } : {}),
      status: noop ? 'skipped' : row.operation === 'restore_page' ? 'restored' : row.operation === 'revert_version' ? 'reverted' : 'created_or_updated',
      slug: row.slug, source_id: row.source_id, chunks: ready.result.chunks, noop,
      ...(ready.result.chunks === 0 ? {chunk_skip_reason: noop ? 'write_skipped'
        : isEmbedSkipped(ready.parsedPage.frontmatter) || isQuarantined(ready.parsedPage.frontmatter) ? 'embed_skip' : 'empty_body'} : {}),
      // #6259: say the gate hid the page, not only why it has no chunks.
      ...(!noop && quarantineOutcome(ready.parsedPage.frontmatter) ? { quarantined: quarantineOutcome(ready.parsedPage.frontmatter) } : {}),
      ...(row.operation === 'capture' ? { channel: 'capture', content_hash: p.capture_hash } : {}),
      ...(edited ? editDiff(row.slug, edited.before, edited.after) : {}), ...fencesNormalized, ...fenceRepairOutcome,
      ...(lowered ? { trust_lowered: lowered } : {}), ...(gate ? { gate } : {}),
      // DX-1: a guarded supersession reports contested (the first proposal; every one when the write contested several rows).
      ...(contested.length ? { contested: { proposal_ref: contested[0], ...(contested.length > 1 ? { proposal_refs: contested } : {}) } } : {}) };
  } };
  return publication;
}

/** What a page's projections report back: removed timeline rows and the contested proposal refs (#5575 guarded supersession). */
function projectedRows(projected: { timelineRowsRemoved?: TimelineRowsRemoved | null; contested?: string[] } | undefined): { removedTimeline: TimelineRowsRemoved | null; contested: string[] } {
  return { removedTimeline: projected?.timelineRowsRemoved ?? null, contested: projected?.contested ?? [] };
}

function editLockedPage(row: WriteRequest, snapshot: PageSnapshot | null) {
  if (!snapshot || snapshot.page.deleted_at) throw pageRefusal('page_not_found', 'Page not found.', row,
    `Page ${row.slug} does not exist in source ${row.source_id} or is deleted, so the edit changed nothing. If it is soft-deleted, restore it with restore_page; otherwise write it whole with put_page.`,
    pageFix(row.source_id, row.slug));
  return applyPageEdits(snapshot.page, snapshot.tags, row.authority.remote, parsePageEdits(row.intent?.edits));
}
