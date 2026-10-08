import { randomUUID } from 'node:crypto';
import { relative, sep } from 'node:path';
import { hardenedPathDirty } from '../hardened-git.ts';
import type { BrainEngine } from '../engine.ts';
import { loadConfig, loadConfigWithEngine, type GBrainConfig } from '../config.ts';
import { OperationError, opError, type OperationContext } from '../ops/contract.ts';
import { validatePageSlug, slugUnderBoundPrefixes } from '../ops/context.ts';
import { isValidSourceId } from '../source-id.ts';
import { submissionAuthority, authorizeStoredRequest } from './authority.ts';
import { currentVerifiedLocalWriter } from './identity.ts';
import { admitWrite, assertPageRequestIdentity, assertReplayIntent, getWriteRequest, intentDigest } from './journal.ts';
import { assertPersistenceAccepting, waitForWrite, writeResponse } from './service.ts';
import { digest, requireUuid, sha256, stableJson } from './digest.ts';
import { mergeReconcile, reconcileCanonical, reconcileDecisions, strictReconcileKeys } from './reconcile-merge.ts';
import { additiveDecisions, assertAutoDecisions, classifyDrift, type AutoDecision, type DriftClassification } from './reconcile-additive.ts';
import { assertReconcilePins, readReconcileState, staleReconcile, validateReconcileArtifact, type ReconcileArtifact, type ReconcileState } from './reconcile-state.ts';
import { prepareReconcileResult } from './reconcile-prepare.ts';
import { assertReconcileOutputPath, assertReconcileSize, manageReconcileBackups, retainReconcileBackup } from './reconcile-backup.ts';
import type { LocalGrant } from './identity.ts';
import { isTerminal } from './model.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';

export { assertReconcileOutputPath } from './reconcile-backup.ts';
export type { ReconcileArtifact } from './reconcile-state.ts';

