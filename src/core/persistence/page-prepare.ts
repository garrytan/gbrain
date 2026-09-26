import { isEmbedSkipped } from '../embed-skip.ts';
import { isQuarantined } from '../quarantine.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { Page, PageVersion } from '../types.ts';
import { importFromContent, type ParsedPage } from '../import-file.ts';
import { parseMarkdown, serializePageToMarkdown, resolveSourceLocalFilePath } from '../markdown.ts';
import { OperationError } from '../ops/contract.ts';
import { assertPageRevision, type PageSnapshot } from '../page-state/types.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { recordedPathFromFileUri, scannerSourcePath } from '../write-through.ts';
import { engineMutationPrecondition, parseMutationPrecondition } from './preconditions.ts';
import { assertPurgeParams } from './purge-params.ts';
import { authorizeWrite } from './authority.ts';
import { digest, sha256 } from './digest.ts';
import { getWorktreeBinding } from './ownership.ts';
import type { PreparedContentImport } from './prepared-import.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import { sealPageTextProjection } from '../page-state/projections.ts';
import { overlayCanonicalBodies } from '../page-state/snapshot.ts';
import { prepareCanonicalProjections } from './canonical-projections.ts';
import { preserveProtectedTakes } from './protected-takes.ts';
import { isAutoLinkEnabled } from '../link-extraction.ts';
import { prepareAutomaticLinks } from './links-preparation.ts';
import { preparePageAdvisories, remoteLinkHint, pageNoopAdvisories } from './page-advisories.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';
import { nativeFileTarget } from './native-file-target.ts';

const PURGE_RESIDUALS = 'Brain-repo git history, synced working-tree copies, exports, compiled context files and slug-keyed derived rows (takes, open loops, file records) may still hold the content — rotate the credential and rewrite or regenerate those copies.';

