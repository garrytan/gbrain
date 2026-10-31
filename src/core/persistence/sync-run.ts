import { randomUUID } from 'node:crypto';
import { addSizeState, type PageSizeState, type SyncSizeStates } from '../page-embedding-budget.ts';
import type { BrainEngine, PageSnapshot } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { loadConfig } from '../config.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { RegistryCode } from '../error-registry.ts';
import { currentSourceFilesystemSignal } from '../minions/source-filesystem.ts';
import { throwIfAborted } from '../abort-check.ts';
import { digest, sha256 } from './digest.ts';
import { getWriteRequest, admitWriteInTransaction, foregroundPriority, intentDigest, receiptFor } from './journal.ts';
import { preflightSyncCapacity } from './sync-capacity-preflight.ts';
import { preparationConfigView } from './config-snapshot.ts';
import { retryWriteAdmission } from './admission-retry.ts';
import { assertPersistenceAccepting, awaitWrite, foregroundWriteCompletions, startPersistenceConsumer } from './service.ts';
import { assertSyncEntryOrigin, discoverManagedSync, readManagedSyncRows, resolveManagedSyncContext, readSyncFile, syncGit, type ManagedSyncContext, type SyncDiscovery } from './sync-discovery.ts';
import { checkpointRevival } from './sync-slug-mode.ts';
import { managedCursorKey, resolveManagedCursor } from './sync-cursor-key.ts';
import { isImageFilePath, isMultimodalEnabled } from '../sync.ts';
import { assertSyncPageOrigin, sameSyncOrigin, sharedOriginExit, syncOriginScope } from './sync-origin.ts';
import { activeManagedBrainId, assertManagedSyncActive, assertSyncDispatchActive, managedSyncAuthority, validateSyncAuthority, validateManagedSyncOptions, syncProcessingOptions, SYNC_PROCESSING_KEYS, type SyncAuthority, type SyncProcessingOptions } from './sync-authority.ts';
import { prepareManagedSyncMutation, type SyncCursorOptions, type SyncIntent } from './sync-prepare.ts';
import { streamedSyncBodyRef, type SyncBodyRef } from './sync-streamed.ts';
import { startClaimPhase } from './claim-phase.ts';
import { screeningRequest } from './noop-kernel.ts';
import { noopWaiversEnabled, prescreenedHead, raceSyncBudget, screenWaiver, syncPreparationBudgetMs, unfinishedPageRequestParams, UNFINISHED_PAGE_REQUEST_SQL, waiveNoopEntry, waiveNoopRun, waivePrescreenedRun, waiverBatchEnabled, type NoopWaiver, type WaiverRunEntry } from './sync-waivers.ts';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { currentCompanyBrainSync, getCompanyBrainProfile, readCompanyBrainPlan } from '../company-brain/profile.ts';
import { readCommittedBlob } from '../company-brain/revision.ts';
import { importAnalyzeEveryPages, maybeRefreshPlannerStats } from '../planner-stats.ts';
import { recordManagedSyncFailure, clearManagedSyncFailureAfterSuccess, formatManagedSyncFailure, managedSyncRetryCommand, type ManagedSyncFailure, type ManagedSyncRootCause } from './sync-failures.ts';
import { writeFailureDiagnostic } from './verb-errors.ts';
import { stampDrainStep } from './drain-step.ts';
import { CHECKPOINT_VALIDATION_TIMEOUT, checkpointRetryCommand, checkpointTimeoutHint, probeCheckpointBlocker, type SyncSettledIndexes } from './checkpoint-validation.ts';
import { isTerminalWriteState, publicWriteReceipt, type WriteReceipt } from './types.ts';
import { principalKey, type WriteRequest } from './model.ts';
import { readJournalLimits } from './limits.ts';
import { assertManagedSyncAllowed } from './worktree-refresh.ts';
import type { GBrainConfig } from '../config.ts';
import { admitGroup, dependencyKeys, freezeFollowers, groupableIntent, nextGroupSize, type BulkSettings } from './sync-group.ts';
import { admittedBy, localResumeRequired, readAdmitted, withoutUnadmitted } from './sync-admitted.ts';
import { cursorFenceCause, isSyncKnockOn } from './sync-knock-on.ts';
import { managedSyncResumeArgs } from '../sync-reconcile.ts';
import { laneApplyMsPerMember, lanePolicy, openLanes } from './sync-lanes.ts';
import { SYNC_READ_BOUND, type TreeBlob } from './sync-blobs.ts';
import { readDryRunWriterState } from './sync-dry-run-writer.ts';
import { driftBaselineContent, dryRunScreen, heldImageEntry, isSyncReadBound, loadSyncScreenRun, originConflictHold, oversizeHold, pinnedBlob, pinnedContent, pinnedImageBytes, preparationStalledHold, prepareTimeFenceHold, screenFrozenImport, streamedRefusalHold, unreadableFileHold, type HeldEntry, type SyncScreenRun } from './sync-screen.ts';
import { frozenImageIntent, sameImageBytes } from './sync-image.ts';
import { fenceReceiptLocation } from '../fence-repair/refusal.ts';
import { managedSyncWriteDiagnostic, writeWaitOf } from './sync-write-diagnostic.ts';
import { checkpointSuperseded } from './sync-checkpoint-replaced.ts';
import { publicFailureDetail } from './publication-failure.ts';
import { dependentHold, fileDriftHold, sharedOriginSurvivor, fileChangedAfterAdmission, headCommittedBytes, liveRevision, idempotentDeletionProof, originFaultHold, pageChangeProof, pageChangedHold, pinnedWorktreeConflict, receiptPageFaultHold, worktreeDirtyHold } from './sync-page-fault.ts';
import { faultPoint } from './fault-points.ts';
import { syncReceiptWait } from './sync-receipt-wait.ts';
import { directoryAt, freezeFaultHold, noteFrozen, nullBytesRefusal } from './sync-entry-fault.ts';
import { syncCursorOptions } from './sync-slices.ts';
import { pipelined } from '../page-state/transactions.ts';
import { withCoordinatedWrite } from './context.ts';
import { principalAttribution } from './attribution.ts';
import { recordSyncRunTrend } from '../fence-repair/census-store.ts';
import { outOfAttemptsHold, addFencesNormalized, addRecovered, buildHoldReport, clearGitHold, clearGitHoldRetryPaths, heldGitPaths, fencesNormalizedReport, holdsEscalated, readSyncHoldPolicy, recordSyncConversion, releaseDiscoveredHolds, recoveredReport, writeGitHold, type FencesTally, type GitHoldCode, type SyncHoldPolicy } from './sync-holds.ts';
import { withScreeningPaths } from './screening-paths.ts';
import { withBoundedReadSession } from './bounded-reads.ts';
import { receiptClass, recordedStop, replaysContentRefusal, resumableStop, stopRecorded, unrecordedStop } from './sync-stop-class.ts';
import { advanceHeld, committedPast, deletionSettled, entryOf, indexOf, promoteWindow, waivedCursor, withHeldKeys, withoutPending } from './sync-cursor-moves.ts';
import { withSyncTail } from './sync-tail.ts';
import { assertDrainLease, currentDrainLease, leaseHeldResult, readDrainHolder, withDrainLease } from './sync-lease.ts';
import { LockUnavailableError, syncLockId } from '../db-lock.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { assertPassAdmission, isPassBatchKey, passBatchStep, passedOverBefore, passRequestId, readPassBatch, setPassBatch, type PassEntry } from './sync-pass-batch.ts';
import type { PassStamp } from './sync-prepare.ts';
import { runSyncPass } from './sync-pass-run.ts';
import { serr } from '../console-prefix.ts';
import { noteIdentityDowngrades } from '../sync-identity-downgrades.ts';
import { isContentRefusal } from '../import-screen.ts';

export interface ManagedSyncWriteDiagnostic {
  source_id: string;
  slug: string;
  path: string | null;
  write_error: string;
  reason: string;
  message: string;
  suggestion: string;
  /** #6712 PR 2: a terminal receipt's `classifyTerminal` category and the public category beside it. */
  category?: import('./terminal-classify.ts').TerminalCategory;
  public_category?: import('./public-category.ts').PublicCategory;
  write_request: WriteReceipt;
  line_endings?: 'crlf_lf_only';
  ledger_recorded?: boolean;
  detail?: string; /** GBRA-133 PR 3a: a pass checkpoint the pass's end superseded (sync-checkpoint-replaced.ts). */ disposition?: 'superseded';
  docs?: string;
}

export interface Pending { requestId: string; slug: string; pageId: number | null; intent: SyncIntent; rebound?: true;
  /** #5988: re-frozen in place from a failed content refusal; a second refusal of the same bytes stays blocked. */
  converted?: true;
  /** #6712: re-frozen in place after the run stopped on this entry (a transport or systemic fault, a legacy knock-on); the re-freezes in a row here. */
  stops?: number; }
/** #5988: the frozen entry is held instead of admitted. #6340 `overtaken`: another cursor of the source imported the entry's page meanwhile (#5522), so the checkpoint accepts a source already at this target. */
export interface Held { hold: HeldEntry; overtaken?: true }
/** #6600: the frozen deletion was already carried out by a committed, authorized delete of its exact page (`idempotentDeletionProof`); it settles with no admission and clears its hold. */
export interface Settled { settled: { path: string; request_id: string } }
export interface Cursor extends SyncDiscovery { runId: string; index: number; authority: SyncAuthority; pending?: Pending; done?: boolean; companyReceiptId?: string;
  processingOptions?: SyncProcessingOptions; syncOptions?: SyncCursorOptions; overtaken?: true;
  counts: { added: number; modified: number; deleted: number; chunks: number; renamed?: number; folded?: true;
    /** #5751: unchanged working-tree files skipped only because a no-op publication could never resolve their admit reason. */
    skippedContextualMode?: number; skippedCanonicalBytes?: number;
    /** DX-A7: entries advanced without an admission because their publication would change nothing. */
    waived?: { imports: number; deletes: number };
    /** #6712 PR 1: of the waived imports, those the guarded kernel passed straight from the discovery prescreen (no preparation). */
    prescreened?: number;
    /** #5988: imports held, and files imported only after quoting frontmatter. */
    held?: number; recovered?: { count: number; sample_paths: string[]; comment_values?: number };
    /** #6188: files whose fences Tier 1 rewrote (and the Git effect committed). */
    fences?: FencesTally; /** #6722: committed pages left large or embed_skip, and their embedding state. */ sizeStates?: SyncSizeStates };
  /** #5988: failed content-refusal requests this run converted in place. */
  convertedFromFailed?: string[];
  /** #6643: the indexes this cursor passed without a commit (waived or held), recorded from `settled.from` on; the checkpoint carries them. */
  settled?: SyncSettledIndexes;
  /** #6643: checkpoint revivals. */
  checkpointRevivals?: number;
  /**
   * #6712: entries whose file changed after admission (`source_changed`), retried after the manifest's last entry instead
   * of slept on: each with its deferrals so far (at most `DEFER_PER_ENTRY`, then a `worktree_dirty` hold). `deferrals`
   * counts this run's deferrals (at most `DEFER_PER_RUN`).
   */
  deferred?: Array<{ index: number; attempts: number }>; deferrals?: number;
  /** #6712 dependency edges: the page keys (`dependencyKeys`) of entries this run held, with the held path and code; a later entry sharing one is held behind it. */
  heldKeys?: Record<string, { path: string; code: GitHoldCode }>;
  /** #6278 (1.5): the systemic breaker over this run's `preparation_stalled` receipts; recorded with the cursor CAS that consumes each. */
  breaker?: CursorBreaker;
  /** #5984: the active drain window (reset when a new drain starts), so a backlog ETA never counts downtime. */
  progress?: CursorProgress;
  /** #5984 bulk: the frozen head (also `pending`) and the members admitted with it, in manifest order. */
  group?: Pending[];
  /**
   * #5984 admit-ahead: groups frozen and admitted after `group` while it publishes, in manifest order. Each member's
   * intent names the previous group's last request (`after`), which orders lane commits. #6712: the members of a group
   * after one that did not commit lead the window too, so every admitted request's identity stays in the cursor until
   * its own receipt is read, whenever it commits.
   */
  window?: Pending[][];
  /**
   * #6712 PR 4b: a live pass's round batch (sync-pass-run.ts), held in memory under a `pass:` key with no cursor row. Its
   * intents carry `passId` (no cursor fields) and a request id derived from `(passId, path, level)`; `stamp`: the batch is
   * the pass's stamp (no entries; its checkpoint publishes the stamp). `fullEpisode`: the open `--full` episode its imports
   * record. `failureKey`: the key a recorded failure of the batch is filed under (the pass row's fingerprint). `passLegacyWaived`:
   * the batch indexes a #5751 waiver passed (no provenance recorded), which the pass settles at their level.
   */
  passId?: string; stamp?: PassStamp; fullEpisode?: string; failureKey?: string; resumeArgs?: string[]; passLegacyWaived?: number[]; }
export interface CursorProgress { startedAt: number; startIndex: number; lastAt: number; lastIndex: number }
/**
 * #6278 (1.5): the breaker state a run carries in its cursor. `stalled` lists the `preparation_stalled` receipts this run
 * processed (held, or the one that tripped), so a restart neither double-counts a receipt nor loses the trip; `streak`
 * counts consecutive stalled entries with no committed page between them. A tripped cursor holds nothing more: the
 * run stops `blocked` / `preparation_systemic`, and the next run re-freezes the entry and schedules the run's earlier
 * stalled holds for a re-screen instead of holding.
 */
