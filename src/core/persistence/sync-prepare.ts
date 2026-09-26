import { realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { Page } from '../types.ts';
import { OperationError } from '../ops/contract.ts';
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
import { assertConfiguredSyncRoot, assertSyncEntryOrigin, syncGit, syncRawHash } from './sync-discovery.ts';
import { assertSyncPageOrigin, syncOriginPath } from './sync-origin.ts';
import { assertManagedSyncActive, validateSyncAuthority, type SyncAuthority, type SyncProcessingOptions } from './sync-authority.ts';
import type { PreparedContentImport } from './prepared-import.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';
import { loadActivePackForEngine, checkApprovedSchemaForEngine } from '../schema-pack/engine-resolution.ts';
import type { CompanyBrainPlan } from '../company-brain/types.ts';
import { companyBrainProfile } from '../company-brain/profile.ts';
import { companyBrainPolicyFingerprint } from '../company-brain/policy.ts';

export interface SyncIntent extends Record<string, unknown> {
  companyApproval?: { schema: NonNullable<CompanyBrainPlan['schema']>; planDigest: string; extractorVersion: string; policyFingerprint: string };
  kind: 'managed_sync_import' | 'managed_sync_delete' | 'managed_sync_checkpoint';
  expected_revision: string | null; sourcePath: string | null; path: string | null;
  rawHash: string | null; content: string | null; ownerEpoch: string;
  lineEndingOnly?: boolean;
  working?: boolean;
  processingOptions?: SyncProcessingOptions;
  syncAuthority: SyncAuthority; cursorKey: string; runId: string; index: number;
  from: string | null; target: string; total: number; slugMode: 'git-root' | 'source-root';
}
export async function prepareManagedSyncMutation(engine: BrainEngine, row: WriteRequest, _config: GBrainConfig): Promise<PreparedMutation> {
  const p = row.intent as SyncIntent | null;
  if (!p || !['managed_sync_import', 'managed_sync_delete', 'managed_sync_checkpoint'].includes(p.kind)) throw new OperationError('invalid_params', 'Unsupported internal sync intent.');
  await assertManagedSyncActive(engine);
  if (p.kind !== 'managed_sync_delete' && (!p.processingOptions ||
      ['noEmbed', 'noExtract', 'noSchemaPack'].some(key => typeof p.processingOptions?.[key as keyof SyncProcessingOptions] !== 'boolean'))) {
    throw new OperationError('invalid_params', 'The legacy sync request has no durable processing options.',
      'Inspect this unchanged request, then use --retry-failed with explicit sync options to rediscover. Unknown embedding and schema consent cannot be inferred from a retry.');
  }
  await validateSyncAuthority(engine, p.syncAuthority, row.slug);
  const binding = await getWorktreeBinding(engine, row.source_id);
  if (!binding?.local_path || String(binding.owner_epoch) !== p.ownerEpoch) throw new OperationError('owner_unavailable', 'The accepted sync owner changed.');
  const root = join(binding.local_path, binding.relative_path);
  const [configuredSource] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [row.source_id]);
  assertConfiguredSyncRoot(root, configuredSource?.local_path ?? null);
  if (p.kind !== 'managed_sync_checkpoint') await assertKnowledgePublicationAllowed(engine, row,
    p.path === null ? undefined : { root, path: join(root, p.path) });
  let origin: Parameters<typeof assertSyncEntryOrigin>[1] | undefined;
  let originContext: Parameters<typeof assertSyncEntryOrigin>[0] | undefined;
  if (p.kind !== 'managed_sync_checkpoint') {
    if (typeof p.path !== 'string' || typeof p.sourcePath !== 'string') throw new OperationError('storage_error', 'The accepted sync origin is missing.');
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
    await assertSyncPageOrigin(engine, row.source_id, p.sourcePath, row.page_id, p.kind === 'managed_sync_delete');
  }
  const validate = async (tx: BrainEngine) => {
    await assertManagedSyncActive(tx, true);
    await validateSyncAuthority(tx, p.syncAuthority, row.slug);
    const [configuredSource] = await tx.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1 FOR SHARE', [row.source_id]);
    assertConfiguredSyncRoot(root, configuredSource?.local_path ?? null);
    const [cursor] = await tx.executeRaw<{ run_id: string; request_id: string | null }>(
      "SELECT completed_keys->0->>'runId' AS run_id,completed_keys->0->'pending'->>'requestId' AS request_id FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1 FOR SHARE", [p.cursorKey]);
    if (cursor && (cursor.run_id !== p.runId || cursor.request_id !== row.request_id)) throw new OperationError('revision_conflict', 'The accepted sync cursor changed before publication.');
    const current = await getWorktreeBinding(tx, row.source_id);
    if (!current || String(current.owner_epoch) !== p.ownerEpoch) throw new OperationError('owner_unavailable', 'The accepted sync owner epoch changed.');
    if (p.kind !== 'managed_sync_checkpoint') await assertKnowledgePublicationAllowed(tx, row,
      p.path === null ? undefined : { root, path: join(root, p.path) });
    if (p.path !== null && syncRawHash(root, p.path) !== p.rawHash) throw new OperationError('source_changed', 'The imported file changed after sync admission.');
    if (origin && originContext) {
      assertSyncEntryOrigin(originContext, origin);
      await assertSyncPageOrigin(tx, row.source_id, origin.sourcePath, row.page_id, p.kind === 'managed_sync_delete');
    }
    if (p.companyApproval) {
      const [source] = await tx.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [row.source_id]);
      const policy = companyBrainProfile(source?.config);
      if (!policy || policy.planDigest !== p.companyApproval.planDigest || policy.extractorVersion !== p.companyApproval.extractorVersion || policy.approvedRevision !== p.target ||
        companyBrainPolicyFingerprint(policy, row.source_id) !== p.companyApproval.policyFingerprint) {
        throw new OperationError('source_changed', 'The company source approval changed.');
      }
      const schema = p.companyApproval.schema;
      await checkApprovedSchemaForEngine(tx, { name: schema.name, identity: schema.identity, resolvedManifestHash: schema.resolved_digest }, { remote: false, sourceId: row.source_id });
    }
  };
  if (p.kind === 'managed_sync_checkpoint') return { sourceExclusive: true, observedRevision: null, validate, apply: async tx => {
    const [cursor] = await tx.executeRaw<{ completed_keys: [{ runId: string; index: number; total: number }] }>(
      "SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1 FOR UPDATE", [p.cursorKey]);
    if (!cursor || cursor.completed_keys[0].runId !== p.runId || cursor.completed_keys[0].index !== p.total || cursor.completed_keys[0].total !== p.total) {
      throw new OperationError('revision_conflict', 'The sync cursor is not fully committed.');
    }
    const [manifest] = await tx.executeRaw<{ count: number }>("SELECT jsonb_array_length(completed_keys) AS count FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [p.runId]);
    if (!manifest || Number(manifest.count) !== p.total) throw new OperationError('storage_error', 'The immutable sync manifest is incomplete.');
    const [incomplete] = await tx.executeRaw(`SELECT r.id FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND
      (r.recovery IS NOT NULL OR (r.intent->>'runId'=$2 AND r.intent->>'kind' IN ('managed_sync_import','managed_sync_delete') AND r.state<>'committed'
        AND (r.state IN ('queued','running','recovering') OR NOT EXISTS (SELECT 1 FROM persistence_requests committed
          WHERE committed.source_id=r.source_id AND committed.intent->>'runId'=$2 AND committed.intent->>'index'=r.intent->>'index' AND committed.state='committed')))) LIMIT 1`,
      [row.worktree_id, p.runId]);
    if (incomplete) throw new OperationError('recovery_required', 'An incomplete page receipt still blocks the sync checkpoint.');
    const changed = await tx.executeRaw(`UPDATE sources SET last_commit=$3,last_sync_at=now(),config=jsonb_set(${SOURCE_CONFIG_OBJECT_SQL},'{slug_root_mode}',to_jsonb($5::text)),
      newest_content_at=(SELECT MAX(updated_at) FROM pages WHERE source_id=$1 AND deleted_at IS NULL)
      WHERE id=$1 AND incarnation=$2::uuid AND last_commit IS NOT DISTINCT FROM $4
      AND (config->>'slug_root_mode' IS NULL OR config->>'slug_root_mode'=$5) RETURNING id`, [row.source_id, row.source_incarnation, p.target, p.from, p.slugMode]);
    if (!changed.length) throw new OperationError('revision_conflict', 'The source checkpoint changed during this sync.');
    await tx.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,done}','true'::jsonb),updated_at=now() WHERE op='managed-sync' AND fingerprint=$1", [p.cursorKey]);
    return { status: 'synced', source_id: row.source_id, committed_pages: p.total };
  } };
  const source = { sourceId: row.source_id };
  const snapshot = await engine.readPageSnapshot(row.slug, { ...source, includeDeleted: true });
  assertPageRevision(snapshot, p.expected_revision === null ? {} : { expectedRevision: p.expected_revision });
  if ((snapshot?.page.id ?? null) !== row.page_id || (snapshot?.page.source_path != null && syncOriginPath(snapshot.page.source_path) !== syncOriginPath(p.sourcePath!))) {
    throw new OperationError('page_identity_changed', 'The imported path no longer names the accepted page.');
  }
  if (p.kind === 'managed_sync_delete') return { observedRevision: snapshot?.revision ?? null, noop: !snapshot || snapshot.page.deleted_at != null,
    validate, apply: async tx => {
      if (snapshot && snapshot.page.deleted_at == null) { await tx.createVersion(row.slug, source); await tx.softDeletePage(row.slug, source); }
      return { status: 'soft_deleted', slug: row.slug, source_id: row.source_id, noop: !snapshot || snapshot.page.deleted_at != null };
    } };
  if (typeof p.content !== 'string' || typeof p.sourcePath !== 'string' || typeof p.path !== 'string') throw new OperationError('storage_error', 'The frozen import content is missing.');
  if (isCodeFilePath(p.sourcePath)) {
    if (p.companyApproval) throw new OperationError('profile_incompatible', 'Company source approval permits only committed Markdown content.');
    if (snapshot && !p.lineEndingOnly && p.rawHash !== sha256(p.content) && snapshot.page.compiled_truth !== p.content) {
      throw new OperationError('source_changed', 'Newer code file bytes disagree with the pinned import.');
    }
    let prepared: PreparedContentImport | undefined;
    const result = await importCodeFile(engine, p.sourcePath, p.content, { ...source, noEmbed: true,
      prepare: async value => { prepared = value; return value.result; } });
    if (!prepared || prepared.slug !== row.slug) throw new OperationError('invalid_params', result.error ?? 'The code file identity could not be prepared.');
    const ready = prepared;
    if (ready.observedRevision !== (snapshot?.revision ?? null)) throw new OperationError('revision_conflict', 'The code page changed during preparation.');
    return { observedRevision: ready.observedRevision, validate, noop: ready.noop, deferEmbedding: true, apply: async tx => {
      await ready.apply(tx);
      return { status: ready.noop ? 'skipped' : snapshot ? 'updated' : 'created', slug: row.slug, source_id: row.source_id,
        chunks: result.chunks, noop: ready.noop, imported_file: true };
    } };
  }
  const schema = p.companyApproval?.schema;
  if (schema && p.processingOptions?.noSchemaPack) throw new OperationError('profile_incompatible', 'Company source approval requires its pinned schema pack.');
  const activePack = p.processingOptions?.noSchemaPack ? undefined : schema ? (await checkApprovedSchemaForEngine(engine, { name: schema.name, identity: schema.identity, resolvedManifestHash: schema.resolved_digest },
    { remote: false, sourceId: row.source_id })).pack.manifest : (await loadActivePackForEngine(engine, { remote: row.authority.remote, sourceId: row.source_id }).catch(() => null))?.manifest;
  const parsedInput = parseMarkdown(p.content, row.slug, { activePack });
  resolveParsedSubtype(parsedInput, snapshot?.page);
  const expectedSlug = resolveSlugForPath(p.sourcePath);
  const retainedWindowsOrigin = process.platform === 'win32' && snapshot?.page.source_path != null &&
    syncOriginPath(snapshot.page.source_path) === syncOriginPath(p.sourcePath) && parsedInput.slug === snapshot.page.slug;
  if (expectedSlug && parsedInput.slug !== expectedSlug && slugifyPath(parsedInput.slug) !== expectedSlug && !retainedWindowsOrigin) {
    throw new OperationError('invalid_params', 'The file frontmatter slug conflicts with its physical origin.');
  }
  if (!p.companyApproval && snapshot && !p.lineEndingOnly && p.rawHash !== sha256(p.content) && !sameCanonicalImport(snapshot, parsedInput)) {
    throw new OperationError('source_changed', 'Newer working-tree bytes and the current page disagree with this pinned Git import.');
  }
  let importContent = p.content;
  if (row.authority.remote) {
    const compiled_truth = preserveProtectedTakes(parsedInput.compiled_truth, snapshot?.page.compiled_truth ?? '');
    const timeline = preserveProtectedTakes(parsedInput.timeline ?? '', snapshot?.page.timeline ?? '');
    if (compiled_truth !== parsedInput.compiled_truth || timeline !== (parsedInput.timeline ?? '')) {
      importContent = serializePageToMarkdown({ ...(snapshot?.page ?? { id: 0, source_id: row.source_id, created_at: new Date(), updated_at: new Date() }),
        ...parsedInput, compiled_truth, timeline } as Page, parsedInput.tags);
    }
  }
  let prepared: PreparedContentImport | undefined;
  const result = await importFromContent(engine, row.slug, importContent, { ...source, noEmbed: true, remote: row.authority.remote, activePack,
    filename: basename(p.sourcePath).replace(/\.mdx?$/i, ''), sourcePath: p.sourcePath, allowEmptyOverwrite: true,
    prepare: async value => { prepared = value; return value.result; } });
  if (!prepared) throw new OperationError('invalid_params', result.error ?? 'The sync file could not be prepared.');
  const ready = prepared;
  if (ready.observedRevision !== (snapshot?.revision ?? null)) throw new OperationError('revision_conflict', 'The page changed during sync preparation.');
  if (ready.slug !== row.slug) {
    // Cross-slug dedup must never advance the origin's checkpoint without a
    // guarded proof about the other identity. Keep the cursor explicitly blocked.
    throw new OperationError('revision_conflict', 'A different page already owns this file identity; resolve the duplicate before syncing.');
  }
  const parsed = parseMarkdown(p.content, row.slug, { activePack });
  resolveParsedSubtype(parsed, snapshot?.page);
  const tags = [...new Set([...(snapshot?.tags ?? []), ...ready.parsedPage.tags])].sort();
  const renderedPage = { ...(snapshot?.page ?? { id: 0, source_id: row.source_id, created_at: new Date(), updated_at: new Date() }), ...ready.parsedPage } as Page;
  const canonical = (page: Pick<typeof parsed, 'type' | 'title' | 'compiled_truth' | 'timeline' | 'frontmatter'>, tags: string[]) => ({ type: page.type, title: page.title, body: page.compiled_truth,
    timeline: page.timeline ?? '', frontmatter: page.frontmatter, tags: [...new Set(tags)].sort() });
  const overlay = digest(canonical(parsed, parsed.tags)) !== digest(canonical(ready.parsedPage, tags));
  if (overlay && p.companyApproval) throw new OperationError('source_writeback_required', 'Canonical preparation requires a source-content correction; this profile never writes repository files.');
  if (overlay && !p.lineEndingOnly && p.rawHash !== sha256(p.content)) throw new OperationError('source_changed', 'Canonical sanitization cannot overwrite newer working-tree bytes.');
  const project = prepareCanonicalProjections(ready.parsedPage, row.slug, row.source_id);
  return { observedRevision: snapshot?.revision ?? null, validate, deferEmbedding: p.processingOptions?.noEmbed,
    ...(overlay ? { file: { root, path: join(root, p.path), content: serializePageToMarkdown(renderedPage, tags), expectedBeforeHash: p.rawHash } } : {}),
    apply: async tx => {
      await ready.apply(tx);
      // Hash no-ops still repair a missing physical origin under the same guard.
      await tx.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2 AND source_path IS DISTINCT FROM $3', [row.source_id, row.slug, p.sourcePath]);
      if (!ready.noop || p.companyApproval) await project(tx);
      if (!ready.noop) await sealPageTextProjection(tx, row.slug, row.source_id);
      return { status: ready.noop ? 'skipped' : snapshot ? 'updated' : 'created', slug: row.slug, source_id: row.source_id,
        chunks: result.chunks, noop: ready.noop, imported_file: true };
    } };
}
