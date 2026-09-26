import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { loadConfig, loadConfigWithEngine, type GBrainConfig } from '../config.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { validatePageSlug, slugUnderBoundPrefixes } from '../ops/context.ts';
import { isValidSourceId } from '../source-id.ts';
import { submissionAuthority, authorizeStoredRequest } from './authority.ts';
import { currentVerifiedLocalWriter } from './identity.ts';
import { admitWrite, assertPageRequestIdentity, assertReplayIntent, getWriteRequest, intentDigest } from './journal.ts';
import { assertPersistenceAccepting, waitForWrite, writeResponse } from './service.ts';
import { digest, requireUuid, sha256, stableJson } from './digest.ts';
import { reconcileCanonical, reconcileDecisions, strictReconcileKeys } from './reconcile-merge.ts';
import { assertReconcilePins, readReconcileState, staleReconcile, validateReconcileArtifact, type ReconcileArtifact, type ReconcileState } from './reconcile-state.ts';
import { prepareReconcileResult } from './reconcile-prepare.ts';
import { assertReconcileOutputPath, assertReconcileSize, manageReconcileBackups, retainReconcileBackup } from './reconcile-backup.ts';
import type { LocalGrant } from './identity.ts';
import { isTerminal } from './model.ts';
import { serializePageToMarkdown } from '../markdown.ts';

export { assertReconcileOutputPath } from './reconcile-backup.ts';
export type { ReconcileArtifact } from './reconcile-state.ts';