export interface CursorBreaker { stalled: string[]; streak: number; interrupted?: number; tripped?: { at: string; rule: 'count' | 'consecutive'; stalled: number; streak: number; step: string | null; request_id: string; interrupted?: number } }
/** The second trip rule: this many consecutive stalled entries with no commit between them. */
export const BREAKER_STREAK = 5;
/** The breaker after this receipt: the count rule is `holdsEscalated`'s "greater than" rule over the run's screened imports, the streak rule is `BREAKER_STREAK`. */
function breakerAfter(cursor: Cursor, done: Pick<WriteRequest, 'request_id' | 'error_code' | 'error_detail'>, policy: Pick<SyncHoldPolicy, 'escalateCount' | 'escalatePct'>): CursorBreaker {
  const prior = cursor.breaker ?? { stalled: [], streak: 0 };
  if (prior.tripped || prior.stalled.includes(done.request_id)) return prior;
  const stalled = [...prior.stalled, done.request_id], streak = prior.streak + 1, interrupted = (prior.interrupted ?? 0) + (done.error_code === 'write_interrupted' ? 1 : 0);
  const screened = cursor.entries.slice(0, cursor.index + 1).filter(entry => entry.action === 'import').length;
  const rule = holdsEscalated(policy, stalled.length, { held: stalled.length, screened }) ? 'count' : streak >= BREAKER_STREAK ? 'consecutive' : null;
  const step = done.error_detail && typeof done.error_detail === 'object' && typeof (done.error_detail as Record<string, unknown>).step === 'string' ? String((done.error_detail as Record<string, unknown>).step) : null;
  return { stalled, streak, interrupted, ...(rule ? { tripped: { at: new Date().toISOString(), rule, stalled: stalled.length, streak, step, request_id: done.request_id, interrupted } } : {}) };
}
/** The cursor after a committed page: a commit ends the breaker's consecutive streak. */
function committedBreaker(cursor: Cursor): Pick<Cursor, 'breaker'> {
  return cursor.breaker?.streak ? { breaker: { ...cursor.breaker, streak: 0 } } : {};
}
/** #6278: the systemic stop a sync result carries when the breaker trips (`drain.stop_reason: preparation_systemic`). */
export interface ManagedSyncBreaker {
  code: 'preparation_systemic';
  rule: 'count' | 'consecutive';
  /** `preparation_stalled` receipts this run saw, and how many in a row without a committed page. */
  stalled: number;
  consecutive: number;
  step: string | null;
  request_id: string;
  fix: import('../agent-output.ts').Action;
}
function breakerResult(cursor: Cursor, pending: Pending, done: WriteRequest, remote: boolean): SyncResult {
  const trip = cursor.breaker!.tripped!, interrupted = trip.interrupted ?? 0, prepared = trip.stalled - interrupted;
  const causes = [prepared ? `${prepared} could not finish preparing${trip.step ? ` at step ${trip.step}` : ''}` : '', interrupted ? `${interrupted} had their statements ended by the database (write_interrupted)` : ''].filter(Boolean).join(', ');
  const fix: ManagedSyncBreaker['fix'] = { argv: ['gbrain', 'sources', 'writer', 'status', '--source', cursor.sourceId, '--json'], consent: [], actor: remote ? 'host_admin' : 'agent', requires_exclusive: false,
    docs: 'docs/guides/write-refusals.md#preparation_systemic', verify: { argv: ['gbrain', 'sources', 'status', cursor.sourceId, '--json'] },
    why: `${trip.stalled} write(s) of this sync ran out of attempts: ${causes} (${trip.rule === 'consecutive' ? `${trip.streak} in a row with no page committed between them` : 'more than a source should hold'}), `
      + 'so the run stopped instead of holding every file: the write owner, not the files, is the likely cause. Writer status (read-only) shows the owner process, its gbrain version and the step '
      + 'each stuck write reached; fix what it names or upgrade gbrain, then rerun the same sync: it re-freezes the stopped entry and re-screens the files this run held.',
    ...(remote ? { user_message: `A managed sync of source ${cursor.sourceId} stopped because ${trip.stalled} writes ran out of attempts (${causes}). Please run 'gbrain sources writer status --source ${cursor.sourceId} --json' on the brain host, fix what it names, then rerun the sync.` } : {}) };
  return { ...result(cursor, 'blocked_by_failures'), failedFiles: 1, failureCodes: [{ code: PREPARATION_STALLED, count: prepared }, { code: 'write_interrupted', count: interrupted }].filter(code => code.count > 0),
    breaker: { code: 'preparation_systemic', rule: trip.rule, stalled: trip.stalled, consecutive: trip.streak, step: trip.step, request_id: trip.request_id, fix },
    ...(remote ? {} : { managedWrite: writeDiagnostic(cursor, pending, done) }) };
}
/** #5984: the cursor's progress after advancing to `index`, in the drain window that started at `drainStartedAt`. */
function stampProgress(prior: CursorProgress | undefined, fromIndex: number, index: number, drainStartedAt: number): CursorProgress {
  const now = Date.now();
  return prior && prior.startedAt === drainStartedAt ? { ...prior, lastAt: now, lastIndex: index }
    : { startedAt: drainStartedAt, startIndex: fromIndex, lastAt: now, lastIndex: index };
}
const OP = 'managed-sync';
type CursorHeader = Omit<Cursor, 'entries' | 'companyPlan'> & { total: number };
const header = ({ entries, companyPlan: _plan, ...value }: Cursor): CursorHeader => ({ ...value, total: entries.length });
/** A managed sync run stopped before admitting the current entry; the next sync retries the recorded failure by rediscovering. */
function syncRunRefusal(code: RegistryCode, message: string, retry: Parameters<typeof checkpointRetryCommand>[0], cause: string): OperationError {
  return opError(code, message, `${cause} Pages committed earlier in this run stay committed. Check the source with the command in fix, then run: ${checkpointRetryCommand(retry)}`,
    { fix: readFix(`Shows source ${retry.sourceId}'s owner and every pending, failed or recovering request, read-only.`,
      { argv: ['gbrain', 'sources', 'writer', 'status', '--source', retry.sourceId, '--json'] }) });
}
class MissingSyncManifest extends OperationError {
  constructor(readonly cursor: CursorHeader) { super('storage_error', 'The durable sync manifest is unavailable.'); }
}
async function readCursor(engine: BrainEngine, key: string, cached?: Cursor): Promise<Cursor | null> {
  if (isPassBatchKey(key)) return readPassBatch<Cursor>(key);
  const [row] = await engine.executeRaw<{ completed_keys: [CursorHeader] }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [OP, key]);
  const value = row?.completed_keys?.[0];
  if (!value) return null;
  let entries = cached?.runId === value.runId ? cached.entries : undefined;
  if (!entries) {
    const [manifest] = await engine.executeRaw<{ completed_keys: Cursor['entries'] }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [`${OP}-manifest`, value.runId]);
    entries = manifest?.completed_keys;
  }
  if (!entries || entries.length !== value.total) throw new MissingSyncManifest(value);
  const companyPlan = value.companyReceiptId ? cached?.companyPlan ?? await readCompanyBrainPlan(engine, value.companyReceiptId) : undefined;
  return { ...value, entries, ...(companyPlan ? { companyPlan } : {}) };
}
async function saveCursor(engine: BrainEngine, key: string, before: Cursor | null, next: Cursor, requireIdle = false, assertActive?: () => void,
  inTx?: (tx: BrainEngine) => Promise<unknown>): Promise<Cursor> {
  const saved = await engine.transaction(async tx => {
    assertActive?.();
    if (!requireIdle) {
      const current = await writeCursor(tx, key, before, next, inTx, true);
      assertActive?.();
      return current;
    }
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
    if (requireIdle) {
      await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR UPDATE', [next.binding.worktree_id]);
      const active = await tx.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) LIMIT 1", [next.sourceId]);
      if (active.length) {
        const current = (await readCursor(tx, key, before ?? undefined))!;
        assertActive?.();
        return current;
      }
    }
    const current = await writeCursor(tx, key, before, next, inTx);
    assertActive?.();
    return current;
  });
  await faultPoint('sync:mid_checkpoint', { sourceId: next.sourceId });
  return saved;
}
/** Compare-and-swap inside the caller's transaction; a lost swap returns the cursor that won. */
async function writeCursor(tx: BrainEngine, key: string, before: Cursor | null, next: Cursor, inTx?: (tx: BrainEngine) => Promise<unknown>, synchronous = false): Promise<Cursor> {
  // #6643: a cursor records the indexes it settles without a commit from its first save by this build on; a cursor saved
  // before (a run that began on an older build) starts recording at the index it had then.
  if (!next.settled) next.settled = before && before.runId === next.runId ? { from: before.settled?.from ?? before.index, ranges: before.settled?.ranges ?? [] } : { from: 0, ranges: [] };
  if (isPassBatchKey(key)) return await passBatchStep(tx, key, before && JSON.stringify(header(before)), next, JSON.stringify(header(next)), inTx) ? next : currentCursor(tx, key, next);
  await assertDrainLease(tx, next.sourceId);
  if (before === null) {
    if (synchronous) await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
    await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb) ON CONFLICT DO NOTHING`, [`${OP}-manifest`, next.runId, JSON.stringify(next.entries)]);
    const inserted = await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb) ON CONFLICT DO NOTHING RETURNING fingerprint`, [OP, key, JSON.stringify([header(next)])]);
    // #6278 (B7): what rides a fresh cursor's save (the retry schedule it consumed) commits only with the insert that won.
    if (inserted.length) await inTx?.(tx);
  } else {
    // #5984: the settings, the compare-and-swap and the manifest touch go out together; a won swap is the saved cursor.
    const [, saved] = await pipelined(tx, [
      () => synchronous ? tx.executeRaw("SELECT set_config('synchronous_commit','on',true)") : Promise.resolve([]),
      () => tx.executeRaw(`UPDATE op_checkpoints SET completed_keys=$4::text::jsonb,updated_at=now()
      WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb RETURNING fingerprint`, [OP, key, JSON.stringify([header(before)]), JSON.stringify([header(next)])]),
      () => tx.executeRaw('UPDATE op_checkpoints SET updated_at=now() WHERE op=$1 AND fingerprint=$2', [`${OP}-manifest`, next.runId]),
    ]) as [unknown, unknown[]];
    // #5988: a hold write or clear commits with the cursor step that passes its entry, never without it.
    if (saved.length) await inTx?.(tx);
    // #6188 (E33): the run's fences_normalized total commits with the cursor step that counts it, so the trend never differs from the cursor.
    const fences = next.counts.fences;
    if (saved.length && fences?.count && fences.count !== before.counts.fences?.count) await recordSyncRunTrend(tx, { sourceId: next.sourceId, runId: next.runId,
      day: new Date().toISOString().slice(0, 10), count: fences.count, byClass: fences.by_class, writers: fences.dirs });
    if (saved.length) return next;
  }
  return currentCursor(tx, key, next);
}
async function currentCursor(engine: BrainEngine, key: string, cached: Cursor): Promise<Cursor> {
  const current = await readCursor(engine, key, cached);
  if (!current) throw syncRunRefusal('storage_error', 'The durable sync cursor disappeared.', cached,
    `The durable sync cursor of source ${cached.sourceId} vanished (another run of the source finished or replaced it), so this run stopped.`);
  return current;
}
/** The rollback signal of an admission whose cursor no longer holds the frozen entry (ENG-A7). */
class CursorMoved extends Error {}
function result(cursor: Cursor | CursorHeader, status: SyncResult['status'], reason?: SyncResult['reason']): SyncResult {
  return { status, ...(cursor.authority.writer.remote ? {} : { runId: cursor.runId }), fromCommit: cursor.authority.writer.remote ? null : cursor.from,
    toCommit: cursor.authority.writer.remote ? '' : cursor.target, added: cursor.counts.added, modified: cursor.counts.modified,
    deleted: cursor.counts.deleted, renamed: cursor.counts.renamed ?? 0, chunksCreated: cursor.counts.chunks, embedded: 0, pagesAffected: [],
    ...(cursor.slugCollisions?.length ? { slugCollisions: cursor.slugCollisions } : {}), ...(cursor.identityDowngrades?.length ? { identityDowngrades: cursor.identityDowngrades } : {}),
    ...(cursor.fileRefusals?.length ? { fileRefusals: cursor.fileRefusals } : {}), ...(cursor.workingTreeKept?.length ? { working_tree_kept: cursor.workingTreeKept.length } : {}),
    ...(cursor.storageInvalidKept?.length ? { storage_invalid_kept: cursor.storageInvalidKept.length } : {}),
    ...(cursor.stagedHead && !cursor.authority.writer.remote ? { staged: { target: cursor.target, head: cursor.stagedHead, ...(cursor.slice && !cursor.slice.done ? { slice: { phase: cursor.slice.phase, after: cursor.slice.after } } : {}) } } : {}),
    waived: { imports: cursor.counts.waived?.imports ?? 0, deletes: cursor.counts.waived?.deletes ?? 0 }, prescreened: cursor.counts.prescreened ?? 0,
    filesImported: cursor.index, bankedFiles: cursor.index,
    managedCursor: { index: cursor.index, total: 'total' in cursor ? cursor.total : cursor.entries.length, ...(cursor.progress ? { progress: cursor.progress } : {}) },
    ...(cursor.uncommitted ? { uncommitted: cursor.uncommitted } : {}), ...(reason ? { reason } : {}),
    ...(cursor.counts.sizeStates?.total ? { size_states: cursor.counts.sizeStates } : {}),
    ...(cursor.counts.skippedContextualMode || cursor.counts.skippedCanonicalBytes ? { legacySkips: {
      contextualMode: cursor.counts.skippedContextualMode ?? 0, canonicalBytes: cursor.counts.skippedCanonicalBytes ?? 0 } } : {}) };
}
const writeDiagnostic = (cursor: Cursor, pending: Pending, row: WriteRequest) => managedSyncWriteDiagnostic({ sourceId: cursor.sourceId, root: cursor.root, processingOptions: cursor.processingOptions, syncOptions: cursor.syncOptions ?? null }, pending, row);
/**
 * #5984 G3: the page snapshot each frozen entry was validated against, read right before its sync authority check;
 * a waiver run's screen of that entry uses it instead of reading the page and the authority again.
 */
