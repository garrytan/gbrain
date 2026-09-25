import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { atomicWriteFileSync } from '../atomic-write.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { sha256 } from './digest.ts';
import { authorizeStoredRequest } from './authority.ts';
import { localHostId } from './identity.ts';
import { acquireWorktree, getWorktreeBinding, guardOwnership, type WorktreeBinding } from './ownership.ts';
import { clearResolvedRecovery, completeWrite, getWriteRequestById, lockCounters, markRecovering, prepareRecovery, releaseUnpublishedClaim } from './journal.ts';
import { isTerminal, principalKey, requestPrincipal, recoveryFiles, type RecoveryRecord, type WriteRequest } from './model.ts';
import { PageRevisionConflictError } from '../page-state/types.ts';
import type { NativeLockHandle } from './native-lock.ts';
import { withCoordinatedWrite } from './context.ts';
import { withFilesystemPublication } from './filesystem-guard.ts';
import { mayReprepare } from './semantic.ts';
import { tryAcquirePublicationCapacity } from './pool-capacity.ts';
import { queuePublicationEffects } from './effect-journal.ts';
import { authorizePageVisibility } from './page-visibility.ts';
import { withNoRepoWriteThroughWarning } from '../write-through.ts';
import { assertRecoveryStagingAbsent, cleanupRecoveryStaging, recoveryStagingFile, upgradeRecoveryStaging } from './staging.ts';
import { assertMutationProtocol, assertSharedSkillPersistence, declarePersistenceProtocol, PERSISTENCE_PROTOCOL_PREDICATE } from './protocol.ts';
import { assertBundleRecoveryBinding, bundleFileHash, prepareBundleRecovery, publishStagedBundleFile, stageBundleFile, type MutationFile } from './bundle-files.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';

