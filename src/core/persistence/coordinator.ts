import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { pageIdentityError } from './page-identity.ts';
import { atomicWriteFileSync, mkdirPrivate } from '../atomic-write.ts';
import { flushDirectory } from '../fs-durable.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { sha256 } from './digest.ts';
import { authorizeStoredRequest } from './authority.ts';
import { localHostId } from './identity.ts';
import { acquireWorktree, getWorktreeBinding, guardOwnership, type WorktreeBinding } from './ownership.ts';
import { chargePreparationAttempt, clearResolvedRecovery, completeWrite, getWriteRequestById, lockCounters, markRecovering, prepareRecovery, releaseUnpublishedClaim } from './journal.ts';
import type { WaitingOn } from './claim-phase.ts';
import { preparationKind } from './preparation-budget.ts';
import { isTerminal, principalKey, requestPrincipal, recoveryFiles, type FileRecoveryRecord, type RecoveryRecord, type WriteRequest } from './model.ts';
import type { NativeLockHandle } from './native-lock.ts';
import { withCoordinatedWrite } from './context.ts';
import { lockCoreSources } from './core-guard.ts';
import { requestAttribution } from './attribution.ts';
import { withFilesystemPublication } from './filesystem-guard.ts';
import { mayReprepare } from './semantic.ts';
import { tryAcquirePublicationCapacity } from './pool-capacity.ts';
import { queuePublicationEffects } from './effect-journal.ts';
import type { GitCommitNote } from './effect-model.ts';
import { authorizePageVisibility } from './page-visibility.ts';
import { withNoRepoWriteThroughWarning } from '../write-through.ts';
import { assertUnboundPublication, classifyUnboundPage, unboundWriteWarning } from './unbound-source.ts';
import { assertRecoveryStagingAbsent, cleanupRecoveryStaging, recoveryStagingFile, upgradeRecoveryStaging } from './staging.ts';
import { assertMutationProtocol, assertSharedSkillPersistence, declareDurablePersistence, PERSISTENCE_PROTOCOL_PREDICATE } from './protocol.ts';
import { assertBundleRecoveryBinding, bundleFileHash, prepareBundleRecovery, publishStagedBundleFile, stageBundleFile, type MutationFile } from './bundle-files.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';
import { classifyMirrorPage, sourceMirrorReadOnly } from './mirror-read-only.ts';
import { databaseRefusal, ownerExceptionFailure, withAttempt, type PublicationFailure, type PublicationFailureDetail, type PublicationStage } from './publication-failure.ts';
import { fenceFailureDetail } from '../fence-repair/refusal.ts';
import { faultPoint, withFaultPoints } from './fault-points.ts';
import { recordPublicationFenceTrend } from '../fence-repair/census-store.ts';

interface PreparedMutationBase {
  sourceExclusive?: boolean;
  /** Always-loaded core writes: source rows locked FOR UPDATE in id order (core-guard.ts lockCoreSources). */
  exclusiveSources?: readonly string[];
  observedRevision: string | null;
  additionalPageKeys?: readonly {sourceId:string;slug:string}[];
  noop?: boolean;
  /** #5470 screening only: the content is unchanged, but publication still runs (and queues effects). */
  contentUnchanged?: boolean;
  deferEmbedding?: boolean;
  /** Why a page write bound to a worktree publishes no file (receipt `write_through.skipped`). */
  databaseOnlyReason?: 'db_only' | 'unbound_source' | 'mirror_read_only';
  /**
   * Must perform only transaction-composable database work. `preimage` (#5984)
   * is the publisher's read of the page under its page guard, after the revision
   * check; apply may use it instead of reading the page again.
   */
  apply(tx: BrainEngine, preimage?: PageSnapshot | null): Promise<Record<string, unknown>>;
  /**
   * #5984: set by apply to its own read of the page (including deleted rows)
   * after its last write to the page; the publisher takes the receipt revision
   * and effects from it instead of reading the page again.
   */
  postimage?: PageSnapshot | null;
  validate?(tx: BrainEngine): Promise<void>;
}
/**
 * A page file target; `publishMode` (Google pages) is the exact mode it publishes with, and its created directories get 0700.
 * `commit` (trusted local preparers only) rides the Git effect into the commit message.
 */