function canonical(page: Pick<Page, 'type' | 'title' | 'compiled_truth' | 'timeline' | 'frontmatter'>, tags: string[]) {
  return { type: page.type, title: page.title, compiled_truth: page.compiled_truth, timeline: page.timeline ?? '',
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
export async function prepareFileTarget(engine: BrainEngine, row: Pick<WriteRequest, 'source_id' | 'worktree_id' | 'slug'>, snapshot: PageSnapshot | null,
  content: string | null, hostId?: string, options: { allowMissing?: boolean } = {}): Promise<PreparedMutation['file']> {
  if (!row.worktree_id) return undefined;
  const binding = await getWorktreeBinding(engine, row.source_id, hostId);
  if (!binding?.local_path) throw new OperationError('owner_unavailable', 'The canonical worktree is unavailable on this host.');
  const root = join(binding.local_path, binding.relative_path);
  const capturedPath = recordedPathFromFileUri(snapshot?.page.source_uri, root);
  const path = nativeFileTarget(root, resolveSourceLocalFilePath(root, snapshot?.page.source_path, row.slug)
    ?? (capturedPath ? join(root, capturedPath) : join(root, `${row.slug}.md`)));
  if (!isWriteTargetContained(path, root)) throw new OperationError('source_changed', 'The canonical file target is outside its registered source.');
  const before = existsSync(path) ? readFileSync(path) : null;
  if (!before && snapshot && !snapshot.page.deleted_at && !options.allowMissing) {
    throw new OperationError('source_changed', 'The canonical file was removed outside coordinated publication.',
      'Import the local deletion or recover the canonical file before editing this page.');
  }
  // A normal edit may replace only the bytes represented by its read snapshot.
  // Unknown local edits require explicit import/recovery, even for force writes.
  if (before && snapshot) {
    const parsed = parseMarkdown(before.toString('utf8'), row.slug);
    const expected = canonical(snapshot.page, snapshot.tags);
    const actual = canonical({ ...parsed, ...await overlayCanonicalBodies(engine.executeRaw.bind(engine),
      parsed.compiled_truth, parsed.timeline ?? '', snapshot.withdrawals) }, parsed.tags);
    // Withdrawal overlays intentionally precede physical mirroring. The ledger
    // is applied by the import preparation and cannot be undone by this check.
    if (digest(actual) !== digest(expected)) {
      throw new OperationError('source_changed', 'The canonical file contains an uncoordinated local edit.', 'Import or recover the local edit before replacing this page.');
    }
  } else if (before && !snapshot && content !== null && sha256(before) !== sha256(content)) {
    throw new OperationError('source_changed', 'An unindexed file already occupies the canonical page path.', 'Import the file before replacing it.');
  }
  return { path, root, content, expectedBeforeHash: before ? sha256(before) : null };
}

/** Providers and parsing run before the OS lock and before any publication transaction. */
export async function preparePageMutation(engine: BrainEngine, row: WriteRequest, _config: GBrainConfig,
  preparedIntent?: { content: string; expectedRevision: string; tags?: string[] }, signal?: AbortSignal): Promise<PreparedMutation> {
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
  if (row.operation === 'put_page' && p.allow_empty !== true && snapshot && !snapshot.page.deleted_at
    && typeof p.content === 'string' && `${snapshot.page.compiled_truth}\n${snapshot.page.timeline ?? ''}`.trim()) {
    const incoming = parseMarkdown(p.content, row.slug);
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
    return { observedRevision, noop, file: await prepareFileTarget(engine, row, snapshot, null, undefined, { allowMissing: purge }), apply: async tx => {
      if (purge) {
        await tx.deletePage(row.slug, source);
        return { status: 'purged', slug: row.slug, source_id: row.source_id, residuals: PURGE_RESIDUALS };
      }
      if (!noop) { await tx.createVersion(row.slug, source); await tx.softDeletePage(row.slug, source); }
      return { status: 'soft_deleted', slug: row.slug, source_id: row.source_id, noop,
        recoverable_until: 'now + 72h via restore_page (remove immediately instead: gbrain delete <slug> --purge, local CLI only)' };
    } };
  }
  let content = preparedIntent?.content ?? p.content as string;
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
  if (row.authority.remote && row.operation !== 'remember' && !row.operation.startsWith('takes_') && typeof content==='string') {
    const parsed=parseMarkdown(content,row.slug);
    const compiled_truth=preserveProtectedTakes(parsed.compiled_truth,snapshot?.page.compiled_truth??'');
    const timeline=preserveProtectedTakes(parsed.timeline??'',snapshot?.page.timeline??'');
    if (compiled_truth!==parsed.compiled_truth || timeline!==(parsed.timeline??'')) content=serializePageToMarkdown({
      ...(snapshot?.page??{id:0,source_id:row.source_id,created_at:new Date(),updated_at:new Date()}),...parsed,compiled_truth,timeline},parsed.tags);
  }
  // Detect an exact canonical no-op before ingestion can invoke any provider.
  // Revision/identity checks above still apply to stale identical replacements.
  if (snapshot && (snapshot.page.deleted_at != null) === targetDeleted && typeof content === 'string') {
    const incoming = parseMarkdown(content,row.slug);
    const tags = versionTags ?? [...new Set([...snapshot.tags,...incoming.tags])].sort();
    if (digest(canonical(snapshot.page,snapshot.tags)) === digest(canonical(incoming,tags))) {
      return {observedRevision,noop:true,file:await prepareFileTarget(engine,row,snapshot,targetDeleted ? null : serializePageToMarkdown(snapshot.page,snapshot.tags)),
        apply:async()=>({...pageNoopAdvisories(row),status:'skipped',slug:row.slug,source_id:row.source_id,noop:true,chunks:0,chunk_skip_reason:'write_skipped',
          ...(row.operation==='capture'?{channel:'capture',content_hash:p.capture_hash}:{})})};
    }
  }
  let prepared: PreparedContentImport | undefined;
  let provenance: CanonicalProvenance | undefined;
  const result = await importFromContent(engine, row.slug, content, {
    ...source, noEmbed: true, remote: row.authority.remote,
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
  const project = row.operation === 'remember' || row.operation.startsWith('takes_') || (row.operation === 'extract_facts' && p.kind === 'managed_facts_entity') ? undefined
    : prepareCanonicalProjections(ready.parsedPage,row.slug,row.source_id);
  const ordinaryPage = ['put_page','capture','restore_page','revert_version'].includes(row.operation);
  const advisories = noop || targetDeleted ? pageNoopAdvisories(row) : !ordinaryPage ? remoteLinkHint(row) : await preparePageAdvisories(engine,row,ready.parsedPage);
  const remoteAutoLink = row.authority.remote && !row.authority.autoLinkTrusted
    && process.env.GBRAIN_REMOTE_AUTO_LINK === '1';
  const links = !noop && !targetDeleted && ordinaryPage && ((row.authority.autoLinkTrusted ?? !row.authority.remote) || remoteAutoLink)
    && await isAutoLinkEnabled(engine)
    ? await prepareAutomaticLinks(engine,row.slug,ready.parsedPage,row.source_id,
      remoteAutoLink ? { excludePrivate: row.authority.excludePrivate ?? true } : undefined) : undefined;
  const disabledRemoteLinks = remoteAutoLink && !links && !noop && !targetDeleted && ordinaryPage
    ? { auto_links: { skipped: 'disabled' } } : {};
  const file = await prepareFileTarget(engine, row, snapshot, targetDeleted ? null : rendered);
  const sourcePath = file ? scannerSourcePath(file.root, file.path) : undefined;
  return { observedRevision, noop, additionalPageKeys:links?.pageKeys, file, apply: async tx => {
    let autoLinks: Awaited<ReturnType<NonNullable<typeof links>['apply']>> | undefined;
    if (!noop) {
      await ready.apply(tx);
      // Mandatory metadata shares publication rollback; exact no-ops never heal it.
      if (sourcePath && !snapshot?.page.source_path) await tx.executeRaw(`UPDATE pages SET source_path = $1
        WHERE source_id=$2 AND slug=$3 AND source_path IS NULL`, [sourcePath, row.source_id, row.slug]);
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
    return { ...advisories, ...disabledRemoteLinks, ...(autoLinks ? {auto_links:autoLinks} : {}),
      status: noop ? 'skipped' : row.operation === 'restore_page' ? 'restored' : row.operation === 'revert_version' ? 'reverted' : 'created_or_updated',
      slug: row.slug, source_id: row.source_id, chunks: ready.result.chunks, noop,
      ...(ready.result.chunks === 0 ? {chunk_skip_reason: noop ? 'write_skipped'
        : isEmbedSkipped(ready.parsedPage.frontmatter) || isQuarantined(ready.parsedPage.frontmatter) ? 'embed_skip' : 'empty_body'} : {}),
      ...(row.operation === 'capture' ? { channel: 'capture', content_hash: p.capture_hash } : {}) };
  } };
}
