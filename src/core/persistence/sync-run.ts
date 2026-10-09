import { randomUUID } from 'node:crypto';
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
import { preparationConfigView } from './config-snapshot.ts';
import { isWriteCapacityWait, retryWriteAdmission } from './admission-retry.ts';
import { assertPersistenceAccepting, awaitWrite, foregroundWriteCompletions, startPersistenceConsumer, type WriteWait } from './service.ts';
import { assertSyncEntryOrigin, discoverManagedSync, resolveManagedSyncContext, readSyncContent, readSyncFile, syncGit, type ManagedSyncContext, type SyncDiscovery } from './sync-discovery.ts';
import { isImageFilePath } from '../sync.ts';
import { assertSyncPageOrigin, sameSyncOrigin, syncOriginScope } from './sync-origin.ts';
import { assertManagedSyncActive, assertSyncDispatchActive, managedSyncAuthority, validateSyncAuthority, validateManagedSyncOptions, syncProcessingOptions, SYNC_PROCESSING_KEYS, type SyncAuthority, type SyncProcessingOptions } from './sync-authority.ts';
import { prepareManagedSyncMutation, type SyncCursorOptions, type SyncIntent } from './sync-prepare.ts';
import { startClaimPhase } from './claim-phase.ts';
import { screeningRequest } from './noop-kernel.ts';
import { noopWaiversEnabled, raceSyncBudget, screenWaiver, syncPreparationBudgetMs, unfinishedPageRequestParams, UNFINISHED_PAGE_REQUEST_SQL, waiveNoopEntry, waiveNoopRun, waiverBatchEnabled, type NoopWaiver, type WaiverRunEntry } from './sync-waivers.ts';
import { resolve } from 'node:path';
import { currentCompanyBrainSync, getCompanyBrainProfile, readCompanyBrainPlan } from '../company-brain/profile.ts';
import { readCommittedBlob } from '../company-brain/revision.ts';
import { refreshProjectionStatistics } from '../search/projection-statistics.ts';
import { importAnalyzeEveryPages, maybeRefreshPlannerStats } from '../planner-stats.ts';
import { recordManagedSyncFailure, clearManagedSyncFailureAfterSuccess, formatManagedSyncFailure, managedSyncRetryCommand, type ManagedSyncFailure } from './sync-failures.ts';
import { writeFailureDiagnostic } from './verb-errors.ts';
import { extractManagedStaleLinks } from './links-maintenance.ts';
import { CHECKPOINT_VALIDATION_TIMEOUT, checkpointRetryCommand, checkpointTimeoutHint } from './checkpoint-validation.ts';
import { isTerminalWriteState, publicWriteReceipt, type WriteReceipt } from './types.ts';
import { principalKey, type WriteRequest } from './model.ts';
import { readJournalLimits } from './limits.ts';
import { assertManagedSyncAllowed } from './worktree-refresh.ts';
import type { GBrainConfig } from '../config.ts';
import { admitGroup, freezeFollowers, groupableIntent, nextGroupSize, type BulkSettings } from './sync-group.ts';
import { cancelRows, cancelWindow } from './sync-window.ts';
import { managedSyncResumeArgs } from '../sync-reconcile.ts';
import { laneApplyMsPerMember, lanePolicy, openLanes } from './sync-lanes.ts';
import { isContentRefusal } from '../import-screen.ts';
import { isRetryableConnError, isStatementTimeoutError } from '../retry-matcher.ts';
import { SYNC_READ_BOUND, type TreeBlob } from './sync-blobs.ts';
import { dryRunScreen, isSyncReadBound, loadSyncScreenRun, managedImageHold, pinnedBlob, preparationStalledHold, prepareTimeFenceHold, screenFrozenImport, type HeldEntry, type SyncScreenRun } from './sync-screen.ts';
import { fenceReceiptLocation } from '../fence-repair/refusal.ts';
import { managedSyncWriteDiagnostic } from './sync-write-diagnostic.ts';
import { fileChangedAfterAdmission, headCommittedBytes, originFaultHold, pageChangeProof, pageChangedHold, pinnedWorktreeConflict, receiptPageFaultHold, worktreeDirtyHold } from './sync-page-fault.ts';
import { faultPoint } from './fault-points.ts';
import { pipelined } from '../page-state/transactions.ts';
import { withCoordinatedWrite } from './context.ts';
import { principalAttribution } from './attribution.ts';
import { recordSyncRunTrend } from '../fence-repair/census-store.ts';
import { addFencesNormalized, addRecovered, buildHoldReport, clearGitHold, clearGitHoldRetryPaths, heldGitPaths, fencesNormalizedReport, holdsEscalated, readGitHoldRetryPaths, readGitSourceHolds, readSyncHoldPolicy, recordSyncConversion, recoveredReport, requestGitHoldRetry, writeGitHold, type FencesTally, type SyncHoldPolicy } from './sync-holds.ts';

export interface ManagedSyncWriteDiagnostic {
  source_id: string;
  slug: string;
  path: string | null;
  write_error: string;
  reason: string;
  message: string;
  suggestion: string;
  write_request: WriteReceipt;
  line_endings?: 'crlf_lf_only';
  ledger_recorded?: boolean;
  detail?: string;
  docs?: string;
}

interface Pending { requestId: string; slug: string; pageId: number | null; intent: SyncIntent; rebound?: true;
  /** #5988: re-frozen in place from a failed content refusal; a second refusal of the same bytes stays blocked. */
  converted?: true; }
/** #5988: the frozen entry is held instead of admitted. #6340 `overtaken`: another cursor of the source imported the entry's page meanwhile (#5522), so the checkpoint accepts a source already at this target. */
interface Held { hold: HeldEntry; overtaken?: true }
interface Cursor extends SyncDiscovery { runId: string; index: number; authority: SyncAuthority; pending?: Pending; done?: boolean; companyReceiptId?: string;
  processingOptions?: SyncProcessingOptions; syncOptions?: SyncCursorOptions; overtaken?: true;
  counts: { added: number; modified: number; deleted: number; chunks: number; renamed?: number;
    /** #5751: unchanged working-tree files skipped only because a no-op publication could never resolve their admit reason. */
    skippedContextualMode?: number; skippedCanonicalBytes?: number;
    /** DX-A7: entries advanced without an admission because their publication would change nothing. */
    waived?: { imports: number; deletes: number };
    /** #5988: imports held, and files imported only after quoting frontmatter. */
    held?: number; recovered?: { count: number; sample_paths: string[]; comment_values?: number };
    /** #6188: files whose fences Tier 1 rewrote (and the Git effect committed). */
    fences?: FencesTally };
  /** #5988: failed content-refusal requests this run converted in place. */
  convertedFromFailed?: string[];
  /** #6278 (1.5): the systemic breaker over this run's `preparation_stalled` receipts; recorded with the cursor CAS that consumes each. */
  breaker?: CursorBreaker;
  /** #5984: the active drain window (reset when a new drain starts), so a backlog ETA never counts downtime. */
  progress?: CursorProgress;
  /** #5984 bulk: the frozen head (also `pending`) and the members admitted with it, in manifest order. */
  group?: Pending[];
  /**
   * #5984 admit-ahead: groups frozen and admitted after `group` while it publishes, in manifest order
   * (at most one today). Each member's intent names the previous group's last request (`after`); a
   * window group publishes only after that request committed, and is cancelled when it did not.
   */
  window?: Pending[][]; }
export interface CursorProgress { startedAt: number; startIndex: number; lastAt: number; lastIndex: number }
/**
 * #6278 (1.5): the breaker state a run carries in its cursor. `stalled` lists the `preparation_stalled` receipts this run
 * processed (held, or the one that tripped), so a restart neither double-counts a receipt nor loses the trip; `streak`
 * counts consecutive stalled entries with no committed page between them. A tripped cursor holds nothing more: the
 * run stops `blocked` / `preparation_systemic`, and the next run re-freezes the entry and schedules the run's earlier
 * stalled holds for a re-screen instead of holding.
 */