export type PageMutationFile = MutationFile & { publishMode?: number; commit?: GitCommitNote };
export type PreparedMutation = PreparedMutationBase & (
  | { target?: 'page'; file?: PageMutationFile; files?: never }
  | { target: 'skill_bundle'; file?: never; files: MutationFile[]; validate(tx: BrainEngine): Promise<void> }
);
export interface PublicationHooks {
  boundary?(name: 'prepared' | 'before_publication' | 'after_publication' | 'before_commit' | 'after_commit', request: WriteRequest): Promise<void>;
  /** Must be synchronous: the staged file is flushed/closed but not renamed. */
  stagingFlushed?(request: WriteRequest): void;
  fileBoundary?(name: 'before_file' | 'staging_flushed' | 'file_replaced' | 'directory_flushed' | 'after_file'
    | 'before_restore' | 'restoration_staging_flushed' | 'restoration_file_replaced' | 'restoration_directory_flushed' | 'after_restore', request: WriteRequest, index: number): void;
}
function fileHash(path: string): string | null { return existsSync(path) ? sha256(readFileSync(path)) : null; }
const ownerStatusFix = (sourceId?: string): Action => readFix(sourceId
  ? `Shows source ${sourceId}'s canonical owner with its pending, failed and recovering write requests, read-only.`
  : 'Shows every source\'s canonical owner with its pending, failed and recovering write requests, read-only.',
  { argv: ['gbrain', 'sources', 'writer', 'status', ...(sourceId ? ['--source', sourceId] : []), '--json'] });
const requestFix = (row: WriteRequest): Action => row.principal_kind === 'local_cli'
  ? readFix(`Reads request ${row.request_id}'s durable receipt: its state and recorded error, read-only.`, { argv: ['gbrain', 'write-request', '--', row.request_id] })
  : ownerStatusFix(row.source_id);