async function authorize(engine: BrainEngine, sourceId: unknown, slug: unknown) {
  const verified = currentVerifiedLocalWriter();
  if (!verified || verified.remote || verified.principal.kind !== 'local_cli') throw new OperationError('permission_denied', 'Reconciliation requires a verified trusted local CLI caller.');
  if (typeof sourceId !== 'string' || !isValidSourceId(sourceId) || typeof slug !== 'string' || !slug) throw new OperationError('invalid_params', 'One explicit source ID and page slug are required.');
  validatePageSlug(slug);
  if (/[?*]/.test(slug)) throw new OperationError('invalid_params', 'Reconciliation requires an exact page slug, not a pattern.');
  const permitted = (grant: LocalGrant) => (grant.sourceIds.includes('*') || grant.sourceIds.includes(sourceId)) &&
    grant.scopes.includes('write') && (grant.operations === null || grant.operations.includes('put_page')) &&
    (grant.slugPrefixes === null || slugUnderBoundPrefixes(grant.slugPrefixes, slug));
  if (!permitted(verified.grant)) throw new OperationError('permission_denied', 'Reconciliation exceeds the original CLI grant.');
  const [writer] = await engine.executeRaw<{ grant_ceiling: LocalGrant; revoked_at: unknown; lane: string }>(
    'SELECT grant_ceiling,revoked_at,lane FROM persistence_local_writers WHERE id=$1::uuid', [verified.principal.id]);
  if (!writer || writer.revoked_at !== null || writer.lane !== 'cli' || !permitted(writer.grant_ceiling)) {
    throw new OperationError('permission_denied', 'Reconciliation exceeds the current CLI grant.');
  }
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) throw new OperationError('source_changed', 'The explicit source is missing or archived.');
  const authority = await submissionAuthority({ engine, remote: false, sourceId } as OperationContext, 'put_page', sourceId, source.incarnation, slug);
  return { sourceId, slug, authority };
}
function assertPreimages(artifact: ReconcileArtifact, state: ReconcileState): void {
  assertReconcilePins(artifact.preconditions, state.pins);
  const canonical = (snapshot: typeof state.snapshot) => ({ page: reconcileCanonical(snapshot.page, snapshot.tags), revision: snapshot.revision,
    sourceIncarnation: snapshot.sourceIncarnation, withdrawals: snapshot.withdrawals,
    provenance: Object.fromEntries(['id', 'slug', 'source_id', 'source_path', 'source_kind', 'source_uri', 'ingested_via', 'ingested_at',
      'knowledge_revision', 'deleted_at'].map(key => [key, snapshot.page[key as keyof typeof snapshot.page]])) });
  if (artifact.preimages.file_base64 !== state.raw.toString('base64') || digest(canonical(artifact.preimages.database)) !== digest(canonical(state.snapshot)) ||
    digest(artifact.preimages.stored_page) !== digest(state.storedPage)) staleReconcile('preimages changed or were edited');
}
async function config(engine: BrainEngine): Promise<GBrainConfig> {
  return await loadConfigWithEngine(engine, loadConfig()) ?? { engine: engine.kind } as GBrainConfig;
}
export async function runReconcilePreview(engine: BrainEngine, params: Record<string, unknown>): Promise<Record<string, unknown> & { preview: ReconcileArtifact }> {
  strictReconcileKeys(params, ['source_id', 'slug', 'from', 'decisions', 'output_path'], ['source_id', 'slug']);
  const { sourceId, slug } = await authorize(engine, params.source_id, params.slug);
  if (params.output_path !== undefined) {
    if (typeof params.output_path !== 'string') throw new OperationError('invalid_params', 'output_path must be an absolute private file path.');
    await assertReconcileOutputPath(engine, sourceId, params.output_path);
  }
  const from = params.from === undefined ? undefined : validateReconcileArtifact(params.from);
  if (params.decisions !== undefined && !from) throw new OperationError('invalid_params', 'Decisions require the previous private preview artifact.');
  if (from && (from.preconditions.source_id !== sourceId || from.preconditions.slug !== slug)) throw new OperationError('invalid_params', 'The previous preview names a different page.');
  const state = await readReconcileState(engine, sourceId, slug, from?.preconditions.assessment_at);
  if (from) assertPreimages(from, state);
  const decisions = reconcileDecisions(params.decisions ?? from?.decisions ?? []);
  const prepared = await prepareReconcileResult(engine, state, decisions);
  const preview: ReconcileArtifact = { format_version: 1, preview_id: from?.preview_id ?? randomUUID(), preconditions: state.pins,
    preimages: JSON.parse(stableJson({ file_base64: state.raw.toString('base64'), database: state.snapshot, stored_page: state.storedPage })),
    decisions, conflicts: prepared.conflicts, result: prepared.result, result_digest: digest(prepared.result),
    status: prepared.conflicts.length ? 'needs_resolution' : 'ready' };
  await assertReconcileSize(engine, preview);
  return { source_id: sourceId, slug, preview_id: preview.preview_id, status: preview.status,
    conflict_paths: prepared.conflicts.map(c => c.path), protected_paths: prepared.protectedPaths,
    migrated_scan_paths: prepared.scanPaths, relative_path: state.pins.relative_path,
    line_endings: state.raw.includes(Buffer.from('\r\n')) ? 'crlf' : 'lf',
    formatting_only: digest(state.file) === digest(reconcileCanonical(state.snapshot.page, state.snapshot.tags)) &&
      sha256(serializePageToMarkdown(state.snapshot.page, state.snapshot.tags)) !== state.pins.raw_file_hash,
    result_digest: preview.result_digest, preview };
}
export async function runReconcileApply(engine: BrainEngine, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  strictReconcileKeys(params, ['source_id', 'slug', 'preview', 'request_id']);
  const { sourceId, slug, authority } = await authorize(engine, params.source_id, params.slug);
  const artifact = validateReconcileArtifact(params.preview);
  artifact.decisions = reconcileDecisions(artifact.decisions);
  const requestId = requireUuid(params.request_id as string);
  if (artifact.preconditions.source_id !== sourceId || artifact.preconditions.slug !== slug || artifact.status !== 'ready' || artifact.conflicts.length) {
    throw new OperationError('invalid_params', 'Apply requires a ready preview for this exact source and page.');
  }
  const callerIntent = { kind: 'canonical_reconcile', preview: artifact };
  const expectedDigest = intentDigest({ operation: 'put_page', sourceId, slug, callerIntent });
  await assertPageRequestIdentity(engine, authority.principal, requestId);
  const replay = async () => {
    const prior = await getWriteRequest(engine, authority.principal, requestId);
    if (!prior) return null;
    assertReplayIntent(prior, expectedDigest);
    await authorizeStoredRequest(engine, prior);
    return writeResponse(isTerminal(prior) ? prior : await waitForWrite(engine, prior, await config(engine)));
  };
  const prior = await replay();
  if (prior) return prior;
  try {
    assertPersistenceAccepting(engine);
    await assertReconcileSize(engine, artifact);
    const state = await readReconcileState(engine, sourceId, slug, artifact.preconditions.assessment_at);
    assertPreimages(artifact, state);
    const prepared = await prepareReconcileResult(engine, state, artifact.decisions);
    if (!prepared.ready || digest(prepared.result) !== artifact.result_digest) staleReconcile('resolved content or canonical policy changed');
    const preparedReplay = await replay();
    if (preparedReplay) return preparedReplay;
    const reference = await retainReconcileBackup(engine, artifact, authority.principal, requestId);
    const retainedReplay = await replay();
    if (retainedReplay) return retainedReplay;
    const current = await readReconcileState(engine, sourceId, slug, artifact.preconditions.assessment_at);
    assertPreimages(artifact, current);
    const row = await admitWrite(engine, { principal: authority.principal, operation: 'put_page', sourceId,
      sourceIncarnation: state.pins.source_incarnation, slug, pageId: state.pins.page_id, worktreeId: state.pins.worktree_id,
      topologyGeneration: state.binding.topology_generation, requestId, authority, callerIntent,
      intent: { ...callerIntent, backup_reference: reference } });
    return writeResponse(await waitForWrite(engine, row, await config(engine)));
  } catch (error) {
    const racedReplay = await replay();
    if (racedReplay) return racedReplay;
    if (error instanceof OperationError) throw error;
    throw new OperationError('storage_error', 'Reconciliation could not preserve or publish its private artifacts.', 'Inspect private storage capacity and permissions before retrying the same request ID.');
  }
}

export async function runReconcileBackups(engine: BrainEngine, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  strictReconcileKeys(params, ['source_id', 'slug', 'action', 'backup_reference', 'after', 'limit'], ['source_id', 'slug', 'action']);
  const { slug, authority } = await authorize(engine, params.source_id, params.slug);
  if (!['list', 'remove'].includes(String(params.action)) || params.action === 'remove' &&
    (typeof params.backup_reference !== 'string' || params.after !== undefined || params.limit !== undefined) ||
    params.action === 'list' && params.backup_reference !== undefined || params.limit !== undefined &&
    (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 100)) {
    throw new OperationError('invalid_params', 'Invalid exact-page backup administration parameters.');
  }
  try {
    return await manageReconcileBackups(engine, authority, slug, { action: params.action as 'list' | 'remove',
      backup_reference: params.backup_reference as string | undefined, after: params.after === undefined ? undefined : requireUuid(params.after as string),
      limit: params.limit as number | undefined });
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError('storage_error', 'Private reconciliation backup administration failed.', 'Inspect the private backup directory permissions and capacity.');
  }
}