export interface CursorBreaker { stalled: string[]; streak: number; tripped?: { at: string; rule: 'count' | 'consecutive'; stalled: number; streak: number; step: string | null; request_id: string } }
/** The second trip rule: this many consecutive stalled entries with no commit between them. */
export const BREAKER_STREAK = 5;
/** The breaker after this receipt: the count rule is `holdsEscalated`'s "greater than" rule over the run's screened imports, the streak rule is `BREAKER_STREAK`. */
function breakerAfter(cursor: Cursor, done: Pick<WriteRequest, 'request_id' | 'error_detail'>, policy: Pick<SyncHoldPolicy, 'escalateCount' | 'escalatePct'>): CursorBreaker {
  const prior = cursor.breaker ?? { stalled: [], streak: 0 };
  if (prior.tripped || prior.stalled.includes(done.request_id)) return prior;
  const stalled = [...prior.stalled, done.request_id], streak = prior.streak + 1;
  const screened = cursor.entries.slice(0, cursor.index + 1).filter(entry => entry.action === 'import').length;
  const rule = holdsEscalated(policy, stalled.length, { held: stalled.length, screened }) ? 'count' : streak >= BREAKER_STREAK ? 'consecutive' : null;
  const step = done.error_detail && typeof done.error_detail === 'object' && typeof (done.error_detail as Record<string, unknown>).step === 'string' ? String((done.error_detail as Record<string, unknown>).step) : null;
  return { stalled, streak, ...(rule ? { tripped: { at: new Date().toISOString(), rule, stalled: stalled.length, streak, step, request_id: done.request_id } } : {}) };
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
  const trip = cursor.breaker!.tripped!;
  const where = trip.step ? ` at step ${trip.step}` : '';
  const fix: ManagedSyncBreaker['fix'] = { argv: ['gbrain', 'sources', 'writer', 'status', '--source', cursor.sourceId, '--json'], consent: [], actor: remote ? 'host_admin' : 'agent', requires_exclusive: false,
    docs: 'docs/guides/write-refusals.md#preparation_systemic', verify: { argv: ['gbrain', 'sources', 'status', cursor.sourceId, '--json'] },
    why: `${trip.stalled} write(s) of this sync could not finish preparing${where} (${trip.rule === 'consecutive' ? `${trip.streak} in a row with no page committed between them` : 'more than a source should hold'}), `
      + 'so the run stopped instead of holding every file: the write owner, not the files, is the likely cause. Writer status (read-only) shows the owner process, its gbrain version and the step '
      + 'each stuck write reached; fix what it names or upgrade gbrain, then rerun the same sync: it re-freezes the stopped entry and re-screens the files this run held.',
    ...(remote ? { user_message: `A managed sync of source ${cursor.sourceId} stopped because ${trip.stalled} writes could not finish preparing. Please run 'gbrain sources writer status --source ${cursor.sourceId} --json' on the brain host, fix what it names, then rerun the sync.` } : {}) };
  return { ...result(cursor, 'blocked_by_failures'), failedFiles: 1, failureCodes: [{ code: PREPARATION_STALLED, count: trip.stalled }],
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
/** A managed sync run stopped before admitting the current entry; the recorded failure lets --retry-failed rediscover. */
function syncRunRefusal(code: RegistryCode, message: string, retry: Parameters<typeof checkpointRetryCommand>[0], cause: string): OperationError {
  return opError(code, message, `${cause} Pages committed earlier in this run stay committed. Check the source with the command in fix, then run: ${checkpointRetryCommand(retry)}`,
    { fix: readFix(`Shows source ${retry.sourceId}'s owner and every pending, failed or recovering request, read-only.`,
      { argv: ['gbrain', 'sources', 'writer', 'status', '--source', retry.sourceId, '--json'] }) });
}
class MissingSyncManifest extends OperationError {
  constructor(readonly cursor: CursorHeader) { super('storage_error', 'The durable sync manifest is unavailable.'); }
}
async function readCursor(engine: BrainEngine, key: string, cached?: Cursor): Promise<Cursor | null> {
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
/** The cursor after a waived entry: counted under `waived`, plus the #5751 kernel breakdown kept for `legacySkips`. */
function waivedCursor(cursor: Cursor, waived: NoopWaiver): Cursor {
  const prior = cursor.counts.waived ?? { imports: 0, deletes: 0 };
  const next: Cursor = { ...cursor, index: cursor.index + 1, counts: { ...cursor.counts,
    waived: { imports: prior.imports + (waived.kind === 'import' ? 1 : 0), deletes: prior.deletes + (waived.kind === 'delete' ? 1 : 0) } } };
  delete next.pending; delete next.group;
  if (waived.kernel.includes('contextual_mode')) next.counts.skippedContextualMode = (next.counts.skippedContextualMode ?? 0) + 1;
  if (waived.kernel.includes('canonical_file_differs')) next.counts.skippedCanonicalBytes = (next.counts.skippedCanonicalBytes ?? 0) + 1;
  return next;
}
/** The rollback signal of an admission whose cursor no longer holds the frozen entry (ENG-A7). */
class CursorMoved extends Error {}
/** DX-A3 / ENG-A12: how the wait for a still-unfinished sync write ended, with its request ID kept. */
export type ManagedSyncWriteWait = { status: 'pending'; request_id: string }
  | { status: 'blocked'; request_id: string; cause: string; command: string }
  | { status: 'read_failed'; request_id: string; reason: string; transient: boolean; sqlstate?: string; attempts: number; message: string; why: string };
function writeWaitOf(wait: WriteWait): ManagedSyncWriteWait {
  if (wait.kind === 'blocked') return { status: 'blocked', request_id: wait.request_id, cause: wait.cause, command: wait.command };
  if (wait.kind !== 'read_failed') return { status: 'pending', request_id: wait.row.request_id };
  const { kind: _kind, row: _row, ...failure } = wait;
  return { status: 'read_failed', ...failure };
}
async function replaceCursor(engine: BrainEngine, key: string, before: CursorHeader, next: Cursor, assertActive: () => void): Promise<Cursor> {
  return engine.transaction(async tx => {
    assertActive();
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
    await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR UPDATE', [next.binding.worktree_id]);
    const active = await tx.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) LIMIT 1", [next.sourceId]);
    if (active.length) {
      const current = (await readCursor(tx, key))!;
      assertActive();
      return current;
    }
    await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)`, [`${OP}-manifest`, next.runId, JSON.stringify(next.entries)]);
    const swapped = await tx.executeRaw('UPDATE op_checkpoints SET completed_keys=$4::text::jsonb,updated_at=now() WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb RETURNING fingerprint',
      [OP, key, JSON.stringify([before]), JSON.stringify([header(next)])]);
    // #6278 (B7): the re-screens the replacing manifest took are consumed with the swap that records them.
    if (swapped.length && next.retryTaken?.length) await clearGitHoldRetryPaths(tx, next.sourceId, next.incarnation, next.retryTaken);
    const current = (await readCursor(tx, key, next))!;
    assertActive();
    return current;
  });
}
function result(cursor: Cursor | CursorHeader, status: SyncResult['status'], reason?: SyncResult['reason']): SyncResult {
  return { status, ...(cursor.authority.writer.remote ? {} : { runId: cursor.runId }), fromCommit: cursor.authority.writer.remote ? null : cursor.from,
    toCommit: cursor.authority.writer.remote ? '' : cursor.target, added: cursor.counts.added, modified: cursor.counts.modified,
    deleted: cursor.counts.deleted, renamed: cursor.counts.renamed ?? 0, chunksCreated: cursor.counts.chunks, embedded: 0, pagesAffected: [],
    ...(cursor.slugCollisions?.length ? { slugCollisions: cursor.slugCollisions } : {}),
    ...(cursor.fileRefusals?.length ? { fileRefusals: cursor.fileRefusals } : {}),
    waived: { imports: cursor.counts.waived?.imports ?? 0, deletes: cursor.counts.waived?.deletes ?? 0 },
    filesImported: cursor.index, bankedFiles: cursor.index,
    managedCursor: { index: cursor.index, total: 'total' in cursor ? cursor.total : cursor.entries.length, ...(cursor.progress ? { progress: cursor.progress } : {}) },
    ...(cursor.uncommitted ? { uncommitted: cursor.uncommitted } : {}), ...(reason ? { reason } : {}),
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
async function freezeEntry(engine: BrainEngine, cursor: Cursor, key: string, assertActive: () => void,
  run: { syncOptions: SyncCursorOptions; repoPath?: string; screen?: SyncScreenRun | null; observedAt?: string; signal?: AbortSignal }): Promise<Pending | Held> {
  assertActive();
  const entry = cursor.entries[cursor.index];
  const retry = { sourceId: cursor.sourceId, processingOptions: cursor.processingOptions, syncOptions: cursor.syncOptions ?? run.syncOptions, repoPath: run.repoPath };
  let slug = '__managed_sync_checkpoint__', pageId: number | null = null, revision: string | null = null;
  let content: string | null = null, rawHash: string | null = null;
  let lineEndingOnly = false, occupantRebound = false;
  let frozenSnapshot: PageSnapshot | null | undefined;
  // #5988: company-profile sources never hold; their approved manifest keeps refusing.
  const screening = entry?.action === 'import' && !cursor.companyPlan ? run.screen ?? null : null;
  let blob: TreeBlob | null = null, oversize: { size: number | null } | undefined;
  if (entry) {
    assertSyncEntryOrigin(cursor, entry);
    if (entry.action === 'import' && !cursor.companyPlan && isImageFilePath(entry.path)) {
      const imageBlob = entry.working ? null : pinnedBlob(cursor, entry.path);
      let bytes: Buffer | null = null;
      if (!imageBlob) { try { bytes = readSyncFile(cursor.root, entry.path); } catch (error) { if (!isSyncReadBound(error)) throw error; } }
      return { hold: managedImageHold(entry, bytes === null ? null : bytes.toString('utf8'), imageBlob) };
    }
    const originScope = syncOriginScope(cursor);
    // #5522: another cursor of this source may have imported this new file since enumeration.
    // #5984 G3: the page snapshot is read beside the origin check (they are independent reads of committed state).
    // #6340: page faults (the database page moved under the manifest) hold the entry, imports and deletes alike, when holds
    // are on; `sync.holds=fail` and company-brain cursors keep the refusals.
    const holdsOn = !!run.screen && !cursor.companyPlan;
    const [occupant, snapshot] = await Promise.all([alreadyImportedAtOrigin(engine, cursor, entry, originScope).catch(error => {
      if (!holdsOn || !(error instanceof OperationError) || error.code !== 'page_identity_changed') throw error;
      return { originFault: error };
    }), engine.readPageSnapshot(entry.slug!, { sourceId: cursor.sourceId, includeDeleted: true })]);
    assertActive();
    if (occupant && 'originFault' in occupant) {
      return { hold: await originFaultHold(engine, { sourceId: cursor.sourceId, incarnation: cursor.incarnation, entry, observed: snapshot, message: occupant.originFault.message }), overtaken: true };
    }
    let bytes: Buffer | null = null;
    try { bytes = readSyncFile(cursor.root, entry.path); }
    catch (error) { if (!screening || !isSyncReadBound(error)) throw error; oversize = { size: null }; }
    if (screening && !entry.working) {
      // #5988: an over-bound pinned blob is held by its size before its content is loaded.
      blob = pinnedBlob(cursor, entry.path);
      if (blob && blob.size > SYNC_READ_BOUND) oversize = { size: blob.size };
    }
    rawHash = bytes === null ? null : sha256(bytes);
    if (entry.action === 'import' && cursor.companyPlan) {
      const company = currentCompanyBrainSync(cursor.sourceId);
      const blob = company?.entries.get(entry.path);
      if (company?.receiptId !== cursor.companyReceiptId || !blob || blob.disposition !== 'included') throw syncRunRefusal('plan_stale', 'The durable cursor does not match its approved content manifest.',
        retry,
        `Source ${cursor.sourceId}'s approved company-brain content manifest no longer includes ${entry.path} for this run (its approval changed, or the file is no longer an included path), so nothing was imported for it. If the approval changed, inspect and approve the repository again first (gbrain sources inspect --help).`);
      content = (await readCommittedBlob(cursor.companyPlan.revision!, blob, cursor.companyPlan.limits)).toString('utf8');
      assertActive();
    } else content = entry.action === 'import' && !oversize ? readSyncContent(cursor, entry) : null;
    // #6340: working-tree bytes that differ from the pinned blob but are committed at HEAD (a commit past the pin on a
    // live checkout) are imported as HEAD has them; the pin..HEAD diff later re-imports the same bytes as a no-op.
    // Uncommitted bytes keep the pinned content and reach the publication screen (idea from PR #6323).
    if (entry.action === 'import' && !cursor.companyPlan && !entry.working && content !== null && rawHash !== null && rawHash !== sha256(content)) {
      const head = headCommittedBytes(cursor, entry.path);
      if (head && head.rawHash === rawHash) { content = head.content; blob = { oid: head.oid, size: bytes!.length }; }
    }
    lineEndingOnly = bytes !== null && content !== null && bytes.equals(Buffer.from(bytes.toString('utf8'))) &&
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
    if (occupant && (content === null || !await sameContentAtOrigin(engine, cursor, entry, key, snapshot, content, rawHash, lineEndingOnly, run.signal))) {
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
        && await sameContentAtOrigin(engine, cursor, entry, key, snapshot, content, rawHash, lineEndingOnly, run.signal);
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
    if (screening) {
      const hold = await screenFrozenImport(engine, { cursor, entry, slug, pageId, snapshot, content, rawHash, lineEndingOnly, blob, oversize,
        retryCommand: checkpointRetryCommand(retry) }, screening);
      assertActive();
      if (hold) return { hold };
    }
  }
  await validateSyncAuthority(engine, cursor.authority, slug);
  assertActive();
  return remember(frozenSnapshot, { requestId: randomUUID(), slug, pageId, ...(occupantRebound ? { rebound: true as const } : {}), intent: { kind: !entry ? 'managed_sync_checkpoint' : entry.action === 'import' ? 'managed_sync_import' : 'managed_sync_delete',
    expected_revision: revision, sourcePath: entry?.sourcePath ?? null, path: entry?.path ?? null, rawHash, content, lineEndingOnly,
    ...(entry?.unownedDeletion ? { unownedDeletion: true } : {}),
    ...(entry?.renameFrom ? { renameFrom: entry.renameFrom } : {}),
    ...(run.observedAt ? { holdObservedAt: run.observedAt } : {}), ...(blob ? { blobOid: blob.oid } : {}),
    ...(!entry && cursor.releasedHolds?.length ? { releasedHolds: cursor.releasedHolds } : {}),
    ...(!entry && cursor.convertedFromFailed?.length ? { supersededRequests: cursor.convertedFromFailed } : {}),
    processingOptions: cursor.processingOptions,
    // A cursor created before its options were recorded has the same key, so this run's options are its options.
    ...(!entry ? { syncOptions: cursor.syncOptions ?? run.syncOptions, ...(run.repoPath ? { repoPath: run.repoPath } : {}) } : {}),
    ...(!entry && cursor.overtaken ? { overtaken: true } : {}),
    ownerEpoch: String(cursor.binding.owner_epoch), syncAuthority: cursor.authority, cursorKey: key, runId: cursor.runId,
    slugMode: cursor.slugMode, index: cursor.index, total: cursor.entries.length, from: cursor.from, target: cursor.target, working: entry?.working ?? false,
    ...(cursor.companyPlan ? { companyApproval: { schema: cursor.companyPlan.schema!, planDigest: cursor.companyPlan.plan_digest, extractorVersion: cursor.companyPlan.extractor_version,
      policyFingerprint: currentCompanyBrainSync(cursor.sourceId)!.policyFingerprint } } : {}) } });
}

/** A resume adopts the cursor's stored processing options unless the caller set a conflicting one explicitly. */
function assertCursorProcessingOptions(cursor: Cursor, processingOptions: SyncProcessingOptions, explicitProcessing: SyncOpts['explicitProcessing']): void {
  const stored = cursor.processingOptions;
  if (stored ? digest(stored) !== digest(processingOptions) : !cursor.pending) {
    // An unattended or flagless resume adopts the cursor's options; freezeEntry reads them from the cursor.
    const explicit = explicitProcessing ?? SYNC_PROCESSING_KEYS;
    if (!stored || explicit.some(key => stored[key] !== processingOptions[key])) {
      const flags = { noEmbed: '--no-embed', noExtract: '--no-extract', noSchemaPack: '--no-schema-pack' } as const;
      const resume = stored ? ` Resume it with: gbrain sync --source ${cursor.sourceId} --no-pull${SYNC_PROCESSING_KEYS.filter(key => stored[key]).map(key => ` ${flags[key]}`).join('')}`
        + ' (or omit the conflicting flag to adopt the stored options).' : '';
      const error = new OperationError('invalid_params', 'The unfinished sync has different or unknown processing options.',
        `The unfinished sync cursor for source ${cursor.sourceId} stores ${stored ? SYNC_PROCESSING_KEYS.map(key => `${key}=${stored[key]}`).join(', ') : 'no processing options'}.${resume}`
        + ' After resolving pending requests, use --retry-failed for explicit rediscovery; existing requests are not rewritten.');
      error.detail = 'cursor_processing_options_conflict';
      throw error;
    }
  }
}

/** #5988: a managed dry run lists the holds the pending (or newly discovered) imports would earn, read-only. */
async function managedDryRun(engine: BrainEngine, value: Cursor, base: Cursor, run: { company: boolean; processingOptions: SyncProcessingOptions;
  syncOptions: SyncCursorOptions; repoPath?: string; remote: boolean }): Promise<SyncResult> {
  const screen = run.company ? null : await loadSyncScreenRun(engine, value.sourceId, value.processingOptions ?? run.processingOptions, run.remote);
  return { ...result(base, 'dry_run'), ...await dryRunScreen(engine, value, screen,
    checkpointRetryCommand({ sourceId: value.sourceId, processingOptions: value.processingOptions, syncOptions: value.syncOptions ?? run.syncOptions, repoPath: run.repoPath })) };
}

/** #5988: the hold clear that commits with the cursor step passing a waived entry. */
const holdClear = (cursor: Cursor, path: string | null | undefined, observedAt: string) => path
  ? (tx: BrainEngine) => clearGitHold(tx, { sourceId: cursor.sourceId, incarnation: cursor.incarnation, path, observedAt }) : undefined;
/** #5988: the hold write that commits with the cursor step passing a held entry. */
const heldWrite = (held: Cursor, hold: HeldEntry, observedAt: string) => (tx: BrainEngine) => writeGitHold(tx, { source_id: held.sourceId, incarnation: held.incarnation, ...hold,
  observed_at: observedAt, run_id: held.runId, mode: 'managed' });

/** #5988: the cursor one entry on, past a held entry (no request admitted for it). */
function advanceHeld(held: Cursor, converted?: string[]): Cursor {
  const next: Cursor = { ...held, index: held.index + 1, counts: { ...held.counts, held: (held.counts.held ?? 0) + 1 },
    ...(converted ? { convertedFromFailed: converted } : {}) };
  delete next.pending;
  return next;
}

/** #6278: the terminal code an owner stamps on a request whose preparation never settled within its attempts (Lane A, consumer.ts). */
export const PREPARATION_STALLED = 'preparation_stalled';
const preparationStalled = (row: Pick<WriteRequest, 'state' | 'error_code'>) => row.state === 'failed' && row.error_code === PREPARATION_STALLED;
/** The run's page requests, as `persistence_requests_sync_run_open` indexes them. */
const SYNC_PAGE_KINDS_SQL = "intent->>'kind' IN ('managed_sync_import','managed_sync_delete')";
/** The `gbrain sync` arguments a hold or receipt prints to resume this cursor with its own options. */
const resumeArgsOf = (cursor: Cursor, run: { syncOptions: SyncCursorOptions; repoPath?: string }) =>
  managedSyncResumeArgs({ sourceId: cursor.sourceId, processingOptions: cursor.processingOptions, syncOptions: cursor.syncOptions ?? run.syncOptions, repoPath: run.repoPath });

/**
 * #6278 (1.2b): the hold gate. Before this change both converters waited until
 * no request on the whole source was unfinished, so one stuck preparation or a
 * stream of maintenance writes on other pages kept every hold pending forever.
 *
 * Invariant the source-wide wait protected, kept by this narrower one: no entry
 * after the held one publishes a change that depends on the held entry's
 * outcome (the same path or origin, either side of a rename, a delete of the
 * same slug), and the cursor never checkpoints past an entry whose request is
 * still unfinished. It holds because (1) the failed entry's obsolete admitted
 * suffix (its group's later members, the admit-ahead window, this run's lane
 * groups: every queued request of the run admitted after it) is cancelled
 * first, so no successor of this run can publish against the held entry and
 * no queued successor can wait behind a blocked root while this gate waits for
 * it; (2) the gate then waits only for requests that are still active in that
 * suffix (claimed, recovering, or carrying a recovery record) and for any
 * unfinished or recovery-bearing request that names the entry's page by slug,
 * page id, path, origin or rename endpoint (`UNFINISHED_PAGE_REQUEST_SQL`);
 * (3) the predicate is evaluated inside the transaction that writes the hold
 * and swaps the cursor, after taking the page keys and before the cursor row
 * (the lock order every waiver and publication uses), so a same-page write
 * admitted meanwhile either committed before the hold or waits behind it and
 * re-reads the page. The checkpoint's own validation then finds every
 * non-committed receipt of the run superseded (`convertedFromFailed` carries
 * the failed receipt and every earlier uncommitted receipt at the same index)
 * or committed by a later request at its index. A hold never turns a failed
 * predecessor into a committed one; cancelled successors are re-frozen under a
 * fresh dependency chain when the run continues.
 */
async function holdUnderGate(engine: BrainEngine, input: { cursor: Cursor; key: string; pending: Pending; assertActive: () => void;
  observedAt: string; waitMs: number; failedId: string; base?: Cursor } & ({ hold: HeldEntry; refrozen?: undefined } | { hold?: undefined;
  /** #6340: instead of a hold, the entry re-frozen under a fresh request (its file changed after admission); same gate, same conversion record. */
  refrozen: Pending })): Promise<Cursor | 'pending'> {
  const { cursor, key, pending, assertActive } = input;
  const principal = cursor.authority.writer.principal;
  const base: Cursor = input.base ?? { ...cursor }; delete base.group; delete base.window; delete base.pending;
  const [failedRow] = await engine.executeRaw<{ sequence: string | number | null }>('SELECT sequence::text AS sequence FROM persistence_requests WHERE id=$1::uuid', [input.failedId]);
  const after = failedRow?.sequence == null ? null : String(failedRow.sequence);
  const keys = [{ sourceId: cursor.sourceId, slug: pending.slug }, ...(pending.intent.renameFrom && pending.intent.renameFrom.slug !== pending.slug ? [{ sourceId: cursor.sourceId, slug: pending.intent.renameFrom.slug }] : [])];
  const deadline = performance.now() + input.waitMs;
  for (;;) {
    assertActive();
    if (cursor.window?.length) await cancelWindow(engine, cursor.window, principal);
    if (after !== null) {
      const queued = await engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests WHERE worktree_id=$1::uuid AND intent->>'runId'=$2 AND state='queued'
        AND ${SYNC_PAGE_KINDS_SQL} AND sequence>$3::bigint ORDER BY sequence`, [cursor.binding.worktree_id, cursor.runId, after]);
      if (queued.length) await cancelRows(engine, queued);
    }
    const saved = await engine.transaction(async tx => {
      assertActive();
      await tx.lockPageKeys(keys);
      const [samePage, suffix] = await Promise.all([
        tx.executeRaw(UNFINISHED_PAGE_REQUEST_SQL, unfinishedPageRequestParams(cursor, pending)),
        after === null ? Promise.resolve([]) : tx.executeRaw(`SELECT 1 FROM persistence_requests WHERE worktree_id=$1::uuid AND intent->>'runId'=$2 AND sequence>$3::bigint
          AND ${SYNC_PAGE_KINDS_SQL} AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) LIMIT 1`, [cursor.binding.worktree_id, cursor.runId, after]),
      ]);
      if (samePage.length || suffix.length) return null;
      const stale = await tx.executeRaw<{ request_id: string }>(`SELECT request_id::text AS request_id FROM persistence_requests WHERE worktree_id=$1::uuid AND intent->>'runId'=$2
        AND ${SYNC_PAGE_KINDS_SQL} AND intent->>'index'=$3 AND state IN ('failed','cancelled','conflict')`, [cursor.binding.worktree_id, cursor.runId, String(cursor.index)]);
      const converted = [...new Set([...(cursor.convertedFromFailed ?? []), ...stale.map(row => row.request_id), pending.requestId])];
      const next: Cursor = input.hold ? advanceHeld(base, converted) : { ...base, convertedFromFailed: converted, pending: { ...input.refrozen, converted: true } };
      return writeCursor(tx, key, cursor, next, async inner => {
        if (input.hold) await heldWrite(cursor, input.hold, input.observedAt)(inner);
        await recordSyncConversion(inner, cursor.sourceId, cursor.incarnation, { request_id: pending.requestId, path: pending.intent.path ?? null, slug: pending.slug, run_id: cursor.runId, outcome: input.hold ? 'held' : 'refrozen' });
      }, true);
    });
    if (saved) { await faultPoint('sync:mid_checkpoint', { sourceId: cursor.sourceId }); return saved; }
    if (performance.now() >= deadline) return 'pending';
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/**
 * #5988 (E6): a cursor blocked by a failed content refusal converts in place
 * with its stored options: held when the screen holds the frozen entry,
 * re-frozen under a new request when it passes, but only once for the same
 * bytes, so a refusal the screen misses stays blocked without minting a
 * receipt per run.
 * #6188: a failed fence refusal (typed, or a message an older gbrain stored)
 * holds the same bytes even when the screen admits them (`prepare_time`: the
 * refusal read stored rows). A compacted `invalid_params` /
 * `take_row_collision` receipt, whose message is gone, converts only when the
 * re-screen of the current bytes holds them; an arbitrary `invalid_params` is
 * never a fence hold.
 * #6278: a `preparation_stalled` receipt (the owner gave up preparing it)
 * holds the entry as it was frozen: an import by its bytes, a delete as a
 * delete hold; the checkpoint never holds (the run stays blocked). Every hold
 * is written behind the narrowed gate (`holdUnderGate`).
 */
async function convertBlockedCursor(engine: BrainEngine, blocked: Cursor, key: string, assertActive: () => void,
  run: Parameters<typeof freezeEntry>[4] & { observedAt?: string }): Promise<Cursor> {
  const previous = blocked.pending!;
  const failed = await getWriteRequest(engine, blocked.authority.writer.principal, previous.requestId);
  if (!failed || !['failed', 'conflict', 'cancelled'].includes(failed.state)) return blocked;
  const entry = blocked.entries[blocked.index];
  if (preparationStalled(failed)) {
    if (blocked.companyPlan || previous.intent.kind === 'managed_sync_checkpoint' || !entry || entry.path !== previous.intent.path) return blocked;
    const converted = [...(blocked.convertedFromFailed ?? []), previous.requestId];
    if (blocked.breaker?.tripped) {
      // A run that tripped the breaker holds nothing: its stopped entry is re-frozen under a fresh request (the attempt
      // counter starts at zero) and the stalled holds it wrote before the trip are scheduled for a re-screen.
      const base: Cursor = { ...blocked, convertedFromFailed: converted }; delete base.pending; delete base.breaker;
      const again = await freezeEntry(engine, base, key, assertActive, run);
      const rescreen = ((await readGitSourceHolds(engine, { sourceIds: [blocked.sourceId], runId: blocked.runId }))[0]?.holds ?? [])
        .filter(hold => hold.code === PREPARATION_STALLED).map(hold => hold.path);
      const inTx = async (tx: BrainEngine) => {
        if (rescreen.length) await requestGitHoldRetry(tx, blocked.sourceId, blocked.incarnation, rescreen);
        if ('hold' in again) await heldWrite(blocked, again.hold, run.observedAt!)(tx);
        await recordSyncConversion(tx, blocked.sourceId, blocked.incarnation, { request_id: previous.requestId, path: previous.intent.path ?? null, slug: previous.slug, run_id: blocked.runId, outcome: 'refrozen' });
      };
      return saveCursor(engine, key, blocked, 'hold' in again ? advanceHeld(base, converted) : { ...base, pending: again }, false, assertActive, inTx);
    }
    const breaker = breakerAfter(blocked, failed, run.screen!.policy);
    if (breaker.tripped) return saveCursor(engine, key, blocked, { ...blocked, breaker }, false, assertActive);
    const hold = preparationStalledHold(entry, previous.slug, previous.pageId, failed, previous.intent.content ?? null, previous.intent.blobOid, resumeArgsOf(blocked, run));
    const base: Cursor = { ...blocked, breaker }; delete base.pending; delete base.group; delete base.window;
    const held = await holdUnderGate(engine, { cursor: blocked, key, pending: previous, hold, assertActive, observedAt: run.observedAt!, waitMs: 5000, failedId: failed.id, base });
    return held === 'pending' ? blocked : held;
  }
  const fence = fenceReceiptLocation(failed);
  const compacted = !fence && failed.compacted === true && failed.error_message == null && ['invalid_params', 'take_row_collision'].includes(failed.error_code ?? '');
  // #6340: a cursor an older run left blocked on a page that moved under it converts the same way the run now does.
  if (!fence && !compacted && entry && entry.path === previous.intent.path && previous.intent.kind !== 'managed_sync_checkpoint' && !blocked.companyPlan) {
    const hold = await receiptPageFaultHold(engine, { sourceId: blocked.sourceId, incarnation: blocked.incarnation, entry, pending: previous, done: failed });
    assertActive();
    if (hold) {
      // The file may have been committed meanwhile: a re-freeze then imports HEAD's bytes instead of holding the stale conflict.
      if (hold.code === 'worktree_dirty' && headCommittedBytes(blocked, entry.path)?.rawHash !== undefined) {
        const base: Cursor = { ...blocked }; delete base.pending;
        const again = await freezeEntry(engine, base, key, assertActive, run);
        const converted = [...(blocked.convertedFromFailed ?? []), previous.requestId];
        if ('hold' in again) {
          const held = await holdUnderGate(engine, { cursor: blocked, key, pending: previous, hold: again.hold, assertActive, observedAt: run.observedAt!, waitMs: 5000, failedId: failed.id });
          return held === 'pending' ? blocked : held;
        }
        return saveCursor(engine, key, blocked, { ...blocked, convertedFromFailed: converted, pending: { ...again, converted: true } }, false, assertActive,
          tx => recordSyncConversion(tx, blocked.sourceId, blocked.incarnation, { request_id: previous.requestId, path: previous.intent.path ?? null, slug: previous.slug, run_id: blocked.runId, outcome: 'refrozen' }));
      }
      const held = await holdUnderGate(engine, { cursor: blocked, key, pending: previous, hold, assertActive, observedAt: run.observedAt!, waitMs: 5000, failedId: failed.id });
      return held === 'pending' ? blocked : held;
    }
  }
  if (!fence && !compacted && !isContentRefusal(failed.error_code, failed.error_message)) return blocked;
  const base: Cursor = { ...blocked }; delete base.pending;
  const again = await freezeEntry(engine, base, key, assertActive, run);
  const converted = [...(blocked.convertedFromFailed ?? []), previous.requestId];
  const holdWith = async (hold: HeldEntry) => {
    const held = await holdUnderGate(engine, { cursor: blocked, key, pending: previous, hold, assertActive, observedAt: run.observedAt!, waitMs: 5000, failedId: failed.id });
    return held === 'pending' ? blocked : held;
  };
  if ('hold' in again) return holdWith(again.hold);
  const sameBytes = again.intent.rawHash === previous.intent.rawHash && again.intent.content === previous.intent.content;
  if (fence && sameBytes && again.intent.kind === 'managed_sync_import' && again.intent.content !== null && entry?.path === again.intent.path) {
    return holdWith(prepareTimeFenceHold(entry, again.slug, again.pageId, fence, again.intent.content, again.intent.blobOid));
  }
  if (compacted || (previous.converted && sameBytes)) return blocked;
  const unfinished = await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) LIMIT 1", [blocked.sourceId]);
  assertActive();
  if (unfinished.length) return blocked;
  return saveCursor(engine, key, blocked, { ...blocked, convertedFromFailed: converted, pending: { ...again, converted: true } }, false, assertActive,
    tx => recordSyncConversion(tx, blocked.sourceId, blocked.incarnation, { request_id: previous.requestId, path: previous.intent.path ?? null, slug: previous.slug, run_id: blocked.runId, outcome: 'refrozen' }));
}

/**
 * #6188 (E10): a page request of this run that failed with a fence refusal (or, #6194, a
 * `revision_conflict` proven to come from a concurrent database-only write, or, #6278, a
 * `preparation_stalled` receipt for an import or a delete) is held in the same run instead
 * of blocking it (the single path, and a bulk group's failed member, which the group step
 * leaves as the single pending entry). The hold waits behind the narrowed gate
 * (`holdUnderGate`) within the run's wait budget; when a request that can still change the
 * entry's outcome is running the run returns `partial` and the next run's start-of-run
 * conversion holds the entry. The failed request is converted once (`convertedFromFailed`,
 * so it no longer blocks the checkpoint), gets no failure-ledger row, and is logged as a
 * conversion. Null when it is not such a receipt, when the entry is the checkpoint, or when
 * the run does not hold files (`sync.holds=fail`, company-brain sources).
 */
async function holdFailedFenceRequest(engine: BrainEngine, cursor: Cursor, key: string, pending: Pending, done: WriteRequest, assertActive: () => void,
  run: { screen?: SyncScreenRun | null; observedAt?: string; syncOptions: SyncCursorOptions; repoPath?: string }, waitMs: number): Promise<Cursor | 'pending' | { tripped: Cursor } | null> {
  if (!run.screen || cursor.companyPlan || pending.intent.kind === 'managed_sync_checkpoint') return null;
  const entry = cursor.entries[cursor.index];
  if (!entry || entry.path !== pending.intent.path) return null;
  const stalled = preparationStalled(done);
  const page = pending.intent.kind === 'managed_sync_import' && typeof pending.intent.content === 'string';
  if (!stalled && !page && pending.intent.kind !== 'managed_sync_delete') return null;
  let base: Cursor | undefined;
  if (stalled) {
    // #6278 (1.5): the breaker counts the receipt first; at the trip the run stops and converts neither this receipt nor a later one.
    if (cursor.breaker?.tripped) return { tripped: cursor };
    const breaker = breakerAfter(cursor, done, run.screen.policy);
    if (breaker.tripped) return { tripped: await saveCursor(engine, key, cursor, { ...cursor, breaker }, false, assertActive) };
    base = { ...cursor, breaker }; delete base.pending; delete base.group; delete base.window;
  }
  const fence = stalled || !page ? null : fenceReceiptLocation(done);
  // #6194 (D4): a revision conflict proven to come from a concurrent database-only write is held the same way; #6340: so is one
  // whose page really moved with no proof of who moved it, and a pinned-worktree conflict (uncommitted local bytes) holds
  // `worktree_dirty` (sync-page-fault.ts). A run-level revision conflict (the page is where it was) still blocks.
  const fault = stalled || fence ? null : await receiptPageFaultHold(engine, { sourceId: cursor.sourceId, incarnation: cursor.incarnation, entry, pending, done });
  // #6340: the file changed after admission (a commit landed between freeze and publication on a live checkout): re-freeze the
  // entry once under a fresh request (committed bytes import as HEAD has them; uncommitted ones reach the dirty hold above);
  // a second change under the same entry is held, so a file that keeps changing never loops.
  if (!stalled && !fence && !fault && page && fileChangedAfterAdmission(done)) {
    const refrozen = await freezeEntry(engine, base ?? (() => { const b: Cursor = { ...cursor }; delete b.pending; delete b.group; delete b.window; return b; })(), key, assertActive, run);
    assertActive();
    if ('hold' in refrozen) return holdUnderGate(engine, { cursor, key, pending, hold: refrozen.hold, assertActive, observedAt: run.observedAt!, waitMs, failedId: done.id, base });
    if (pending.converted) return holdUnderGate(engine, { cursor, key, pending, hold: worktreeDirtyHold(entry, pending.slug, pending.pageId, { ...pending.intent, rawHash: refrozen.intent.rawHash }), assertActive, observedAt: run.observedAt!, waitMs, failedId: done.id, base });
    return holdUnderGate(engine, { cursor, key, pending, refrozen, assertActive, observedAt: run.observedAt!, waitMs, failedId: done.id, base });
  }
  if (!stalled && !fence && !fault) return null;
  const hold = stalled ? preparationStalledHold(entry, pending.slug, pending.pageId, done, pending.intent.content ?? null, pending.intent.blobOid, resumeArgsOf(cursor, run))
    : fence ? prepareTimeFenceHold(entry, pending.slug, pending.pageId, fence, pending.intent.content!, pending.intent.blobOid) : fault!;
  return holdUnderGate(engine, { cursor, key, pending, hold, assertActive, observedAt: run.observedAt!, waitMs, failedId: done.id, base });
}

/**
 * A page request of the run ended without committing. #6188: a fence refusal is held in the same
 * run (or the run returns `partial` while the source's other requests settle); anything else is
 * recorded in the failure ledger and blocks the run with its diagnostic.
 */
async function settleFailedRequest(engine: BrainEngine, input: { cursor: Cursor; key: string; pending: Pending; done: WriteRequest; assertActive: () => void;
  run: { screen?: SyncScreenRun | null; observedAt?: string; repoPath?: string; syncOptions: SyncCursorOptions }; syncOptions: SyncCursorOptions; processingOptions: SyncProcessingOptions;
  remote: boolean; waitMs: number; signal?: AbortSignal }): Promise<{ cursor: Cursor } | { result: SyncResult }> {
  const { cursor, key, pending, done, syncOptions, processingOptions, remote } = input;
  const converted = await holdFailedFenceRequest(engine, cursor, key, pending, done, input.assertActive, input.run, input.waitMs);
  if (converted === 'pending') return { result: result(cursor, 'partial', input.signal?.aborted ? 'timeout' : 'writer_pending') };
  if (converted && 'tripped' in converted) return { result: breakerResult(converted.tripped, pending, done, remote) };
  if (converted) { input.assertActive(); return { cursor: converted }; }
  const { failure, ledgerRecorded } = await recordManagedSyncFailure(engine, { source_id: cursor.sourceId, source_incarnation: cursor.incarnation, path: pending.intent.path ?? '<checkpoint>',
    code: done.error_code ?? (done.state === 'cancelled' ? 'cancelled' : 'storage_error'), message: done.error_message ?? 'The accepted sync request did not commit.',
    request_id: pending.requestId, run_id: cursor.runId, target: cursor.target, cursor_key: key,
    syncOptions: cursor.syncOptions ?? syncOptions, processingOptions: cursor.processingOptions ?? processingOptions,
    phase: pending.intent.kind === 'managed_sync_checkpoint' ? 'checkpoint' : 'receipt', state: done.state, observation_id: pending.requestId,
    first_seen: new Date(done.completed_at ?? done.updated_at).toISOString() });
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
 * #6278: the preparation races the sync budget; past it the origin refusal stands, and a cancelled run propagates.
 */
async function sameContentAtOrigin(engine: BrainEngine, cursor: Cursor, entry: Cursor['entries'][number], key: string,
  snapshot: Awaited<ReturnType<BrainEngine['readPageSnapshot']>>, content: string, rawHash: string | null, lineEndingOnly: boolean, signal?: AbortSignal): Promise<boolean> {
  if (!snapshot || snapshot.page.deleted_at != null) return false;
  const intent: SyncIntent = { kind: 'managed_sync_import', expected_revision: snapshot.revision, sourcePath: entry.sourcePath, path: entry.path, rawHash, content, lineEndingOnly,
    processingOptions: cursor.processingOptions, ownerEpoch: String(cursor.binding.owner_epoch), syncAuthority: cursor.authority,
    cursorKey: key, runId: cursor.runId, slugMode: cursor.slugMode, index: cursor.index, total: cursor.entries.length, from: cursor.from, target: cursor.target, working: entry.working ?? false };
  try {
    const budgetMs = await syncPreparationBudgetMs(engine);
    const prepared = await raceSyncBudget(prepareManagedSyncMutation(engine, screeningRequest({ source_id: cursor.sourceId, source_incarnation: cursor.incarnation, slug: snapshot.page.slug,
      page_id: snapshot.page.id, worktree_id: cursor.binding.worktree_id, authority: cursor.authority.writer, intent }), { engine: engine.kind }, startClaimPhase(Date.now(), undefined, budgetMs)), budgetMs, signal);
    return (prepared.contentUnchanged === true || prepared.noop === true) && !prepared.file && prepared.observedRevision === snapshot.revision;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

/** Counts a committed page into the cursor, as the single path does. */
function countCommitted(counts: Cursor['counts'], pending: Pending, outcome: WriteRequest['outcome']): void {
  if (outcome?.noop !== true) {
    if (pending.intent.kind === 'managed_sync_delete') counts.deleted++;
    else if (pending.intent.renameFrom) counts.renamed = (counts.renamed ?? 0) + 1;
    else if (pending.pageId === null) counts.added++; else counts.modified++;
  }
  counts.chunks += Number(outcome?.chunks ?? 0);
  if ((outcome?.recovered_frontmatter || outcome?.comment_value) && pending.intent.path) counts.recovered = addRecovered(counts.recovered,
    { paths: outcome.recovered_frontmatter ? [pending.intent.path] : [], commentValues: outcome.comment_value ? 1 : 0 });
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
 * per-entry path for the head (its screen admits it, or the run's transaction validated nothing or timed out);
 * otherwise the cursor past the waived prefix (or as another run moved it), with the entry that ended the prefix
 * saved as pending.
 */
async function waiveRun(engine: BrainEngine, cursor: Cursor, head: Pending, key: string, config: GBrainConfig, assertActive: () => void,
  frozenRun: Parameters<typeof freezeEntry>[4], drainStartedAt: number, limit: number, onProgress: SyncOpts['onProgress']): Promise<Cursor | null> {
  const first = await screenWaiver(engine, cursor, head, config, frozenRun.signal);
  if (!first) return null;
  assertActive();
  const run: WaiverRunEntry[] = [{ pending: head, waived: first }];
  const max = Math.max(1, Math.min(WAIVER_RUN_MAX, limit));
  extend: for (let next = cursor.index + 1; run.length < max && next < cursor.entries.length;) {
    const batch = Array.from({ length: Math.min(4, max - run.length, cursor.entries.length - next) }, (_, i) => next + i);
    const frozen = await Promise.all(batch.map(index => freezeEntry(engine, { ...cursor, index }, key, assertActive, frozenRun).catch(() => null)));
    const screened = await Promise.all(frozen.map((entry, i) => entry && !('hold' in entry) && !entry.rebound
      ? screenWaiver(engine, { ...cursor, index: batch[i]! }, entry, config, frozenRun.signal,
        frozenSnapshots.has(entry as Pending) ? { snapshot: frozenSnapshots.get(entry as Pending)! } : undefined).catch(() => null) : null));
    for (const [i, waived] of screened.entries()) {
      if (!waived) break extend;
      run.push({ pending: frozen[i] as Pending, waived });
    }
    next += batch.length;
  }
  assertActive();
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

/** #5984 bulk: freezes the followers of an eligible head and records them with it as the cursor's group. */
async function formGroup(engine: BrainEngine, head: Cursor, pending: Pending, key: string, bulk: BulkPass, config: GBrainConfig, freezeAt: FreezeAt,
  assertActive: () => void): Promise<Cursor> {
  const followers = await freezeFollowers(engine, head, config, groupSize(head, bulk) - 1, freezeAt(head));
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
    const prior = await getWriteRequest(engine, head.authority.writer.principal, pending.requestId);
    if (prior?.digest !== intentDigest({ operation: 'submit_job', sourceId: head.sourceId, slug: pending.slug, callerIntent: pending.intent })) throw error;
    return currentCursor(engine, key, head);
  }
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
      const frozen = await freezeFollowers(engine, base, config, size, freezeAt(base)).catch(() => []);
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
  const principal = cursor.authority.writer.principal;
  const admitted = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=ANY($3::uuid[])',
    [principal.kind, principal.id, members.map(member => member.requestId)]);
  if ((admitted[0]?.n ?? 0) >= members.length) return true;
  const rows = await admitGroup(engine, members, cursor, async tx => {
    const [held] = await tx.executeRaw<{ request_id: string | null }>(`SELECT completed_keys->0->'window'->($3::int)->0->>'requestId' AS request_id FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 FOR SHARE`, [OP, key, slot]);
    return held?.request_id === members[0]!.requestId;
  }).catch(() => null);
  if (rows) startPersistenceConsumer(engine, loadConfig() ?? { engine: engine.kind }).wake(true);
  return rows !== null;
}
/**
 * #5984 bulk: admits the cursor's group, waits for it and advances over the
 * committed prefix. A terminal failure leaves that member as the single
 * pending entry, so the single path records and reports it.
 */
async function groupStep(engine: BrainEngine, cursor: Cursor, key: string, bulk: BulkPass, config: GBrainConfig, wait: { waitMs: number; signal?: AbortSignal },
  drainStartedAt: number, onProgress: SyncOpts['onProgress'], ahead?: (cursor: Cursor) => Promise<Cursor>): Promise<{ cursor: Cursor } | { result: SyncResult }> {
  const signal = wait.signal;
  const members = cursor.group!;
  const principal = cursor.authority.writer.principal;
  let rows = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=ANY($3::uuid[])',
    [principal.kind, principal.id, members.map(member => member.requestId)]);
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
    const ids = next.window.flat().map(member => member.requestId);
    const done = new Map((await engine.executeRaw<WriteRequest>(`SELECT request_id,state,outcome FROM persistence_requests
      WHERE principal_kind=$1 AND principal_id=$2 AND request_id=ANY($3::uuid[]) AND state='committed'`, [principal.kind, principal.id, ids])).map(row => [row.request_id, row]));
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
  } else { next.pending = stuck; if (failed) delete next.group; else next.group = members.slice(committed); }
  // A failed page stops the run: groups admitted ahead of it are cancelled, never published after it.
  if (failed && next.window) { await cancelWindow(engine, next.window, principal); delete next.window; }
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

/**
 * The result of a committed checkpoint. #6278 (B7): `sources retry-held` schedules re-screens that only discovery honours,
 * and a cursor discovered before them (a backlog the retry was scheduled against, or a run the retry overlapped) never sees
 * them, so the pass yields (`writer_yield`, as at a slice boundary) and the drain's next pass retires the finished cursor and
 * discovers again, taking them; a single-pass caller re-enters the same way.
 */
async function finishCheckpoint(engine: BrainEngine, key: string, cursor: Cursor, company: boolean, assertActive: () => void): Promise<SyncResult> {
  await clearManagedSyncFailureAfterSuccess(engine, key);
  if (cursor.counts.added + cursor.counts.modified + cursor.counts.deleted > 0) await refreshProjectionStatistics(engine);
  assertActive();
  const scheduled = company ? [] : await readGitHoldRetryPaths(engine, cursor.sourceId, cursor.incarnation);
  assertActive();
  return scheduled.length ? result(cursor, 'partial', 'writer_yield') : result(cursor, cursor.from === null ? 'first_sync' : 'synced');
}
/** A finished cursor is deleted (compare-and-swap) before the next run discovers; returns whichever cursor replaced it. */
async function retireCompletedCursor(engine: BrainEngine, key: string, completed: Cursor, assertActive: () => void): Promise<Cursor | null> {
  await engine.transaction(async tx => {
    assertActive();
    await tx.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb', [OP, key, JSON.stringify([header(completed)])]);
    assertActive();
  });
  assertActive();
  await clearManagedSyncFailureAfterSuccess(engine, key);
  return readCursor(engine, key);
}
/** What the hold report needs from a managed run: its source, cursor and authority. */
interface HoldRunState { sourceId?: string; incarnation?: string; remote?: boolean; cursor?: () => Cursor | CursorHeader | null }

/**
 * One immutable page is admitted at a time; foreground writes can never sit behind a whole scan.
 * #5988: every result (resumed, no-change and blocked runs included) carries this run's holds and the source's outstanding total.
 */

/** The cursor-selecting options of a managed run; part of its durable cursor key. */
function cursorSyncOptions(opts: SyncOpts): SyncCursorOptions {
  return { full: opts.full ?? false, workingTree: opts.workingTree ?? false, srcSubpath: opts.srcSubpath ?? null,
    exclude: opts.exclude ?? [], includeHidden: opts.includeHidden ?? [], strategy: opts.strategy ?? null };
}
function managedCursorKey(incarnation: string, authority: SyncAuthority, company: ReturnType<typeof currentCompanyBrainSync>, syncOptions: SyncCursorOptions): string {
  return digest({ source: incarnation, principal: authority.writer.principal, authority, ...(company ? { company: { receiptId: company.receiptId, planDigest: company.plan.plan_digest } } : {}),
    options: syncOptions });
}
/** The durable cursor key performManagedSync would use for these options, so --retry-failed can count only the failures it retries. */
export async function managedSyncCursorKey(engine: BrainEngine, opts: SyncOpts): Promise<string> {
  const context = await resolveManagedSyncContext(engine, opts);
  const authority = await managedSyncAuthority(engine, context.sourceId, context.incarnation, opts.repoPath ?? context.root);
  return managedCursorKey(context.incarnation, authority, currentCompanyBrainSync(context.sourceId), cursorSyncOptions(opts));
}
/**
 * `--retry-failed` on an unfinished cursor whose pending request failed (or whose run has a ledger row). #6340: a pending
 * request that failed on a page fault (a page that moved, a dirty file) converts in place with the frozen manifest; every
 * other failure keeps the explicit rediscovery from HEAD. Null when nothing applies (an unfinished request, no failure).
 */
async function retryFailedStart(engine: BrainEngine, cursor: Cursor, key: string, input: { opts: SyncOpts; context: ManagedSyncContext; authority: SyncAuthority;
  processingOptions: SyncProcessingOptions; syncOptions: SyncCursorOptions; startupConfig: BrainEngine; frozenRun: Parameters<typeof freezeEntry>[4]; runStartedAt: string;
  discoveryRun: string; assertActive: () => void }): Promise<{ cursor: Cursor; discoveryTarget?: string } | null> {
  const { opts, context, authority, processingOptions, syncOptions, assertActive } = input;
  const unfinished = await engine.executeRaw(`SELECT id FROM persistence_requests WHERE source_id=$1
    AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) LIMIT 1`, [cursor.sourceId]);
  assertActive();
  if (unfinished.length) return null;
  const failed = cursor.pending ? await getWriteRequest(engine, cursor.authority.writer.principal, cursor.pending.requestId) : null;
  const recorded = await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=$1 AND completed_keys->0->>'run_id'=$2", [key, cursor.runId]);
  assertActive();
  if (!((failed && ['failed', 'conflict', 'cancelled'].includes(failed.state)) || (recorded.length && (failed?.state === 'committed' || !failed)))) return null;
  // Only the #6340 page faults convert here (a content refusal under --retry-failed keeps its explicit rediscovery).
  const pageFault = !!failed && !!cursor.pending && (pinnedWorktreeConflict(failed) || failed.error_code === 'revision_conflict');
  const screen = pageFault ? await loadSyncScreenRun(input.startupConfig, cursor.sourceId, cursor.processingOptions ?? processingOptions, authority.writer.remote) : null;
  const converted = screen ? await convertBlockedCursor(engine, cursor, key, assertActive, { ...input.frozenRun, screen, observedAt: cursor.discoveredAt ?? input.runStartedAt }) : cursor;
  assertActive();
  if (converted !== cursor) return { cursor: converted };
  const discoveryTarget = syncGit(context.gitRoot, ['rev-parse', 'HEAD']).trim();
  const discovery = await discoverManagedSync(engine, opts, context);
  assertActive();
  return { cursor: await replaceCursor(engine, key, header(cursor), { ...discovery, authority, processingOptions, syncOptions, runId: input.discoveryRun, index: 0, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 } }, assertActive), discoveryTarget };
}

export async function performManagedSync(engine: BrainEngine, opts: SyncOpts, slice?: { maxPages: number; maxMs: number }): Promise<SyncResult> {
  const state: HoldRunState = {};
  const synced = await runManagedSync(engine, opts, slice, state);
  if (!state.sourceId || !state.incarnation || synced.status === 'dry_run') return synced;
  const cursor = state.cursor?.() ?? null;
  try {
    const report = await buildHoldReport(engine, { sourceId: state.sourceId, incarnation: state.incarnation, runId: cursor?.runId ?? '', remote: state.remote === true,
      policy: await readSyncHoldPolicy(engine), pendingScreen: synced.reason === 'writer_yield',
      screened: 'entries' in (cursor ?? {}) ? (cursor as Cursor).entries.slice(0, cursor!.index).filter(entry => entry.action === 'import').length : 0 });
    const recovered = state.remote ? undefined : recoveredReport(state.sourceId, cursor?.counts.recovered);
    const fences = fencesNormalizedReport(state.sourceId, cursor?.counts.fences, state.remote === true);
    return { ...synced, ...report, ...(!state.remote && cursor?.convertedFromFailed?.length ? { converted_from_failed: cursor.convertedFromFailed } : {}),
      ...(recovered ? { recovered_frontmatter: recovered } : {}), ...(fences ? { fences_normalized: fences } : {}) };
  } catch {
    return synced;
  }
}

async function runManagedSync(engine: BrainEngine, opts: SyncOpts, slice: { maxPages: number; maxMs: number } | undefined, state: HoldRunState): Promise<SyncResult> {
  await assertManagedSyncActive(engine);
  if (opts.sourceId && !currentCompanyBrainSync(opts.sourceId) && await getCompanyBrainProfile(engine, opts.sourceId)) {
    return (await import('../company-brain/runtime.ts')).performCompanyBrainSync(engine, opts);
  }
  assertPersistenceAccepting(engine);
  validateManagedSyncOptions(opts);
  const context = await resolveManagedSyncContext(engine, opts);
  if (!opts.dryRun) await assertManagedSyncAllowed(engine, context.binding.worktree_id, context.sourceId);
  const authority = await managedSyncAuthority(engine, context.sourceId, context.incarnation, opts.repoPath ?? context.root);
  const company = currentCompanyBrainSync(context.sourceId);
  const processingOptions = syncProcessingOptions(opts);
  const syncOptions = cursorSyncOptions(opts);
  const frozenRun: { syncOptions: SyncCursorOptions; repoPath?: string; screen?: SyncScreenRun | null; observedAt?: string; signal?: AbortSignal } = { syncOptions, ...(opts.repoPath ? { repoPath: resolve(opts.repoPath) } : {}) };
  const runStartedAt = new Date().toISOString();
  const key = managedCursorKey(context.incarnation, authority, company, syncOptions);
  let cursor: Cursor | null = null;
  let missingManifestCursor: CursorHeader | null = null;
  if (!company) Object.assign(state, { sourceId: context.sourceId, incarnation: context.incarnation, remote: authority.writer.remote, cursor: () => cursor });
  const dryRun = (value: Cursor, base: Cursor = value) => managedDryRun(engine, value, base, { company: !!company, processingOptions, syncOptions, repoPath: frozenRun.repoPath, remote: authority.writer.remote });
  let phase: ManagedSyncFailure['phase'] = 'resume';
  let discoveryTarget: string | null = null;
  const discoveryRun = randomUUID();
  const inheritedSignal = currentSourceFilesystemSignal();
  const signal = opts.signal && inheritedSignal ? AbortSignal.any([opts.signal, inheritedSignal]) : opts.signal ?? inheritedSignal; if (signal) frozenRun.signal = signal;
  const assertActive = () => {
    assertSyncDispatchActive();
    throwIfAborted(signal);
    assertPersistenceAccepting(engine);
  };
  // Links derive from committed pages once the checkpoint lands, in this owner
  // process, so forward references inside one run resolve and PGLite-delegated
  // syncs match Postgres. Content is already committed: a failure here leaves
  // the pages stale for `gbrain extract --stale` instead of failing the sync.
  const withLinks = async (done: Cursor, synced: SyncResult): Promise<SyncResult> => {
    if (company || (done.processingOptions ?? processingOptions).noExtract) return synced;
    try { return { ...synced, links: await extractManagedStaleLinks(engine, { sourceId: done.sourceId, maxPages: 1000, signal, mentions: false,
      slugs: done.entries.flatMap(entry => entry.action === 'import' && entry.slug ? [entry.slug] : []) }) }; }
    catch { return synced; }
  };
  try {
    assertActive();
    try { cursor = await readCursor(engine, key); }
    catch (error) {
      if (!(error instanceof MissingSyncManifest) || !opts.retryFailed || opts.dryRun || company) throw error;
      missingManifestCursor = error.cursor;
      assertActive();
      phase = 'discovery';
      discoveryTarget = syncGit(context.gitRoot, ['rev-parse', 'HEAD']).trim();
      const discovery = await discoverManagedSync(engine, opts, context);
      assertActive();
      cursor = await replaceCursor(engine, key, error.cursor, { ...discovery, authority, processingOptions, syncOptions, runId: discoveryRun, index: 0, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 } }, assertActive);
    }
    assertActive();
    if (company && opts.retryFailed && cursor && !cursor.done && !opts.dryRun) {
      const failed = cursor.pending ? await getWriteRequest(engine, cursor.authority.writer.principal, cursor.pending.requestId) : null;
      const unfinished = await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) LIMIT 1", [cursor.sourceId]);
      assertActive();
      if (!unfinished.length && (failed && ['failed', 'conflict', 'cancelled'].includes(failed.state) || !cursor.pending && !cursor.processingOptions)) {
        if (cursor.processingOptions && digest(cursor.processingOptions) !== digest(processingOptions)) {
          throw syncRunRefusal('invalid_params', 'The approved company sync must retain its original processing options.',
            { sourceId: cursor.sourceId, processingOptions: cursor.processingOptions, syncOptions: cursor.syncOptions ?? syncOptions, repoPath: frozenRun.repoPath },
            `The unfinished company-brain sync of source ${cursor.sourceId} was approved with ${SYNC_PROCESSING_KEYS.map(key => `${key}=${cursor!.processingOptions![key]}`).join(', ')}, and its retry must keep exactly those processing options; nothing was retried.`);
        }
        phase = 'freeze';
        const retry = { ...cursor, processingOptions };
        cursor = await saveCursor(engine, key, cursor, { ...retry, pending: await freezeEntry(engine, retry, key, assertActive, frozenRun) as Pending }, true, assertActive);
      }
    }
    const startupConfig = await preparationConfigView(engine); // #5984 G3: one config read answers the startup's config reads
    if (cursor && opts.retryFailed && !opts.dryRun && !company && !cursor.done) {
      const retried = await retryFailedStart(engine, cursor, key, { opts, context, authority, processingOptions, syncOptions, startupConfig, frozenRun, runStartedAt, discoveryRun, assertActive });
      if (retried) { cursor = retried.cursor; if (retried.discoveryTarget) { phase = 'discovery'; discoveryTarget = retried.discoveryTarget; } }
    }
    assertActive();
    // #5988: a finished run is not pending work; the dry run previews the holds of what a new run would discover.
    if (cursor?.done && opts.dryRun) return dryRun({ ...await discoverManagedSync(engine, opts, context), authority, processingOptions, syncOptions, runId: discoveryRun, index: 0, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 } }, cursor);
    if (cursor?.done && company) {
      await clearManagedSyncFailureAfterSuccess(engine, key);
      assertActive();
      return result(cursor, cursor.from === null ? 'first_sync' : 'synced');
    }
    if (cursor?.done) cursor = await retireCompletedCursor(engine, key, cursor, assertActive);
    if (!cursor) {
      assertActive();
      phase = 'discovery';
      discoveryTarget = company?.plan.revision?.commit ?? syncGit(context.gitRoot, ['rev-parse', 'HEAD']).trim();
      const discovery = await discoverManagedSync(startupConfig, opts, context);
      assertActive();
      const fresh: Cursor = { ...discovery, authority, processingOptions, syncOptions, runId: discoveryRun, index: 0, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 }, ...(company ? { companyReceiptId: company.receiptId } : {}) };
      if (opts.dryRun) return dryRun(fresh);
      if (!fresh.entries.length && fresh.from === fresh.target) {
        // A complete check that found nothing is still a sync: stamp the freshness heartbeat for this incarnation only.
        await engine.transaction(tx => withCoordinatedWrite(tx, [context.sourceId], () => {
          assertActive();
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
    if (cursor.incarnation !== context.incarnation || cursor.binding.worktree_id !== context.binding.worktree_id ||
        String(cursor.binding.topology_generation) !== String(context.binding.topology_generation) ||
        String(cursor.binding.owner_epoch) !== String(context.binding.owner_epoch) || cursor.root !== context.root) {
      throw syncRunRefusal('source_changed', 'The unfinished sync cursor belongs to an older source binding.',
        { sourceId: cursor.sourceId, processingOptions: cursor.processingOptions, syncOptions: cursor.syncOptions ?? syncOptions, repoPath: frozenRun.repoPath },
        `The unfinished sync cursor of source ${cursor.sourceId} was written under an older binding (its owner epoch, topology generation, worktree or root changed since), so this run stopped without importing; the retry rediscovers against the current binding.`);
    }
    assertCursorProcessingOptions(cursor, processingOptions, opts.explicitProcessing);
    if (opts.dryRun) return dryRun(cursor);
    frozenRun.screen = company ? null : await loadSyncScreenRun(startupConfig, cursor.sourceId, cursor.processingOptions ?? processingOptions, authority.writer.remote);
    const observedAt = frozenRun.observedAt = cursor.discoveredAt ?? runStartedAt;
    if (frozenRun.screen && !opts.retryFailed && cursor.pending && !cursor.done) {
      phase = 'freeze';
      cursor = await convertBlockedCursor(engine, cursor, key, assertActive, frozenRun);
    }
    const config = loadConfig() ?? { engine: engine.kind }, analyzeEvery = await importAnalyzeEveryPages(engine);
    let batchStart = performance.now(), batchPages = 0, foregroundWaitStart = 0, foregroundBaseline = 0;
    let creditedPages = 0, creditStarted = 0, foregroundQueued = false;
    const sliceStarted = performance.now(), sliceFirstIndex = cursor.index, drainStartedAt = opts.drainStartedAt ?? Date.now();
    const bulk: BulkPass = { settings: opts.bulk && !company ? opts.bulk : { enabled: false, reason: null, size: 1, maxTxnMs: 0 }, perMemberMs: null, foregroundFirst: await foregroundPriority(engine) };
    const waiveBatch = noopWaiversEnabled() && await waiverBatchEnabled(startupConfig);
    opts.onProgress?.({ phase: 'managed_sync.start', bankedFiles: cursor.index, total: cursor.entries.length });
    while (!cursor.done) {
      assertActive();
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
        phase = 'freeze';
        const frozen = await freezeEntry(engine, cursor, key, assertActive, frozenRun);
        if ('hold' in frozen) {
          cursor = await saveCursor(engine, key, cursor, { ...advanceHeld(cursor), ...(frozen.overtaken ? { overtaken: true as const } : {}) }, false, assertActive, heldWrite(cursor, frozen.hold, observedAt));
          opts.onProgress?.({ phase: 'managed_sync.page_committed', bankedFiles: cursor.index }); assertActive();
          if (slice && (cursor.index - sliceFirstIndex >= slice.maxPages || performance.now() - sliceStarted >= slice.maxMs)) return result(cursor, 'partial', 'writer_yield');
          continue;
        }
        const waived: Cursor | null = waiveBatch && !frozen.rebound ? await waiveRun(engine, cursor, frozen, key, config, assertActive, frozenRun, drainStartedAt,
          slice ? slice.maxPages - (cursor.index - sliceFirstIndex) : WAIVER_RUN_MAX, opts.onProgress) : null;
        if (waived && slice && (waived.index - sliceFirstIndex >= slice.maxPages || performance.now() - sliceStarted >= slice.maxMs)) return result(waived, 'partial', 'writer_yield');
        if (waived) { cursor = waived; continue; }
        cursor = await saveCursor(engine, key, cursor, { ...cursor, ...(frozen.rebound ? { overtaken: true as const } : {}), pending: frozen }, false, assertActive);
      }
      if (!cursor.pending) continue; // another owner-loop advanced the cursor
      const pending: Pending = cursor.pending;
      phase = 'admission';
      const prior = await getWriteRequest(engine, cursor.authority.writer.principal, pending.requestId);
      assertActive();
      // #5470/#5984: a frozen entry whose publication would change nothing advances the cursor without an admission.
      const screened: Cursor = cursor;
      const waived: Cursor | null = prior ? null : await waiveNoopEntry(engine, screened, pending, config, key,
        (tx, noop) => writeCursor(tx, key, screened, { ...waivedCursor(screened, noop), progress: stampProgress(screened.progress, screened.index, screened.index + 1, drainStartedAt) },
          holdClear(screened, pending.intent.path, observedAt)), tx => currentCursor(tx, key, screened), signal);
      if (waived) {
        cursor = waived;
        opts.onProgress?.({ phase: 'managed_sync.page_committed', bankedFiles: cursor.index, total: cursor.entries.length, waived: true });
        assertActive();
        // A skipped entry still counts toward the caller's slice, so a sliced run yields at the same positions.
        if (slice && (cursor.index - sliceFirstIndex >= slice.maxPages || performance.now() - sliceStarted >= slice.maxMs)) return result(cursor, 'partial', 'writer_yield');
        continue;
      }
      const freezeAt: FreezeAt = base => async index => { const frozen = await freezeEntry(engine, { ...base, index }, key, assertActive, frozenRun); return 'hold' in frozen ? null : frozen; };
      if (bulk.settings.enabled && (bulk.foregroundFirst || !foregroundQueued) && !prior && !cursor.group && !pending.rebound && groupableIntent(pending.intent)) cursor = await formGroup(engine, cursor, pending, key, bulk, config, freezeAt, assertActive);
      if (cursor.group?.[0]?.requestId === pending.requestId && cursor.pending?.requestId === pending.requestId) {
        const step = await groupStep(engine, cursor, key, bulk, config, opts.drainStartedAt ? { waitMs: 30_000, signal } : { waitMs: 5000 }, drainStartedAt, opts.onProgress,
          opts.drainStartedAt ? next => admitAhead(engine, next, key, bulk, config, freezeAt, assertActive) : undefined);
        if ('result' in step) return step.result;
        cursor = step.cursor;
        assertActive();
        continue;
      }
      const admitting = cursor;
      const row = prior ?? await retryWriteAdmission(pending.requestId, remaining => engine.transaction(async tx => {
        assertActive();
        await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
          [`${Math.min(1000, remaining)}ms`, `${remaining}ms`]);
        const accepted = await admitWriteInTransaction(tx, { requestId: pending.requestId, operation: 'submit_job',
          sourceId: admitting.sourceId, sourceIncarnation: admitting.incarnation, slug: pending.slug, pageId: pending.pageId,
          worktreeId: admitting.binding.worktree_id, topologyGeneration: admitting.binding.topology_generation,
          principal: admitting.authority.writer.principal, authority: admitting.authority.writer, callerIntent: pending.intent, intent: pending.intent });
        // ENG-A7: after the counter locks (the publication lock order), admit only while the cursor still holds this entry
        // with this intent (#6075: a bulk pass may have grouped the head since this pass read it).
        const [held] = await tx.executeRaw<{ request_id: string | null; same: boolean | null }>(`SELECT completed_keys->0->'pending'->>'requestId' AS request_id,
          completed_keys->0->'pending'->'intent' = $3::text::jsonb AS same FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 FOR SHARE`, [OP, key, JSON.stringify(pending.intent)]);
        if (held?.request_id !== pending.requestId || held.same !== true) throw new CursorMoved();
        assertActive();
        return accepted;
      }), undefined, error => engine.reconnect({ error })).catch(error => cursorMovedAdmission(engine, key, admitting, pending, error));
      if (!row) { cursor = await currentCursor(engine, key, cursor); continue; }
      await validateSyncAuthority(engine, cursor.authority, pending.slug);
      assertSyncDispatchActive();
      // #5762: a checkpoint's validation runs under the coordinator's 5 s statement timeout, so its wait outlasts that
      // budget; a timed-out checkpoint then reports its terminal refusal and hint in this run instead of the next.
      // #5984: a drain re-enters anyway, so it waits longer per page instead of paying a full re-entry; its stop signal bounds the wait.
      const waited = await awaitWrite(engine, row, config, opts.drainStartedAt ? { waitMs: 30_000, signal } : { waitMs: pending.intent.kind === 'managed_sync_checkpoint' ? 8000 : 5000 });
      const done = waited.row;
      assertSyncDispatchActive();
      if (!isTerminalWriteState(done.state)) {
        return { ...result(cursor, 'partial', signal?.aborted ? 'timeout' : 'writer_pending'),
          ...(authority.writer.remote ? {} : { managedWrite: writeDiagnostic(cursor, pending, done), writeWait: writeWaitOf(waited) }) };
      }
      if (done.state !== 'committed') {
        const settled = await settleFailedRequest(engine, { cursor, key, pending, done, assertActive, run: frozenRun, syncOptions, processingOptions,
          remote: authority.writer.remote, waitMs: opts.drainStartedAt ? 30_000 : 5000, signal });
        if ('result' in settled) return settled.result;
        cursor = settled.cursor;
        opts.onProgress?.({ phase: 'managed_sync.page_committed', bankedFiles: cursor.index, total: cursor.entries.length });
        continue;
      }
      if (pending.intent.kind === 'managed_sync_checkpoint') {
        cursor = (await readCursor(engine, key))!;
        if (!cursor?.done) throw syncRunRefusal('storage_error', 'Committed sync checkpoint lost its cursor.',
          { sourceId: context.sourceId, processingOptions: pending.intent.processingOptions, syncOptions: pending.intent.syncOptions ?? syncOptions, repoPath: pending.intent.repoPath ?? frozenRun.repoPath },
          `The final checkpoint request ${pending.requestId} of this sync committed, but its cursor could not be read back to finish the run.`);
        return withLinks(cursor, await finishCheckpoint(engine, key, cursor, !!company, assertActive));
      }
      // The frozen manifest is shared; only the cursor header changes per page.
      const next: Cursor = { ...cursor, ...committedBreaker(cursor), index: cursor.index + 1, counts: { ...cursor.counts }, progress: stampProgress(cursor.progress, cursor.index, cursor.index + 1, drainStartedAt) }; delete next.pending; delete next.group;
      countCommitted(next.counts, pending, done.outcome);
      cursor = await saveCursor(engine, key, cursor, next);
      opts.onProgress?.({ phase: 'managed_sync.page_committed', bankedFiles: cursor.index, total: cursor.entries.length });
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
    return withLinks(cursor, result(cursor, cursor.from === null ? 'first_sync' : 'synced'));
  } catch (error) {
    assertSyncDispatchActive();
    if (signal?.aborted && error instanceof Error && error.name === 'AbortError') {
      if (cursor) return result(cursor, 'partial', 'timeout');
      if (missingManifestCursor) return result(missingManifestCursor, 'partial', 'timeout');
      const from = authority.writer.remote || opts.full ? null : context.source.last_commit;
      return { status: 'partial', reason: 'timeout', fromCommit: from, toCommit: authority.writer.remote ? '' : discoveryTarget ?? from ?? '',
        added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], filesImported: 0, bankedFiles: 0 };
    }
    if (!opts.dryRun) {
      const code = error instanceof OperationError ? error.code : 'storage_error';
      // A refresh fence, or an admission refused while other requests hold the writer's outstanding cap (#6278: the drain
      // waits for them), is transient admission back-pressure, not a sync failure to record. #6340: neither is a lost
      // database connection or a statement timeout: the cursor and its frozen manifest stay, and the next pass resumes them.
      if (!['permission_denied', 'worktree_refreshing', 'refresh_recovery_required'].includes(code) && !isWriteCapacityWait(error)
        && !isRetryableConnError(error) && !isStatementTimeoutError(error)) {
        const [stored] = cursor ? [] : await engine.executeRaw<{ completed_keys: [CursorHeader] }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [OP, key]);
        const failedCursor = cursor ?? stored?.completed_keys?.[0];
        const { failure } = await recordManagedSyncFailure(engine, { source_id: context.sourceId, source_incarnation: context.incarnation, path: cursor?.entries[cursor.index]?.path ?? failedCursor?.pending?.intent.path ?? `<${phase}>`, code,
          message: error instanceof Error ? error.message : String(error), request_id: failedCursor?.pending?.requestId ?? null,
          run_id: failedCursor?.runId ?? discoveryRun, target: failedCursor?.target ?? discoveryTarget, cursor_key: key,
          syncOptions: failedCursor?.syncOptions ?? syncOptions, processingOptions: failedCursor?.processingOptions ?? processingOptions, phase, state: 'failed',
          observation_id: failedCursor ? `${failedCursor.runId}:${failedCursor.index}:${phase}:${code}` : `${key}:discovery:${discoveryTarget}:${code}` });
        if (error instanceof Error) error.message = authority.writer.remote ? 'Managed sync is blocked; ask the host operator to inspect doctor.' : `${formatManagedSyncFailure(failure)} Fix the cause, then run: ${managedSyncRetryCommand(failure, frozenRun.repoPath)}`;
      }
    }
    throw error;
  }
}