const frozenSnapshots = new WeakMap<Pending, PageSnapshot | null>();
function remember(snapshot: PageSnapshot | null | undefined, pending: Pending): Pending {
  if (snapshot !== undefined) frozenSnapshots.set(pending, snapshot);
  return pending;
}
/** GBRA-133 S-63: one entry whose freeze throws is held alone when holds are on (sync-entry-fault.ts); run-scoped faults and deliberate refusals still stop. */
async function freezeEntry(engine: BrainEngine, cursor: Cursor, key: string, assertActive: () => void, run: Parameters<typeof freezeEntryOnce>[4]): Promise<Pending | Held | Settled> {
  const entry = cursor.entries[cursor.index];
  try { const frozen = await freezeEntryOnce(engine, cursor, key, assertActive, run); noteFrozen(run.screen); return frozen; } catch (error) {
    const hold = entry && run.screen && !cursor.companyPlan && !run.signal?.aborted ? freezeFaultHold(run.screen, entry, entry.slug!, entry.pageId ?? null, error, () => pinnedBlob(cursor, entry.path)) : null;
    if (!hold) throw error;
    return { hold };
  }
}
async function freezeEntryOnce(engine: BrainEngine, cursor: Cursor, key: string, assertActive: () => void,
  run: { syncOptions: SyncCursorOptions; repoPath?: string; screen?: SyncScreenRun | null; observedAt?: string; signal?: AbortSignal; embedDeferred?: boolean }): Promise<Pending | Held | Settled> {
  assertActive();
  const entry = cursor.entries[cursor.index];
  const retry = { sourceId: cursor.sourceId, processingOptions: cursor.processingOptions, syncOptions: cursor.syncOptions ?? run.syncOptions, repoPath: run.repoPath };
  let slug = '__managed_sync_checkpoint__', pageId: number | null = null, revision: string | null = null;
  let content: string | null = null, rawHash: string | null = null;
  let lineEndingOnly = false, occupantRebound = false;
  let frozenSnapshot: PageSnapshot | null | undefined;
  // #5988: company-profile sources never hold; their approved manifest keeps refusing.
  const screening = entry?.action === 'import' && !cursor.companyPlan ? run.screen ?? null : null;
  let blob: TreeBlob | null = null, oversize: { size: number | null } | undefined, bodyRef: SyncBodyRef | null = null;
  // #6529: an image entry is frozen as its bytes (base64) for the coordinated image importer when multimodal embedding is on.
  const image = !!entry && entry.action === 'import' && !cursor.companyPlan && isImageFilePath(entry.path);
  let imageBytes: Buffer | null = null;
  if (entry) {
    assertSyncEntryOrigin(cursor, entry);
    if (image && !isMultimodalEnabled()) return { hold: heldImageEntry(cursor, entry) };
    const originScope = syncOriginScope(cursor);
    // #5522: another cursor of this source may have imported this new file since enumeration.
    // #5984 G3: the page snapshot is read beside the origin check (they are independent reads of committed state).
    // #6340: page faults (the database page moved under the manifest) hold the entry, imports and deletes alike, when holds
    // are on; `sync.holds=fail` and company-brain cursors keep the refusals.
    const holdsOn = !!run.screen && !cursor.companyPlan;
    if (entry.legacySlugs?.length && !holdsOn) throw syncRunRefusal('page_identity_changed', 'Legacy pages sync cannot import into match the imported file.', retry, `${entry.path} imports as page ${entry.slug}, but pages ${entry.legacySlugs.join(', ')} of source ${cursor.sourceId}, imported from a file of that name, record no file (sync.holds=fail); keep the file's page, remove the others, then sync again.`);
    if (entry.originConflict) {
      if (!holdsOn) throw syncRunRefusal('page_identity_changed', 'Several pages claim the same imported origin.', retry, `Pages ${entry.originConflict.claimants.map(page => page.slug).join(', ')} of source ${cursor.sourceId} all record ${entry.path} as their origin (sync.holds=fail); ${sharedOriginExit(cursor.sourceId, entry.originConflict.claimants.map(page => page.slug))} Then sync again.`);
      return { hold: originConflictHold(entry) };
    }
    const [occupant, snapshot] = await Promise.all([alreadyImportedAtOrigin(engine, cursor, entry, originScope).catch(error => {
      if (!holdsOn || !(error instanceof OperationError) || error.code !== 'page_identity_changed') throw error;
      return { originFault: error };
    }), engine.readPageSnapshot(entry.slug!, { sourceId: cursor.sourceId, includeDeleted: true })]);
    assertActive();
    if (occupant && 'originFault' in occupant) {
      if (entry.action === 'delete' && snapshot?.page.deleted_at != null && !existsSync(join(cursor.root, entry.path))) {
        const done = await idempotentDeletionProof(engine, { sourceId: cursor.sourceId, incarnation: cursor.incarnation, pageId: entry.pageId ?? null, revision: entry.revision ?? null, sourcePath: entry.sourcePath });
        assertActive();
        if (done) return { settled: { path: entry.path, request_id: done.request_id } };
      }
      return { hold: await originFaultHold(engine, { sourceId: cursor.sourceId, incarnation: cursor.incarnation, entry, observed: snapshot, message: occupant.originFault.message }), overtaken: true };
    }
    let bytes: Buffer | null = null;
    // G3: a strict source's entry reads its commit alone (a deletion has no bytes); only a blob over the read bound takes the streamed path below.
    const committed = entry.committedOnly === true && !entry.working ? entry.action === 'delete' ? null : pinnedBlob(cursor, entry.path) : undefined;
    try { bytes = committed !== undefined && (committed === null || committed.size <= SYNC_READ_BOUND) ? committed && pinnedImageBytes(cursor, entry)
      : entry.action === 'delete' && directoryAt(cursor.root, entry.path) ? null : readSyncFile(cursor.root, entry.path); } // GBRA-133 S-22: a directory is no file
    catch (error) {
      if (!isSyncReadBound(error)) { const held = holdsOn ? unreadableFileHold(entry, entry.slug!, entry.pageId ?? null, error, () => pinnedBlob(cursor, entry.path)) : null; if (held) return { hold: held }; throw error; } // GBRA-130 A-7
      // Wave B: with segmented storage on, a Markdown file over the read bound is frozen by reference and streamed by its owner.
      if (entry.action === 'import' && !cursor.companyPlan && !image) {
        bodyRef = await streamedSyncBodyRef(engine, { root: cursor.root, path: entry.path, target: cursor.target, working: entry.working,
          blob: () => (blob = pinnedBlob(cursor, entry.path)) });
        assertActive();
      }
      if (!bodyRef && !screening) throw error;
      if (!bodyRef) oversize = { size: null };
    }
    if ((screening || image) && !entry.working && !bodyRef) {
      // #5988: an over-bound pinned blob is held by its size before its content is loaded.
      blob = pinnedBlob(cursor, entry.path);
      if (blob && blob.size > SYNC_READ_BOUND) oversize = { size: blob.size };
    }
    rawHash = bodyRef ? bodyRef.sha256 : bytes === null ? null : sha256(bytes);
    if (image && oversize) return { hold: oversizeHold(entry, entry.slug!, entry.pageId ?? null, oversize.size, blob) };
    if (image) imageBytes = pinnedImageBytes(cursor, entry);
    if (entry.action === 'import' && cursor.companyPlan) {
      const company = currentCompanyBrainSync(cursor.sourceId);
      const blob = company?.entries.get(entry.path);
      if (company?.receiptId !== cursor.companyReceiptId || !blob || blob.disposition !== 'included') throw syncRunRefusal('plan_stale', 'The durable cursor does not match its approved content manifest.',
        retry,
        `Source ${cursor.sourceId}'s approved company-brain content manifest no longer includes ${entry.path} for this run (its approval changed, or the file is no longer an included path), so nothing was imported for it. If the approval changed, inspect and approve the repository again first (gbrain sources inspect --help).`);
      content = (await readCommittedBlob(cursor.companyPlan.revision!, blob, cursor.companyPlan.limits)).toString('utf8');
      assertActive();
    } else content = imageBytes ? frozenImageIntent(imageBytes).content : entry.action === 'import' && !oversize && !bodyRef ? pinnedContent(cursor, entry) : null;
    const nul = !screening && content !== null && !image ? nullBytesRefusal(entry.path, content) : null; // GBRA-133 S-39 with sync.holds=fail
    if (nul) throw syncRunRefusal('content_null_bytes', 'A synced Markdown file holds NUL bytes.', retry, nul.message);
    // #6340: working-tree bytes that differ from the pinned blob but are committed at HEAD (a commit past the pin on a
    // live checkout) are imported as HEAD has them; the pin..HEAD diff later re-imports the same bytes as a no-op.
    // Uncommitted bytes keep the pinned content and reach the publication screen (idea from PR #6323).
    if (entry.action === 'import' && !cursor.companyPlan && !image && !entry.working && content !== null && rawHash !== null && rawHash !== sha256(content)) {
      const head = headCommittedBytes(cursor, entry.path);
      if (head && head.rawHash === rawHash) { content = head.content; blob = { oid: head.oid, size: bytes!.length }; }
    }
    lineEndingOnly = !image && bytes !== null && content !== null && bytes.equals(Buffer.from(bytes.toString('utf8'))) &&
      bytes.toString('utf8').replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n');
    slug = entry.slug!; pageId = occupant?.page.id ?? entry.pageId ?? null; revision = occupant ? occupant.revision : entry.revision ?? null;
    frozenSnapshot = snapshot;
    // #6340: a page that moved under the manifest holds the page, not the run (sync-page-fault.ts); `sync.holds=fail`
    // and company-brain cursors keep the refusal. The hold's intent shape is what the entry would have imported.
    const frozenIntent = { content, blobOid: blob?.oid, expected_revision: revision, rawHash };
    const moved = entry.renameFrom;
    // A page another cursor of the source moved may also have been checkpointed by it at this exact target (#5522), so a
    // page-fault hold marks the cursor overtaken; the checkpoint still refuses any other move of `last_commit`.
    const pageHold = async (why: string, observedPageId: number | null, observedRevision: string | null): Promise<Held> => {
      const proof = await pageChangeProof(engine, { sourceId: cursor.sourceId, incarnation: cursor.incarnation, pageId, expectedRevision: revision });
      assertActive();
      return { hold: pageChangedHold(entry, slug, observedPageId ?? pageId, frozenIntent, { proof, revision: observedRevision, why }), overtaken: true };
    };
    if (occupant && (content === null || !(image ? sameImageBytes(imageBytes, occupant.page) : await sameContentAtOrigin(engine, cursor, entry, key, snapshot, content, rawHash, lineEndingOnly, run.signal)))) {
      if (holdsOn) return pageHold(`another run of this source imported page ${slug} from ${entry.path} with different content`, occupant.page.id, occupant.revision);
      throw syncRunRefusal('page_identity_changed', 'The imported origin no longer identifies exactly the accepted page.', retry,
        `Page ${slug} was imported from ${entry.path} by another run of source ${cursor.sourceId} with different content after this run enumerated it, so the run stopped before admitting it.`);
    }
    occupantRebound = occupant !== null;
    const recorded = moved?.slug === slug ? moved.sourcePath : entry.sourcePath;
    const foreignOrigin = snapshot?.page.source_path != null && !sameSyncOrigin(snapshot.page.source_path, recorded, originScope, snapshot.page.slug);
    if ((snapshot?.page.id ?? null) !== pageId || (snapshot?.revision ?? null) !== revision || (entry.unownedDeletion ? !foreignOrigin : foreignOrigin)) {
      if (!holdsOn) throw syncRunRefusal('revision_conflict', 'A page changed after this sync cursor was enumerated.', retry,
        `Page ${slug} in source ${cursor.sourceId} was edited, deleted or re-bound after this sync enumerated ${entry.path}, so the run stopped before admitting it.`);
      // The page moved but still holds exactly what this import carries: re-bind the entry to it (the waiver screen passes it).
      const rebind = entry.action === 'import' && !moved && !foreignOrigin && snapshot !== null && snapshot.page.deleted_at == null
        && (snapshot.page.id === pageId || pageId === null) && content !== null
        && (image ? sameImageBytes(imageBytes, snapshot.page) : await sameContentAtOrigin(engine, cursor, entry, key, snapshot, content, rawHash, lineEndingOnly, run.signal));
      assertActive();
      if (!rebind) return pageHold(`page ${slug} was ${snapshot === null || snapshot.page.deleted_at != null ? 'deleted' : foreignOrigin ? 're-bound to another file' : 'edited'} in the database`,
        snapshot?.page.id ?? null, snapshot?.revision ?? null);
      // Re-bound like a #5522 occupant: the cursor is marked overtaken, since another cursor may have checkpointed this target.
      pageId = snapshot!.page.id; revision = snapshot!.revision; occupantRebound = true;
    }
    if (moved && moved.slug !== slug) {
      const previous = await engine.readPageSnapshot(moved.slug, { sourceId: cursor.sourceId, includeDeleted: true });
      assertActive();
      if (previous?.page.id !== moved.pageId || previous.revision !== moved.revision || previous.page.deleted_at != null ||
          previous.page.source_path == null || !sameSyncOrigin(previous.page.source_path, moved.sourcePath, originScope, previous.page.slug)) {
        if (holdsOn) return { hold: pageChangedHold(entry, slug, pageId, frozenIntent, { proof: null, revision: previous?.revision ?? null,
          why: `page ${moved.slug}, which ${entry.path} was renamed from, changed or was deleted in the database` }), overtaken: true };
        throw syncRunRefusal('revision_conflict', 'A renamed page changed after this sync cursor was enumerated.', retry,
          `Page ${moved.slug}, which ${entry.path} was renamed from, changed or was deleted after this sync enumerated it, so the run stopped before admitting the rename.`);
      }
    }
    // #6712 PR 1: an import whose page moved since its file was last imported runs only as a proven no-op (sync-prescreen.ts).
    if (entry.drift && !occupantRebound && content !== null && snapshot && !(image ? sameImageBytes(imageBytes, snapshot.page)
      : await sameContentAtOrigin(engine, cursor, entry, key, snapshot, content, rawHash, lineEndingOnly, run.signal) || await sameContentAtOrigin(engine, cursor, entry, key, snapshot, driftBaselineContent(cursor.gitRoot, entry), null, false, run.signal, true))) {
      if (!holdsOn) throw syncRunRefusal('file_drift', 'An import would overwrite a database version of the page that sync never saw.', retry, `Page ${slug} in source ${cursor.sourceId} ${entry.drift === 'unknown' ? `differs from ${entry.path} and has no import record to tell whether the file or the database changed` : `changed in the database since ${entry.path} was last imported, and the file differs from it`}, so the run stopped before admitting it (sync.holds=fail).`);
      const proof = await pageChangeProof(engine, { sourceId: cursor.sourceId, incarnation: cursor.incarnation, pageId, expectedRevision: null }); assertActive();
      return { hold: fileDriftHold(entry, slug, pageId, frozenIntent, { sides: entry.drift, revision: snapshot.revision, proof, sharedOrigin: await sharedOriginSurvivor(engine, cursor.sourceId, entry.sourcePath) }) };
    }
    if (screening && !image) {
      const hold = await screenFrozenImport(engine, { cursor, entry, slug, pageId, snapshot, content, rawHash, lineEndingOnly, blob, oversize, streamed: !!bodyRef,
        retryCommand: checkpointRetryCommand(retry) }, screening);
      assertActive();
      if (hold) return { hold };
    }
  }
  await validateSyncAuthority(engine, cursor.authority, slug);
  assertActive();
  if (entry?.action === 'import') await faultPoint('sync:after_freeze', { sourceId: cursor.sourceId, slug, path: entry.path });
  const passLevel = cursor.passId ? (entry as PassEntry | undefined)?.level ?? (entry ? null : cursor.target) : undefined;
  return remember(frozenSnapshot, { requestId: cursor.passId ? passRequestId(cursor.passId, entry?.path ?? slug, passLevel!) : randomUUID(), slug, pageId, ...(occupantRebound ? { rebound: true as const } : {}), intent: { kind: !entry ? 'managed_sync_checkpoint' : entry.action === 'import' ? 'managed_sync_import' : 'managed_sync_delete',
    expected_revision: revision, sourcePath: entry?.sourcePath ?? null, path: entry?.path ?? null, rawHash, content, lineEndingOnly, ...(bodyRef ? { body_ref: bodyRef } : {}),
    ...(entry?.unownedDeletion ? { unownedDeletion: true } : {}), ...(entry?.heldDeletion ? { heldDeletion: entry.heldDeletion } : {}),
    ...(entry?.committedOnly ? { committedOnly: true } : {}),
    ...(entry?.renameFrom ? { renameFrom: entry.renameFrom } : {}),
    ...(run.observedAt ? { holdObservedAt: run.observedAt } : {}), ...(blob ? { blobOid: blob.oid } : {}), ...(entry && run.embedDeferred ? { embedDeferred: true } : {}),
    ...(!entry && cursor.releasedHolds?.length ? { releasedHolds: cursor.releasedHolds } : {}),
    ...(!entry && cursor.convertedFromFailed?.length ? { supersededRequests: cursor.convertedFromFailed } : {}),
    ...(!entry && cursor.settled ? { settled: cursor.settled } : {}),
    processingOptions: cursor.processingOptions,
    // A cursor created before its options were recorded has the same key, so this run's options are its options.
    ...(!entry ? { syncOptions: cursor.syncOptions ?? run.syncOptions, ...(run.repoPath ? { repoPath: run.repoPath } : {}) } : {}),
    ...(!entry && cursor.overtaken ? { overtaken: true } : {}),
    ownerEpoch: String(cursor.binding.owner_epoch), syncAuthority: cursor.authority, ...cursorIntent(cursor, key),
    ...(cursor.passId ? { level: passLevel ?? null, ...(cursor.stamp && (!entry || cursor.index === cursor.entries.length - 1) ? { stamp: cursor.stamp } : {}) } : {}),
    slugMode: cursor.slugMode, from: cursor.from, target: cursor.target, working: entry?.working ?? false,
    ...(cursor.companyPlan ? { companyApproval: { schema: cursor.companyPlan.schema!, planDigest: cursor.companyPlan.plan_digest, extractorVersion: cursor.companyPlan.extractor_version,
      policyFingerprint: currentCompanyBrainSync(cursor.sourceId)!.policyFingerprint } } : {}) } });
}

/**
 * #6712: the cursor's next freeze. Past the manifest's last entry it is the first entry deferred because its file
 * changed after admission. A settled deletion (#6600) and a hold, the entry's own or a dependency edge's (an entry that
 * shares a slug or page id with one this run held waits on that hold), are saved in one cursor step (`saved`); anything
 * else is the frozen entry to admit.
 */
async function freezeNext(engine: BrainEngine, cursor: Cursor, key: string, assertActive: () => void, run: Parameters<typeof freezeEntry>[4],
  observedAt: string): Promise<{ saved: Cursor; held: boolean } | { frozen: Pending; deferredAt?: number }> {
  const deferredAt: number | undefined = cursor.index >= cursor.entries.length ? cursor.deferred?.[0]?.index : undefined;
  const index = deferredAt ?? cursor.index;
  let frozen = await freezeEntry(engine, { ...cursor, index }, key, assertActive, run);
  if ('settled' in frozen) return { held: false, saved: await saveCursor(engine, key, cursor, deletionSettled(cursor, index), false, assertActive, holdClear(cursor, frozen.settled.path, observedAt)) };
  const blockedOn = 'requestId' in frozen ? dependencyKeys(frozen).map(page => cursor.heldKeys?.[page]).find(Boolean) : undefined;
  if (blockedOn && 'requestId' in frozen && cursor.entries[index]) frozen = { hold: dependentHold(cursor.entries[index]!, frozen.slug, frozen.pageId, frozen.intent, blockedOn) };
  if ('hold' in frozen) {
    return { held: true, saved: await saveCursor(engine, key, cursor, { ...withHeldKeys(advanceHeld(cursor, undefined, index), frozen.hold), ...(frozen.overtaken ? { overtaken: true as const } : {}) },
      false, assertActive, heldWrite(cursor, frozen.hold, observedAt)) };
  }
  return { frozen, ...(deferredAt !== undefined ? { deferredAt } : {}) };
}


/**
 * #6712 PR 1: a pass resumes the source's one cursor whoever wrote it (sync-cursor-key.ts), in one compare-and-swap:
 * - Admitted requests keep the authority frozen in their intent: they are read under that principal (`admittedBy`) and
 *   publish under it. A frozen entry no request was admitted for yet is dropped (`withoutUnadmitted`), so it is frozen
 *   again under this pass's authority and nothing new is admitted on an earlier writer's grant.
 * - This pass's authority is validated and stamped on the cursor in the same transaction; what it freezes from then on
 *   is authorized for its own grant (`freezeEntry` validates every entry with the cursor's authority).
 * - A remote caller resumes only its own principal's cursor; any other is left to the brain host's CLI.
 * - Processing options: only a company cursor reaches here, and its approval keeps its exact options (a non-company
 *   pass keeps its opt-outs on the pass row's episode).
 */
async function adoptCursor(engine: BrainEngine, key: string, cursor: Cursor, input: { authority: SyncAuthority; processingOptions: SyncProcessingOptions;
  embedDeferred?: boolean; assertActive: () => void }): Promise<Cursor> {
  const { authority } = input;
  // #6696: a cost-gate deferral is this run's constraint (each request it freezes carries `embedDeferred`), never an opt-out the cursor keeps.
  const processingOptions = input.embedDeferred ? { ...input.processingOptions, noEmbed: false } : input.processingOptions;
  const writerChanged = digest(cursor.authority) !== digest(authority);
  if (writerChanged && authority.writer.remote && (!cursor.authority.writer.remote
      || principalKey(cursor.authority.writer.principal) !== principalKey(authority.writer.principal))) throw localResumeRequired(cursor.sourceId);
  if (!writerChanged && cursor.processingOptions) return cursor;
  const next: Cursor = { ...cursor, authority, processingOptions: cursor.processingOptions ?? processingOptions };
  if (writerChanged) await withoutUnadmitted(engine, next);
  const saved = await saveCursor(engine, key, cursor, next, false, input.assertActive, tx => validateSyncAuthority(tx, authority, '__managed_sync_checkpoint__'));
  if (writerChanged) await faultPoint('sync:cursor_adopted', { sourceId: cursor.sourceId });
  return saved;
}
/** #5988: a managed dry run lists the holds the pending (or newly discovered) imports would earn, read-only. */
async function managedDryRun(engine: BrainEngine, value: Cursor, base: Cursor, run: { company: boolean; processingOptions: SyncProcessingOptions;
  syncOptions: SyncCursorOptions; repoPath?: string; remote: boolean }): Promise<SyncResult> {
  const screen = run.company ? null : await loadSyncScreenRun(engine, value.sourceId, value.processingOptions ?? run.processingOptions, run.remote);
  return { ...result(base, 'dry_run'), writer: await readDryRunWriterState(engine, value.sourceId), ...await dryRunScreen(engine, value, screen,
    checkpointRetryCommand({ sourceId: value.sourceId, processingOptions: value.processingOptions, syncOptions: value.syncOptions ?? run.syncOptions, repoPath: run.repoPath })) };
}

/** #5988: the hold clear that commits with the cursor step passing a waived entry. */
const holdClear = (cursor: Cursor, path: string | null | undefined, observedAt: string) => path
  ? (tx: BrainEngine) => clearGitHold(tx, { sourceId: cursor.sourceId, incarnation: cursor.incarnation, path, observedAt }) : undefined;
/** #5988: the hold write that commits with the cursor step passing a held entry. */
const heldWrite = (held: Cursor, hold: HeldEntry, observedAt: string) => (tx: BrainEngine) => writeGitHold(tx, { source_id: held.sourceId, incarnation: held.incarnation, ...hold,
  observed_at: observedAt, run_id: held.runId, mode: 'managed' });

/** #6278: the terminal code an owner stamps on a request whose preparation never settled within its attempts (Lane A, consumer.ts). */
export const PREPARATION_STALLED = 'preparation_stalled';
const preparationStalled = (row: Pick<WriteRequest, 'state' | 'error_code'>) => row.state === 'failed' && outOfAttemptsHold(row.error_code);
/** The run's page requests, as `persistence_requests_sync_run_open` indexes them. */
const SYNC_PAGE_KINDS_SQL = "intent->>'kind' IN ('managed_sync_import','managed_sync_delete')";
/** The `gbrain sync` arguments a hold or receipt prints to resume this cursor with its own options. */
const resumeArgsOf = (cursor: Cursor, run: { syncOptions: SyncCursorOptions; repoPath?: string }) => cursor.resumeArgs ??
  managedSyncResumeArgs({ sourceId: cursor.sourceId, processingOptions: cursor.processingOptions, syncOptions: cursor.syncOptions ?? run.syncOptions, repoPath: run.repoPath });

/**
 * #6278 (1.2b) / #6712: the hold gate. A failed entry's hold and the cursor step that settles its index commit in one
 * transaction (one cursor compare-and-swap), after the entry's page keys are locked and only while no unfinished or
 * recovery-bearing request names its page by slug, page id, path, origin or rename endpoint
 * (`UNFINISHED_PAGE_REQUEST_SQL`), so a same-page write admitted meanwhile either committed before the hold or waits
 * behind it and re-reads the page (the lock order every waiver and publication uses). Nothing after the entry depends
 * on it: dependency edges keep same-page entries apart (`freezeFollowers`, `heldKeys`), so the run's later requests are
 * neither cancelled nor waited for; they stay in the cursor's window and are settled by their own receipts. Every
 * failed receipt at the entry's index is recorded as converted. A hold never turns a failed request into a committed one.
 */