function grantFix(): Action {
  return readFix('Shows the CLI writer registration and its sources, operations and slug-prefix grant.', { argv: ['gbrain', 'auth', 'local-writer', 'list', '--json'] });
}
async function authorize(engine: BrainEngine, sourceId: unknown, slug: unknown) {
  const verified = currentVerifiedLocalWriter();
  if (!verified || verified.remote || verified.principal.kind !== 'local_cli') throw trustedCliRequired('Reconciliation requires a verified trusted local CLI caller.');
  if (typeof sourceId !== 'string' || !isValidSourceId(sourceId) || typeof slug !== 'string' || !slug) throw opError('invalid_params', 'One explicit source ID and page slug are required.',
    'Pass the source ID and the exact page slug as the first two arguments of gbrain sources reconcile.');
  validatePageSlug(slug);
  if (/[?*]/.test(slug)) throw opError('invalid_params', 'Reconciliation requires an exact page slug, not a pattern.',
    `Reconcile one page at a time by its exact slug; an --audit run for source ${sourceId} lists the pages that drifted.`);
  const permitted = (grant: LocalGrant) => (grant.sourceIds.includes('*') || grant.sourceIds.includes(sourceId)) &&
    grant.scopes.includes('write') && (grant.operations === null || grant.operations.includes('put_page')) &&
    (grant.slugPrefixes === null || slugUnderBoundPrefixes(grant.slugPrefixes, slug));
  if (!permitted(verified.grant)) throw opError('permission_denied', 'Reconciliation exceeds the original CLI grant.',
    `The CLI writer registration does not grant put_page on ${slug} in '${sourceId}'. Review its grant with the command in fix; widening it is the user's decision.`, { fix: grantFix() });
  const [writer] = await engine.executeRaw<{ grant_ceiling: LocalGrant; revoked_at: unknown; lane: string }>(
    'SELECT grant_ceiling,revoked_at,lane FROM persistence_local_writers WHERE id=$1::uuid', [verified.principal.id]);
  if (!writer || writer.revoked_at !== null || writer.lane !== 'cli' || !permitted(writer.grant_ceiling)) {
    throw opError('permission_denied', 'Reconciliation exceeds the current CLI grant.',
      `The current CLI writer registration is revoked or no longer grants put_page on ${slug} in '${sourceId}'. Review it with the command in fix; widening or re-registering it is the user's decision.`, { fix: grantFix() });
  }
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) throw opError('source_changed', 'The explicit source is missing or archived.',
    `Source '${sourceId}' is missing or archived. Check it with the command in fix, and restore an archived source before reconciling its pages.`,
    { fix: readFix('Lists registered sources, archived ones included.', { argv: ['gbrain', 'sources', 'list', '--json'] }) });
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
/** Agent-facing next step for an --auto-additive preview. */
function additiveNextAction(classification: DriftClassification, status: string, git: { dirty: boolean | null; root: string; path: string }): string {
  // #6138: agreeing content can still be a modified file in Git (the same content written differently, such as YAML quoting).
  if (classification.verdict === 'no_drift') return git.dirty
    ? `No drift in content: the file and database agree, but Git reports ${git.path} as modified, because its bytes differ from the last commit only in how the same content is written (for example YAML quoting). `
      + `Reconcile does not commit files, so there is nothing to apply here. Show the difference with git -C ${git.root} diff -- ${git.path}; leaving it uncommitted is safe, and committing it by hand is the user's decision. `
      + 'If this preview came from a refused write, retry that write with a new request ID.'
    : 'No drift: the file and database agree' + (git.dirty === false ? ' and Git shows the file unchanged' : '')
      + '. Nothing needs reconciling; if this preview came from a refused write, retry that write with a new request ID.';
  if (classification.verdict === 'review_required') return 'Some paths are not structurally additive (see drift_paths with class review). Do not apply this preview; '
    + 'show the user the private preview file\'s conflicts and result, then resolve with --from <preview> --decisions <file> after they decide.';
  if (status === 'ready') return `Apply with --apply <preview file> --request-id <new uuid>, then retry the original write with a new request ID.`;
  if (classification.verdict !== 'additive_with_suggestions') return 'Resolve the remaining conflict_paths with --from <preview> --decisions <file>; no automatic rule covers them.';
  return 'Inserted text is structurally additive but can still contradict existing text. Read the inserted lines in the private preview file '
    + '(or show them to the user if the page is private or the claims matter), then rerun the preview with --auto-additive --accept-suggested.';
}
/**
 * #6138: whether Git reports the canonical file as changed from its last commit; null when Git cannot say (not a Git checkout).
 * W4.3: filter-free plumbing, never `git status` (which runs the checkout's clean/process filters).
 */
