import { realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { Page } from '../types.ts';
import { OperationError, opError } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';
import type { RegistryCode } from '../error-registry.ts';
import { importFromContent, importCodeFile } from '../import-file.ts';
import { parseMarkdown, resolveParsedSubtype, serializePageToMarkdown } from '../markdown.ts';
import { resolveSlugForPath, slugifyPath, isCodeFilePath } from '../sync.ts';
import { SOURCE_CONFIG_OBJECT_SQL } from '../source-config-sql.ts';
import { sameCanonicalImport } from '../page-state/import-guard.ts';
import { assertPageRevision } from '../page-state/types.ts';
import { sealPageTextProjection } from '../page-state/projections.ts';
import { prepareCanonicalProjections } from './canonical-projections.ts';
import { digest, sha256 } from './digest.ts';
import { preserveProtectedTakes } from './protected-takes.ts';
import { getWorktreeBinding } from './ownership.ts';
import { sourceMirrorReadOnly } from './mirror-read-only.ts';
import { assertConfiguredSyncRoot, assertSyncEntryOrigin, readSyncFile, syncGit, syncRawHash, type SyncRename } from './sync-discovery.ts';
import { assertSyncPageOrigin, sameSyncOrigin, syncOriginPath, syncOriginScope, type SyncOriginScope } from './sync-origin.ts';
import { assertManagedSyncActive, validateSyncAuthority, type SyncAuthority, type SyncProcessingOptions } from './sync-authority.ts';
import type { PreparedContentImport } from './prepared-import.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';
import { loadActivePackForEngine, checkApprovedSchemaForEngine } from '../schema-pack/engine-resolution.ts';
import type { CompanyBrainPlan } from '../company-brain/types.ts';
import { companyBrainProfile } from '../company-brain/profile.ts';
import { companyBrainPolicyFingerprint } from '../company-brain/policy.ts';
import { isUnboundSourcePage, UNBOUND_COLLISION_MESSAGE } from './unbound-source.ts';
import { checkpointRetryCommand, findIncompleteSyncReceipt } from './checkpoint-validation.ts';
import { frontmatterSlugConflictMessage } from './verb-errors.ts';
import { CHUNKER_VERSION } from '../chunkers/code.ts';

/** The options that select a managed sync cursor (its key), recorded so a refusal can print the exact retry. */
export interface SyncCursorOptions { full: boolean; workingTree: boolean; srcSubpath: string | null; exclude: string[]; includeHidden: string[]; strategy: string | null }
export interface SyncIntent extends Record<string, unknown> {
  companyApproval?: { schema: NonNullable<CompanyBrainPlan['schema']>; planDigest: string; extractorVersion: string; policyFingerprint: string };
  kind: 'managed_sync_import' | 'managed_sync_delete' | 'managed_sync_checkpoint';
  expected_revision: string | null; sourcePath: string | null; path: string | null;
  rawHash: string | null; content: string | null; ownerEpoch: string;
  lineEndingOnly?: boolean;
  /** #5565: the deleted file is no page's origin; publication only re-proves that and commits a no-op. */
  unownedDeletion?: boolean;
  working?: boolean;
  renameFrom?: SyncRename;
  processingOptions?: SyncProcessingOptions;
  syncOptions?: SyncCursorOptions;
  /** The `--repo` base a relative `--src-subpath` resolved against, for the printed retry. */
  repoPath?: string;
  /** #5522: another cursor of this source imported entries of this run, so the source may already sit at the target. */
  overtaken?: boolean;
  syncAuthority: SyncAuthority; cursorKey: string; runId: string; index: number;
  from: string | null; target: string; total: number; slugMode: 'git-root' | 'source-root';
}
/**
 * Read-only: the receipt itself for the local CLI writer's own request;
 * another principal's request is inspected on the owner instead.
 */
function syncInspectFix(row: WriteRequest, requestId: string, owner: boolean): Action {
  return owner || row.principal_kind !== 'local_cli'
    ? { argv: ['gbrain', 'sources', 'writer', 'status', '--source', row.source_id, '--json'], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Shows the source\'s owner, cursor and every pending, failed or recovering receipt without changing anything.' }
    : { argv: ['gbrain', 'write-request', '--', requestId], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'The receipt records whether this sync write published anything; nothing is resubmitted until it is final.' };
}

/**
 * Publishing an accepted managed-sync request was refused. The coordinator
 * keeps only code and message, so the suggestion stands alone: inspect the
 * request, then rerun the exact failed-run command once the cause is fixed.
 */
function syncPublicationRefusal(code: RegistryCode, message: string, row: WriteRequest, p: SyncIntent | null, cause: string, inspectOwner = false): OperationError {
  const fix = syncInspectFix(row, row.request_id, inspectOwner);
  const rerun = checkpointRetryCommand({ sourceId: row.source_id, processingOptions: p?.processingOptions, syncOptions: p?.syncOptions, repoPath: p?.repoPath });
  return opError(code, message, `${cause} Request ${row.request_id} in ${row.source_id} was refused; inspect it first (${fix.argv!.join(' ')}) and do not resubmit it. `
    + `Once it is final and the cause is fixed, run: ${rerun}`, { fix });
}

export async function prepareManagedSyncMutation(engine: BrainEngine, row: WriteRequest, _config: GBrainConfig): Promise<PreparedMutation> {
  const p = row.intent as SyncIntent | null;
  if (!p || !['managed_sync_import', 'managed_sync_delete', 'managed_sync_checkpoint'].includes(p.kind)) throw syncPublicationRefusal('invalid_params', 'Unsupported internal sync intent.', row, p,
    'The request does not carry a managed sync intent this release can publish.');
  if (p.unownedDeletion && p.kind !== 'managed_sync_delete') throw syncPublicationRefusal('invalid_params', 'Only a deletion can record an unowned path.', row, p,
    'Its intent records an unowned path on something other than a deletion.');
  const originPageId = p.unownedDeletion ? null : row.page_id;
  await assertManagedSyncActive(engine);
  if (p.kind !== 'managed_sync_delete' && (!p.processingOptions ||
      ['noEmbed', 'noExtract', 'noSchemaPack'].some(key => typeof p.processingOptions?.[key as keyof SyncProcessingOptions] !== 'boolean'))) {
    throw new OperationError('invalid_params', 'The legacy sync request has no durable processing options.',
      'Inspect this unchanged request, then use --retry-failed with explicit sync options to rediscover. Unknown embedding and schema consent cannot be inferred from a retry.');
  }
  await validateSyncAuthority(engine, p.syncAuthority, row.slug);
  const binding = await getWorktreeBinding(engine, row.source_id);
  if (!binding?.local_path || String(binding.owner_epoch) !== p.ownerEpoch) throw syncPublicationRefusal('owner_unavailable', 'The accepted sync owner changed.', row, p,
    `The canonical owner of ${row.source_id} changed, or lost its local path, after this sync was admitted. Do not claim or transfer the source to repair content.`, true);
  const root = join(binding.local_path, binding.relative_path);
  const [configuredSource] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [row.source_id]);
  assertConfiguredSyncRoot(root, configuredSource?.local_path ?? null);
  if (p.kind !== 'managed_sync_checkpoint') await assertKnowledgePublicationAllowed(engine, row,
    p.path === null ? undefined : { root, path: join(root, p.path) });
  let origin: Parameters<typeof assertSyncEntryOrigin>[1] | undefined;
  let originContext: Parameters<typeof assertSyncEntryOrigin>[0] | undefined;
  let originScope: SyncOriginScope | undefined;
  if (p.kind !== 'managed_sync_checkpoint') {
    if (typeof p.path !== 'string' || typeof p.sourcePath !== 'string') throw syncPublicationRefusal('storage_error', 'The accepted sync origin is missing.', row, p,
      'The stored intent has no recorded file path for this page.');
    let working = p.working;
    if (p.kind === 'managed_sync_delete' && working === undefined) {
      const [manifest] = await engine.executeRaw<{ entry: { path: string; sourcePath: string; action: string; working: boolean; pageId?: number | null } }>(
        "SELECT completed_keys->$2::integer AS entry FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [p.runId, p.index]);
      const entry = manifest?.entry;
      if (!entry || entry.path !== p.path || entry.sourcePath !== p.sourcePath || entry.action !== 'delete' ||
          typeof entry.working !== 'boolean' || (entry.pageId ?? null) !== row.page_id) {
        throw new OperationError('page_identity_changed', 'The legacy deletion has no matching immutable origin manifest.',
          'Inspect the source identity and explicitly retry failed sync discovery; the accepted request has not been rewritten.');
      }
      working = entry.working;
    }
    origin = { path: p.path, sourcePath: p.sourcePath, action: p.kind === 'managed_sync_delete' ? 'delete' : 'import', working };
    originContext = { root, gitRoot: realpathSync(syncGit(root, ['rev-parse', '--show-toplevel']).trim()), target: p.target, slugMode: p.slugMode };
    assertSyncEntryOrigin(originContext, origin);
    originScope = syncOriginScope({ ...originContext, sourceId: row.source_id });
    await assertSyncPageOrigin(engine, row.source_id, p.sourcePath, originPageId, p.kind === 'managed_sync_delete', originScope);
    if (p.renameFrom) await assertSyncPageOrigin(engine, row.source_id, p.renameFrom.sourcePath, p.renameFrom.pageId, true, originScope);
  }
  const moved = p.kind === 'managed_sync_import' ? p.renameFrom : undefined;
  const assertRenameSource = async (tx: BrainEngine) => {
    if (!moved || moved.slug === row.slug) return;
    const previous = await tx.readPageSnapshot(moved.slug, { sourceId: row.source_id, includeDeleted: true });
    if (previous?.page.id !== moved.pageId || previous.revision !== moved.revision || previous.page.deleted_at != null) {
      throw syncPublicationRefusal('revision_conflict', 'The renamed page changed after sync admission.', row, p,
        `Page ${moved.slug}, which this file was renamed from, changed or was deleted after the sync was admitted.`);
    }
  };
  const validate = async (tx: BrainEngine) => {
    await assertManagedSyncActive(tx, true);
    await validateSyncAuthority(tx, p.syncAuthority, row.slug);
    const [configuredSource] = await tx.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1 FOR SHARE', [row.source_id]);
    assertConfiguredSyncRoot(root, configuredSource?.local_path ?? null);
    const [cursor] = await tx.executeRaw<{ run_id: string; request_id: string | null }>(
      "SELECT completed_keys->0->>'runId' AS run_id,completed_keys->0->'pending'->>'requestId' AS request_id FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1 FOR SHARE", [p.cursorKey]);
    if (cursor && (cursor.run_id !== p.runId || cursor.request_id !== row.request_id)) throw syncPublicationRefusal('revision_conflict', 'The accepted sync cursor changed before publication.', row, p,
      `Another sync run of ${row.source_id} replaced the cursor this request belongs to.`);
    const current = await getWorktreeBinding(tx, row.source_id);
    if (!current || String(current.owner_epoch) !== p.ownerEpoch) throw syncPublicationRefusal('owner_unavailable', 'The accepted sync owner epoch changed.', row, p,
      `The owner epoch of ${row.source_id} changed after this sync was admitted. Do not claim or transfer the source to repair content.`, true);
    if (p.kind !== 'managed_sync_checkpoint') await assertKnowledgePublicationAllowed(tx, row,
      p.path === null ? undefined : { root, path: join(root, p.path) });
    if (p.path !== null && syncRawHash(root, p.path) !== p.rawHash) throw syncPublicationRefusal('source_changed', 'The imported file changed after sync admission.', row, p,
      `The file of ${row.slug} changed on disk after this sync was admitted; review the change and commit it.`);
    if (origin && originContext) {
      assertSyncEntryOrigin(originContext, origin);
      await assertSyncPageOrigin(tx, row.source_id, origin.sourcePath, originPageId, p.kind === 'managed_sync_delete', originScope);
      if (moved) await assertSyncPageOrigin(tx, row.source_id, moved.sourcePath, moved.pageId, true, originScope);
      await assertRenameSource(tx);
    }
    if (p.companyApproval) {
      const [source] = await tx.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [row.source_id]);
      const policy = companyBrainProfile(source?.config);
      if (!policy || policy.planDigest !== p.companyApproval.planDigest || policy.extractorVersion !== p.companyApproval.extractorVersion || policy.approvedRevision !== p.target ||
        companyBrainPolicyFingerprint(policy, row.source_id) !== p.companyApproval.policyFingerprint) {
        throw syncPublicationRefusal('source_changed', 'The company source approval changed.', row, p,
          `The approved company-brain plan of ${row.source_id} changed after this sync was admitted, so the run needs the current approval.`);
      }
      const schema = p.companyApproval.schema;
      await checkApprovedSchemaForEngine(tx, { name: schema.name, identity: schema.identity, resolvedManifestHash: schema.resolved_digest }, { remote: false, sourceId: row.source_id });
    }
  };
  if (p.kind === 'managed_sync_checkpoint') return { sourceExclusive: true, observedRevision: null, validate, apply: async tx => {
    const [cursor] = await tx.executeRaw<{ completed_keys: [{ runId: string; index: number; total: number }] }>(
      "SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1 FOR UPDATE", [p.cursorKey]);
    if (!cursor || cursor.completed_keys[0].runId !== p.runId || cursor.completed_keys[0].index !== p.total || cursor.completed_keys[0].total !== p.total) {
      throw syncPublicationRefusal('revision_conflict', 'The sync cursor is not fully committed.', row, p,
        `Not every page write of this sync run has committed, so the checkpoint of ${row.source_id} did not advance.`);
    }
    const [manifest] = await tx.executeRaw<{ count: number }>("SELECT jsonb_array_length(completed_keys) AS count FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [p.runId]);
    if (!manifest || Number(manifest.count) !== p.total) throw syncPublicationRefusal('storage_error', 'The immutable sync manifest is incomplete.', row, p,
      `The immutable manifest of this sync run is incomplete, so the checkpoint of ${row.source_id} did not advance.`);
    const incomplete = await findIncompleteSyncReceipt(tx, row.worktree_id!, p.runId);
    if (incomplete) throw opError('recovery_required', `An incomplete page receipt (request ${incomplete}) still blocks the sync checkpoint.`,
      `Page request ${incomplete} of this sync run is still open or needs recovery, so checkpoint request ${row.request_id} of ${row.source_id} did not commit. `
        + `Inspect request ${incomplete} and let it finish; do not resubmit it. Then run: ${checkpointRetryCommand({ sourceId: row.source_id, processingOptions: p.processingOptions, syncOptions: p.syncOptions, repoPath: p.repoPath })}`,
      { fix: syncInspectFix(row, incomplete, false) });
    // #5522: an overtaken run accepts a source another cursor already checkpointed at this exact target.
    const changed = await tx.executeRaw(`UPDATE sources SET last_commit=$3,last_sync_at=now(),config=jsonb_set(${SOURCE_CONFIG_OBJECT_SQL},'{slug_root_mode}',to_jsonb($5::text)),
      newest_content_at=(SELECT MAX(updated_at) FROM pages WHERE source_id=$1 AND deleted_at IS NULL)
      WHERE id=$1 AND incarnation=$2::uuid AND (last_commit IS NOT DISTINCT FROM $4 OR ($6::boolean AND last_commit=$3))
      AND (config->>'slug_root_mode' IS NULL OR config->>'slug_root_mode'=$5) RETURNING id`, [row.source_id, row.source_incarnation, p.target, p.from, p.slugMode, p.overtaken === true]);
    if (!changed.length) throw syncPublicationRefusal('revision_conflict', 'The source checkpoint changed during this sync.', row, p,
      `Another sync moved the commit checkpoint of ${row.source_id} while this run published.`);
    // #5566: a full walk re-chunked every stale page, so acknowledge the chunker version as the legacy gate does.
    if (p.from === null || p.syncOptions?.full === true) await tx.executeRaw('UPDATE sources SET chunker_version=$2 WHERE id=$1', [row.source_id, String(CHUNKER_VERSION)]);
    await tx.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,done}','true'::jsonb),updated_at=now() WHERE op='managed-sync' AND fingerprint=$1", [p.cursorKey]);
    return { status: 'synced', source_id: row.source_id, committed_pages: p.total };
  } };
  const source = { sourceId: row.source_id };
  const snapshot = await engine.readPageSnapshot(row.slug, { ...source, includeDeleted: true });
  assertPageRevision(snapshot, p.expected_revision === null ? {} : { expectedRevision: p.expected_revision });
  const recordedOrigin = moved?.slug === row.slug ? moved.sourcePath : p.sourcePath!;
  const foreignOrigin = snapshot?.page.source_path != null && !sameSyncOrigin(snapshot.page.source_path, recordedOrigin, originScope, snapshot.page.slug);
  if ((snapshot?.page.id ?? null) !== row.page_id || (p.unownedDeletion ? !foreignOrigin : foreignOrigin)) {
    throw syncPublicationRefusal('page_identity_changed', 'The imported path no longer names the accepted page.', row, p,
      `Page ${row.slug} was recreated, or its recorded origin moved, after this sync was admitted.`);
  }
  if (p.unownedDeletion) return { observedRevision: snapshot!.revision, noop: true, validate,
    apply: async () => ({ status: 'skipped', slug: row.slug, source_id: row.source_id, noop: true, reason: 'unowned_deleted_path' }) };
  if (snapshot && snapshot.page.source_path == null && await isUnboundSourcePage(engine, row.source_id, row.slug)) {
    throw syncPublicationRefusal('source_changed', UNBOUND_COLLISION_MESSAGE, row, p,
      `A canonical file now occupies the path of page ${row.slug}, written while ${row.source_id} was unbound; neither copy was overwritten. Rename or remove the file and commit, or copy what you need into the page first.`);
  }
  if (p.kind === 'managed_sync_delete') return { observedRevision: snapshot?.revision ?? null, noop: !snapshot || snapshot.page.deleted_at != null,
    validate, apply: async tx => {
      if (snapshot && snapshot.page.deleted_at == null) { await tx.createVersion(row.slug, source); await tx.softDeletePage(row.slug, source); }
      return { status: 'soft_deleted', slug: row.slug, source_id: row.source_id, noop: !snapshot || snapshot.page.deleted_at != null };
    } };
  if (typeof p.content !== 'string' || typeof p.sourcePath !== 'string' || typeof p.path !== 'string') throw syncPublicationRefusal('storage_error', 'The frozen import content is missing.', row, p,
    'The stored intent has no frozen file content to import.');
  if (isCodeFilePath(p.sourcePath)) {
    if (p.companyApproval) throw syncPublicationRefusal('profile_incompatible', 'Company source approval permits only committed Markdown content.', row, p,
      `A company-brain source imports only committed Markdown, and ${row.slug} is a code file; remove it from the approved revision.`);
    if (snapshot && !p.lineEndingOnly && p.rawHash !== sha256(p.content) && snapshot.page.compiled_truth !== p.content) {
      throw syncPublicationRefusal('source_changed', 'Newer code file bytes disagree with the pinned import.', row, p,
        `The working tree holds newer bytes for ${row.slug} than the pinned import; sync did not overwrite them. Preserve the local edit and commit it.`);
    }
    let prepared: PreparedContentImport | undefined;
    const result = await importCodeFile(engine, p.sourcePath, p.content, { ...source, noEmbed: true,
      prepare: async value => { prepared = value; return value.result; } });
    if (!prepared || prepared.slug !== row.slug) throw syncPublicationRefusal('invalid_params', result.error ?? 'The code file identity could not be prepared.', row, p,
      `The code file could not be prepared as page ${row.slug}.`);
    const ready = prepared;
    if (ready.observedRevision !== (snapshot?.revision ?? null)) throw syncPublicationRefusal('revision_conflict', 'The code page changed during preparation.', row, p,
      `Page ${row.slug} changed while this sync was being prepared.`);
    return { observedRevision: ready.observedRevision,
      validate: async tx => { await validate(tx); await ready.validate(tx); },
      noop: ready.noop, deferEmbedding: true, apply: async tx => {
      await ready.apply(tx);
      return { status: ready.noop ? 'skipped' : snapshot ? 'updated' : 'created', slug: row.slug, source_id: row.source_id,
        chunks: result.chunks, noop: ready.noop, imported_file: true };
    } };
  }
  const schema = p.companyApproval?.schema;
  if (schema && p.processingOptions?.noSchemaPack) throw syncPublicationRefusal('profile_incompatible', 'Company source approval requires its pinned schema pack.', row,
    { ...p, processingOptions: { ...p.processingOptions!, noSchemaPack: false } },
    `A company-brain source imports with its pinned schema pack, so ${row.source_id} cannot sync with --no-schema-pack.`);
  const activePack = p.processingOptions?.noSchemaPack ? undefined : schema ? (await checkApprovedSchemaForEngine(engine, { name: schema.name, identity: schema.identity, resolvedManifestHash: schema.resolved_digest },
    { remote: false, sourceId: row.source_id })).pack.manifest : (await loadActivePackForEngine(engine, { remote: row.authority.remote, sourceId: row.source_id }).catch(() => null))?.manifest;
  // A renamed page is prepared where it stands; publication moves it, then re-prepares at the new slug.
  const renamed = moved && moved.slug !== row.slug ? moved : undefined;
  const base = renamed ? await engine.readPageSnapshot(renamed.slug, { ...source, includeDeleted: true }) : snapshot;
  if (renamed && (base?.page.id !== renamed.pageId || base.revision !== renamed.revision || base.page.deleted_at != null)) {
    throw syncPublicationRefusal('revision_conflict', 'The renamed page changed after sync admission.', row, p,
      `Page ${renamed.slug}, which this file was renamed from, changed or was deleted after the sync was admitted.`);
  }
  // row.slug is already resolved; parseMarkdown expects a filename, as in importFromContent.
  const parsedInput = parseMarkdown(p.content, `${row.slug}.md`, { activePack });
  resolveParsedSubtype(parsedInput, base?.page);
  const expectedSlug = resolveSlugForPath(p.sourcePath);
  const retainedRecordedOrigin = snapshot?.page.source_path != null &&
    syncOriginPath(snapshot.page.source_path) === syncOriginPath(p.sourcePath) && parsedInput.slug === snapshot.page.slug;
  if (expectedSlug && parsedInput.slug !== expectedSlug && slugifyPath(parsedInput.slug) !== expectedSlug && !retainedRecordedOrigin) {
    throw syncPublicationRefusal('invalid_params', frontmatterSlugConflictMessage(p.sourcePath, parsedInput.slug, expectedSlug), row, p,
      'Correct the frontmatter `slug:` in the file and commit the change.');
  }
  if (!p.companyApproval && base && !p.lineEndingOnly && p.rawHash !== sha256(p.content) && !sameCanonicalImport(base, parsedInput)) {
    // The pinned commit can simply trail the coordinator: a committed page write reaches the
    // working tree before its Git effect lands. When the newer working-tree bytes are the
    // current page itself, there is nothing to import and nothing to protect; the commit that
    // carries them is imported as a no-op by a later run.
    // The checkpoint may advance past the pinned commit's bytes because the working tree wins, as for any local edit.
    const working = renamed ? null : readSyncFile(root, p.path);
    if (!working || sha256(working) !== p.rawHash
      || !sameCanonicalImport(base, parseMarkdown(working.toString('utf8'), `${row.slug}.md`, { activePack }))) {
      throw syncPublicationRefusal('source_changed', 'Newer working-tree bytes and the current page disagree with this pinned Git import.', row, p,
        `The working tree holds newer bytes for ${row.slug} that match neither the pinned import nor the current page; sync did not overwrite them. Preserve the local edit and commit it.`);
    }
    return { observedRevision: snapshot?.revision ?? null, noop: true, contentUnchanged: true, validate,
      apply: async () => ({ status: 'skipped', slug: row.slug, source_id: row.source_id, chunks: 0, noop: true, imported_file: true }) };
  }
  let importContent = p.content;
  if (row.authority.remote) {
    const compiled_truth = preserveProtectedTakes(parsedInput.compiled_truth, base?.page.compiled_truth ?? '');
    const timeline = preserveProtectedTakes(parsedInput.timeline ?? '', base?.page.timeline ?? '');
    if (compiled_truth !== parsedInput.compiled_truth || timeline !== (parsedInput.timeline ?? '')) {
      importContent = serializePageToMarkdown({ ...(base?.page ?? { id: 0, source_id: row.source_id, created_at: new Date(), updated_at: new Date() }),
        ...parsedInput, compiled_truth, timeline } as Page, parsedInput.tags);
    }
  }
  let prepared: PreparedContentImport | undefined;
  const importOptions = { ...source, noEmbed: true, remote: row.authority.remote, activePack,
    filename: basename(p.sourcePath).replace(/\.mdx?$/i, ''), sourcePath: p.sourcePath, allowEmptyOverwrite: true };
  const result = await importFromContent(engine, renamed?.slug ?? row.slug, importContent, { ...importOptions,
    prepare: async value => { prepared = value; return value.result; } });
  if (!prepared) throw syncPublicationRefusal('invalid_params', result.error ?? 'The sync file could not be prepared.', row, p,
    `The file could not be prepared as page ${row.slug}.`);
  const ready = prepared;
  if (ready.observedRevision !== (base?.revision ?? null)) throw syncPublicationRefusal('revision_conflict', 'The page changed during sync preparation.', row, p,
    `Page ${renamed?.slug ?? row.slug} changed while this sync was being prepared.`);
  if (ready.slug !== (renamed?.slug ?? row.slug)) {
    // Cross-slug dedup must never advance the origin's checkpoint without a
    // guarded proof about the other identity. Keep the cursor explicitly blocked.
    throw syncPublicationRefusal('revision_conflict', 'A different page already owns this file identity; resolve the duplicate before syncing.', row, p,
      `Page ${ready.slug} already holds the content identity of ${renamed?.slug ?? row.slug}; resolve the duplicate pages first.`);
  }
  const parsed = parseMarkdown(p.content, `${row.slug}.md`, { activePack });
  resolveParsedSubtype(parsed, base?.page);
  const tags = [...new Set([...(base?.tags ?? []), ...ready.parsedPage.tags])].sort();
  const renderedPage = { ...(base?.page ?? { id: 0, source_id: row.source_id, created_at: new Date(), updated_at: new Date() }), ...ready.parsedPage } as Page;
  if (renamed && parsedInput.typeExplicit !== true) renderedPage.type = parsedInput.type;
  const canonical = (page: Pick<typeof parsed, 'type' | 'title' | 'compiled_truth' | 'timeline' | 'frontmatter'>, tags: string[]) => ({ type: page.type, title: page.title, body: page.compiled_truth,
    timeline: page.timeline ?? '', frontmatter: page.frontmatter, tags: [...new Set(tags)].sort() });
  // A move re-infers an implicit type from the new location, as a fresh import there would.
  const renamedType = renamed && parsedInput.typeExplicit !== true ? parsedInput.type : undefined;
  const overlay = digest(canonical(parsed, parsed.tags)) !== digest(canonical({ ...ready.parsedPage, type: renamedType ?? ready.parsedPage.type }, tags));
  if (overlay && p.companyApproval) throw syncPublicationRefusal('source_writeback_required', 'Canonical preparation requires a source-content correction; this profile never writes repository files.', row, p,
    `The file of ${row.slug} needs a canonical correction, and a company-brain source never rewrites repository files; correct it in the repository and commit.`);
  // #5409: a read-only mirror keeps its canonical metadata in the database only; its checkout stays the remote's bytes.
  const mirrorReadOnly = overlay && await sourceMirrorReadOnly(engine, row.source_id);
  const writeback = overlay && !mirrorReadOnly;
  if (writeback && !p.lineEndingOnly && p.rawHash !== sha256(p.content)) throw syncPublicationRefusal('source_changed', 'Canonical sanitization cannot overwrite newer working-tree bytes.', row, p,
    `The canonical correction for ${row.slug} would overwrite newer working-tree bytes; preserve the local edit and commit it.`);
  // A rename projects against the moved page (same id), so its pinned timeline rows carry over.
  const project = await prepareCanonicalProjections(engine, ready.parsedPage, row.slug, row.source_id, base, p.companyApproval ? 'immutable' : 'file');
  return { observedRevision: snapshot?.revision ?? null,
    // Tells the #5470 screen the content is unchanged; publication still queues its effects.
    contentUnchanged: ready.noop && !moved && !writeback,
    ...(renamed ? { additionalPageKeys: [{ sourceId: row.source_id, slug: renamed.slug }] } : {}),
    validate: async tx => { await validate(tx); await ready.validate(tx); },
    deferEmbedding: p.processingOptions?.noEmbed,
    ...(writeback ? { file: { root, path: join(root, p.path), content: serializePageToMarkdown(renderedPage, tags), expectedBeforeHash: p.rawHash } } : {}),
    ...(mirrorReadOnly ? { databaseOnlyReason: 'mirror_read_only' as const } : {}),
    apply: async tx => {
      let applied = ready;
      if (renamed) {
        // The page moves first, keeping its id, inbound links and history and leaving
        // `old -> new` in slug_aliases; the file content is then prepared against it.
        if (await tx.updateSlug(renamed.slug, row.slug, source) !== 1) throw syncPublicationRefusal('page_identity_changed', 'The renamed page could not move to its new slug.', row, p,
          `Page ${renamed.slug} could not move to ${row.slug}.`);
        if (renamedType) await tx.executeRaw('UPDATE pages SET type=$3 WHERE source_id=$1 AND slug=$2', [row.source_id, row.slug, renamedType]);
        let movedImport: PreparedContentImport | undefined;
        await importFromContent(tx, row.slug, importContent, { ...importOptions, prepare: async value => { movedImport = value; return value.result; } });
        if (!movedImport || movedImport.slug !== row.slug) throw syncPublicationRefusal('page_identity_changed', 'The renamed page could not be prepared at its new slug.', row, p,
          `Page ${renamed.slug} could not be prepared at ${row.slug}.`);
        await movedImport.validate(tx);
        applied = movedImport;
      }
      await applied.apply(tx);
      // Hash no-ops still repair a missing physical origin under the same guard.
      await tx.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2 AND source_path IS DISTINCT FROM $3', [row.source_id, row.slug, p.sourcePath]);
      if (!applied.noop || p.companyApproval) await project(tx);
      if (!applied.noop) await sealPageTextProjection(tx, row.slug, row.source_id);
      return { status: moved ? 'renamed' : applied.noop ? 'skipped' : snapshot ? 'updated' : 'created', slug: row.slug, source_id: row.source_id,
        chunks: applied.result.chunks, noop: applied.noop && !moved, imported_file: true, ...(moved ? { renamed_from: moved.slug } : {}) };
    } };
}
