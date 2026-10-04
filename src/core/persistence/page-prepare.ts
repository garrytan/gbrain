import { isEmbedSkipped } from '../embed-skip.ts';
import { isQuarantined } from '../quarantine.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { Page, PageVersion } from '../types.ts';
import { importFromContent, type ParsedPage } from '../import-file.ts';
import { parseMarkdown, resolveParsedSubtype, serializePageToMarkdown, resolveSourceLocalFilePath, type ParseOpts } from '../markdown.ts';
import { OperationError } from '../ops/contract.ts';
import { assertPageRevision, type PageSnapshot } from '../page-state/types.ts';
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
import { overlayCanonicalBodies } from '../page-state/snapshot.ts';
import { materializeTimeline, prepareCanonicalProjections } from './canonical-projections.ts';
import { preserveProtectedTakes } from './protected-takes.ts';
import { restoreOmittedFacts } from './omitted-facts.ts';
import { isAutoLinkEnabled } from '../link-extraction.ts';
import { prepareAutomaticLinks } from './links-preparation.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { preparePageAdvisories, remoteLinkHint, pageNoopAdvisories } from './page-advisories.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';
import { colonSlugWindowsRefusal, isWindowsColonTarget, nativeFileTarget } from './native-file-target.ts';
import { isSourceDbOnlySlug } from './source-storage.ts';
import { isMirrorOnlyPage, sourceMirrorReadOnly } from './mirror-read-only.ts';
import { DERIVE_PHASE_DB_ONLY_DEFAULTS } from '../storage-config.ts';
import { SOURCE_CONFIG_OBJECT_SQL } from '../source-config-sql.ts';
import { readSlugRootMode } from '../sync-anchor.ts';
import { applyPageEdits, editDiff, parsePageEdits } from './page-edit.ts';

const PURGE_RESIDUALS = 'Brain-repo git history, synced working-tree copies, exports, compiled context files and slug-keyed derived rows (takes, open loops, file records) may still hold the content — rotate the credential and rewrite or regenerate those copies.';

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
export async function prepareFileTarget(engine: BrainEngine, row: Pick<WriteRequest, 'source_id' | 'worktree_id' | 'slug'>, snapshot: PageSnapshot | null,
  content: string | null, hostId?: string, options: { allowMissing?: boolean; capture?: { path: string; hash: string }; activePack?: ParseOpts['activePack'] } = {}): Promise<PreparedMutation['file']> {
  if (!row.worktree_id) return undefined;
  // #5409: a read-only mirror's checkout belongs to its Git remote; nothing is written or removed there.
  if (await sourceMirrorReadOnly(engine, row.source_id)) return undefined;
  if (snapshot && !snapshot.page.source_path && await isMirrorOnlyPage(engine, row.source_id, row.slug)) return undefined;
  // #5254: a page written while its source was unbound stays database-only in
  // every state (live, tombstone, restore, revert, delete, purge); any file at
  // its derived path is not its canonical file and is neither written nor removed.
  if (snapshot && !snapshot.page.source_path && await isUnboundSourcePage(engine, row.source_id, row.slug)) return undefined;
  const binding = await getWorktreeBinding(engine, row.source_id, hostId);
  if (!binding?.local_path) throw new OperationError('owner_unavailable', 'The canonical worktree is unavailable on this host.');
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
  if (!isWriteTargetContained(path, root)) throw new OperationError('source_changed', 'The canonical file target is outside its registered source.');
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
    throw new OperationError('source_changed', 'The canonical file was removed outside coordinated publication.',
      'Import the local deletion or recover the canonical file before editing this page.');
  }
  // A normal edit may replace only the bytes represented by its read snapshot.
  // Unknown local edits require explicit import/recovery, even for force writes.
  if (before && snapshot) {
    const parsed = parseMarkdown(before.toString('utf8'), row.slug, { activePack: options.activePack });
    resolveParsedSubtype(parsed, snapshot.page);
    const expected = canonical(snapshot.page, snapshot.tags);
    // #1035 parity (#5521): a file without an explicit `type:` keeps the stored type on import.
    const type = parsed.typeExplicit ? parsed.type : snapshot.page.type;
    const actual = canonical({ ...parsed, type, ...await overlayCanonicalBodies(engine.executeRaw.bind(engine),
      parsed.compiled_truth, parsed.timeline ?? '', snapshot.withdrawals) }, parsed.tags);
    // Withdrawal overlays intentionally precede physical mirroring. The ledger
    // is applied by the import preparation and cannot be undone by this check.
    if (digest(actual) !== digest(expected)) {
      const error = new OperationError('source_changed', 'The canonical file contains an uncoordinated local edit.',
        `On the brain host, run gbrain sources reconcile ${row.source_id} ${row.slug} --brain <brain id, host by default> --preview, review and apply the resolved preview, then retry this write with a new request_id. Neither copy was overwritten.`);
      error.detail = 'file_database_drift';
      throw error;
    }
  } else if (before && !snapshot && content !== null && sha256(before) !== sha256(content)
    && !(options.capture && sha256(before) === options.capture.hash)) {
    throw new OperationError('source_changed', 'An unindexed file already occupies the canonical page path.', 'Import the file before replacing it.');
  }
  return { path, root, content, expectedBeforeHash: before ? sha256(before) : null };
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