export function canonicalFileGitDirty(root: string, path: string): boolean | null {
  return hardenedPathDirty(root, relative(root, path).split(sep).join('/'));
}
async function config(engine: BrainEngine): Promise<GBrainConfig> {
  return await loadConfigWithEngine(engine, loadConfig()) ?? { engine: engine.kind } as GBrainConfig;
}
export async function runReconcilePreview(engine: BrainEngine, params: Record<string, unknown>): Promise<Record<string, unknown> & { preview: ReconcileArtifact }> {
  strictReconcileKeys(params, ['source_id', 'slug', 'from', 'decisions', 'output_path', 'auto_additive', 'accept_suggested'], ['source_id', 'slug']);
  const auto = params.auto_additive === true;
  if (params.auto_additive !== undefined && typeof params.auto_additive !== 'boolean'
    || params.accept_suggested !== undefined && (typeof params.accept_suggested !== 'boolean' || !auto)) {
    throw opError('invalid_params', 'accept_suggested requires auto_additive; both are booleans.',
      'Pass auto_additive: true with accept_suggested: true, or drop accept_suggested.');
  }
  if (auto && params.decisions !== undefined) throw opError('invalid_params', 'auto_additive computes its own decisions; omit decisions, or resolve manually without auto_additive.',
    'Drop decisions, or drop auto_additive and resolve the preview with decisions.');
  const { sourceId, slug } = await authorize(engine, params.source_id, params.slug);
  if (params.output_path !== undefined) {
    if (typeof params.output_path !== 'string') throw opError('invalid_params', 'output_path must be an absolute private file path.',
      'Pass output_path (CLI: --out) as an absolute path to a new file outside every source checkout.');
    await assertReconcileOutputPath(engine, sourceId, params.output_path);
  }
  const from = params.from === undefined ? undefined : validateReconcileArtifact(params.from);
  if (params.decisions !== undefined && !from) throw opError('invalid_params', 'Decisions require the previous private preview artifact.',
    'Pass the preview being resolved along with the decisions (CLI: --from with the preview file written by --out).');
  if (from && (from.preconditions.source_id !== sourceId || from.preconditions.slug !== slug)) throw opError('invalid_params', 'The previous preview names a different page.',
    `Use the preview made for ${slug} in '${sourceId}', or run the command with the source and slug that preview file names.`);
  const state = await readReconcileState(engine, sourceId, slug, from?.preconditions.assessment_at);
  if (from) assertPreimages(from, state);
  const database = reconcileCanonical(state.snapshot.page, state.snapshot.tags);
  const classification = auto ? classifyDrift(state.file, database) : undefined;
  let decisions = reconcileDecisions(params.decisions ?? from?.decisions ?? []);
  let autoDecisions: AutoDecision[] = params.decisions === undefined ? from?.auto_decisions ?? [] : [];
  if (classification) {
    const chosen = additiveDecisions(classification, mergeReconcile(state.file, database, []).conflicts, state.file, database, params.accept_suggested === true);
    decisions = reconcileDecisions(chosen.decisions);
    autoDecisions = chosen.auto;
  }
  if (autoDecisions.length) assertAutoDecisions(autoDecisions, state.file, database, decisions);
  const prepared = await prepareReconcileResult(engine, state, decisions);
  const reviewRequired = classification?.verdict === 'review_required';
  const preview: ReconcileArtifact = { format_version: autoDecisions.length ? 2 : 1, preview_id: from?.preview_id ?? randomUUID(), preconditions: state.pins,
    preimages: JSON.parse(stableJson({ file_base64: state.raw.toString('base64'), database: state.snapshot, stored_page: state.storedPage })),
    decisions, conflicts: prepared.conflicts, result: prepared.result, result_digest: digest(prepared.result),
    status: prepared.conflicts.length || reviewRequired ? 'needs_resolution' : 'ready', ...(autoDecisions.length ? { auto_decisions: autoDecisions } : {}) };
  await assertReconcileSize(engine, preview);
  const git = { dirty: classification?.verdict === 'no_drift' ? canonicalFileGitDirty(state.root, state.path) : null, root: state.root, path: relative(state.root, state.path) };
  return { source_id: sourceId, slug, preview_id: preview.preview_id, status: preview.status,
    ...(classification ? { classification: classification.verdict, drift_paths: classification.paths,
      auto_decided_paths: autoDecisions.map(d => d.path), next_action: additiveNextAction(classification, preview.status, git),
      ...(git.dirty === null ? {} : { git_dirty: git.dirty }) } : {}),
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
    throw opError('invalid_params', 'Apply requires a ready preview for this exact source and page.',
      `Nothing was submitted. Resolve every conflict first (preview with --from and --decisions until status is ready), then apply that resolved preview for ${slug} in '${sourceId}'.`);
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
    assertAutoDecisions(artifact.auto_decisions ?? [], state.file, reconcileCanonical(state.snapshot.page, state.snapshot.tags), artifact.decisions);
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
    throw opError('invalid_params', 'Invalid exact-page backup administration parameters.',
      'List backups with --backups (optional --limit 1 to 100 and --after cursor), or remove one with --remove-backup and its exact reference and no other options.');
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