const confinementCheck = 'Inspect the canonical owner before resubmitting anything; how to repair the checkout is the user\'s decision.';
function localEditRefusal(message: string, row: WriteRequest, skill: boolean, when: string): OperationError {
  const review = skill ? `review the edited files of ${row.slug}` : `preview the difference with gbrain sources reconcile ${row.source_id} ${row.slug} --preview on the brain host and apply the resolved preview`;
  return opError('source_changed', message,
    `A canonical file of ${row.slug} in source ${row.source_id} was edited outside gbrain ${when}, so it was not overwritten. Inspect request ${row.request_id} first; once it is final, ${review}, then submit the write again with a new request_id.`,
    { fix: requestFix(row) });
}
function unexpectedRecoveryBytes(message: string, row: WriteRequest, when: string): OperationError {
  return opError('unexpected_file_bytes', message,
    `A canonical file of request ${row.request_id} in source ${row.source_id} ${when} matches neither its prior nor its published bytes, so recovery left it untouched and the worktree stays blocked. Inspect the owner and ask the user which version to keep; do not delete the file to unblock it.`,
    { fix: ownerStatusFix(row.source_id) });
}
function publishFile(file: PageMutationFile, stagingPath?: string, afterStagingFlush?: () => void, mode?: number | null): void {
  if (!isWriteTargetContained(file.path, file.root)) throw opError('storage_error', 'Canonical file target escapes its source root.',
    `The file path resolves outside its source's canonical root (a symlinked directory or a moved checkout), so the file was not written. ${confinementCheck}`,
    { fix: ownerStatusFix() });
  if (file.publishMode === undefined) mkdirSync(dirname(file.path), { recursive: true });
  else mkdirPrivate(dirname(file.path), file.root);
  if (!isWriteTargetContained(file.path, file.root)) throw opError('storage_error', 'Canonical parent path changed during publication.',
    `A directory on the file's path was replaced (for example by a symlink) while gbrain created it, so the file was not written. ${confinementCheck}`,
    { fix: ownerStatusFix() });
  const openMode = mode ?? file.publishMode;
  if (file.content === null) {
    try { unlinkSync(file.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } else atomicWriteFileSync(file.path, file.content, { durable: true, stagingPath, ...(openMode === undefined ? {} : { mode: openMode }), afterStagingFlush });
  flushDirectory(dirname(file.path));
}
// Effect recovery uses the same confined durable publication primitive, under
// its own recovery record and native root capability.
export { fileHash as persistenceFileHash, publishFile as publishPersistenceFile };
function requestError(error: unknown): PublicationFailure {
  if (error instanceof OperationError) {
    // #6188: a typed fence refusal keeps its location in the bounded detail, which outlives receipt compaction.
    const fence = fenceFailureDetail(error);
    return { code: error.code, message: error.message, ...(fence ? { detail: fence } : {}) };
  }
  const refusal = databaseRefusal(error);
  if (refusal) return refusal;
  const code = (error as { code?: string })?.code;
  if (code === 'revision_conflict') {
    return { code, message: error instanceof Error && error.message ? error.message : 'The page changed after the supplied revision was read.' };
  }
  // #5216: the row still awaits its revision backfill; the error names the resume command.
  if (code === 'revision_backfill_pending' && error instanceof Error) return { code, message: error.message };
  return ownerExceptionFailure(error);
}
function conflictCode(code: string): boolean { return ['revision_required','revision_conflict','revision_backfill_pending','source_changed','page_identity_changed'].includes(code); }
export function transientDatabaseFailure(error: unknown): boolean {
  return ['40001','40P01','55P03','57014','53300','57P01','57P02','57P03','08000','08003','08006','08001','08004',
    'ECONNRESET','ECONNREFUSED','ETIMEDOUT','CONNECTION_CLOSED','CONNECTION_ENDED'].includes(String((error as {code?:string})?.code));
}
/**
 * #6278: the reasons a consumer aborts a preparation with. An error that is
 * that abort (the reason itself, an AbortError, or the Postgres cancel the
 * signal sent, 57014) is a release under that reason, never a terminal
 * `storage_error` or an uncounted `database_contention`; classify it before
 * `finishUnpublishedFailure`. Null when the error is the preparer's own.
 */
export type PreparationAbortReason = 'preparation_deadline' | 'consumer_stopping' | 'claim_lost' | 'group_member_waiting';
const ABORT_REASONS: ReadonlySet<string> = new Set<PreparationAbortReason>(['preparation_deadline', 'consumer_stopping', 'claim_lost', 'group_member_waiting']);
export function preparationAbortReason(error: unknown, signal?: AbortSignal): PreparationAbortReason | null {
  const reason = signal?.aborted ? (signal.reason as { code?: unknown } | null)?.code : undefined;
  const own = typeof reason === 'string' && ABORT_REASONS.has(reason) ? reason as PreparationAbortReason : null;
  const e = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (e && typeof e === 'object' && typeof e.code === 'string' && ABORT_REASONS.has(e.code)) return e.code as PreparationAbortReason;
  if (!own) return null;
  if (error === signal!.reason || e?.name === 'AbortError') return own;
  if (e?.code === '57014' && typeof e.message === 'string' && /canceling statement due to user request/.test(e.message)) return own;
  // #6278: the engine discards a reserved connection whose cancel a pooler never completed; after our abort that end is ours.
  if (e?.code === 'CONNECTION_DESTROYED' || e?.code === 'CONNECTION_CLOSED') return own;
  return null;
}

/** #6278: the owner-only detail of a `preparation_stalled` receipt: the last recorded step and the count that reached the limit. */
export interface PreparationStallDetail extends Pick<PublicationFailureDetail, 'stage' | 'attempt'> {
  origin: 'preparation_stall'; step: string | null; waiting_on: WaitingOn; attempts: number; limit: number;
}
export interface PreparationStallInfo { step: string | null; waiting_on: WaitingOn; attempts: number; limit: number }
export function preparationStalledFailure(row: WriteRequest, info: PreparationStallInfo): PublicationFailure {
  const kind = preparationKind(row);
  const where = info.step ? `, last at step ${info.step} (waiting on ${info.waiting_on})` : '';
  const fix = kind === 'sync'
    ? `Run gbrain sources writer status --source ${row.source_id} --json, then gbrain sources retry-held ${row.source_id}, then the same gbrain sync with the same options.`
    : `Run gbrain sources writer status --source ${row.source_id} --json, fix or report what the step was waiting on, then submit the write again with a new request_id.`;
  return { code: 'preparation_stalled',
    message: `Preparation of this write was cut off ${info.attempts} time(s) at its deadline${where}, the limit of persistence.max_preparation_attempts (${info.limit}); it is not claimed again. ${fix}`,
    detail: { origin: 'preparation_stall', step: info.step, waiting_on: info.waiting_on, attempts: info.attempts, limit: info.limit } as unknown as PublicationFailureDetail };
}
/**
 * #6278: finishes a claimed request `failed`/`preparation_stalled`: at claim
 * when its counter is already at the limit, or at the release that would
 * bring it there (`charge`, which counts that attempt first). Token-fenced
 * like every completion.
 */
export async function finishPreparationStalled(engine: BrainEngine, row: WriteRequest, info: Omit<PreparationStallInfo, 'attempts'>, charge: boolean): Promise<WriteRequest> {
  const attempts = charge ? await chargePreparationAttempt(engine, row) : row.preparation_attempts ?? info.limit;
  const failure = withAttempt(preparationStalledFailure(row, { ...info, attempts }), 'preparation');
  return engine.transaction(tx => completeWrite(tx, row, 'failed', {}, failure));
}

export async function finishUnpublishedFailure(engine: BrainEngine, row: WriteRequest, error: unknown,
  stage: PublicationStage = 'publication'): Promise<WriteRequest> {
  const failure = withAttempt(requestError(error), stage);
  if (mayReprepare(row, failure) || transientDatabaseFailure(error)) {
    await releaseUnpublishedClaim(engine, row, transientDatabaseFailure(error) ? 'database_contention' : 'revision_changed_repreparing');
    return (await getWriteRequestById(engine, row.id))!;
  }
  return engine.transaction(tx => completeWrite(tx, row, conflictCode(failure.code) ? 'conflict' : 'failed', {}, failure));
}

/**
 * #5984: the page after apply, for the receipt revision and effects: apply's own
 * read when it kept one and nothing reclassified the page since, else a fresh read.
 */
export async function publicationPostimage(tx: BrainEngine, row: WriteRequest, prepared: PreparedMutation): Promise<PageSnapshot | null> {
  const reclassified = row.authority.databaseOnlyReason === 'unbound_source' || prepared.databaseOnlyReason === 'mirror_read_only';
  if (prepared.postimage !== undefined && !reclassified) return prepared.postimage;
  return tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
}

/** The receipt fields every committed publication carries: revision, persistence mode and write-through. */
export function decoratePublicationOutcome(row: WriteRequest, prepared: PreparedMutation, outcome: Record<string, unknown>,
  final: { revision: string } | null, fileCount: number, skill: boolean): void {
  if (final) outcome.revision = final.revision;
  outcome.persistence = { mode: fileCount ? 'filesystem' : 'database', ...(fileCount ? { file_written: !prepared.noop } : {}), ...(skill ? { git_state: 'not_requested' } : {}) };
  outcome.write_through = fileCount ? { written: !prepared.noop } : { written: false, skipped: prepared.databaseOnlyReason ?? row.authority.databaseOnlyReason ?? 'no_repo_configured' };
  if (prepared.databaseOnlyReason === 'mirror_read_only') outcome.storage = 'database_only';
  if ((row.operation === 'put_page' || row.operation === 'edit_page') && row.authority.remote && row.authority.databaseOnlyReason === 'no_repo_configured') outcome.write_through = withNoRepoWriteThroughWarning(outcome.write_through as { written: boolean; skipped?: string }, row.source_id, row.operation);
  if ((outcome.write_through as { skipped?: string }).skipped === 'unbound_source') {
    outcome.write_through = { ...outcome.write_through as object, warning: unboundWriteWarning(row.operation, row.source_id, row.authority.databaseOnlyReason === 'unbound_source') };
  }
}

/**
 * prepare outside locks → durable recovery → file → DB+receipt commit.
 * The root lock spans all file effects; the DB guards span authorization and
 * publication. A rejected/ambiguous commit is recovered before releasing FIFO.
 */
/**
 * The recovery record of one page file publication (its before bytes, hashes,
 * mode and reserved staging names) and the recovery bytes it reserves. Read
 * while holding the worktree's native lock, before any file is touched.
 */
export function pageRecoveryRecord(row: WriteRequest, file: PageMutationFile, binding: WorktreeBinding): { record: FileRecoveryRecord; bytes: number } {
  const before = existsSync(file.path) ? readFileSync(file.path) : null;
  const record: FileRecoveryRecord = {
    version: 1, path: file.path, root: file.root,
    before: before?.toString('base64') ?? null, beforeHash: before ? sha256(before) : null,
    afterHash: file.content === null ? null : sha256(file.content),
    mode: before ? statSync(file.path).mode & 0o7777 : null,
    ownerEpoch: String(binding.owner_epoch), attempt: row.execution_token!,
    staging: {
      ...(file.content === null ? {} : { publication: recoveryStagingFile(file.path, file.content) }),
      ...(before === null ? {} : { restoration: recoveryStagingFile(file.path, before) }),
    },
  };
  const nextBytes = file.content === null ? 0 : typeof file.content === 'string' ? Buffer.byteLength(file.content) : file.content.byteLength;
  const beforeBytes = before?.byteLength ?? 0;
  return { record, bytes: Math.max(beforeBytes * 3 + nextBytes * 2, Buffer.byteLength(JSON.stringify(record)) + beforeBytes + nextBytes) + 4096 };
}

export async function publishMutation(engine: BrainEngine, row: WriteRequest, prepared: PreparedMutation,
  hostId = localHostId(), callerHooks: PublicationHooks = {}): Promise<WriteRequest> {
  const hooks = withFaultPoints(callerHooks);
  let lock: NativeLockHandle | null = null;
  let releaseCapacity: (() => void) | null = null;
  let binding: WorktreeBinding | null = null;
  let recovery: RecoveryRecord | null = null;
  let published = false;
  let transactionBodyCompleted = false;
  const skill = prepared.target === 'skill_bundle';
  const files = skill ? prepared.files ?? [] : prepared.file ? [prepared.file] : [];
  try {
    assertMutationProtocol(row);
    if ((row.target_kind ?? 'page') !== (prepared.target ?? 'page') || (skill ? !!prepared.file || !files.length : prepared.files !== undefined)) {
      throw opError('unsupported_mutation_protocol', 'Prepared mutation does not match its accepted target.',
        `Request ${row.request_id} in source ${row.source_id} was prepared for a different target than it was accepted for, so nothing was published. This is an internal mismatch, not a caller error: inspect the request and report it to the user; do not resubmit it unchanged.`,
        { fix: requestFix(row) });
    }
    if (skill) await assertSharedSkillPersistence(engine, row.source_id);
    if (row.worktree_id) {
      binding = await getWorktreeBinding(engine, row.source_id, hostId);
      if (!binding || binding.owner_host_id !== hostId || !binding.local_path) {
        await releaseUnpublishedClaim(engine, row, 'owner_unavailable');
        return (await getWriteRequestById(engine, row.id))!;
      }
      lock = await acquireWorktree(binding, 0, undefined, engine, { yieldLanes: true });
      if (!lock) {
        await releaseUnpublishedClaim(engine, row, 'writer_busy');
        return (await getWriteRequestById(engine, row.id))!;
      }
      // Recheck after native exclusion, before reserving or touching any sink.
      // A terminal receipt may still own unresolved physical cleanup.
      const blocked = await engine.executeRaw(`SELECT 1 FROM persistence_requests
        WHERE worktree_id=$1::uuid AND id<>$2::uuid AND recovery IS NOT NULL
        UNION ALL SELECT 1 FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL LIMIT 1`,
      [row.worktree_id, row.id]);
      if (blocked.length) {
        await releaseUnpublishedClaim(engine, row, 'recovery_required');
        return (await getWriteRequestById(engine, row.id))!;
      }
    }
    releaseCapacity = tryAcquirePublicationCapacity(engine);
    if (!releaseCapacity) {
      await releaseUnpublishedClaim(engine, row, 'writer_pool_capacity');
      return (await getWriteRequestById(engine, row.id))!;
    }
    if (!skill) await assertKnowledgePublicationAllowed(engine, row, prepared.file);
    if (skill && !prepared.noop) {
      if (!binding || !lock) throw opError('storage_error', 'Skill publication requires a canonical owner.',
        `Shared-skill request ${row.request_id} reached publication without this host holding source ${row.source_id}'s canonical worktree, so no skill file was written. Inspect the owner; the skill publishes only on the host that owns the source.`,
        { fix: ownerStatusFix(row.source_id) });
      const bundle = prepareBundleRecovery(files, binding, row);
      await prepareRecovery(engine, row, bundle.record, bundle.bytes);
      recovery = bundle.record;
      await hooks.boundary?.('prepared', row);
      await withFilesystemPublication([bundle.record.root], async () => {
        for (let index = 0; index < files.length; index++) {
          stageBundleFile(files[index], bundle.record.files[index]);
          if (files[index].content !== null) {
            hooks.stagingFlushed?.(row);
            hooks.fileBoundary?.('staging_flushed', row, index);
          }
        }
      });
    } else if (prepared.file && !prepared.noop) {
      if (!binding || !lock || !isWriteTargetContained(prepared.file.path, prepared.file.root)) throw opError('storage_error', 'Filesystem publication requires a confined canonical owner.',
        `This host does not hold source ${row.source_id}'s canonical worktree, or the file of ${row.slug} resolves outside it, so request ${row.request_id} wrote no file. Inspect the owner; the write publishes only on the host that owns the source.`,
        { fix: ownerStatusFix(row.source_id) });
      const { record, bytes } = pageRecoveryRecord(row, prepared.file, binding);
      if (prepared.file.expectedBeforeHash !== undefined && record.beforeHash !== prepared.file.expectedBeforeHash) {
        // A coordinated writer (a withdrawal mirror) also advanced the page:
        // reprepare against it. Bytes changed at an unchanged revision are an
        // uncoordinated edit.
        const current = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
        if ((current?.revision ?? null) !== prepared.observedRevision) {
          throw new OperationError('revision_conflict', 'The page changed during preparation.', 'Read its current revision and submit the updated intent with a new request_id.');
        }
        throw localEditRefusal('The canonical file changed after preparation.', row, skill, 'after the write was prepared, at an unchanged page revision');
      }
      await prepareRecovery(engine, row, record, bytes);
      recovery = record;
      await hooks.boundary?.('prepared', row);
    }
    const done = await engine.transaction(async tx => {
      await declareDurablePersistence(tx);
      const liveBinding = await guardOwnership(tx, row, hostId);
      if (prepared.sourceExclusive && !prepared.exclusiveSources?.length) await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [row.source_id]);
      if (prepared.exclusiveSources?.length) await lockCoreSources(tx, prepared.sourceExclusive ? [row.source_id, ...prepared.exclusiveSources] : prepared.exclusiveSources);
      if (binding && String(liveBinding?.owner_epoch) !== String(binding.owner_epoch)) throw opError('owner_unavailable', 'Owner epoch changed before publication.',
        `Source ${row.source_id}'s canonical owner changed (a transfer or re-claim) after request ${row.request_id} was prepared, so this host published nothing for it. Inspect the owner and the request before resubmitting; do not claim or transfer the source to push this write through.`,
        { fix: ownerStatusFix(row.source_id) });
      // A page target's visibility is checked below, once its page is locked.
      await authorizeStoredRequest(tx, row, true, { pageVisibility: skill });
      await lockCounters(tx, ['brain', principalKey(requestPrincipal(row)), ...(row.worktree_id ? [`worktree:${row.worktree_id}`] : [])]);
      const [current] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [row.id]);
      if (!current || current.execution_token !== row.execution_token || current.state !== 'running') throw opError('write_claim_lost', 'Execution claim changed before publication.',
        `Another worker took over request ${row.request_id} (its execution claim expired or was reassigned) before this attempt published, so this attempt wrote nothing and the current holder decides the outcome. Inspect the request rather than resubmitting it.`,
        { fix: requestFix(row) });
      let snapshot: PageSnapshot | null = null;
      if (skill) await assertSharedSkillPersistence(tx, row.source_id);
      else {
        await assertKnowledgePublicationAllowed(tx, row, prepared.file);
        await tx.lockPageKeys([{ sourceId: row.source_id, slug: row.slug },...(prepared.additionalPageKeys??[])]);
        snapshot = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
        await authorizePageVisibility(tx, row.authority, row.slug);
        if ((snapshot?.page.id ?? null) !== row.page_id) throw pageIdentityError(snapshot != null || row.page_id === null, 'The accepted page was deleted or recreated.');
        await assertUnboundPublication(tx, row, snapshot?.page.source_path);
        if ((snapshot?.revision ?? null) !== prepared.observedRevision) throw new OperationError('revision_conflict', 'The page changed during preparation.', 'Read its current revision and submit the updated intent with a new request_id.');
      }
      await prepared.validate?.(tx);
      // #5409: a file target prepared before the source became a read-only mirror is never published.
      if (!skill && prepared.file && await sourceMirrorReadOnly(tx, row.source_id, true)) {
        throw new OperationError('source_changed', 'The source became a read-only mirror after this write was prepared; nothing was written to its checkout.',
          'Retry the write with a new request_id; it is now stored database-only.');
      }
      if (recovery) {
        const records = recoveryFiles(recovery);
        for (const record of records) if ((skill ? bundleFileHash(record) : fileHash(record.path)) !== record.beforeHash) {
          throw localEditRefusal('The canonical file changed during preparation.', row, skill, 'while the write was being prepared');
        }
        await tx.executeRaw('UPDATE persistence_requests SET publication_started=true WHERE id=$1::uuid', [row.id]);
        await hooks.boundary?.('before_publication', row);
        // Mark before the call: a rename followed by an fsync error still needs recovery.
        published = true;
        await withFilesystemPublication([...new Set(files.map(file => file.root))], async () => {
          for (let index = 0; index < files.length; index++) {
            hooks.fileBoundary?.('before_file', row, index);
            const record = records[index];
            if ((skill ? bundleFileHash(record) : fileHash(record.path)) !== record.beforeHash) throw localEditRefusal('The canonical file changed before publication.', row, skill, 'just before publication');
            if (skill) publishStagedBundleFile(record, phase => hooks.fileBoundary?.(phase, row, index));
            else publishFile(files[index], record.staging?.publication?.path, () => {
              hooks.stagingFlushed?.(row);
              hooks.fileBoundary?.('staging_flushed', row, index);
            });
            hooks.fileBoundary?.('after_file', row, index);
          }
        });
        await hooks.boundary?.('after_publication', row);
      }
      prepared.postimage = undefined;
      const outcome = await withCoordinatedWrite(tx, [row.source_id], () => prepared.apply(tx, snapshot), requestAttribution(row));
      if (!skill) await classifyUnboundPage(tx, row);
      if (prepared.databaseOnlyReason === 'mirror_read_only') await classifyMirrorPage(tx, row);
      const final = skill ? null : await publicationPostimage(tx, row, prepared);
      decoratePublicationOutcome(row, prepared, outcome, final, files.length, skill);
      await recordPublicationFenceTrend(tx, row, outcome);
      await queuePublicationEffects(tx, row, final, outcome, prepared);
      await hooks.boundary?.('before_commit', row);
      const committed = await completeWrite(tx, current, 'committed', outcome, undefined, current);
      transactionBodyCompleted = true;
      return committed;
    });
    await hooks.boundary?.('after_commit', done);
    if (recovery) await clearResolvedRecovery(engine, row.id, done);
    return done;
  } catch (error) {
    if (recovery) {
      // Even a rejected prepare can retain a journal record; do not leave that
      // record unaccounted or let a sibling publication bypass its recovery.
      const failure = !transactionBodyCompleted && !mayReprepare(row, requestError(error)) && !transientDatabaseFailure(error)
        ? withAttempt(requestError(error), published ? 'after_file_publication' : 'publication') : undefined;
      try { await markRecovering(engine, row, failure ? 'publication_failed' : published ? 'commit_outcome_uncertain' : 'publication_not_started', failure); }
      catch { /* database outage: durable recovery record remains discoverable */ }
      if (lock) {
        try { return await recoverPublication(engine, row.id, hostId, true,
          failure, releaseCapacity !== null); }
        catch { /* hold durable recovering state; next owner loop retries */ }
      }
      try { return await getWriteRequestById(engine, row.id) ?? { ...row, state: 'recovering', blocked_reason: 'database_unavailable' }; }
      catch { return { ...row, state: 'recovering', blocked_reason: 'database_unavailable' }; }
    }
    if ((error as { code?: string })?.code === 'queue_capacity') {
      await releaseUnpublishedClaim(engine, row, 'recovery_capacity');
      return (await getWriteRequestById(engine, row.id))!;
    }
    return finishUnpublishedFailure(engine, row, error);
  } finally { releaseCapacity?.(); await lock?.release(); }
}