/** Providers and parsing run before the OS lock and before any publication transaction. */
export async function preparePageMutation(engine: BrainEngine, row: WriteRequest, _config: GBrainConfig,
  preparedIntent?: { content: string; expectedRevision: string; tags?: string[] }, signal?: AbortSignal,
  options: { allowMissingFile?: boolean } = {}): Promise<PreparedMutation> {
  signal?.throwIfAborted();
  if (!row.intent) throw new OperationError('storage_error', 'A pending write lost its normalized intent.');
  await assertKnowledgePublicationAllowed(engine, row);
  const p = row.intent;
  const source = { sourceId: row.source_id };
  const snapshot = await engine.readPageSnapshot(row.slug, { ...source, includeDeleted: true });
  signal?.throwIfAborted();
  assertPageRevision(snapshot, preparedIntent ? { expectedRevision: preparedIntent.expectedRevision } : engineMutationPrecondition(parseMutationPrecondition(p)));
  if ((snapshot?.page.id ?? null) !== row.page_id) throw new OperationError('page_identity_changed', 'The accepted page identity changed.');
  const observedRevision = snapshot?.revision ?? null;
  const activePack = (await loadActivePackForEngine(engine, { remote: row.authority.remote, sourceId: row.source_id }).catch(() => null))?.manifest;
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
    if (!snapshot) throw new OperationError('page_not_found', 'Page not found.');
    const purge = p.purge === true;
    const noop = !purge && snapshot.page.deleted_at != null;
    // Tombstones still own their recorded artifact. Purge always attempts its
    // removal before the guarded hard-delete and receipt commit; failure rolls
    // back to the prior row, and replay survives the eventual absence of that row.
    const file = await prepareFileTarget(engine, row, snapshot, null, undefined, { allowMissing: purge || options.allowMissingFile, activePack });
    return { observedRevision, noop, file, ...await pageDatabaseOnlyPublication(engine, row, file), apply: async tx => {
      if (purge) {
        await tx.deletePage(row.slug, source);
        return { status: 'purged', slug: row.slug, source_id: row.source_id, residuals: PURGE_RESIDUALS };
      }
      if (!noop) { await tx.createVersion(row.slug, source); await tx.softDeletePage(row.slug, source); }
      return { status: 'soft_deleted', slug: row.slug, source_id: row.source_id, noop,
        recoverable_until: 'now + 72h via restore_page (remove immediately instead: gbrain delete <slug> --purge, local CLI only)' };
    } };
  }
  // #5616: edits apply to the caller's view of the locked snapshot (revision checked above).
  const edited = row.operation === 'edit_page' ? editLockedPage(row, snapshot) : undefined;
  let content = edited?.content ?? preparedIntent?.content ?? p.content as string;
  let versionTags: string[] | undefined = preparedIntent?.tags;
  // A replacement/restore publishes a live page. Only a recorded version may
  // explicitly restore a tombstone; legacy versions leave this state unchanged.
  let targetDeleted = false;
  if (row.operation === 'restore_page' || row.operation === 'revert_version') {
    if (!snapshot) throw new OperationError('page_not_found', 'Page not found.');
    let page = snapshot.page;
    let tags = snapshot.tags;
    if (row.operation === 'revert_version') {
      const [version] = await engine.executeRaw<PageVersion>(
        'SELECT * FROM page_versions WHERE id=$1 AND page_id=$2', [p.version_id, page.id]);
      if (!version) throw new OperationError('not_found', 'Version not found for this page.');
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
  // get_page omit_facts: the stored facts fence goes back where the reader saw the placeholder.
  if (row.operation === 'put_page' && typeof content === 'string') {
    content = restoreOmittedFacts(content, snapshot && !snapshot.page.deleted_at ? serializePageToMarkdown(snapshot.page, snapshot.tags) : '');
  }
  if (row.authority.remote && row.operation !== 'remember' && !row.operation.startsWith('takes_') && typeof content==='string') {
    const parsed=parseMarkdown(content,row.slug,{ activePack });
    const compiled_truth=preserveProtectedTakes(parsed.compiled_truth,snapshot?.page.compiled_truth??'');
    const timeline=preserveProtectedTakes(parsed.timeline??'',snapshot?.page.timeline??'');
    if (compiled_truth!==parsed.compiled_truth || timeline!==(parsed.timeline??'')) content=serializePageToMarkdown({
      ...(snapshot?.page??{id:0,source_id:row.source_id,created_at:new Date(),updated_at:new Date()}),...parsed,compiled_truth,timeline},parsed.tags);
  }
  const projected = !(row.operation === 'remember' || row.operation.startsWith('takes_') || (row.operation === 'extract_facts' && p.kind === 'managed_facts_entity'));
  const writer = (row.operation === 'put_page' || row.operation === 'edit_page') && p.kind !== 'managed_maintenance_page'
    && (preparedIntent !== undefined || typeof p.expected_revision === 'string') ? 'editing' : 'preserving';
  // #5567: database-only timeline rows are written back into the page before
  // the no-op check, digest, rendering and chunking see the body.
  if (projected && snapshot && typeof content === 'string') {
    const parsed = parseMarkdown(content,row.slug);
    const { timeline, materialized } = await materializeTimeline(engine,parsed,row.slug,snapshot,writer);
    if (materialized) content = serializePageToMarkdown({...snapshot.page,...parsed,timeline,type:parsed.typeExplicit ? parsed.type : snapshot.page.type},parsed.tags);
  }
  // Detect an exact canonical no-op before ingestion can invoke any provider.
  // Revision/identity checks above still apply to stale identical replacements.
  if (snapshot && (snapshot.page.deleted_at != null) === targetDeleted && typeof content === 'string') {
    const incoming = parseMarkdown(content,row.slug,{ activePack });
    resolveParsedSubtype(incoming, snapshot.page);
    const tags = versionTags ?? [...new Set([...snapshot.tags,...incoming.tags])].sort();
    if (digest(canonical(snapshot.page,snapshot.tags)) === digest(canonical(incoming,tags))) {
      const file=await prepareFileTarget(engine,row,snapshot,targetDeleted ? null : serializePageToMarkdown(snapshot.page,snapshot.tags),undefined,{ activePack });
      return {observedRevision,noop:true,file,...await pageDatabaseOnlyPublication(engine,row,file),
        apply:async()=>({...pageNoopAdvisories(row),status:'skipped',slug:row.slug,source_id:row.source_id,noop:true,chunks:0,chunk_skip_reason:'write_skipped',
          ...(row.operation==='capture'?{channel:'capture',content_hash:p.capture_hash}:{})})};
    }
  }
  let prepared: PreparedContentImport | undefined;
  let provenance: CanonicalProvenance | undefined;
  const result = await importFromContent(engine, row.slug, content, {
    ...source, noEmbed: true, remote: row.authority.remote, activePack,
    forceRechunk: row.operation === 'restore_page' || row.operation === 'revert_version',
    allowEmptyOverwrite: p.allow_empty === true || row.operation === 'restore_page' || row.operation === 'revert_version',
    source_kind: typeof p.source_kind === 'string' ? p.source_kind : null,
    source_uri: typeof p.source_uri === 'string' ? p.source_uri : null,
    ingested_via: typeof p.ingested_via === 'string' ? p.ingested_via : null,
    prepareFrontmatter: page => { provenance = putProvenance(row, snapshot, page); },
    prepare: async value => { prepared = value; return value.result; },
  });
  signal?.throwIfAborted();
  if (!prepared) {
    const oversized = result.error?.startsWith('Content too large') === true;
    throw new OperationError(oversized ? 'request_too_large' : 'invalid_params', oversized ? result.error!
      : /yaml/i.test(result.error ?? '') ? 'Invalid YAML frontmatter. Quote scalar values or fix the frontmatter block.'
      : 'The content was rejected before publication.');
  }
  const ready = prepared;
  if (ready.observedRevision !== observedRevision) throw new OperationError('revision_conflict', 'The page changed during import preparation.');
  if (ready.slug !== row.slug) {
    await authorizeWrite(engine, row.authority, row.operation, ready.slug);
    const duplicate = await engine.readPageSnapshot(ready.slug, { ...source, excludePrivate: row.authority.remote });
    if (!duplicate) throw new OperationError('permission_denied', 'The duplicate is not readable by this writer.');
    return { observedRevision, noop: true, additionalPageKeys:[{sourceId:row.source_id,slug:ready.slug}],validate: async tx => {
      await authorizeWrite(tx,row.authority,row.operation,ready.slug,true);
      const current=await tx.readPageSnapshot(ready.slug,{...source,excludePrivate:row.authority.remote});
      if (!current || current.page.id!==duplicate.page.id || current.revision!==duplicate.revision) throw new OperationError('revision_conflict','The read-only duplicate changed during preparation.');
    },
      apply: async () => ({ status: 'duplicate', slug: duplicate.page.slug, duplicate_revision: duplicate.revision }) };
  }
  const tags = versionTags ?? [...new Set([...(snapshot?.tags ?? []), ...ready.parsedPage.tags])].sort();
  const renderedPage: Page = { ...(snapshot?.page ?? { id: 0, slug: row.slug, source_id: row.source_id, created_at: new Date(), updated_at: new Date() }), ...ready.parsedPage };
  const rendered = serializePageToMarkdown(renderedPage, tags);
  const logicalNoop = snapshot !== null && digest(canonical(snapshot.page, snapshot.tags)) === digest(canonical(ready.parsedPage, tags));
  const noop = logicalNoop && (snapshot?.page.deleted_at != null) === targetDeleted;
  const project = projected ? await prepareCanonicalProjections(engine,ready.parsedPage,row.slug,row.source_id,snapshot,writer) : undefined;
  const ordinaryPage = ['put_page','capture','restore_page','revert_version','edit_page'].includes(row.operation);
  const advisories = noop || targetDeleted ? pageNoopAdvisories(row) : !ordinaryPage ? remoteLinkHint(row) : await preparePageAdvisories(engine,row,ready.parsedPage);
  // A managed maintenance page (e.g. the dream write-back after grounding
  // quarantine) republishes a body; its automatic links follow that body.
  const autoLinkedPage = ordinaryPage || p.kind === 'managed_maintenance_page';
  const links = !noop && !targetDeleted && autoLinkedPage && (row.authority.autoLinkTrusted ?? !row.authority.remote) && await isAutoLinkEnabled(engine)
    ? await prepareAutomaticLinks(engine,row.slug,ready.parsedPage,row.source_id) : undefined;
  const capture = row.operation === 'capture' && typeof p.capture_path === 'string' && typeof p.capture_file_hash === 'string'
    ? { path: p.capture_path, hash: p.capture_file_hash } : undefined;
  const file = await prepareFileTarget(engine, row, snapshot, targetDeleted ? null : rendered, undefined, { capture, allowMissing: options.allowMissingFile, activePack });
  const mintMode = file && !snapshot?.page.source_path ? await scannerSlugRootMode(engine, row.source_id, file.root) : undefined;
  const sourcePath = file && mintMode ? scannerSourcePath(file.root, file.path, mintMode) : undefined;
  // An inferred mode is pinned with the first origin it mints, so later pages cannot flip the inference (#5610).
  const pinMode = sourcePath && mintMode && scannerSourcePath(file!.root, file!.root) && !await readSlugRootMode(engine, row.source_id) ? mintMode : undefined;
  return { observedRevision, noop, additionalPageKeys:links?.pageKeys, file, ...await pageDatabaseOnlyPublication(engine, row, file), validate: ready.validate, apply: async tx => {
    let autoLinks: Awaited<ReturnType<NonNullable<typeof links>['apply']>> | undefined;
    if (!noop) {
      await ready.apply(tx);
      // Mandatory metadata shares publication rollback; exact no-ops never heal it.
      if (sourcePath && !snapshot?.page.source_path) await tx.executeRaw(`UPDATE pages SET source_path = $1
        WHERE source_id=$2 AND slug=$3 AND source_path IS NULL`, [sourcePath, row.source_id, row.slug]);
      if (pinMode) {
        const [pinned] = await tx.executeRaw<{ mode: string | null }>(`UPDATE sources SET config=CASE WHEN config->>'slug_root_mode' IS NULL
          THEN jsonb_set(${SOURCE_CONFIG_OBJECT_SQL},'{slug_root_mode}',to_jsonb($2::text)) ELSE config END WHERE id=$1 RETURNING config->>'slug_root_mode' AS mode`,
        [row.source_id, pinMode]);
        if (pinned?.mode !== pinMode) throw new OperationError('revision_conflict', 'The source slug-root mode changed during preparation.');
      }
      if (provenance) await tx.executeRaw(`UPDATE pages SET source_kind=$3,ingested_via=$4,ingested_at=$5::timestamptz
        WHERE source_id=$1 AND slug=$2`, [row.source_id, row.slug, provenance.source_kind, provenance.ingested_via, provenance.ingested_at]);
      if (row.operation === 'restore_page') await tx.restorePage(row.slug, source);
      if (versionTags) {
        for (const tag of snapshot!.tags) if (!versionTags.includes(tag)) await tx.removeTag(row.slug, tag, source);
        for (const tag of versionTags) await tx.addTag(row.slug, tag, source);
      }
      await project?.(tx);
      autoLinks = await links?.apply(tx);
      if (targetDeleted) await tx.softDeletePage(row.slug, source);
      // Index installation and terminal receipt share this transaction.
      await sealPageTextProjection(tx, row.slug, row.source_id);
    }
    return { ...advisories, ...(autoLinks ? {auto_links:autoLinks} : {}),
      status: noop ? 'skipped' : row.operation === 'restore_page' ? 'restored' : row.operation === 'revert_version' ? 'reverted' : 'created_or_updated',
      slug: row.slug, source_id: row.source_id, chunks: ready.result.chunks, noop,
      ...(ready.result.chunks === 0 ? {chunk_skip_reason: noop ? 'write_skipped'
        : isEmbedSkipped(ready.parsedPage.frontmatter) || isQuarantined(ready.parsedPage.frontmatter) ? 'embed_skip' : 'empty_body'} : {}),
      ...(row.operation === 'capture' ? { channel: 'capture', content_hash: p.capture_hash } : {}),
      ...(edited ? editDiff(row.slug, edited.before, edited.after) : {}) };
  } };
}

function editLockedPage(row: WriteRequest, snapshot: PageSnapshot | null) {
  if (!snapshot || snapshot.page.deleted_at) throw new OperationError('page_not_found', 'Page not found.');
  return applyPageEdits(snapshot.page, snapshot.tags, row.authority.remote, parsePageEdits(row.intent?.edits));
}