interface PreparedMutationBase {
  sourceExclusive?: boolean;
  observedRevision: string | null;
  additionalPageKeys?: readonly {sourceId:string;slug:string}[];
  noop?: boolean;
  deferEmbedding?: boolean;
  /** Must perform only transaction-composable database work. */
  apply(tx: BrainEngine): Promise<Record<string, unknown>>;
  validate?(tx: BrainEngine): Promise<void>;
}
export type PreparedMutation = PreparedMutationBase & (
  | { target?: 'page'; file?: MutationFile; files?: never }
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
function flushDirectory(path: string): void {
  let fd: number | undefined;
  try { fd = openSync(dirname(path), 'r'); fsyncSync(fd); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows cannot open a directory through Node's file descriptor API.
    // Its atomic replacement is handled by the platform filesystem primitive.
    if (!(process.platform === 'win32' && ['EISDIR','EPERM','EINVAL','ENOTSUP'].includes(code ?? ''))) throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function publishFile(file: NonNullable<PreparedMutation['file']>, stagingPath?: string, afterStagingFlush?: () => void, mode?: number | null): void {
  if (!isWriteTargetContained(file.path, file.root)) throw new OperationError('storage_error', 'Canonical file target escapes its source root.');
  mkdirSync(dirname(file.path), { recursive: true });
  if (!isWriteTargetContained(file.path, file.root)) throw new OperationError('storage_error', 'Canonical parent path changed during publication.');
  if (file.content === null) {
    try { unlinkSync(file.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } else atomicWriteFileSync(file.path, file.content, { durable: true, stagingPath, afterStagingFlush: () => {
    if (mode !== undefined && mode !== null && stagingPath) {
      chmodSync(stagingPath, mode);
      const fd = openSync(stagingPath, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    afterStagingFlush?.();
  } });
  flushDirectory(file.path);
}
// Effect recovery uses the same confined durable publication primitive, under
// its own recovery record and native root capability.
export { fileHash as persistenceFileHash, publishFile as publishPersistenceFile };
function requestError(error: unknown): { code: string; message: string } {
  if (error instanceof OperationError) return { code: error.code, message: error.message };
  const code = (error as { code?: string })?.code;
  // PageRevisionConflictError already distinguishes the three real cases
  // (missing precondition, drifted revision, deleted page); keep its message
  // instead of blaming a page change on a submit that supplied no revision.
  if (error instanceof PageRevisionConflictError) return { code: error.code, message: error.message };
  if (code === 'revision_conflict') return { code, message: 'The page changed after the supplied revision was read.' };
  return { code: 'storage_error', message: `Publication failed${code ? ` (${code})` : ''}. Inspect owner diagnostics.` };
}
function conflictCode(code: string): boolean { return ['revision_required','revision_conflict','source_changed','page_identity_changed'].includes(code); }
export function transientDatabaseFailure(error: unknown): boolean {
  return ['40001','40P01','55P03','57014','53300','57P01','57P02','57P03','08000','08003','08006','08001','08004',
    'ECONNRESET','ECONNREFUSED','ETIMEDOUT','CONNECTION_CLOSED','CONNECTION_ENDED'].includes(String((error as {code?:string})?.code));
}
export async function finishUnpublishedFailure(engine: BrainEngine, row: WriteRequest, error: unknown): Promise<WriteRequest> {
  const failure = requestError(error);
  if (mayReprepare(row, failure) || transientDatabaseFailure(error)) {
    await releaseUnpublishedClaim(engine, row, transientDatabaseFailure(error) ? 'database_contention' : 'revision_changed_repreparing');
    return (await getWriteRequestById(engine, row.id))!;
  }
  return engine.transaction(tx => completeWrite(tx, row, conflictCode(failure.code) ? 'conflict' : 'failed', {}, failure));
}

/**
 * prepare outside locks → durable recovery → file → DB+receipt commit.
 * The root lock spans all file effects; the DB guards span authorization and
 * publication. A rejected/ambiguous commit is recovered before releasing FIFO.
 */
export async function publishMutation(engine: BrainEngine, row: WriteRequest, prepared: PreparedMutation,
  hostId = localHostId(), hooks: PublicationHooks = {}): Promise<WriteRequest> {
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
      throw new OperationError('unsupported_mutation_protocol', 'Prepared mutation does not match its accepted target.');
    }
    if (skill) await assertSharedSkillPersistence(engine, row.source_id);
    if (row.worktree_id) {
      binding = await getWorktreeBinding(engine, row.source_id, hostId);
      if (!binding || binding.owner_host_id !== hostId || !binding.local_path) {
        await releaseUnpublishedClaim(engine, row, 'owner_unavailable');
        return (await getWriteRequestById(engine, row.id))!;
      }
      lock = await acquireWorktree(binding);
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
      if (!binding || !lock) throw new OperationError('storage_error', 'Skill publication requires a canonical owner.');
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
      if (!binding || !lock || !isWriteTargetContained(prepared.file.path, prepared.file.root)) throw new OperationError('storage_error', 'Filesystem publication requires a confined canonical owner.');
      const before = existsSync(prepared.file.path) ? readFileSync(prepared.file.path) : null;
      const record: RecoveryRecord = {
        version: 1, path: prepared.file.path, root: prepared.file.root,
        before: before?.toString('base64') ?? null, beforeHash: before ? sha256(before) : null,
        afterHash: prepared.file.content === null ? null : sha256(prepared.file.content),
        mode: before ? statSync(prepared.file.path).mode & 0o7777 : null,
        ownerEpoch: String(binding.owner_epoch), attempt: row.execution_token!,
        staging: {
          ...(prepared.file.content === null ? {} : { publication: recoveryStagingFile(prepared.file.path, prepared.file.content) }),
          ...(before === null ? {} : { restoration: recoveryStagingFile(prepared.file.path, before) }),
        },
      };
      if (prepared.file.expectedBeforeHash !== undefined && record.beforeHash !== prepared.file.expectedBeforeHash) {
        throw new OperationError('source_changed', 'The canonical file changed after preparation.');
      }
      const nextBytes = prepared.file.content === null ? 0 : typeof prepared.file.content === 'string'
        ? Buffer.byteLength(prepared.file.content) : prepared.file.content.byteLength;
      const beforeBytes = before?.byteLength ?? 0;
      await prepareRecovery(engine, row, record, Math.max(beforeBytes * 3 + nextBytes * 2,
        Buffer.byteLength(JSON.stringify(record)) + beforeBytes + nextBytes) + 4096);
      recovery = record;
      await hooks.boundary?.('prepared', row);
    }
    const done = await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
      const liveBinding = await guardOwnership(tx, row, hostId);
      if (prepared.sourceExclusive) await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [row.source_id]);
      if (binding && String(liveBinding?.owner_epoch) !== String(binding.owner_epoch)) throw new OperationError('owner_unavailable', 'Owner epoch changed before publication.');
      await authorizeStoredRequest(tx, row, true);
      await lockCounters(tx, ['brain', principalKey(requestPrincipal(row)), ...(row.worktree_id ? [`worktree:${row.worktree_id}`] : [])]);
      const [current] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [row.id]);
      if (!current || current.execution_token !== row.execution_token || current.state !== 'running') throw new OperationError('write_claim_lost', 'Execution claim changed before publication.');
      if (skill) await assertSharedSkillPersistence(tx, row.source_id);
      else {
        await assertKnowledgePublicationAllowed(tx, row, prepared.file);
        await tx.lockPageKeys([{ sourceId: row.source_id, slug: row.slug },...(prepared.additionalPageKeys??[])]);
        const snapshot = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
        await authorizePageVisibility(tx, row.authority, row.slug);
        if ((snapshot?.page.id ?? null) !== row.page_id) throw new OperationError('page_identity_changed', 'The accepted page was deleted or recreated.');
        if ((snapshot?.revision ?? null) !== prepared.observedRevision) throw new OperationError('revision_conflict', 'The page changed during preparation.', 'Read its current revision and submit the updated intent with a new request_id.');
      }
      await prepared.validate?.(tx);
      if (recovery) {
        const records = recoveryFiles(recovery);
        for (const record of records) if ((skill ? bundleFileHash(record) : fileHash(record.path)) !== record.beforeHash) {
          throw new OperationError('source_changed', 'The canonical file changed during preparation.');
        }
        await tx.executeRaw('UPDATE persistence_requests SET publication_started=true WHERE id=$1::uuid', [row.id]);
        await hooks.boundary?.('before_publication', row);
        // Mark before the call: a rename followed by an fsync error still needs recovery.
        published = true;
        await withFilesystemPublication([...new Set(files.map(file => file.root))], async () => {
          for (let index = 0; index < files.length; index++) {
            hooks.fileBoundary?.('before_file', row, index);
            const record = records[index];
            if ((skill ? bundleFileHash(record) : fileHash(record.path)) !== record.beforeHash) throw new OperationError('source_changed', 'The canonical file changed before publication.');
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
      const outcome = await withCoordinatedWrite(tx, [row.source_id], () => prepared.apply(tx));
      const final = skill ? null : await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
      if (final) outcome.revision = final.revision;
      outcome.persistence = { mode: files.length ? 'filesystem' : 'database', ...(files.length ? { file_written: !prepared.noop } : {}), ...(skill ? { git_state: 'not_requested' } : {}) };
      outcome.write_through = files.length ? { written: !prepared.noop } : { written: false, skipped: row.authority.databaseOnlyReason ?? 'no_repo_configured' };
      if (row.operation === 'put_page' && row.authority.remote && row.authority.databaseOnlyReason === 'no_repo_configured') outcome.write_through = withNoRepoWriteThroughWarning(outcome.write_through as { written: boolean; skipped?: string }, row.source_id);
      await queuePublicationEffects(tx, row, final?.revision, outcome, prepared);
      await hooks.boundary?.('before_commit', row);
      const committed = await completeWrite(tx, current, 'committed', outcome);
      transactionBodyCompleted = true;
      return committed;
    });
    await hooks.boundary?.('after_commit', done);
    await clearResolvedRecovery(engine, row.id);
    return done;
  } catch (error) {
    if (recovery) {
      // Even a rejected prepare can retain a journal record; do not leave that
      // record unaccounted or let a sibling publication bypass its recovery.
      const failure = !transactionBodyCompleted && !mayReprepare(row, requestError(error)) && !transientDatabaseFailure(error)
        ? requestError(error) : undefined;
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
  terminalError?: { code: string; message: string }, capacityAlreadyHeld = false, hooks: PublicationHooks = {}): Promise<WriteRequest> {
  let row = await getWriteRequestById(engine, id);
  if (!row) throw new OperationError('not_found', 'Write request not found.');
  if (!row.recovery) return row;
  assertMutationProtocol(row);
  const binding = await getWorktreeBinding(engine, row.source_id, hostId);
  if (!binding || binding.owner_host_id !== hostId) throw new OperationError('owner_unavailable', 'Recovery requires the canonical owner.');
  const lock = alreadyLocked ? null : await acquireWorktree(binding);
  if (!alreadyLocked && !lock) return row;
  const releaseCapacity = capacityAlreadyHeld ? null : tryAcquirePublicationCapacity(engine);
  try {
    if (!capacityAlreadyHeld && !releaseCapacity) {
      const [blocked] = await engine.executeRaw<WriteRequest>(`UPDATE persistence_requests SET blocked_reason='writer_pool_capacity',updated_at=now()
        WHERE id=$1::uuid AND recovery IS NOT NULL AND state IN ('running','recovering') AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING *`, [id]);
      return blocked ?? row;
    }
    if (row.recovery.version === 1 && !row.recovery.staging && !isTerminal(row)) await upgradeRecoveryStaging(engine, 'persistence_requests', id, row.worktree_id!, 'restore');
    row = await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
      await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [row!.worktree_id]);
      await lockCounters(tx, ['brain', principalKey(requestPrincipal(row!)), `worktree:${row!.worktree_id}`]);
      const [current] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [id]);
      if (!current.recovery) return current;
      const records = recoveryFiles(current.recovery);
      if (current.recovery.version === 2) {
        const owner = await guardOwnership(tx, current, hostId);
        if (!owner) throw new OperationError('owner_unavailable', 'Skill recovery requires its canonical owner.');
        assertBundleRecoveryBinding(current.recovery, owner, current.execution_token);
      }
      for (const record of records) if (!isWriteTargetContained(record.path, record.root) || !binding.local_path || !isWriteTargetContained(record.path, binding.local_path)) throw new OperationError('recovery_required', 'Recovery file binding is no longer confined to this owner.');
      try {
        if (!isTerminal(current)) for (const record of records) {
          const actual = current.recovery.version === 2 ? bundleFileHash(record) : fileHash(record.path);
          if (actual !== record.beforeHash && actual !== record.afterHash) throw new OperationError('unexpected_file_bytes', 'Canonical recovery bytes changed outside publication.');
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
        if (actual !== record.beforeHash && actual !== record.afterHash) throw new OperationError('unexpected_file_bytes', 'Canonical recovery bytes changed during restoration.');
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
            } else publishFile(file, record.staging?.restoration?.path, undefined, record.mode);
          });
        }
        hooks.fileBoundary?.('after_restore', current, index);
        assertRecoveryStagingAbsent(record);
      }
      // Withdrawal is authoritative DB state and is never rolled back here.
      const failure = terminalError ?? (current.error_code ? {code:current.error_code,message:current.error_message ?? 'Publication failed before database completion.'} : undefined);
      if (failure) return completeWrite(tx, current, conflictCode(failure.code) ? 'conflict' : 'failed', {}, failure);
      for (const key of ['brain', `worktree:${current.worktree_id}`]) await tx.executeRaw('UPDATE persistence_counters SET recovery_bytes=recovery_bytes-$2 WHERE key=$1', [key, Number(current.recovery_bytes)]);
      const [queued] = await tx.executeRaw<WriteRequest>(`UPDATE persistence_requests SET state='queued',execution_token=NULL,
        claim_expires_at=NULL,recovery=NULL,recovery_bytes=0,publication_started=false,blocked_reason=NULL,updated_at=now()
        WHERE id=$1::uuid RETURNING *`, [id]);
      return queued;
    });
    if (isTerminal(row) && row.blocked_reason !== 'unexpected_staging_bytes') {
      await clearResolvedRecovery(engine, id);
      row = (await getWriteRequestById(engine, id))!;
    }
    return row;
  } finally { releaseCapacity?.(); await lock?.release(); }
}