export async function recoverPublication(engine: BrainEngine, id: string, hostId = localHostId(), alreadyLocked = false,
  terminalError?: PublicationFailure, capacityAlreadyHeld = false, hooks: PublicationHooks = {}): Promise<WriteRequest> {
  let row = await getWriteRequestById(engine, id);
  if (!row) throw opError('not_found', 'Write request not found.',
    'The write request is no longer in the journal (it was compacted or never existed), so there is nothing to recover. Inspect the canonical owners for requests that still need recovery.',
    { fix: ownerStatusFix() });
  if (!row.recovery) return row;
  assertMutationProtocol(row);
  const binding = await getWorktreeBinding(engine, row.source_id, hostId);
  if (!binding || binding.owner_host_id !== hostId) throw opError('owner_unavailable', 'Recovery requires the canonical owner.',
    `Request ${row.request_id} in source ${row.source_id} holds a publication recovery record that only the host owning the source's canonical worktree can finish, and this host does not own it. Inspect the owner; its resident writer finishes the recovery.`,
    { fix: ownerStatusFix(row.source_id) });
  const lock = alreadyLocked ? null : await acquireWorktree(binding, 0, undefined, engine, { yieldLanes: true });
  if (!alreadyLocked && !lock) return row;
  const releaseCapacity = capacityAlreadyHeld ? null : tryAcquirePublicationCapacity(engine);
  try {
    if (!capacityAlreadyHeld && !releaseCapacity) {
      const [blocked] = await engine.executeRaw<WriteRequest>(`UPDATE persistence_requests SET blocked_reason='writer_pool_capacity',updated_at=now()
        WHERE id=$1::uuid AND recovery IS NOT NULL AND state IN ('running','recovering') AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING *`, [id]);
      return blocked ?? row;
    }
    if (!isTerminal(row)) await upgradeRecoveryStaging(engine, 'persistence_requests', id, row.worktree_id!, 'restore');
    row = await engine.transaction(async tx => {
      await declareDurablePersistence(tx);
      await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [row!.worktree_id]);
      await lockCounters(tx, ['brain', principalKey(requestPrincipal(row!)), `worktree:${row!.worktree_id}`]);
      const [current] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [id]);
      if (!current.recovery) return current;
      const records = recoveryFiles(current.recovery);
      if (current.recovery.version === 2) {
        const owner = await guardOwnership(tx, current, hostId);
        if (!owner) throw opError('owner_unavailable', 'Skill recovery requires its canonical owner.',
          `This host no longer holds source ${current.source_id}'s current owner epoch, so shared-skill request ${current.request_id} stays recovering until its owner finishes it. Inspect the owner; its resident writer finishes the recovery.`,
          { fix: ownerStatusFix(current.source_id) });
        assertBundleRecoveryBinding(current.recovery, owner, current.execution_token);
      }
      for (const record of records) if (!isWriteTargetContained(record.path, record.root) || !binding.local_path || !isWriteTargetContained(record.path, binding.local_path)) throw opError('recovery_required', 'Recovery file binding is no longer confined to this owner.',
        `A recovery file of request ${current.request_id} now resolves outside source ${current.source_id}'s canonical worktree (a moved checkout or a symlink), so recovery stopped without touching it and the request stays recovering. Inspect the owner and tell the user; the checkout must be repaired before recovery can finish.`,
        { fix: ownerStatusFix(current.source_id) });
      try {
        if (!isTerminal(current)) for (const record of records) {
          const actual = current.recovery.version === 2 ? bundleFileHash(record) : fileHash(record.path);
          if (actual !== record.beforeHash && actual !== record.afterHash) throw unexpectedRecoveryBytes('Canonical recovery bytes changed outside publication.', current, 'was edited outside gbrain and');
        }
        await withFilesystemPublication([...new Set(records.map(record => record.root))], async () => {
          for (const record of records) cleanupRecoveryStaging(record);
        });
      }
      catch (error) {
        if (!(error instanceof OperationError) || !['unexpected_staging_bytes','unexpected_file_bytes','storage_error'].includes(error.code)) throw error;
        const reason = error.code === 'unexpected_staging_bytes' ? error.code : 'unexpected_file_bytes';
        const [blocked] = await tx.executeRaw<WriteRequest>(`UPDATE persistence_requests SET
          state=CASE WHEN state IN ('committed','conflict','failed','cancelled') THEN state ELSE 'recovering' END,
          blocked_reason=$2,updated_at=now() WHERE id=$1::uuid RETURNING *`, [id, reason]);
        return blocked;
      }
      // A delivered or durable terminal outcome is immutable. Only its known
      // temporary files are cleaned; its canonical file is never restored.
      if (isTerminal(current)) return { ...current, blocked_reason: null };
      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        hooks.fileBoundary?.('before_restore', current, index);
        const actual = current.recovery.version === 2 ? bundleFileHash(record) : fileHash(record.path);
        if (actual !== record.beforeHash && actual !== record.afterHash) throw unexpectedRecoveryBytes('Canonical recovery bytes changed during restoration.', current, 'changed while recovery was restoring it and');
        if (actual === record.afterHash && actual !== record.beforeHash) {
          await withFilesystemPublication([record.root], async () => {
            const file = { path: record.path, root: record.root, content: record.before === null ? null : Buffer.from(record.before, 'base64') };
            if (current.recovery!.version === 2) {
              const restored = { ...record, beforeHash: record.afterHash, afterHash: record.beforeHash,
                mode: record.afterHash === null ? null : record.afterMode ?? record.mode, afterMode: record.mode ?? undefined,
                staging: { publication: record.staging?.restoration } };
              stageBundleFile(file, restored);
              if (file.content !== null) hooks.fileBoundary?.('restoration_staging_flushed', current, index);
              publishStagedBundleFile(restored, phase => hooks.fileBoundary?.(`restoration_${phase}`, current, index));
            } else publishFile(file, record.staging?.restoration?.path,
              () => hooks.fileBoundary?.('restoration_staging_flushed', current, index), record.mode);
          });
        }
        hooks.fileBoundary?.('after_restore', current, index);
        assertRecoveryStagingAbsent(record);
      }
      // Withdrawal is authoritative DB state and is never rolled back here.
      const failure: PublicationFailure | undefined = terminalError ?? (current.error_code ? {code:current.error_code,message:current.error_message ?? 'Publication failed before database completion.',
        ...(current.error_detail ? { detail: current.error_detail as unknown as PublicationFailureDetail } : {})} : undefined);
      if (failure) return completeWrite(tx, current, conflictCode(failure.code) ? 'conflict' : 'failed', {}, failure);
      for (const key of ['brain', `worktree:${current.worktree_id}`]) await tx.executeRaw('UPDATE persistence_counters SET recovery_bytes=recovery_bytes-$2 WHERE key=$1', [key, Number(current.recovery_bytes)]);
      const [queued] = await tx.executeRaw<WriteRequest>(`UPDATE persistence_requests SET state='queued',execution_token=NULL,
        claim_expires_at=NULL,recovery=NULL,recovery_bytes=0,publication_started=false,blocked_reason=NULL,updated_at=now()
        WHERE id=$1::uuid RETURNING *`, [id]);
      return queued;
    });
    if (isTerminal(row) && row.blocked_reason !== 'unexpected_staging_bytes') {
      await faultPoint('publication_recovery:before_clear', { requestId: row.request_id, sourceId: row.source_id, operation: row.operation });
      await clearResolvedRecovery(engine, id);
      row = (await getWriteRequestById(engine, id))!;
    }
    return row;
  } finally { releaseCapacity?.(); await lock?.release(); }
}