async function holdUnderGate(engine: BrainEngine, input: { cursor: Cursor; key: string; pending: Pending; assertActive: () => void;
  observedAt: string; waitMs: number; hold: HeldEntry; base?: Cursor }): Promise<Cursor | 'pending'> {
  const { cursor, key, pending, assertActive } = input;
  const base: Cursor = input.base ?? withoutPending(cursor);
  const index = indexOf(cursor, pending);
  const keys = [{ sourceId: cursor.sourceId, slug: pending.slug }, ...(pending.intent.renameFrom && pending.intent.renameFrom.slug !== pending.slug ? [{ sourceId: cursor.sourceId, slug: pending.intent.renameFrom.slug }] : [])];
  const deadline = performance.now() + input.waitMs;
  for (;;) {
    assertActive();
    const saved = await engine.transaction(async tx => {
      assertActive();
      await tx.lockPageKeys(keys);
      if ((await tx.executeRaw(UNFINISHED_PAGE_REQUEST_SQL, unfinishedPageRequestParams(cursor, pending))).length) return null;
      const stale = await tx.executeRaw<{ request_id: string }>(`SELECT request_id::text AS request_id FROM persistence_requests WHERE worktree_id=$1::uuid AND intent->>'runId'=$2
        AND ${SYNC_PAGE_KINDS_SQL} AND intent->>'index'=$3 AND state IN ('failed','cancelled','conflict')`, [cursor.binding.worktree_id, cursor.runId, String(index)]);
      const converted = [...new Set([...(cursor.convertedFromFailed ?? []), ...stale.map(row => row.request_id), pending.requestId])];
      return writeCursor(tx, key, cursor, withHeldKeys(advanceHeld(base, converted, index), input.hold), async inner => {
        await heldWrite(cursor, input.hold, input.observedAt)(inner);
        await recordSyncConversion(inner, cursor.sourceId, cursor.incarnation, { request_id: pending.requestId, path: pending.intent.path ?? null, slug: pending.slug, run_id: cursor.runId, outcome: 'held' });
      }, true);
    });
    if (saved) { await faultPoint('sync:held_settled', { sourceId: cursor.sourceId, path: pending.intent.path ?? undefined }); return saved; }
    if (performance.now() >= deadline) return 'pending';
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** #6712: an entry is retried after the manifest end this many times when its file keeps changing after admission, then held `worktree_dirty` (a pass's at once: GBRA-130). */
export const DEFER_PER_ENTRY = 3;
/** #6712: the most deferrals one run makes; past it a changed file is held at once. */
export const DEFER_PER_RUN = 200;
/**
 * #6712: an import whose file changed after admission (`source_changed`: the bytes moved between freeze and publication)
 * is deferred: the cursor passes it now and retries it under a fresh request after the manifest's last entry, instead of
 * sleeping on it or blocking the entries after it. Bounded per entry (`DEFER_PER_ENTRY`) and per run (`DEFER_PER_RUN`);
 * past either bound the entry is held `worktree_dirty` (the file keeps changing without settling). The deferral commits
 * in the cursor step that passes the entry, so a kill after it re-runs nothing twice. `revision_conflict` and
 * `concurrent_write` get no such retry: `freezeEntry`'s rebind-or-hold already rebinds only when the database content
 * equals the file, so no retry can overwrite a database-only write.
 */
async function deferChangedEntry(engine: BrainEngine, input: { cursor: Cursor; key: string; pending: Pending; assertActive: () => void;
  observedAt: string; waitMs: number; base: Cursor }): Promise<Cursor | 'pending'> {
  const { cursor, pending, base } = input;
  const index = indexOf(cursor, pending), entry = entryOf(cursor, pending)!;
  const attempts = (cursor.deferred?.find(deferred => deferred.index === index)?.attempts ?? 0) + 1;
  if (cursor.passId || attempts > DEFER_PER_ENTRY || (cursor.deferrals ?? 0) >= DEFER_PER_RUN) {
    let bytes: Buffer | null = null;
    try { bytes = readSyncFile(cursor.root, entry.path); } catch { /* the hold records no working hash */ }
    return holdUnderGate(engine, { ...input, hold: worktreeDirtyHold(entry, pending.slug, pending.pageId, { ...pending.intent, rawHash: bytes === null ? null : sha256(bytes) }) });
  }
  const passed: Cursor = index === base.index ? promoteWindow({ ...base, index: base.index + 1 }) : base;
  const next: Cursor = { ...passed, deferred: [...(base.deferred ?? []).filter(deferred => deferred.index !== index), { index, attempts }], deferrals: (base.deferrals ?? 0) + 1,
    convertedFromFailed: [...new Set([...(cursor.convertedFromFailed ?? []), pending.requestId])] };
  const saved = await saveCursor(engine, input.key, cursor, next, false, input.assertActive,
    tx => recordSyncConversion(tx, cursor.sourceId, cursor.incarnation, { request_id: pending.requestId, path: pending.intent.path ?? null, slug: pending.slug, run_id: cursor.runId, outcome: 'refrozen' }));
  await faultPoint('sync:retry_deferred', { sourceId: cursor.sourceId, path: entry.path });
  return saved;
}

/**
 * #6188 (E10) / #6712: a page request of this run that ended without committing on a positively classified page fault
 * is settled in the same run instead of blocking it (the single path, and a bulk group's failed member, which the group
 * step leaves as the single pending entry): a fence refusal, a `revision_conflict` proven to come from a concurrent
 * database-only write or whose page really moved, a pinned-worktree conflict (`worktree_dirty`) and a
 * `preparation_stalled` receipt are held behind the gate (`holdUnderGate`); a file that changed after admission is
 * deferred past the manifest end (`deferChangedEntry`). When a request that can still change the entry's outcome is
 * running the run returns `partial` and the next run's start-of-run conversion holds the entry. The failed request is
 * converted (`convertedFromFailed`, so it no longer blocks the checkpoint), gets no failure-ledger row, and is logged as
 * a conversion. Null when it is not such a fault, when the entry is the checkpoint, or when the run does not hold files
 * (`sync.holds=fail`, company-brain sources).
 */
async function holdFailedFenceRequest(engine: BrainEngine, cursor: Cursor, key: string, pending: Pending, done: WriteRequest, assertActive: () => void,
  run: { screen?: SyncScreenRun | null; observedAt?: string; syncOptions: SyncCursorOptions; repoPath?: string }, waitMs: number): Promise<Cursor | 'pending' | { tripped: Cursor } | null> {
  if (!run.screen || cursor.companyPlan || pending.intent.kind === 'managed_sync_checkpoint') return null;
  const entry = entryOf(cursor, pending);
  if (!entry || entry.path !== pending.intent.path) return null;
  const stalled = preparationStalled(done);
  const page = pending.intent.kind === 'managed_sync_import' && (typeof pending.intent.content === 'string' || !!pending.intent.body_ref);
  if (!stalled && !page && pending.intent.kind !== 'managed_sync_delete') return null;
  let base = withoutPending(cursor);
  if (stalled) {
    // #6278 (1.5): the breaker counts the receipt first; at the trip the run stops and converts neither this receipt nor a later one.
    if (cursor.breaker?.tripped) return { tripped: cursor };
    const breaker = breakerAfter(cursor, done, run.screen.policy);
    if (breaker.tripped) return { tripped: await saveCursor(engine, key, cursor, { ...cursor, breaker }, false, assertActive) };
    base = { ...base, breaker };
  }
  const fence = stalled || !page ? null : fenceReceiptLocation(done);
  // #6194 (D4): a revision conflict proven to come from a concurrent database-only write is held the same way; #6340: so is one
  // whose page really moved with no proof of who moved it, and a pinned-worktree conflict (uncommitted local bytes) holds
  // `worktree_dirty` (sync-page-fault.ts). A run-level revision conflict (the page is where it was) is not a page fault.
  const fault = stalled || fence ? null : await receiptPageFaultHold(engine, { sourceId: cursor.sourceId, incarnation: cursor.incarnation, entry, pending, done });
  const observedAt = run.observedAt ?? new Date().toISOString();
  if (!stalled && !fence && !fault && page && fileChangedAfterAdmission(done)) return deferChangedEntry(engine, { cursor, key, pending, assertActive, observedAt, waitMs, base });
  // Wave B: a file the streamed preparation refuses (a fence, a frontmatter problem) is held with the refusal's code.
  const streamed = !stalled && !fence && !fault && pending.intent.body_ref && isContentRefusal(done.error_code, null)
    ? streamedRefusalHold(entry, pending.slug, pending.pageId, done, pending.intent.blobOid) : null;
  if (!stalled && !fence && !fault && !streamed) return null;
  const hold = stalled ? preparationStalledHold(entry, pending.slug, pending.pageId, done, pending.intent.content ?? null, pending.intent.blobOid, resumeArgsOf(cursor, run))
    : fence ? prepareTimeFenceHold(entry, pending.slug, pending.pageId, fence, pending.intent.content!, pending.intent.blobOid) : fault ?? streamed!;
  return holdUnderGate(engine, { cursor, key, pending, hold, assertActive, observedAt, waitMs, base });
}

const CHECKPOINT_REVIVAL_LIMIT = 3;
type SettleInput = Parameters<typeof settleFailedRequest>[1];
/** #6712: an entry the run stopped on (a transport or systemic fault, a legacy knock-on) is re-frozen in place at most this many times in a row; then its failure is recorded and the next sync resets the bound. */
export const STOPS_PER_ENTRY = 3;

/**
 * #6712: the entry of a request that did not commit and whose fault is not the page's (a transport fault proven by its
 * receipt, a systemic stop an earlier invocation recorded, or a legacy knock-on an older gbrain cancelled) is re-frozen in
 * place under a fresh request: the cursor does not advance past it and the failed receipt is recorded as converted
 * (`convertedFromFailed`), so it never blocks the checkpoint. Bounded by `STOPS_PER_ENTRY` re-freezes in a row at the
 * entry (`Pending.stops`); null past the bound, so the failure is recorded and the next sync takes the entry again (a pass re-classifies its path; a company run retries its recorded stop).
 */
async function refreezeInPlace(engine: BrainEngine, input: SettleInput): Promise<Cursor | null> {
  const { cursor, key, pending, assertActive } = input;
  if (pending.intent.kind === 'managed_sync_checkpoint' || (pending.stops ?? 0) >= STOPS_PER_ENTRY) return null;
  const entry = entryOf(cursor, pending), index = indexOf(cursor, pending);
  if (!entry || entry.path !== pending.intent.path) return null;
  const base = withoutPending(cursor);
  const fresh = await freezeEntry(engine, { ...base, index }, key, assertActive, input.run);
  assertActive();
  const converted = [...new Set([...(cursor.convertedFromFailed ?? []), pending.requestId])];
  const observedAt = input.run.observedAt ?? new Date().toISOString();
  if ('settled' in fresh) return saveCursor(engine, key, cursor, { ...deletionSettled(base, index), convertedFromFailed: converted }, false, assertActive, holdClear(cursor, fresh.settled.path, observedAt));
  if ('hold' in fresh) {
    const held = await holdUnderGate(engine, { cursor, key, pending, hold: fresh.hold, assertActive, observedAt, waitMs: input.waitMs, base });
    return held === 'pending' ? null : held;
  }
  return saveCursor(engine, key, cursor, { ...base, convertedFromFailed: converted, pending: { ...fresh, stops: (pending.stops ?? 0) + 1 } }, false, assertActive,
    tx => recordSyncConversion(tx, cursor.sourceId, cursor.incarnation, { request_id: pending.requestId, path: pending.intent.path ?? null, slug: pending.slug, run_id: cursor.runId, outcome: 'refrozen' }));
}

/** #6643: checkpoint revivals per sync invocation (keyed by its run options object), so a refusal loop ends the invocation, never the cursor. */
const checkpointRevivalsByRun = new WeakMap<object, number>();
/** A same-run index lag ("The sync cursor is not fully committed.") stays a recorded failure (managed-sync-checkpoint-controls-company.test.ts pins it). */
const revivableCheckpointRefusal = (done: Pick<WriteRequest, 'state' | 'error_code' | 'recovery'>) => !done.recovery && done.state === 'failed'
  && (done.error_code === 'recovery_required' || done.error_code === CHECKPOINT_VALIDATION_TIMEOUT);
/**
 * #6643: a checkpoint refused because a receipt blocked it (`recovery_required`) is re-assessed whenever the run resumes: when nothing blocks it any more (a
 * knock-on, a receipt at an index the cursor settled), a fresh checkpoint request replaces it by cursor swap, and its
 * publication validates everything again. The completed manifest and the old receipt stay as they are. Null when it
 * still blocks, or after `CHECKPOINT_REVIVAL_LIMIT` revivals in this invocation (the next invocation re-assesses).
 * #6694/#6834: a slug-mode refusal the source now admits, or a moved checkpoint at this run's target, revives too (sync-slug-mode.ts).
 * #6735: so does a validation timeout, once per invocation and only once an earlier invocation recorded the stop, so a resume
 * re-validates the pinned checkpoint instead of rediscovering the manifest.
 */
async function reviveCheckpoint(engine: BrainEngine, input: SettleInput): Promise<Cursor | null> {
  const { cursor, key, pending, done } = input;
  const refused = revivableCheckpointRefusal(done) || (pending.intent.kind === 'managed_sync_checkpoint' && await checkpointRevival(engine, cursor, pending.intent, done));
  const revivals = checkpointRevivalsByRun.get(input.run) ?? 0;
  const timedOut = done.error_code === CHECKPOINT_VALIDATION_TIMEOUT;
  if (pending.intent.kind !== 'managed_sync_checkpoint' || !refused || done.recovery || cursor.index !== cursor.entries.length || revivals >= (timedOut ? 1 : CHECKPOINT_REVIVAL_LIMIT)
    || (timedOut && !await stopRecorded(engine, key, cursor.runId))) return null;
  const base: Cursor = { ...withoutPending(cursor), ...(refused === 'overtaken' ? { overtaken: true as const } : {}) };
  const fresh = await freezeEntry(engine, base, key, input.assertActive, input.run);
  if (!('requestId' in fresh)) return null;
  const blocker = await probeCheckpointBlocker(engine, cursor.binding.worktree_id, cursor.runId, fresh.intent.supersededRequests ?? [], fresh.intent.settled ?? null);
  input.assertActive();
  if (blocker) return null;
  checkpointRevivalsByRun.set(input.run, revivals + 1);
  return saveCursor(engine, key, cursor, { ...base, checkpointRevivals: (cursor.checkpointRevivals ?? 0) + 1, pending: fresh }, false, input.assertActive);
}

/** #6643: what caused a blocked checkpoint refused `recovery_required`: the receipt that blocks it. Null for a page (it is its own cause). */
async function syncRootCause(engine: BrainEngine, cursor: Cursor, pending: Pending, done: WriteRequest): Promise<ManagedSyncRootCause | null> {
  if (pending.intent.kind !== 'managed_sync_checkpoint' || done.error_code !== 'recovery_required') return null;
  const rootId = /request ([0-9a-f-]{36})/i.exec(done.error_message ?? '')?.[1];
  if (!rootId) return null;
  const row = await getWriteRequest(engine, cursor.authority.writer.principal, rootId);
  if (!row) return { request_id: rootId, slug: null, state: 'missing', code: null, message: null };
  const cause = cursorFenceCause(row.error_detail);
  return { request_id: row.request_id, slug: row.slug, state: row.state, code: row.error_code ?? null, message: row.error_message ?? null, ...(cause ? { cause } : {}) };
}

/**
 * A page request of the run ended without committing; #6712 routes it by its fault class (`receiptClass`, #6565): a
 * positively classified page fault is held with its index settled in one cursor step (`holdFailedFenceRequest`), or
 * deferred when its file changed after admission; a transport fault, or a legacy knock-on, is re-frozen in place without
 * advancing (`refreezeInPlace`); any other fault is recorded in the failure ledger and blocks the run with its
 * diagnostic and the classifier's action, and for a database refusal the fault table retries (`resumableStop`) the next
 * invocation re-freezes the entry in place (`stopRecorded`), so a plain sync converges once the cause is gone. Nothing after the entry is cancelled: requests
 * admitted after it stay in the cursor's window and are settled by their own receipts.
 */
async function settleFailedRequest(engine: BrainEngine, input: { cursor: Cursor; key: string; pending: Pending; done: WriteRequest; assertActive: () => void;
  run: { screen?: SyncScreenRun | null; observedAt?: string; repoPath?: string; syncOptions: SyncCursorOptions }; syncOptions: SyncCursorOptions; processingOptions: SyncProcessingOptions;
  remote: boolean; waitMs: number; signal?: AbortSignal }): Promise<{ cursor: Cursor } | { result: SyncResult }> {
  const { cursor, key, pending, done, syncOptions, processingOptions, remote } = input;
  // #6643: a page whose run another run replaced is superseded, not failed: go on with the winning cursor.
  if (cursorFenceCause(done.error_detail) === 'run_replaced') {
    const current = await currentCursor(engine, key, cursor);
    if (current.runId !== cursor.runId) return { cursor: current };
  }
  const revived = await reviveCheckpoint(engine, input);
  if (revived) { input.assertActive(); return { cursor: revived }; }
  const fault = receiptClass(done);
  if (fault === 'transport' || isSyncKnockOn(done) || (fault === 'systemic' && resumableStop(done) && pending.intent.kind !== 'managed_sync_checkpoint' && await stopRecorded(engine, cursor.failureKey ?? key, cursor.runId))) {
    const refrozen = await refreezeInPlace(engine, input);
    if (refrozen) { input.assertActive(); return { cursor: refrozen }; }
  }
  const converted = fault !== 'transport' ? await holdFailedFenceRequest(engine, cursor, key, pending, done, input.assertActive, input.run, input.waitMs) : null;
  if (converted === 'pending') return { result: result(cursor, 'partial', input.signal?.aborted ? 'timeout' : 'writer_pending') };
  if (converted && 'tripped' in converted) return { result: breakerResult(converted.tripped, pending, done, remote) };
  if (converted) { input.assertActive(); return { cursor: converted }; }
  // #6513: a checkpoint another run superseded records nothing; this run goes on with the winning cursor (GBRA-133 PR 3a: a pass's ends; the next pass stamps).
  if (checkpointSuperseded(pending, done)) return pending.intent.passId ? { result: result(cursor, 'partial', 'writer_pending') } : { cursor: await currentCursor(engine, key, cursor) };
  const rootCause = await syncRootCause(engine, cursor, pending, done);
  const { failure, ledgerRecorded } = await recordManagedSyncFailure(engine, { source_id: cursor.sourceId, source_incarnation: cursor.incarnation, path: pending.intent.path ?? '<checkpoint>',
    code: done.error_code ?? (done.state === 'cancelled' ? 'cancelled' : 'storage_error'), message: done.error_message ?? 'The accepted sync request did not commit.',
    ...(rootCause ? { root_cause: rootCause } : {}),
    request_id: pending.requestId, run_id: cursor.runId, target: cursor.target, cursor_key: cursor.failureKey ?? key,
    syncOptions: cursor.syncOptions ?? syncOptions, processingOptions: cursor.processingOptions ?? processingOptions,
    phase: pending.intent.kind === 'managed_sync_checkpoint' ? 'checkpoint' : 'receipt', state: done.state, observation_id: pending.requestId,
    first_seen: new Date(done.completed_at ?? done.updated_at).toISOString(), ...(done.error_detail ? { write_error_detail: publicFailureDetail(done.error_detail) } : {}) });
  // #5762: the hint is built after the failed transaction, from a fresh read of the request indexes.
  const hint = done.error_code === CHECKPOINT_VALIDATION_TIMEOUT && !remote ? await checkpointTimeoutHint(engine,
    { requestId: pending.requestId, sourceId: cursor.sourceId, processingOptions: pending.intent.processingOptions, syncOptions: pending.intent.syncOptions ?? syncOptions, repoPath: pending.intent.repoPath ?? input.run.repoPath }) : null;
  return { result: { ...result(cursor, 'blocked_by_failures'), failedFiles: 1,
    failureCodes: [{ code: failure.code, count: 1 }], ...(remote ? {} : { failures: [failure],
      managedWrite: { ...writeDiagnostic(cursor, pending, done), ...hint, ledger_recorded: ledgerRecorded } }) } };
}

/**
 * #5522: an import entry enumerated before its page existed (`pageId: null`)
 * whose origin now names exactly one live page at the entry's slug, in the
 * cursor's source incarnation, was imported meanwhile by another cursor of the
 * same source. That page is returned so the entry can be re-frozen against it;
 * anything else keeps the origin refusal. The manifest is never rewritten.
 */
async function alreadyImportedAtOrigin(engine: BrainEngine, cursor: Cursor, entry: Cursor['entries'][number], originScope: ReturnType<typeof syncOriginScope>) {
  try {
    await assertSyncPageOrigin(engine, cursor.sourceId, entry.sourcePath, entry.unownedDeletion ? null : entry.pageId ?? null, entry.action === 'delete', originScope);
    return null;
  } catch (error) {
    if (!(error instanceof OperationError) || error.code !== 'page_identity_changed' || entry.action !== 'import' || (entry.pageId ?? null) !== null
      || entry.renameFrom || cursor.companyPlan || !cursor.processingOptions) throw error;
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [cursor.sourceId]);
    const occupant = await engine.readPageSnapshot(entry.slug!, { sourceId: cursor.sourceId, includeDeleted: true });
    if (source?.incarnation !== cursor.incarnation || !occupant || occupant.page.deleted_at != null || occupant.page.source_path == null
      || !sameSyncOrigin(occupant.page.source_path, entry.sourcePath, originScope, occupant.page.slug)) throw error;
    await assertSyncPageOrigin(engine, cursor.sourceId, entry.sourcePath, occupant.page.id, true, originScope).catch(() => { throw error; });
    return occupant;
  }
}

/**
 * #5522: the page now at the origin already holds exactly the content this entry would import (the preparer's own no-op verdict).
 * #6278: the preparation races the sync budget; past it the origin refusal stands, and a cancelled run propagates. #6712 `pageOnly`: the page holds what `content` (a `both` entry's recorded disk blob) imports, a canonical writeback aside.
 */
async function sameContentAtOrigin(engine: BrainEngine, cursor: Cursor, entry: Cursor['entries'][number], key: string,
  snapshot: Awaited<ReturnType<BrainEngine['readPageSnapshot']>>, content: string | null, rawHash: string | null, lineEndingOnly: boolean, signal?: AbortSignal, pageOnly = false): Promise<boolean> {
  if (!snapshot || snapshot.page.deleted_at != null || content === null) return false;
  const intent: SyncIntent = { kind: 'managed_sync_import', expected_revision: snapshot.revision, sourcePath: entry.sourcePath, path: entry.path, rawHash: pageOnly ? sha256(content) : rawHash, content, lineEndingOnly,
    processingOptions: cursor.processingOptions, ownerEpoch: String(cursor.binding.owner_epoch), syncAuthority: cursor.authority,
    ...cursorIntent(cursor, key), slugMode: cursor.slugMode, from: cursor.from, target: cursor.target, working: entry.working ?? false };
  try {
    const budgetMs = await syncPreparationBudgetMs(engine);
    const prepared = await raceSyncBudget(prepareManagedSyncMutation(engine, screeningRequest({ source_id: cursor.sourceId, source_incarnation: cursor.incarnation, slug: snapshot.page.slug,
      page_id: snapshot.page.id, worktree_id: cursor.binding.worktree_id, authority: cursor.authority.writer, intent }), { engine: engine.kind }, startClaimPhase(Date.now(), undefined, budgetMs)), budgetMs, signal);
    return (pageOnly ? prepared.pageUnchanged === true || prepared.noop === true : (prepared.contentUnchanged === true || prepared.noop === true) && !prepared.file) && prepared.observedRevision === snapshot.revision;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

/**
 * The cursor fields of a frozen intent: a cursor's key, run and position, or (#6712 PR 4b) a pass batch's `passId` and the
 * open episode its import records (`fullEpisode`); the #6862 FIFO guard reads neither (it keys on kind, slug, page and `renameFrom`).
 */
function cursorIntent(cursor: Cursor, key: string): Pick<SyncIntent, 'cursorKey' | 'runId' | 'index' | 'total' | 'passId' | 'fullEpisode'> {
  return cursor.passId ? { passId: cursor.passId, ...(cursor.fullEpisode ? { fullEpisode: cursor.fullEpisode } : {}) }
    : { cursorKey: key, runId: cursor.runId, index: cursor.index, total: cursor.entries.length };
}

/** Counts a committed page into the cursor, as the single path does. */
function countCommitted(counts: Cursor['counts'], pending: Pending, outcome: WriteRequest['outcome']): void {
  if (outcome?.noop !== true) {
    if (pending.intent.kind === 'managed_sync_delete') counts.deleted++;
    else if (pending.intent.renameFrom) counts.renamed = (counts.renamed ?? 0) + 1;
    else if (pending.pageId === null) counts.added++; else counts.modified++;
  }
  counts.chunks += Number(outcome?.chunks ?? 0); if (outcome?.pass_stamp === 'folded') counts.folded = true;
  if ((outcome?.recovered_frontmatter || outcome?.comment_value) && pending.intent.path) counts.recovered = addRecovered(counts.recovered,
    { paths: outcome.recovered_frontmatter ? [pending.intent.path] : [], commentValues: outcome.comment_value ? 1 : 0 });
  const sizeState = outcome?.size_state as PageSizeState | undefined;
  if (sizeState && typeof outcome?.slug === 'string') counts.sizeStates = addSizeState(counts.sizeStates, { slug: outcome.slug, ...(pending.intent.path ? { path: pending.intent.path } : {}), ...sizeState });
  const fences = outcome?.fences_normalized;
  if (Array.isArray(fences) && fences.length && pending.intent.path) counts.fences = addFencesNormalized(counts.fences, pending.intent.path, fences as Array<{ class: string }>);
}
interface BulkPass { settings: BulkSettings; perMemberMs: number | null;
  /** Groups this pass formed, and the heads of window groups it admitted (saved and admitted in one transaction). */
  formed?: number; admitted?: Set<string>;
  /** #5984 admit-ahead: when this pass last saw a foreground write queued on the worktree. */
  foregroundAt?: number;
  /** #5984 Phase 4.5 (`foreground_priority`): foreground writes go first at claim time, so the sync side does not pause for them. */
  foregroundFirst?: boolean }
/** While foreground writes are recent, nothing is admitted ahead, so a new foreground write waits behind at most the publishing group. */
const FOREGROUND_RECENT_MS = 60_000;
/** A foreground write queued or committed this recently sizes new lane groups to the foreground budget. */
const FOREGROUND_BUDGET_RECENT_MS = 5_000;
type FreezeAt = (base: Cursor) => (index: number) => Promise<Pending | null>;

/** The most consecutive no-op entries one waiver transaction passes. */
const WAIVER_RUN_MAX = 64;
/**
 * #5984 Phase 3: when the frozen head would be waived, freezes and screens the entries after it four at a time
 * (stopping at the first that would not be waived, is held, is overtaken, refuses to freeze, or at the checkpoint)
 * and waives the run in one transaction, without a `pending` cursor save per entry. Returns null to take the
 * per-entry path for the head when the run's transaction validated nothing or timed out, and `admit` when the head's own
 * screen admits it (the per-entry path then skips its screen: it would prepare the same frozen entry again); otherwise the
 * cursor past the waived prefix (or as another run moved it), with the entry that ended the prefix saved as pending.
 */
async function waiveRun(engine: BrainEngine, cursor: Cursor, head: Pending, key: string, config: GBrainConfig, assertActive: () => void,
  frozenRun: Parameters<typeof freezeEntry>[4], drainStartedAt: number, limit: number, onProgress: SyncOpts['onProgress']): Promise<Cursor | 'admit' | null> {
  // The run's screens share one memo of root-level path facts (screening-paths.ts); waiveNoopRun re-validates each entry.
  // GBRA-75 wave 9: and one bounded-read session (bounded-reads.ts), so the run's screens share one transaction.
  const run = await withScreeningPaths(() => withBoundedReadSession(engine, session => screenWaiverRun(session, cursor, head, key, config, assertActive, frozenRun, limit)));
  if (!run) return 'admit';
  assertActive(); stampDrainStep('waiver_run', frozenRun.signal);
  const observedAt = frozenRun.observedAt ?? new Date().toISOString();
  const done = await waiveNoopRun(engine, cursor, run, key, async (tx, prefix) => {
    let next: Cursor = cursor;
    for (const { waived } of prefix) next = waivedCursor(next, waived);
    const paths = prefix.map(({ pending }) => pending.intent.path).filter((path): path is string => typeof path === 'string');
    return writeCursor(tx, key, cursor, { ...next, progress: stampProgress(cursor.progress, cursor.index, cursor.index + prefix.length, drainStartedAt) }, async inner => {
      for (const path of await heldGitPaths(inner, cursor.sourceId, cursor.incarnation, paths)) await holdClear(cursor, path, observedAt)!(inner);
    });
  }, tx => currentCursor(tx, key, cursor));
  if (!done) return null;
  for (let index = cursor.index + 1; index <= cursor.index + done.waived; index++) onProgress?.({ phase: 'managed_sync.page_committed', bankedFiles: index, total: cursor.entries.length, waived: true });
  assertActive();
  return done.next && done.cursor.index === cursor.index + done.waived
    ? saveCursor(engine, key, done.cursor, { ...done.cursor, pending: done.next as Pending }, false, assertActive) : done.cursor;
}

/**
 * #6712 PR 1 (L1): the consecutive prescreened entries at the head (sync-prescreen.ts), passed by the guarded kernel's
 * bounded checks in one transaction (`waivePrescreenedRun`) without freezing or preparing them. Null when the head is
 * not a prescreened entry or the kernel passed none; `missed` then remembers the head, so the ordinary path freezes,
 * screens and imports it (the prescreen fails toward importing). A bulk group stops before a prescreened entry (`freezeAt`).
 */
async function prescreenRun(engine: BrainEngine, cursor: Cursor, key: string, run: { missed: Set<number>; limit: number; embeddingRequested: boolean;
  drainStartedAt: number; assertActive: () => void; signal?: AbortSignal; onProgress: SyncOpts['onProgress'] }): Promise<Cursor | null> {
  const entries = prescreenedHead(cursor.entries, cursor.index, run.missed, run.limit);
  if (!entries.length || cursor.pending) return null;
  stampDrainStep('waiver_run', run.signal);
  const done = await waivePrescreenedRun(engine, cursor, entries, key, { embeddingRequested: run.embeddingRequested, noSchemaPack: !!cursor.processingOptions?.noSchemaPack }, (tx, count) => {
    let next: Cursor = cursor;
    for (let i = 0; i < count; i++) next = waivedCursor(next, { kind: 'import', kernel: [] });
    return writeCursor(tx, key, cursor, { ...next, counts: { ...next.counts, prescreened: (cursor.counts.prescreened ?? 0) + count },
      progress: stampProgress(cursor.progress, cursor.index, cursor.index + count, run.drainStartedAt) });
  }, tx => currentCursor(tx, key, cursor));
  if (!done) { run.missed.add(cursor.index); return null; }
  for (let index = cursor.index + 1; index <= cursor.index + done.waived; index++) run.onProgress?.({ phase: 'managed_sync.page_committed', bankedFiles: index, total: cursor.entries.length, waived: true });
  run.assertActive();
  return done.cursor;
}

/** waiveRun's screens: the head, then its followers four at a time while each one screens as a waiver. */
async function screenWaiverRun(engine: BrainEngine, cursor: Cursor, head: Pending, key: string, config: GBrainConfig, assertActive: () => void,
  frozenRun: Parameters<typeof freezeEntry>[4], limit: number): Promise<WaiverRunEntry[] | null> {
  const first = await screenWaiver(engine, cursor, head, config, frozenRun.signal);
  if (!first) return null;
  assertActive();
  const run: WaiverRunEntry[] = [{ pending: head, waived: first }];
  const max = Math.max(1, Math.min(WAIVER_RUN_MAX, limit));
  extend: for (let next = cursor.index + 1; run.length < max && next < cursor.entries.length;) {
    const batch = Array.from({ length: Math.min(4, max - run.length, cursor.entries.length - next) }, (_, i) => next + i);
    const frozen = await Promise.all(batch.map(index => freezeEntry(engine, { ...cursor, index }, key, assertActive, frozenRun).catch(() => null)));
    const screened = await Promise.all(frozen.map((entry, i) => entry && 'requestId' in entry && !entry.rebound
      ? screenWaiver(engine, { ...cursor, index: batch[i]! }, entry, config, frozenRun.signal,
        frozenSnapshots.has(entry as Pending) ? { snapshot: frozenSnapshots.get(entry as Pending)! } : undefined).catch(() => null) : null));
    for (const [i, waived] of screened.entries()) {
      if (!waived) break extend;
      run.push({ pending: frozen[i] as Pending, waived });
    }
    next += batch.length;
  }
  return run;
}

/** #5984 bulk: freezes the followers of an eligible head and records them with it as the cursor's group. */
async function formGroup(engine: BrainEngine, head: Cursor, pending: Pending, key: string, bulk: BulkPass, config: GBrainConfig, freezeAt: FreezeAt,
  assertActive: () => void): Promise<Cursor> {
  const followers = await freezeFollowers(engine, head, config, groupSize(head, bulk) - 1, freezeAt(head), [...inFlight(head), ...dependencyKeys(pending)]);
  if (!followers.length) return head;
  // Members name their group (the head's request ID), so a consumer can claim them together.
  const lane = laneRunOf(head, bulk);
  const members = [pending, ...followers].map(member => ({ ...member, intent: groupedIntent(member.intent, pending.requestId, lane) }));
  await faultPoint('sync:before_group_admission', { sourceId: head.sourceId });
  try {
    return await admitAndSave(engine, key, head, { ...head, pending: members[0], group: members }, members, assertActive) ?? currentCursor(engine, key, head);
  } catch (error) {
    // #6075: a pass that read the head before this one grouped it admitted it first on the single path, with the head's
    // ungrouped intent. The group is not formed (nothing was admitted) and the single path takes that request; any
    // other intent under the head's request ID stays an idempotency_conflict.
    if (!(error instanceof OperationError && error.code === 'idempotency_conflict')) throw error;
    const prior = await getWriteRequest(engine, admittedBy(pending, head), pending.requestId);
    if (prior?.digest !== intentDigest({ operation: 'submit_job', sourceId: head.sourceId, slug: pending.slug, callerIntent: pending.intent })) throw error;
    return currentCursor(engine, key, head);
  }
}
/** #6712: the page keys followers may not share: every request the cursor holds in flight (its pending entry, its group and the window admitted ahead) and every entry this run held. */
function inFlight(cursor: Cursor): string[] {
  return [...[...(cursor.pending ? [cursor.pending] : []), ...(cursor.group ?? []), ...(cursor.window ?? []).flat()].flatMap(dependencyKeys), ...Object.keys(cursor.heldKeys ?? {})];
}
/** The size of the next group this pass forms: the drain's first group is small; lanes size by their measured apply time. */
function groupSize(cursor: Cursor, bulk: BulkPass): number {
  const lanes = (bulk.settings.lanes ?? 1) > 1;
  const first = !bulk.formed && !(cursor.counts.added + cursor.counts.modified + cursor.counts.deleted);
  bulk.formed = (bulk.formed ?? 0) + 1;
  return nextGroupSize(bulk.settings, lanes ? laneApplyMsPerMember(cursor.binding.worktree_id) : bulk.perMemberMs,
    // With foreground priority a foreground write publishes beside lane groups instead of waiting for them, so
    // groups keep their full budget; without it they shrink while foreground writes are recent.
    { first, foreground: !bulk.foregroundFirst && bulk.foregroundAt !== undefined && performance.now() - bulk.foregroundAt < FOREGROUND_BUDGET_RECENT_MS });
}
/**
 * #5984 Phase 1: admits a group's requests and saves the cursor that records them in one transaction: the
 * admission first, then the cursor compare-and-swap, so a lost swap rolls the admission back and no request is
 * admitted that the cursor does not hold. Returns the saved cursor, or null when another run moved the cursor.
 */
async function admitAndSave(engine: BrainEngine, key: string, before: Cursor, next: Cursor, members: Pending[], assertActive: () => void): Promise<Cursor | null> {
  const rows = await admitGroup(engine, members, before, async tx => {
    assertActive();
    if (isPassBatchKey(key)) return passBatchStep(tx, key, JSON.stringify(header(before)), next, JSON.stringify(header(next)));
    const [saved] = await pipelined(tx, [
      () => tx.executeRaw(`UPDATE op_checkpoints SET completed_keys=$4::text::jsonb,updated_at=now()
        WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb RETURNING fingerprint`, [OP, key, JSON.stringify([header(before)]), JSON.stringify([header(next)])]),
      () => tx.executeRaw('UPDATE op_checkpoints SET updated_at=now() WHERE op=$1 AND fingerprint=$2', [`${OP}-manifest`, next.runId]),
    ]) as [unknown[]];
    return saved.length > 0;
  });
  if (!rows) return null;
  // The sync loop's own admission: the consumer's next tick claims it directly, leaving its scans to their cadence.
  startPersistenceConsumer(engine, loadConfig() ?? { engine: engine.kind }).wake(true);
  await faultPoint('sync:mid_checkpoint', { sourceId: next.sourceId });
  return next;
}
/** The keys formGroup adds to a frozen intent; `ungroupedIntent` removes exactly these. */
function groupedIntent(intent: SyncIntent, group: string, lane: string | null): SyncIntent {
  return { ...intent, group, ...(lane ? { lane } : {}) };
}
/** #6075: the intent a head carried before formGroup named its group, as a single-path pass admits it. */
function ungroupedIntent(intent: SyncIntent): SyncIntent {
  const { group: _group, lane: _lane, ...single } = intent;
  return single;
}

/** #5984 lanes: the drain's lane run, opened for this cursor's worktree on first use; null when lanes are off. */
function laneRunOf(cursor: Cursor, bulk: BulkPass): string | null {
  const run = bulk.settings.laneRun, lanes = bulk.settings.lanes ?? 1;
  if (!run || lanes <= 1) return null;
  if (lanePolicy(cursor.binding.worktree_id)?.run !== run) openLanes(cursor.binding.worktree_id, run, lanes, null);
  return run;
}

/**
 * #5984 admit-ahead: while the cursor's group publishes, freeze and admit the next groups so they are queued
 * behind it and the consumer starts each one as soon as it may: under the per-worktree FIFO claim one at a
 * time (window depth 1), or, with lanes, up to the effective lane count at once (sync-lanes.ts). Each window
 * group names the request before it (`after`), so groups commit in manifest order. Nothing is admitted ahead
 * while foreground writes are recent (one was queued on the worktree in the last minute), or when the next
 * entry is not groupable (renames, holds, waivers, the checkpoint and overtaken entries stay on the single path).
 */
/** Requests the sync writer may still admit before its principal or the brain reaches the outstanding-request limit, less a reserve of 10. */
async function admissionRoom(engine: BrainEngine, cursor: Cursor): Promise<number> {
  const [limits, counters] = await Promise.all([readJournalLimits(engine),
    engine.executeRaw<{ key: string; outstanding: string }>('SELECT key,outstanding_count::text AS outstanding FROM persistence_counters WHERE key=ANY($1::text[])',
      [['brain', principalKey(cursor.authority.writer.principal)]])]);
  const used = (key: string) => Number(counters.find(row => row.key === key)?.outstanding ?? 0);
  return Math.min(limits.principalOutstanding - used(principalKey(cursor.authority.writer.principal)), limits.brainOutstanding - used('brain')) - 10;
}
async function admitAhead(engine: BrainEngine, cursor: Cursor, key: string, bulk: BulkPass, config: GBrainConfig, freezeAt: FreezeAt,
  assertActive: () => void): Promise<Cursor> {
  if (!bulk.settings.enabled || !cursor.group?.length) return cursor;
  const lane = laneRunOf(cursor, bulk);
  // With lanes, twice the lane count stays admitted, so lanes never wait for the sync side to freeze the next group;
  // until the run's first page commits only one, so freezing the window does not delay the first group (#5984 G3).
  const committed = cursor.counts.added + cursor.counts.modified + cursor.counts.deleted > 0;
  const depth = lane && committed ? 2 * Math.max(1, lanePolicy(cursor.binding.worktree_id)?.effective ?? 1) : 1;
  let current = cursor, foregroundChecked = false;
  for (let slot = 0; ; slot++) {
    const window = current.window ?? [];
    // A group admits only after the group before it: a failed admission ends this pass (it is retried on the next).
    if (slot < window.length) {
      if (bulk.admitted?.has(window[slot]![0]!.requestId)) continue;
      if (!await admitWindowGroup(engine, current, key, slot)) break;
      (bulk.admitted ??= new Set()).add(window[slot]![0]!.requestId);
      continue;
    }
    if (window.length >= depth) break;
    const start = current.index + current.group!.length + window.reduce((sum, group) => sum + group.length, 0);
    if (start >= current.entries.length) break;
    if (!foregroundChecked) {
      foregroundChecked = true;
      const [foreground] = await engine.executeRaw(`SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid
        AND state IN ('queued','running','recovering') AND NOT(COALESCE(intent->>'kind','') LIKE 'managed_sync_%') LIMIT 1`, [current.binding.worktree_id]);
      if (foreground) bulk.foregroundAt = performance.now();
    }
    if (!bulk.foregroundFirst && bulk.foregroundAt !== undefined && performance.now() - bulk.foregroundAt < FOREGROUND_RECENT_MS) break;
    // The admission must fit the writer's outstanding-request capacity (a refused admission would end admit-ahead):
    // the groups admitted at once take only the room left after the cursor's next group and the agent's own writes.
    const room = await admissionRoom(engine, current) - bulk.settings.size;
    // The window's free slots are frozen and then admitted and saved in one transaction, up to a lane count of
    // groups at a time, so lanes start on the first ones while the rest are frozen.
    const formed: Pending[][] = [];
    let next = start;
    while (window.length + formed.length < depth && formed.length < Math.max(1, depth / 2) && next < current.entries.length) {
      const base: Cursor = { ...current, index: next - 1 };
      const size = Math.min(groupSize(base, bulk), room - formed.flat().length);
      if (size < 1) break;
      // A freeze refusal here is left for the single path to raise in order, after the publishing groups.
      const frozen = await freezeFollowers(engine, base, config, size, freezeAt(base), [...inFlight(current), ...formed.flat().flatMap(dependencyKeys)]).catch(() => []);
      if (!frozen.length) break;
      const after = (formed.at(-1) ?? window.at(-1) ?? current.group!).at(-1)!.requestId;
      formed.push(frozen.map(member => ({ ...member, intent: { ...member.intent, group: frozen[0]!.requestId, after, ...(lane ? { lane } : {}) } })));
      next += frozen.length;
    }
    if (!formed.length) break;
    // A failed admission ends this pass (the groups are frozen again on the next); a lost cursor returns the winner's.
    const saved = await admitAndSave(engine, key, current, { ...current, window: [...window, ...formed] }, formed.flat(), assertActive).catch(() => undefined);
    if (saved === undefined) break;
    if (saved === null) return currentCursor(engine, key, current);
    for (const group of formed) (bulk.admitted ??= new Set()).add(group[0]!.requestId);
    current = saved;
  }
  assertActive();
  return current;
}
/** Admits window group `slot` when its requests are missing; false when they are still missing (retried on the next pass, or when it becomes the cursor's group). */
async function admitWindowGroup(engine: BrainEngine, cursor: Cursor, key: string, slot: number): Promise<boolean> {
  const members = cursor.window![slot]!;
  if ((await readAdmitted(engine, cursor, members)).length >= members.length) return true;
  const rows = await admitGroup(engine, members, cursor, async tx => {
    if (isPassBatchKey(key)) return readPassBatch<Cursor>(key)?.window?.[slot]?.[0]?.requestId === members[0]!.requestId;
    const [held] = await tx.executeRaw<{ request_id: string | null }>(`SELECT completed_keys->0->'window'->($3::int)->0->>'requestId' AS request_id FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 FOR SHARE`, [OP, key, slot]);
    return held?.request_id === members[0]!.requestId;
  }).catch(() => null);
  if (rows) startPersistenceConsumer(engine, loadConfig() ?? { engine: engine.kind }).wake(true);
  return rows !== null;
}
/**
 * #5984 bulk: admits the cursor's group, waits for it and advances over the
 * committed prefix. A terminal failure leaves that member as the single
 * pending entry, so the single path settles it by its fault class; #6712: the
 * members after it stay admitted at the head of the window.
 */
async function groupStep(engine: BrainEngine, cursor: Cursor, key: string, bulk: BulkPass, config: GBrainConfig, wait: { waitMs: number; signal?: AbortSignal; whileHeldMs?: number },
  drainStartedAt: number, onProgress: SyncOpts['onProgress'], ahead?: (cursor: Cursor) => Promise<Cursor>): Promise<{ cursor: Cursor } | { result: SyncResult }> {
  const signal = wait.signal;
  const members = cursor.group!;
  let rows = await readAdmitted(engine, cursor, members);
  if (rows.length < members.length) {
    // #6075: a pass that froze the head before it was grouped may have admitted it on the single path. The group is
    // dropped and the single path takes that request; the followers were never admitted (a group admits in one
    // transaction) and are frozen again. Any other intent under the head's request ID stays an idempotency_conflict.
    const head = members[0]!, single = ungroupedIntent(head.intent);
    const prior = rows.find(row => row.request_id === head.requestId);
    if (prior && !cursor.window && prior.digest === intentDigest({ operation: 'submit_job', sourceId: cursor.sourceId, slug: head.slug, callerIntent: single })) {
      const next: Cursor = { ...cursor, pending: { ...head, intent: single } }; delete next.group;
      return { cursor: await saveCursor(engine, key, cursor, next) };
    }
    const admitted = await admitGroup(engine, members, cursor, async tx => {
      const [held] = await tx.executeRaw<{ request_id: string | null }>(`SELECT completed_keys->0->'pending'->>'requestId' AS request_id FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 FOR SHARE`, [OP, key]);
      return held?.request_id === members[0]!.requestId;
    });
    if (!admitted) return { cursor: await currentCursor(engine, key, cursor) };
    rows = admitted;
  }
  const admitted = performance.now();
  onProgress?.({ phase: 'managed_sync.group', bankedFiles: cursor.index, total: cursor.entries.length, group: members.length });
  await validateSyncAuthority(engine, cursor.authority, members[0]!.slug);
  assertSyncDispatchActive();
  if (ahead) {
    const before = new Set((cursor.window ?? []).map(group => group[0]!.requestId));
    cursor = await ahead(cursor);
    for (const formed of cursor.window ?? []) if (!before.has(formed[0]!.requestId)) onProgress?.({ phase: 'managed_sync.group_ahead', bankedFiles: cursor.index, total: cursor.entries.length, group: formed.length });
  }
  const last = rows.find(row => row.request_id === members.at(-1)!.requestId)!;
  const waited = await awaitWrite(engine, last, config, wait);
  const policy = ahead ? lanePolicy(cursor.binding.worktree_id) : null;
  if (policy && policy.run === bulk.settings.laneRun) onProgress?.({ phase: 'managed_sync.lanes', lanes: { effective: policy.effective, stepDown: policy.stepDown, overlapped: policy.overlapped, fallbacks: policy.fallbacks } });
  assertSyncDispatchActive();
  const states = new Map((await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=ANY($1::uuid[])', [rows.map(row => row.id)])).map(row => [row.request_id, row]));
  const next: Cursor = { ...cursor, counts: { ...cursor.counts } };
  let committed = 0;
  for (const member of members) {
    const row = states.get(member.requestId);
    if (row?.state !== 'committed') break;
    countCommitted(next.counts, member, row.outcome);
    committed++;
  }
  if (committed === members.length) bulk.perMemberMs = (performance.now() - admitted) / members.length;
  if (committed) Object.assign(next, committedBreaker(cursor));
  next.index = cursor.index + committed;
  if (committed) next.progress = stampProgress(cursor.progress, cursor.index, next.index, drainStartedAt);
  const stuck = members[committed];
  const stuckRow = stuck ? states.get(stuck.requestId) : undefined;
  const failed = !!stuck && !!stuckRow && isTerminalWriteState(stuckRow.state);
  if (!stuck && next.window?.length) {
    next.window = [...next.window];
    // Window groups that lanes already committed are passed in this same save: the feeder's cost per wait stays
    // one save however many groups committed meanwhile. It stops at the first group not wholly committed.
    const done = new Map((await readAdmitted(engine, cursor, next.window.flat(), true)).map(row => [row.request_id, row]));
    while (next.window.length && next.window[0]!.every(member => done.has(member.requestId))) {
      const group = next.window.shift()!;
      for (const member of group) countCommitted(next.counts, member, done.get(member.requestId)!.outcome);
      onProgress?.({ phase: 'managed_sync.group', bankedFiles: next.index, total: cursor.entries.length, group: group.length });
      next.index += group.length;
    }
    if (next.index !== cursor.index + committed) next.progress = stampProgress(cursor.progress, cursor.index, next.index, drainStartedAt);
  }
  if (!stuck) {
    // The window's first group becomes the cursor's group; its requests are already admitted and queued.
    const [promoted, ...rest] = next.window ?? [];
    if (promoted) { next.pending = promoted[0]; next.group = promoted; } else { delete next.pending; delete next.group; }
    if (rest.length) next.window = rest; else delete next.window;
  } else if (failed) {
    // #6712: one page, one fate. The failed member becomes the single pending entry (the single path settles it by its
    // fault class); the members after it stay admitted and lead the window, so every admitted follower's identity stays
    // in the cursor until its own receipt is read, whenever it commits.
    next.pending = stuck; delete next.group;
    const rest = members.slice(committed + 1);
    if (rest.length) next.window = [rest, ...(next.window ?? [])];
  } else { next.pending = stuck; next.group = members.slice(committed); }
  const saved = committed || failed || next.group?.length !== members.length ? await saveCursor(engine, key, cursor, next) : cursor;
  for (let index = cursor.index + 1; index <= saved.index && index <= next.index; index++) onProgress?.({ phase: 'managed_sync.page_committed', bankedFiles: index, total: cursor.entries.length });
  if (stuck && stuckRow && !isTerminalWriteState(stuckRow.state) && saved.index === next.index) {
    return { result: { ...result(saved, 'partial', signal?.aborted ? 'timeout' : 'writer_pending'), ...(cursor.authority.writer.remote ? {} : {
      managedWrite: writeDiagnostic(saved, stuck, stuckRow), writeWait: writeWaitOf(last.request_id === stuckRow.request_id ? waited : { kind: 'pending', row: stuckRow }) }) } };
  }
  return { cursor: saved };
}

/**
 * A single-path admission that lost its cursor resolves to null (the caller re-reads the cursor): ENG-A7's
 * CursorMoved, or #6075's idempotency_conflict when a bulk pass admitted the head first with its grouped intent.
 */
async function cursorMovedAdmission(engine: BrainEngine, key: string, admitting: Cursor, pending: Pending, error: unknown): Promise<null> {
  if (error instanceof CursorMoved) return null;
  if (error instanceof OperationError && error.code === 'idempotency_conflict') {
    const current = await readCursor(engine, key, admitting);
    if (current?.pending?.requestId === pending.requestId && digest(current.pending.intent) !== digest(pending.intent)) return null;
  }
  throw error;
}

/** The result of a committed company checkpoint (a non-company source's `sources retry-held` re-screens are a pass's hold rounds). */
async function finishCheckpoint(engine: BrainEngine, key: string, cursor: Cursor, assertActive: () => void): Promise<SyncResult> {
  await clearManagedSyncFailureAfterSuccess(engine, key);
  assertActive();
  return result(cursor, cursor.from === null ? 'first_sync' : 'synced');
}
/** What the hold report needs from a managed run: its source, cursor and authority. */
interface HoldRunState { sourceId?: string; incarnation?: string; remote?: boolean; cursor?: () => Cursor | CursorHeader | null }

/**
 * One immutable page is admitted at a time; foreground writes can never sit behind a whole scan.
 * #5988: every result (resumed, no-change and blocked runs included) carries this run's holds and the source's outstanding total.
 */

/** #6643: a request the whole-manifest retirement must wait for, named with its producer, instead of a silent no-op. */
export interface RetryWait { request_id: string; kind: string | null; slug: string; state: string; recovery: boolean; retry_after_ms: number }

/**
 * One managed pass under the source's drain lease (#6712 PR 1): reentrant inside a drain, a staged catch-up or a CLI
 * run that holds it; a direct caller (an owner RPC slice, a refresh) takes it for this pass, and a busy or lost lease
 * returns `sync_drain_lease_held` (resumable). A dry run takes no lease.
 */
export async function performManagedSync(engine: BrainEngine, opts: SyncOpts, slice?: { maxPages: number; maxMs: number }): Promise<SyncResult> {
  if (opts.dryRun || currentDrainLease(opts.sourceId ?? 'default')) return performManagedPass(engine, opts, slice);
  const sourceId = opts.sourceId ?? 'default';
  const remote = currentSubmissionAuthority()?.kind === 'remote_generic';
  let tailClear = false;
  return withDrainLease(engine, sourceId, { holder: opts.drainHolder ?? { kind: slice ? 'owner_slice' : 'cli', id: null }, remote },
    signal => performManagedPass(engine, signal ? { ...opts, signal: opts.signal ? AbortSignal.any([opts.signal, signal]) : signal } : opts, slice)
      .finally(() => { tailClear = currentDrainLease(sourceId)?.tailClear === true; }))
    // #6712 PR 2: an owner slice's tail gets the slice's budget. PR 4b: an idle pass that read no owed tail under the lease reads none.
    .then(result => tailClear ? result : withSyncTail(engine, sourceId, result, { signal: opts.signal, deadlineAtMs: opts.deadlineAtMs, ...(slice ? { budgetMs: slice.maxMs } : {}) }))
    .catch(async error => {
      if (!(error instanceof LockUnavailableError) || error.lockId !== syncLockId(sourceId)) throw error;
      return leaseHeldResult(sourceId, await readDrainHolder(engine, sourceId).catch(() => null), { remote });
    });
}
async function performManagedPass(engine: BrainEngine, opts: SyncOpts, slice?: { maxPages: number; maxMs: number }): Promise<SyncResult> {
  const state: HoldRunState = {};
  // #6729: every managed entry point (CLI, drain, owner slice, worktree refresh) records the renames whose identity it did not keep.
  const synced = await noteIdentityDowngrades(engine, opts.sourceId ?? 'default', await runManagedSync(engine, opts, slice, state), serr);
  if (!state.sourceId || !state.incarnation || synced.status === 'dry_run' || currentDrainLease(state.sourceId)?.idleClear) return synced;
  const cursor = state.cursor?.() ?? null;
  try {
    const report = await buildHoldReport(engine, { sourceId: state.sourceId, incarnation: state.incarnation, runId: cursor?.runId ?? '', remote: state.remote === true,
      policy: readSyncHoldPolicy(engine), pendingScreen: synced.reason === 'writer_yield',
      screened: 'entries' in (cursor ?? {}) ? (cursor as Cursor).entries.slice(0, cursor!.index).filter(entry => entry.action === 'import').length : 0 });
    const recovered = state.remote ? undefined : recoveredReport(state.sourceId, cursor?.counts.recovered);
    const fences = fencesNormalizedReport(state.sourceId, cursor?.counts.fences, state.remote === true);
    return { ...synced, ...report, ...(!state.remote && cursor?.convertedFromFailed?.length ? { converted_from_failed: cursor.convertedFromFailed } : {}),
      ...(recovered ? { recovered_frontmatter: recovered } : {}), ...(fences ? { fences_normalized: fences } : {}) };
  } catch {
    return synced;
  }
}

/** ENG-A7: admits the cursor's frozen head while the cursor (or the pass batch) still holds it, under the drain lease; null when the cursor moved. */
function admitPendingWrite(engine: BrainEngine, key: string, admitting: Cursor, pending: Pending, assertActive: () => void) {
  return retryWriteAdmission(pending.requestId, remaining => engine.transaction(async tx => {
    assertActive();
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
      [`${Math.min(1000, remaining)}ms`, `${remaining}ms`]);
    const accepted = await admitWriteInTransaction(tx, { requestId: pending.requestId, operation: 'submit_job',
      sourceId: admitting.sourceId, sourceIncarnation: admitting.incarnation, slug: pending.slug, pageId: pending.pageId,
      worktreeId: admitting.binding.worktree_id, topologyGeneration: admitting.binding.topology_generation, ownerEpoch: admitting.binding.owner_epoch,
      principal: admitting.authority.writer.principal, authority: admitting.authority.writer, callerIntent: pending.intent, intent: pending.intent });
    // ENG-A7: after the counter locks (the publication lock order), admit only while the cursor still holds this entry
    // with this intent (#6075: a bulk pass may have grouped the head since this pass read it).
    if (isPassBatchKey(key)) {
      // #6712 PR 4b: a pass batch has no cursor row; the lease (below) fences it, and the batch must still hold this entry.
      const head = readPassBatch<Cursor>(key)?.pending;
      if (head?.requestId !== pending.requestId || digest(head.intent) !== digest(pending.intent)) throw new CursorMoved();
    } else {
      const [held] = await tx.executeRaw<{ request_id: string | null; same: boolean | null }>(`SELECT completed_keys->0->'pending'->>'requestId' AS request_id,
        completed_keys->0->'pending'->'intent' = $3::text::jsonb AS same FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 FOR SHARE`, [OP, key, JSON.stringify(pending.intent)]);
      if (held?.request_id !== pending.requestId || held.same !== true) throw new CursorMoved();
    }
    await assertDrainLease(tx, admitting.sourceId);
    await assertPassAdmission(tx, [pending.intent]);
    assertActive();
    return accepted;
  }), undefined, error => engine.reconnect({ error })).catch(error => cursorMovedAdmission(engine, key, admitting, pending, error));
}

/** A pass's recovered, normalized and converted totals, summed over its batches. */
type PassTotals = { recovered?: Cursor['counts']['recovered']; fences?: FencesTally; converted: string[] };
function foldPassTotals(totals: PassTotals, done: Cursor): void {
  const sum = (a: Record<string, number> = {}, b: Record<string, number> = {}) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(k => [k, (a[k] ?? 0) + (b[k] ?? 0)]));
  const { recovered, fences } = done.counts;
  if (recovered) totals.recovered = { count: (totals.recovered?.count ?? 0) + recovered.count, sample_paths: [...totals.recovered?.sample_paths ?? [], ...recovered.sample_paths].slice(0, 5),
    ...((totals.recovered?.comment_values ?? 0) + (recovered.comment_values ?? 0) ? { comment_values: (totals.recovered?.comment_values ?? 0) + (recovered.comment_values ?? 0) } : {}) };
  if (fences) totals.fences = { count: (totals.fences?.count ?? 0) + fences.count, by_class: sum(totals.fences?.by_class, fences.by_class),
    sample_paths: [...totals.fences?.sample_paths ?? [], ...fences.sample_paths].slice(0, 5), dirs: sum(totals.fences?.dirs, fences.dirs) };
  totals.converted = [...new Set([...totals.converted, ...done.convertedFromFailed ?? []])];
}

/** #6712: whether a stopped company-brain run re-freezes its head with this run's processing options (an approved run keeps its own). */
async function companyRetryOwed(engine: BrainEngine, cursor: Cursor, companyStop: NonNullable<Awaited<ReturnType<typeof recordedStop>>>,
  run: { processingOptions: NonNullable<Cursor['processingOptions']>; syncOptions: Cursor['syncOptions']; repoPath: string | undefined; assertActive: () => void }): Promise<boolean> {
  const { processingOptions, syncOptions, assertActive } = run;
  const failed = cursor.pending ? await getWriteRequest(engine, admittedBy(cursor.pending, cursor), cursor.pending.requestId) : null;
  const unfinished = await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) LIMIT 1", [cursor.sourceId]);
  assertActive();
  // #6712: a legacy knock-on is re-frozen in place by the drain (refreezeInPlace), within its stop bound.
  // The approved manifest pins the content, so a content refusal this version recorded replays until the approval changes.
  if (!(!unfinished.length && (failed && ['failed', 'conflict', 'cancelled'].includes(failed.state) && !isSyncKnockOn(failed) && !replaysContentRefusal(failed, companyStop, () => true)
    || !cursor.pending && !cursor.processingOptions))) return false;
  if (cursor.processingOptions && digest(cursor.processingOptions) !== digest(processingOptions)) {
    throw syncRunRefusal('invalid_params', 'The approved company sync must retain its original processing options.',
      { sourceId: cursor.sourceId, processingOptions: cursor.processingOptions, syncOptions: cursor.syncOptions ?? syncOptions, repoPath: run.repoPath },
      `The unfinished company-brain sync of source ${cursor.sourceId} was approved with ${SYNC_PROCESSING_KEYS.map(key => `${key}=${cursor!.processingOptions![key]}`).join(', ')}, and its retry must keep exactly those processing options; nothing was retried.`);
  }
  return true;
}

/** A cursor written under an older source binding (incarnation, worktree, topology, owner epoch or root) never drains. */
function assertCursorBinding(cursor: Cursor, context: ManagedSyncContext, syncOptions: Cursor['syncOptions'], repoPath: string | undefined): void {
  if (cursor.incarnation !== context.incarnation || cursor.binding.worktree_id !== context.binding.worktree_id ||
      String(cursor.binding.topology_generation) !== String(context.binding.topology_generation) ||
      String(cursor.binding.owner_epoch) !== String(context.binding.owner_epoch) || cursor.root !== context.root) {
    throw syncRunRefusal('source_changed', 'The unfinished sync cursor belongs to an older source binding.',
      { sourceId: cursor.sourceId, processingOptions: cursor.processingOptions, syncOptions: cursor.syncOptions ?? syncOptions, repoPath },
      `The unfinished sync cursor of source ${cursor.sourceId} was written under an older binding (its owner epoch, topology generation, worktree or root changed since), so this run stopped without importing; the retry rediscovers against the current binding.`);
  }
}

/** Records a run's failure (not transient back-pressure, a lost connection or a statement timeout) and points its message at the retry. */
async function recordRunFailure(engine: BrainEngine, error: unknown, run: { cursor: Cursor | null; key: string; phase: ManagedSyncFailure['phase']; discoveryTarget: string | null;
  discoveryRun: string; context: ManagedSyncContext; remote: boolean; syncOptions: Cursor['syncOptions']; processingOptions: NonNullable<Cursor['processingOptions']>; repoPath: string | undefined }): Promise<void> {
  const { cursor, key, phase, discoveryTarget, discoveryRun, context, syncOptions, processingOptions } = run;
  const code = error instanceof OperationError ? error.code : 'storage_error';
  // A refresh fence, write back-pressure, a lost connection or a statement timeout is not a sync failure to record: the
  // cursor and its frozen manifest stay, and the next pass resumes them (`unrecordedStop`).
  if (!unrecordedStop(error)) {
    const [stored] = cursor ? [] : await engine.executeRaw<{ completed_keys: [CursorHeader] }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [OP, key]);
    const failedCursor = cursor ?? stored?.completed_keys?.[0];
    const { failure } = await recordManagedSyncFailure(engine, { source_id: context.sourceId, source_incarnation: context.incarnation, path: cursor?.entries[cursor.index]?.path ?? failedCursor?.pending?.intent.path ?? `<${phase}>`, code,
      message: error instanceof Error ? error.message : String(error), request_id: failedCursor?.pending?.requestId ?? null,
      run_id: failedCursor?.runId ?? discoveryRun, invocation: discoveryRun, target: failedCursor?.target ?? discoveryTarget, cursor_key: cursor?.failureKey ?? key,
      syncOptions: failedCursor?.syncOptions ?? syncOptions, processingOptions: failedCursor?.processingOptions ?? processingOptions, phase, state: 'failed',
      observation_id: failedCursor ? `${failedCursor.runId}:${failedCursor.index}:${phase}:${code}` : `${key}:discovery:${discoveryTarget}:${code}` });
    if (error instanceof Error) error.message = run.remote ? 'Managed sync is blocked; ask the host operator to inspect doctor.' : `${formatManagedSyncFailure(failure)} Fix the cause, then run: ${managedSyncRetryCommand(failure, run.repoPath)}`;
  }
}

/**
 * #6712 PR 1: the key this pass reads and the older keys folded in (`resolveManagedCursor`). A remote caller folds nothing
 * in: the cursors it would cancel or retire may belong to another principal (it adopts only its own). A superseded run's
 * write still in flight settles before the adopted run publishes beside it (`waiting`, `writer_pending`).
 */
async function resolvePassCursor(engine: BrainEngine, input: { sourceId: string; incarnation: string; company: Parameters<typeof resolveManagedCursor>[1]['company'];
  remote: boolean; dryRun: boolean; assertActive: () => void }): Promise<{ key: string; waiting?: SyncResult }> {
  const resolution = await resolveManagedCursor(engine, { sourceId: input.sourceId, incarnation: input.incarnation, company: input.company, assertActive: input.assertActive,
    readOnly: input.dryRun, foldIn: !input.remote });
  const header = resolution.waitFor && !input.dryRun
    ? (await engine.executeRaw<{ completed_keys: [CursorHeader] }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [OP, resolution.key]))[0]?.completed_keys?.[0] : undefined;
  if (!header) return { key: resolution.key };
  return { key: resolution.key, waiting: { ...result(header, 'partial', 'writer_pending'), ...(input.remote ? {} : { retryWait: { ...resolution.waitFor!, retry_after_ms: 5000 } }) } };
}
async function runManagedSync(engine: BrainEngine, opts: SyncOpts, slice: { maxPages: number; maxMs: number } | undefined, state: HoldRunState): Promise<SyncResult> {
  // #6712 PR 4b: the mode, the company profile and the source's rows in one round trip; each check refuses in its old order.
  const rows = readManagedSyncRows(engine, opts.sourceId ?? 'default'); rows.catch(() => undefined);
  const [active, profile] = await Promise.allSettled([activeManagedBrainId(engine),
    opts.sourceId && !currentCompanyBrainSync(opts.sourceId) ? getCompanyBrainProfile(engine, opts.sourceId) : null]);
  for (const read of [active, profile]) if (read.status === 'rejected') throw read.reason;
  if (profile.status === 'fulfilled' && profile.value) return (await import('../company-brain/runtime.ts')).performCompanyBrainSync(engine, opts);
  assertPersistenceAccepting(engine);
  validateManagedSyncOptions(opts);
  const context = await resolveManagedSyncContext(engine, opts, rows);
  // Independent reads, one round trip; a refusal still wins over the authority's own error, as when they ran in turn.
  const reads = await Promise.allSettled([opts.dryRun ? null : assertManagedSyncAllowed(engine, context.binding.worktree_id, context.sourceId),
    managedSyncAuthority(engine, context.sourceId, context.incarnation, opts.repoPath ?? context.root, (active as PromiseFulfilledResult<string>).value)] as const);
  for (const read of reads) if (read.status === 'rejected') throw read.reason;
  const authority = (reads[1] as PromiseFulfilledResult<SyncAuthority>).value;
  const company = currentCompanyBrainSync(context.sourceId);
  const processingOptions = syncProcessingOptions(opts);
  const syncOptions = syncCursorOptions(opts);
  const frozenRun: Parameters<typeof freezeEntry>[4] = { syncOptions, ...(opts.repoPath ? { repoPath: resolve(opts.repoPath) } : {}), ...(opts.embedDeferred ? { embedDeferred: true } : {}) };
  const runStartedAt = new Date().toISOString();
  let key = managedCursorKey(context.incarnation, company); // #6712 PR 1: one per incarnation; resolvePassCursor may pick an older key's cursor
  let cursor: Cursor | null = null;
  if (!company) Object.assign(state, { sourceId: context.sourceId, incarnation: context.incarnation, remote: authority.writer.remote, cursor: () => live.cursor ?? cursor });
  const dryRun = (value: Cursor, base: Cursor = value) => managedDryRun(engine, value, base, { company: !!company, processingOptions, syncOptions, repoPath: frozenRun.repoPath, remote: authority.writer.remote });
  let phase: ManagedSyncFailure['phase'] = 'resume';
  let discoveryTarget: string | null = null, levelReading = false;
  const discoveryRun = randomUUID();
  const inheritedSignal = currentSourceFilesystemSignal();
  const signal = opts.signal && inheritedSignal ? AbortSignal.any([opts.signal, inheritedSignal]) : opts.signal ?? inheritedSignal; if (signal) frozenRun.signal = signal;
  const assertActive = () => {
    assertSyncDispatchActive();
    throwIfAborted(signal);
    assertPersistenceAccepting(engine);
  };
  // #6696 C4: the checkpoint commit is the run's last commit. #6712 PR 2 (L5): its tail (statistics, links) is owed from that
  // commit (sync-tail.ts) and runs after the lease is released, outside this governed pass.
  const finishing = (done: Cursor) => { opts.onProgress?.({ phase: 'managed_sync.finish', bankedFiles: done.index, total: done.entries.length }); };
  /** One cursor's drain (or, #6712 PR 4b, one round batch of a live pass): the freeze, screen, waive, group, admit, await and settle loop. */
  const live: { cursor: Cursor | null } = { cursor: null };
  const drainCursor = async (from: Cursor, startupConfig: Awaited<ReturnType<typeof preparationConfigView>>,
    sliceBase?: { started: number; pages: number }): Promise<SyncResult | Cursor> => {
    let cursor = from;
    try {
      frozenRun.screen = company ? null : await loadSyncScreenRun(startupConfig, cursor.sourceId, cursor.processingOptions ?? processingOptions, authority.writer.remote);
      const observedAt = frozenRun.observedAt = cursor.discoveredAt ?? runStartedAt;
      const config = loadConfig() ?? { engine: engine.kind }, analyzeEvery = await importAnalyzeEveryPages(engine);
      let batchStart = performance.now(), batchPages = 0, foregroundWaitStart = 0, foregroundBaseline = 0;
      let creditedPages = 0, creditStarted = 0, foregroundQueued = false, screenedAdmit: string | null = null;
      const sliceStarted = sliceBase?.started ?? performance.now(), sliceFirstIndex = cursor.index - (sliceBase?.pages ?? 0), drainStartedAt = opts.drainStartedAt ?? Date.now();
      // #6712 PR 4b: a local pass waits on its own write up to 30 s while this process's consumer still holds it (item 7).
      const whileHeld = !opts.drainStartedAt && !!cursor.passId && !authority.writer.remote ? { whileHeldMs: syncReceiptWait().held } : {};
      const bulk: BulkPass = { settings: opts.bulk && !company ? opts.bulk : { enabled: false, reason: null, size: 1, maxTxnMs: 0 }, perMemberMs: null, foregroundFirst: await foregroundPriority(engine) };
      const waiveBatch = noopWaiversEnabled() && await waiverBatchEnabled(startupConfig), prescreen = { missed: new Set<number>(), limit: Infinity, drainStartedAt, assertActive, signal, onProgress: opts.onProgress,
        embeddingRequested: !(cursor.processingOptions ?? processingOptions).noEmbed && !opts.embedDeferred && !config.embedding_disabled && !!config.embedding_model?.trim() };
      if (opts.capacityPreflight && !cursor.done) await preflightSyncCapacity(engine, { root: cursor.root, writer: cursor.authority.writer, entries: cursor.entries.slice(cursor.index) });
      opts.onProgress?.({ phase: 'managed_sync.start', bankedFiles: cursor.index, total: cursor.entries.length });
      while (!cursor.done) {
        assertActive();
        // #6712 PR 4b: a pass's batch ends at its last entry; its stamp is its own batch or rides the last import (#6926, `folded`).
        if (cursor.passId && (!cursor.stamp || cursor.entries.length > 0) && !cursor.pending && cursor.index >= cursor.entries.length && !cursor.deferred?.length) return cursor;
        if (!cursor.pending) {
          // A source remains fair in both directions: foreground gets service, then sync earns one bounded batch even if new interactive work keeps arriving.
          if (creditedPages && performance.now() - creditStarted >= 250) creditedPages = 0;
          const [foreground] = await engine.executeRaw(`SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid
            AND state IN ('queued','running','recovering') AND NOT(COALESCE(intent->>'kind','') LIKE 'managed_sync_%') LIMIT 1`, [cursor.binding.worktree_id]);
          assertActive();
          if ((foregroundQueued = Boolean(foreground))) bulk.foregroundAt = performance.now();
          if (foreground && creditedPages === 0 && !bulk.foregroundFirst) {
            startPersistenceConsumer(engine, config);
            if (!foregroundWaitStart) {
              foregroundWaitStart = performance.now();
              foregroundBaseline = foregroundWriteCompletions(engine, cursor.binding.worktree_id);
            }
            const completed = foregroundWriteCompletions(engine, cursor.binding.worktree_id) - foregroundBaseline;
            if (completed < 25 && performance.now() - foregroundWaitStart < 1000) {
              await new Promise(resolve => setTimeout(resolve, 25));
              continue;
            }
            creditedPages = 25; creditStarted = performance.now();
          }
          foregroundWaitStart = 0;
          const prescreened = await prescreenRun(engine, cursor, key, { ...prescreen, limit: slice ? slice.maxPages - (cursor.index - sliceFirstIndex) : Infinity });
          if (prescreened && slice && (prescreened.index - sliceFirstIndex >= slice.maxPages || performance.now() - sliceStarted >= slice.maxMs)) return result(prescreened, 'partial', 'writer_yield');
          if (prescreened) { cursor = prescreened; continue; }
          phase = 'freeze'; stampDrainStep('freeze', signal);
          const next = await freezeNext(engine, cursor, key, assertActive, frozenRun, observedAt);
          if ('saved' in next) {
            cursor = next.saved;
            opts.onProgress?.({ phase: 'managed_sync.page_committed', bankedFiles: cursor.index, ...(next.held ? {} : { total: cursor.entries.length, waived: true }) }); assertActive();
            if (next.held && slice && (cursor.index - sliceFirstIndex >= slice.maxPages || performance.now() - sliceStarted >= slice.maxMs)) return result(cursor, 'partial', 'writer_yield');
            continue;
          }
          const { frozen, deferredAt } = next;
          const ran = waiveBatch && !frozen.rebound && deferredAt === undefined ? await waiveRun(engine, cursor, frozen, key, config, assertActive, frozenRun, drainStartedAt,
            slice ? slice.maxPages - (cursor.index - sliceFirstIndex) : WAIVER_RUN_MAX, opts.onProgress) : null;
          const waived = ran === 'admit' ? null : ran;
          if (waived && slice && (waived.index - sliceFirstIndex >= slice.maxPages || performance.now() - sliceStarted >= slice.maxMs)) return result(waived, 'partial', 'writer_yield');
          if (waived) { cursor = waived; continue; }
          // The run's screen of this head already found it admits: its per-entry screen below would prepare it again.
          screenedAdmit = ran === 'admit' ? frozen.requestId : null;
          cursor = await saveCursor(engine, key, cursor, { ...cursor, ...(frozen.rebound ? { overtaken: true as const } : {}), pending: frozen }, false, assertActive);
        }
        if (!cursor.pending) continue; // another owner-loop advanced the cursor
        const pending: Pending = cursor.pending;
        phase = 'admission'; stampDrainStep('admission', signal);
        const prior = await getWriteRequest(engine, admittedBy(pending, cursor), pending.requestId);
        assertActive();
        // #5470/#5984: a frozen entry whose publication would change nothing advances the cursor without an admission.
        const screened: Cursor = cursor;
        const waived: Cursor | null = prior || screenedAdmit === pending.requestId ? null : await waiveNoopEntry(engine, screened, pending, config, key,
          (tx, noop) => writeCursor(tx, key, screened, { ...waivedCursor(screened, noop, indexOf(screened, pending)), progress: stampProgress(screened.progress, screened.index, screened.index + 1, drainStartedAt) },
            holdClear(screened, pending.intent.path, observedAt)), tx => currentCursor(tx, key, screened), signal);
        if (waived) {
          cursor = waived;
          opts.onProgress?.({ phase: 'managed_sync.page_committed', bankedFiles: cursor.index, total: cursor.entries.length, waived: true });
          assertActive();
          // A skipped entry still counts toward the caller's slice, so a sliced run yields at the same positions.
          if (slice && (cursor.index - sliceFirstIndex >= slice.maxPages || performance.now() - sliceStarted >= slice.maxMs)) return result(cursor, 'partial', 'writer_yield');
          continue;
        }
        const freezeAt: FreezeAt = base => async index => { if (base.entries[index]?.prescreened && !prescreen.missed.has(index)) return null; const frozen = await freezeEntry(engine, { ...base, index }, key, assertActive, frozenRun).catch(() => null); return frozen && 'requestId' in frozen ? frozen : null; }; // GBRA-133 S-64: a follower's throw is raised by the single path, naming its own entry
        if (bulk.settings.enabled && (bulk.foregroundFirst || !foregroundQueued) && !prior && !cursor.group && !pending.rebound && indexOf(cursor, pending) === cursor.index && groupableIntent(pending.intent)) cursor = await formGroup(engine, cursor, pending, key, bulk, config, freezeAt, assertActive);
        if (cursor.group?.[0]?.requestId === pending.requestId && cursor.pending?.requestId === pending.requestId) {
          const step = await groupStep(engine, cursor, key, bulk, config, opts.drainStartedAt ? { waitMs: syncReceiptWait().drain, signal } : { waitMs: syncReceiptWait().pass, signal, ...whileHeld }, drainStartedAt, opts.onProgress,
            opts.drainStartedAt ? next => admitAhead(engine, next, key, bulk, config, freezeAt, assertActive) : undefined);
          if ('result' in step) return step.result;
          cursor = step.cursor;
          assertActive();
          continue;
        }
        const admitting = cursor;
        const row = prior ?? await admitPendingWrite(engine, key, admitting, pending, assertActive);
        if (!row) { cursor = await currentCursor(engine, key, cursor); continue; }
        await validateSyncAuthority(engine, cursor.authority, pending.slug);
        assertSyncDispatchActive(); stampDrainStep('await_receipt', signal);
        // #5762: a checkpoint's validation runs under the coordinator's 5 s statement timeout, so its wait outlasts that
        // budget; a timed-out checkpoint then reports its terminal refusal and hint in this run instead of the next.
        // #5984: a drain re-enters anyway, so it waits longer per page instead of paying a full re-entry; the stop signal bounds every wait (awaitWrite).
        const waited = await awaitWrite(engine, row, config, opts.drainStartedAt ? { waitMs: syncReceiptWait().drain, signal } : { waitMs: pending.intent.kind === 'managed_sync_checkpoint' ? syncReceiptWait().checkpoint : syncReceiptWait().pass, signal, ...whileHeld });
        const done = waited.row;
        assertSyncDispatchActive();
        if (!isTerminalWriteState(done.state)) {
          return { ...result(cursor, 'partial', signal?.aborted ? 'timeout' : 'writer_pending'),
            ...(authority.writer.remote ? {} : { managedWrite: writeDiagnostic(cursor, pending, done), writeWait: writeWaitOf(waited) }) };
        }
        // #6712 PR 4b: a pass's refused stamp, or a write sync.admission paused at publication, ends the pass, never the page.
        if (done.state !== 'committed' && cursor.passId && done.error_code === 'admission_paused') {
          return { ...result(cursor, 'partial', 'admission_paused'), ...(authority.writer.remote ? {} : { managedWrite: writeDiagnostic(cursor, pending, done) }) };
        }
        // #6712 PR 4b (design v3.2 §2): a pass's write refused because its file changed after admission is the level moving, not a
        // page failure: the entry is passed over and the next round classifies the new level (a level that never settles ends the
        // pass not_converged); its receipt read again (same level: an uncommitted edit) and a pinned-worktree conflict hold worktree_dirty below. So is an import whose
        // page identity another writer changed after the freeze (a repair created the page at its slug): its page moved.
        if (cursor.passId && ((fileChangedAfterAdmission(done) && !passedOverBefore(cursor.passId, pending.requestId)) || (done.error_code === 'page_identity_changed'
          && await liveRevision(engine, context.sourceId, pending) !== (pending.intent.expected_revision == null ? null : String(pending.intent.expected_revision))))) {
          cursor = await saveCursor(engine, key, cursor, committedPast({ ...cursor, counts: { ...cursor.counts } }, pending));
          assertActive();
          continue;
        }
        if (done.state !== 'committed') {
          const settled = await settleFailedRequest(engine, { cursor, key, pending, done, assertActive, run: frozenRun, syncOptions, processingOptions,
            remote: authority.writer.remote, waitMs: opts.drainStartedAt ? syncReceiptWait().drain : syncReceiptWait().pass, signal });
          if ('result' in settled) return settled.result;
          cursor = settled.cursor;
          opts.onProgress?.({ phase: 'managed_sync.page_committed', bankedFiles: cursor.index, total: cursor.entries.length });
          continue;
        }
        if (pending.intent.kind === 'managed_sync_checkpoint' && cursor.passId) return { ...cursor, pending: undefined, done: true };
        if (pending.intent.kind === 'managed_sync_checkpoint') {
          cursor = (await readCursor(engine, key))!;
          if (!cursor?.done) throw syncRunRefusal('storage_error', 'Committed sync checkpoint lost its cursor.',
            { sourceId: context.sourceId, processingOptions: pending.intent.processingOptions, syncOptions: pending.intent.syncOptions ?? syncOptions, repoPath: pending.intent.repoPath ?? frozenRun.repoPath },
            `The final checkpoint request ${pending.requestId} of this sync committed, but its cursor could not be read back to finish the run.`);
          finishing(cursor); return finishCheckpoint(engine, key, cursor, assertActive);
        }
        // The frozen manifest is shared; only the cursor header changes per page.
        const next: Cursor = committedPast({ ...cursor, ...committedBreaker(cursor), counts: { ...cursor.counts }, progress: stampProgress(cursor.progress, cursor.index, cursor.index + 1, drainStartedAt) }, pending);
        countCommitted(next.counts, pending, done.outcome);
        cursor = await saveCursor(engine, key, cursor, next);
        opts.onProgress?.({ phase: 'managed_sync.page_committed', bankedFiles: cursor.index, total: cursor.entries.length }); if (next.counts.folded) return cursor;
        // F4b: PGLite plans the rest of a large sync against fresh statistics (spec Addendum A item 2).
        if (analyzeEvery > 0 && cursor.index % analyzeEvery === 0) await maybeRefreshPlannerStats(engine, 'managed_sync', { throttle: false }).catch(() => undefined);
        assertActive();
        if (slice && (cursor.index - sliceFirstIndex >= slice.maxPages || performance.now() - sliceStarted >= slice.maxMs)) return result(cursor, 'partial', 'writer_yield');
        batchPages++;
        if (creditedPages) creditedPages--;
        if (batchPages >= 25 || performance.now() - batchStart >= 250) {
          opts.onProgress?.({ phase: 'managed_sync.yield', bankedFiles: cursor.index });
          await new Promise(resolve => setTimeout(resolve, 0));
          batchPages = 0; batchStart = performance.now();
        }
      }
      finishing(cursor); return result(cursor, cursor.from === null ? 'first_sync' : 'synced');
    } finally { live.cursor = cursor; }
  };
  try {
    assertActive();
    // #6712 PR 4b (design v3.2 §3.1): a non-company source syncs by the live level-triggered pass; company brains and dry
    // runs keep the frozen manifest and its cursor.
    if (!company && !opts.dryRun) {
      // The run's report reads the recovered, normalized and converted totals of every batch of the pass, not its last (stamp) batch.
      const totals: PassTotals = { converted: [] };
      let folded: Cursor | null = null;
      state.cursor = () => live.cursor ? { ...live.cursor, counts: { ...live.cursor.counts, recovered: totals.recovered, fences: totals.fences }, convertedFromFailed: totals.converted } : null;
      return await runSyncPass(engine, { opts, slice, context, authority, processingOptions, syncOptions, assertActive, signal, state, runStartedAt,
        // A failed level read is recorded as that read (phase discovery, its target, the incarnation's key), not as the last batch.
        onLevelRead: target => { phase = 'discovery'; discoveryTarget = target; levelReading = true; key = managedCursorKey(context.incarnation, company); },
        drainBatch: async (batchKey, batch, sliceBase) => {
          key = batchKey; levelReading = false;
          setPassBatch(batchKey, batch, JSON.stringify(header(batch)));
          try { return await drainCursor(batch, await preparationConfigView(engine), sliceBase); }
          catch (error) {
            assertSyncDispatchActive();
            // An abort mid-batch stops the pass with what the batch committed before it.
            if (signal?.aborted && error instanceof Error && error.name === 'AbortError') return result(live.cursor ?? batch, 'partial', 'timeout');
            throw error;
          } finally {
            setPassBatch(batchKey, null);
            const done = live.cursor;
            if (done?.passId && done !== folded) {
              folded = done;
              foldPassTotals(totals, done);
            }
          }
        } });
    }
    const resolved = await resolvePassCursor(engine, { sourceId: context.sourceId, incarnation: context.incarnation, company, remote: authority.writer.remote, dryRun: !!opts.dryRun, assertActive });
    key = resolved.key;
    if (resolved.waiting) return resolved.waiting;
    cursor = await readCursor(engine, key);
    assertActive();
    if (cursor && !cursor.done && !opts.dryRun) cursor = await adoptCursor(engine, key, cursor, { authority, processingOptions, embedDeferred: opts.embedDeferred, assertActive });
    assertActive();
    const companyStop = company && cursor && !cursor.done && !opts.dryRun ? await recordedStop(engine, key, cursor.runId) : null;
    if (companyStop && cursor && await companyRetryOwed(engine, cursor, companyStop, { processingOptions, syncOptions, repoPath: frozenRun.repoPath, assertActive })) {
      phase = 'freeze';
      const retry = { ...cursor, processingOptions };
      cursor = await saveCursor(engine, key, cursor, { ...retry, pending: await freezeEntry(engine, retry, key, assertActive, frozenRun) as Pending }, true, assertActive);
    }
    const startupConfig = await preparationConfigView(engine); // #5984 G3: one config read answers the startup's config reads
    assertActive();
    // #5988: a finished run is not pending work; the dry run previews the holds of what a new run would discover.
    if (cursor?.done && opts.dryRun) return dryRun({ ...await discoverManagedSync(engine, opts, context), authority, processingOptions, syncOptions, runId: discoveryRun, index: 0, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 } }, cursor);
    if (cursor?.done && company) {
      await clearManagedSyncFailureAfterSuccess(engine, key);
      assertActive();
      return result(cursor, cursor.from === null ? 'first_sync' : 'synced');
    }
    if (!cursor) {
      assertActive();
      phase = 'discovery';
      discoveryTarget = company?.plan.revision?.commit ?? syncGit(context.gitRoot, ['rev-parse', 'HEAD']).trim();
      const discovery = await discoverManagedSync(startupConfig, opts, context);
      assertActive();
      const fresh: Cursor = { ...discovery, authority, processingOptions, syncOptions, runId: discoveryRun, index: 0, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 }, ...(company ? { companyReceiptId: company.receiptId } : {}) };
      if (opts.dryRun) return dryRun(fresh);
      if (!fresh.entries.length && fresh.from === fresh.target) {
        // A complete check that found nothing is still a sync: stamp the freshness heartbeat for this incarnation only (#6712 PR 2: and release what left the source).
        await engine.transaction(tx => withCoordinatedWrite(tx, [context.sourceId], async () => {
          assertActive(); await releaseDiscoveredHolds(tx, fresh);
          return tx.executeRaw('UPDATE sources SET last_sync_at=now() WHERE id=$1 AND incarnation=$2::uuid', [context.sourceId, context.incarnation]);
        }, principalAttribution(authority.writer.principal)));
        await clearManagedSyncFailureAfterSuccess(engine, key);
        assertActive();
        return result(fresh, 'up_to_date');
      }
      if (company) await company.protect([{ op: OP, fingerprint: key, kind: 'managed_cursor' }, { op: `${OP}-manifest`, fingerprint: fresh.runId, kind: 'manifest' }]);
      assertActive();
      // #6278 (B7): the re-screens this manifest took are consumed by the save that records them (a kill between the two loses nothing).
      cursor = await saveCursor(engine, key, null, fresh, false, assertActive,
        fresh.retryTaken?.length ? tx => clearGitHoldRetryPaths(tx, fresh.sourceId, fresh.incarnation, fresh.retryTaken!) : undefined);
    }
    assertActive();
    assertCursorBinding(cursor, context, syncOptions, frozenRun.repoPath);
    if (opts.dryRun) return dryRun(cursor);
    return await drainCursor(cursor, startupConfig) as SyncResult;
  } catch (error) {
    assertSyncDispatchActive();
    if (live.cursor && !levelReading) cursor = live.cursor;
    if (signal?.aborted && error instanceof Error && error.name === 'AbortError') {
      if (cursor) return result(cursor, 'partial', 'timeout');
      const from = authority.writer.remote || opts.full ? null : context.source.last_commit;
      return { status: 'partial', reason: 'timeout', fromCommit: from, toCommit: authority.writer.remote ? '' : discoveryTarget ?? from ?? '',
        added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], filesImported: 0, bankedFiles: 0 };
    }
    if (!opts.dryRun) {
      await recordRunFailure(engine, error, { cursor, key, phase, discoveryTarget, discoveryRun, context, remote: authority.writer.remote, syncOptions, processingOptions, repoPath: frozenRun.repoPath });
    }
    throw error;
  }
}
