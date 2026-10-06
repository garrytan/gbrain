import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { loadConfig } from '../config.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { RegistryCode } from '../error-registry.ts';
import { currentSourceFilesystemSignal } from '../minions/source-filesystem.ts';
import { throwIfAborted } from '../abort-check.ts';
import { digest, sha256 } from './digest.ts';
import { getWriteRequest, admitWriteInTransaction, receiptFor } from './journal.ts';
import { retryWriteAdmission } from './admission-retry.ts';
import { assertPersistenceAccepting, awaitWrite, foregroundWriteCompletions, startPersistenceConsumer, type WriteWait } from './service.ts';
import { assertSyncEntryOrigin, discoverManagedSync, resolveManagedSyncContext, readSyncContent, readSyncFile, syncGit, type SyncDiscovery } from './sync-discovery.ts';
import { isImageFilePath } from '../sync.ts';
import { assertSyncPageOrigin, sameSyncOrigin, syncOriginScope } from './sync-origin.ts';
import { assertManagedSyncActive, assertSyncDispatchActive, managedSyncAuthority, validateSyncAuthority, validateManagedSyncOptions, syncProcessingOptions, SYNC_PROCESSING_KEYS, type SyncAuthority, type SyncProcessingOptions } from './sync-authority.ts';
import { prepareManagedSyncMutation, type SyncCursorOptions, type SyncIntent } from './sync-prepare.ts';
import { screeningRequest } from './noop-kernel.ts';
import { waiveNoopEntry, type NoopWaiver } from './sync-waivers.ts';
import { resolve } from 'node:path';
import { currentCompanyBrainSync, getCompanyBrainProfile, readCompanyBrainPlan } from '../company-brain/profile.ts';
import { readCommittedBlob } from '../company-brain/revision.ts';
import { refreshProjectionStatistics } from '../search/projection-statistics.ts';
import { importAnalyzeEveryPages, maybeRefreshPlannerStats } from '../planner-stats.ts';
import { recordManagedSyncFailure, clearManagedSyncFailureAfterSuccess, formatManagedSyncFailure, type ManagedSyncFailure } from './sync-failures.ts';
import { writeFailureDiagnostic } from './verb-errors.ts';
import { extractManagedStaleLinks } from './links-maintenance.ts';
import { CHECKPOINT_VALIDATION_TIMEOUT, checkpointRetryCommand, checkpointTimeoutHint } from './checkpoint-validation.ts';
import { isTerminalWriteState, publicWriteReceipt, type WriteReceipt } from './types.ts';
import type { WriteRequest } from './model.ts';
import { assertManagedSyncAllowed } from './worktree-refresh.ts';
import type { GBrainConfig } from '../config.ts';
import { admitGroup, freezeFollowers, groupableIntent, nextGroupSize, type BulkSettings } from './sync-group.ts';
import { cancelWindow } from './sync-window.ts';
import { lanePolicy, openLanes } from './sync-lanes.ts';
import { isContentRefusal } from '../import-screen.ts';
import { SYNC_READ_BOUND, type TreeBlob } from './sync-blobs.ts';
import { dryRunScreen, isSyncReadBound, loadSyncScreenRun, managedImageHold, pinnedBlob, screenFrozenImport, type HeldEntry, type SyncScreenRun } from './sync-screen.ts';
import { faultPoint } from './fault-points.ts';
import { addRecovered, buildHoldReport, clearGitHold, clearGitHoldRetryPaths, readSyncHoldPolicy, recordSyncConversion, recoveredReport, writeGitHold } from './sync-holds.ts';

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
/** #5988: the frozen entry is held instead of admitted. */
interface Held { hold: HeldEntry }
interface Cursor extends SyncDiscovery { runId: string; index: number; authority: SyncAuthority; pending?: Pending; done?: boolean; companyReceiptId?: string;
  processingOptions?: SyncProcessingOptions; syncOptions?: SyncCursorOptions; overtaken?: true;
  counts: { added: number; modified: number; deleted: number; chunks: number; renamed?: number;
    /** #5751: unchanged working-tree files skipped only because a no-op publication could never resolve their admit reason. */
    skippedContextualMode?: number; skippedCanonicalBytes?: number;
    /** DX-A7: entries advanced without an admission because their publication would change nothing. */
    waived?: { imports: number; deletes: number };
    /** #5988: imports held, and files imported only after quoting frontmatter. */
    held?: number; recovered?: { count: number; sample_paths: string[]; comment_values?: number } };
  /** #5988: failed content-refusal requests this run converted in place. */
  convertedFromFailed?: string[];
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
async function writeCursor(tx: BrainEngine, key: string, before: Cursor | null, next: Cursor, inTx?: (tx: BrainEngine) => Promise<unknown>): Promise<Cursor> {
  if (before === null) {
    await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb) ON CONFLICT DO NOTHING`, [`${OP}-manifest`, next.runId, JSON.stringify(next.entries)]);
    await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb) ON CONFLICT DO NOTHING`, [OP, key, JSON.stringify([header(next)])]);
  } else {
    const saved = await tx.executeRaw(`UPDATE op_checkpoints SET completed_keys=$4::text::jsonb,updated_at=now()
      WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb RETURNING fingerprint`, [OP, key, JSON.stringify([header(before)]), JSON.stringify([header(next)])]);
    await tx.executeRaw('UPDATE op_checkpoints SET updated_at=now() WHERE op=$1 AND fingerprint=$2', [`${OP}-manifest`, next.runId]);
    // #5988: a hold write or clear commits with the cursor step that passes its entry, never without it.
    if (saved.length) await inTx?.(tx);
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
    await tx.executeRaw('UPDATE op_checkpoints SET completed_keys=$4::text::jsonb,updated_at=now() WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb',
      [OP, key, JSON.stringify([before]), JSON.stringify([header(next)])]);
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
function writeDiagnostic(cursor: Cursor, pending: Pending, row: WriteRequest): ManagedSyncWriteDiagnostic {
  const terminal = isTerminalWriteState(row.state);
  const code = terminal ? row.error_code ?? (row.state === 'cancelled' ? 'cancelled' : 'storage_error') : 'write_pending';
  const blockedReason = ['writer_busy', 'writer_pool_capacity', 'owner_unavailable', 'recovery_required', 'writer_lock_unavailable',
    'database_contention', 'consumer_stopping', 'revision_changed_repreparing', 'unexpected_file_bytes', 'unexpected_staging_bytes'].includes(row.blocked_reason ?? '') ? row.blocked_reason! : 'write_pending';
  const detail = terminal ? writeFailureDiagnostic(code, row.error_message) : {
    reason: blockedReason, message: 'The write is accepted but not committed; the sync checkpoint has not advanced.',
    suggestion: 'Re-run the same sync options to resume this request. Do not submit a replacement request or skip the pending write.',
  };
  const diagnostic: ManagedSyncWriteDiagnostic = { source_id: cursor.sourceId, slug: pending.slug,
    path: pending.intent.path, write_error: code, ...detail, write_request: publicWriteReceipt(receiptFor(row)) };
  if (terminal) diagnostic.suggestion += ' After repair, run gbrain sync with the same source/options and --retry-failed to start a new request. Without --retry-failed, the frozen terminal request returns the same outcome. Skipping failures cannot bypass a managed write.';
  if (diagnostic.reason === 'pinned_git_worktree_conflict' && pending.intent.path && pending.intent.content !== null) {
    try {
      const bytes = readSyncFile(cursor.root, pending.intent.path);
      if (bytes && sha256(bytes) === pending.intent.rawHash && sha256(bytes) !== sha256(pending.intent.content)
        && bytes.equals(Buffer.from(bytes.toString('utf8')))
        && bytes.toString('utf8').replace(/\r\n/g, '\n') === pending.intent.content.replace(/\r\n/g, '\n')) {
        diagnostic.line_endings = 'crlf_lf_only';
        diagnostic.message += ' The frozen working-tree and Git versions differ only by CRLF/LF line endings; exact byte protection still applies.';
      }
    } catch {}
  }
  return diagnostic;
}
async function freezeEntry(engine: BrainEngine, cursor: Cursor, key: string, assertActive: () => void,
  run: { syncOptions: SyncCursorOptions; repoPath?: string; screen?: SyncScreenRun | null; observedAt?: string }): Promise<Pending | Held> {
  assertActive();
  const entry = cursor.entries[cursor.index];
  const retry = { sourceId: cursor.sourceId, processingOptions: cursor.processingOptions, syncOptions: cursor.syncOptions ?? run.syncOptions, repoPath: run.repoPath };
  let slug = '__managed_sync_checkpoint__', pageId: number | null = null, revision: string | null = null;
  let content: string | null = null, rawHash: string | null = null;
  let lineEndingOnly = false, occupantRebound = false;
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
    const occupant = await alreadyImportedAtOrigin(engine, cursor, entry, originScope);
    assertActive();
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
    lineEndingOnly = bytes !== null && content !== null && bytes.equals(Buffer.from(bytes.toString('utf8'))) &&
      bytes.toString('utf8').replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n');
    slug = entry.slug!; pageId = occupant?.page.id ?? entry.pageId ?? null; revision = occupant ? occupant.revision : entry.revision ?? null;
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: cursor.sourceId, includeDeleted: true });
    assertActive();
    if (occupant && (content === null || !await sameContentAtOrigin(engine, cursor, entry, key, snapshot, content, rawHash, lineEndingOnly))) {
      throw syncRunRefusal('page_identity_changed', 'The imported origin no longer identifies exactly the accepted page.', retry,
        `Page ${slug} was imported from ${entry.path} by another run of source ${cursor.sourceId} with different content after this run enumerated it, so the run stopped before admitting it.`);
    }
    occupantRebound = occupant !== null;
    const moved = entry.renameFrom;
    const recorded = moved?.slug === slug ? moved.sourcePath : entry.sourcePath;
    const foreignOrigin = snapshot?.page.source_path != null && !sameSyncOrigin(snapshot.page.source_path, recorded, originScope, snapshot.page.slug);
    if ((snapshot?.page.id ?? null) !== pageId || (snapshot?.revision ?? null) !== revision || (entry.unownedDeletion ? !foreignOrigin : foreignOrigin)) {
      throw syncRunRefusal('revision_conflict', 'A page changed after this sync cursor was enumerated.', retry,
        `Page ${slug} in source ${cursor.sourceId} was edited, deleted or re-bound after this sync enumerated ${entry.path}, so the run stopped before admitting it.`);
    }
    if (moved && moved.slug !== slug) {
      const previous = await engine.readPageSnapshot(moved.slug, { sourceId: cursor.sourceId, includeDeleted: true });
      assertActive();
      if (previous?.page.id !== moved.pageId || previous.revision !== moved.revision || previous.page.deleted_at != null ||
          previous.page.source_path == null || !sameSyncOrigin(previous.page.source_path, moved.sourcePath, originScope, previous.page.slug)) {
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
  return { requestId: randomUUID(), slug, pageId, ...(occupantRebound ? { rebound: true as const } : {}), intent: { kind: !entry ? 'managed_sync_checkpoint' : entry.action === 'import' ? 'managed_sync_import' : 'managed_sync_delete',
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
      policyFingerprint: currentCompanyBrainSync(cursor.sourceId)!.policyFingerprint } } : {}) } };
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

/**
 * #5988 (E6): a cursor blocked by a failed content refusal converts in place with its stored
 * options: held when the screen holds the frozen entry, re-frozen under a new request when it
 * passes, but only once for the same bytes, so a refusal the screen misses stays blocked
 * without minting a receipt per run.
 */
async function convertBlockedCursor(engine: BrainEngine, blocked: Cursor, key: string, assertActive: () => void,
  run: Parameters<typeof freezeEntry>[4] & { observedAt?: string }): Promise<Cursor> {
  const previous = blocked.pending!;
  const failed = await getWriteRequest(engine, blocked.authority.writer.principal, previous.requestId);
  if (!failed || !['failed', 'conflict', 'cancelled'].includes(failed.state) || !isContentRefusal(failed.error_code, failed.error_message)) return blocked;
  const unfinished = await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) LIMIT 1", [blocked.sourceId]);
  assertActive();
  if (unfinished.length) return blocked;
  const base: Cursor = { ...blocked }; delete base.pending;
  const again = await freezeEntry(engine, base, key, assertActive, run);
  const converted = [...(blocked.convertedFromFailed ?? []), previous.requestId];
  const logged = (outcome: 'held' | 'refrozen') => (tx: BrainEngine) => recordSyncConversion(tx, blocked.sourceId, blocked.incarnation,
    { request_id: previous.requestId, path: previous.intent.path ?? null, slug: previous.slug, run_id: blocked.runId, outcome });
  if ('hold' in again) {
    return saveCursor(engine, key, blocked, advanceHeld(base, converted), false, assertActive,
      async tx => { await heldWrite(blocked, again.hold, run.observedAt!)(tx); await logged('held')(tx); });
  }
  if (previous.converted && again.intent.rawHash === previous.intent.rawHash && again.intent.content === previous.intent.content) return blocked;
  return saveCursor(engine, key, blocked, { ...blocked, convertedFromFailed: converted, pending: { ...again, converted: true } }, false, assertActive, logged('refrozen'));
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

/** #5522: the page now at the origin already holds exactly the content this entry would import (the preparer's own no-op verdict). */
async function sameContentAtOrigin(engine: BrainEngine, cursor: Cursor, entry: Cursor['entries'][number], key: string,
  snapshot: Awaited<ReturnType<BrainEngine['readPageSnapshot']>>, content: string, rawHash: string | null, lineEndingOnly: boolean): Promise<boolean> {
  if (!snapshot || snapshot.page.deleted_at != null) return false;
  const intent: SyncIntent = { kind: 'managed_sync_import', expected_revision: snapshot.revision, sourcePath: entry.sourcePath, path: entry.path, rawHash, content, lineEndingOnly,
    processingOptions: cursor.processingOptions, ownerEpoch: String(cursor.binding.owner_epoch), syncAuthority: cursor.authority,
    cursorKey: key, runId: cursor.runId, slugMode: cursor.slugMode, index: cursor.index, total: cursor.entries.length, from: cursor.from, target: cursor.target, working: entry.working ?? false };
  try {
    const prepared = await prepareManagedSyncMutation(engine, screeningRequest({ source_id: cursor.sourceId, source_incarnation: cursor.incarnation, slug: snapshot.page.slug,
      page_id: snapshot.page.id, worktree_id: cursor.binding.worktree_id, authority: cursor.authority.writer, intent }), { engine: engine.kind });
    return (prepared.contentUnchanged === true || prepared.noop === true) && !prepared.file && prepared.observedRevision === snapshot.revision;
  } catch {
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
}
interface BulkPass { settings: BulkSettings; perMemberMs: number | null;
  /** #5984 admit-ahead: when this pass last saw a foreground write queued on the worktree. */
  foregroundAt?: number }
/** While foreground writes are recent, nothing is admitted ahead, so a new foreground write waits behind at most the publishing group. */
const FOREGROUND_RECENT_MS = 60_000;
type FreezeAt = (base: Cursor) => (index: number) => Promise<Pending | null>;

/** #5984 bulk: freezes the followers of an eligible head and records them with it as the cursor's group. */
async function formGroup(engine: BrainEngine, head: Cursor, pending: Pending, key: string, bulk: BulkPass, config: GBrainConfig, freezeAt: FreezeAt,
  assertActive: () => void): Promise<Cursor> {
  const followers = await freezeFollowers(engine, head, config, nextGroupSize(bulk.settings, bulk.perMemberMs) - 1, freezeAt(head));
  if (!followers.length) return head;
  // Members name their group (the head's request ID), so a consumer can claim them together.
  const lane = laneRunOf(head, bulk);
  const members = [pending, ...followers].map(member => ({ ...member, intent: { ...member.intent, group: pending.requestId, ...(lane ? { lane } : {}) } }));
  return saveCursor(engine, key, head, { ...head, pending: members[0], group: members }, false, assertActive);
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
async function admitAhead(engine: BrainEngine, cursor: Cursor, key: string, bulk: BulkPass, config: GBrainConfig, freezeAt: FreezeAt,
  assertActive: () => void): Promise<Cursor> {
  if (!bulk.settings.enabled || !cursor.group?.length) return cursor;
  const lane = laneRunOf(cursor, bulk);
  // With lanes, twice the lane count stays admitted, so lanes never wait for the sync side to freeze the next group.
  const depth = lane ? 2 * Math.max(1, lanePolicy(cursor.binding.worktree_id)?.effective ?? 1) : 1;
  let current = cursor, foregroundChecked = false;
  for (let slot = 0; ; slot++) {
    const window = current.window ?? [];
    // A group admits only after the group before it: a failed admission ends this pass (it is retried on the next).
    if (slot < window.length) { if (!await admitWindowGroup(engine, current, key, slot)) break; continue; }
    if (window.length >= depth) break;
    const start = current.index + current.group!.length + window.reduce((sum, group) => sum + group.length, 0);
    if (start >= current.entries.length) break;
    if (!foregroundChecked) {
      foregroundChecked = true;
      const [foreground] = await engine.executeRaw(`SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid
        AND state IN ('queued','running','recovering') AND NOT(COALESCE(intent->>'kind','') LIKE 'managed_sync_%') LIMIT 1`, [current.binding.worktree_id]);
      if (foreground) bulk.foregroundAt = performance.now();
    }
    if (bulk.foregroundAt !== undefined && performance.now() - bulk.foregroundAt < FOREGROUND_RECENT_MS) break;
    const base: Cursor = { ...current, index: start - 1 };
    // A freeze refusal here is left for the single path to raise in order, after the publishing groups.
    const frozen = await freezeFollowers(engine, base, config, nextGroupSize(bulk.settings, bulk.perMemberMs), freezeAt(base)).catch(() => []);
    if (!frozen.length) break;
    const after = (window.at(-1) ?? current.group!).at(-1)!.requestId;
    const members = frozen.map(member => ({ ...member, intent: { ...member.intent, group: frozen[0]!.requestId, after, ...(lane ? { lane } : {}) } }));
    const saved = await saveCursor(engine, key, current, { ...current, window: [...window, members] }, false, assertActive);
    if (saved.window?.[window.length]?.[0]?.requestId !== members[0]!.requestId) return saved;
    current = saved;
    slot--;
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
  if (rows) startPersistenceConsumer(engine, loadConfig() ?? { engine: engine.kind }).wake();
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
  next.index = cursor.index + committed;
  if (committed) next.progress = stampProgress(cursor.progress, cursor.index, next.index, drainStartedAt);
  const stuck = members[committed];
  const stuckRow = stuck ? states.get(stuck.requestId) : undefined;
  const failed = !!stuck && !!stuckRow && isTerminalWriteState(stuckRow.state);
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
    return { ...synced, ...report, ...(!state.remote && cursor?.convertedFromFailed?.length ? { converted_from_failed: cursor.convertedFromFailed } : {}),
      ...(recovered ? { recovered_frontmatter: recovered } : {}) };
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
  const syncOptions: SyncCursorOptions = { full: opts.full ?? false, workingTree: opts.workingTree ?? false, srcSubpath: opts.srcSubpath ?? null,
    exclude: opts.exclude ?? [], includeHidden: opts.includeHidden ?? [], strategy: opts.strategy ?? null };
  const frozenRun: { syncOptions: SyncCursorOptions; repoPath?: string; screen?: SyncScreenRun | null; observedAt?: string } = { syncOptions, ...(opts.repoPath ? { repoPath: resolve(opts.repoPath) } : {}) };
  const runStartedAt = new Date().toISOString();
  const key = digest({ source: context.incarnation, principal: authority.writer.principal, authority, ...(company ? { company: { receiptId: company.receiptId, planDigest: company.plan.plan_digest } } : {}),
    options: syncOptions });
  let cursor: Cursor | null = null;
  let missingManifestCursor: CursorHeader | null = null;
  if (!company) Object.assign(state, { sourceId: context.sourceId, incarnation: context.incarnation, remote: authority.writer.remote, cursor: () => cursor });
  const dryRun = (value: Cursor, base: Cursor = value) => managedDryRun(engine, value, base, { company: !!company, processingOptions, syncOptions, repoPath: frozenRun.repoPath, remote: authority.writer.remote });
  let phase: ManagedSyncFailure['phase'] = 'resume';
  let discoveryTarget: string | null = null;
  const discoveryRun = randomUUID();
  const inheritedSignal = currentSourceFilesystemSignal();
  const signal = opts.signal && inheritedSignal ? AbortSignal.any([opts.signal, inheritedSignal]) : opts.signal ?? inheritedSignal;
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
    if (cursor && opts.retryFailed && !opts.dryRun && !company && !cursor.done) {
      const unfinished = await engine.executeRaw(`SELECT id FROM persistence_requests WHERE source_id=$1
        AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) LIMIT 1`, [cursor.sourceId]);
      assertActive();
      if (!unfinished.length) {
        const failed = cursor.pending ? await getWriteRequest(engine, cursor.authority.writer.principal, cursor.pending.requestId) : null;
        const recorded = await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=$1 AND completed_keys->0->>'run_id'=$2", [key, cursor.runId]);
        assertActive();
        if ((failed && ['failed', 'conflict', 'cancelled'].includes(failed.state)) || (recorded.length && (failed?.state === 'committed' || !failed))) {
          phase = 'discovery';
          discoveryTarget = syncGit(context.gitRoot, ['rev-parse', 'HEAD']).trim();
          const discovery = await discoverManagedSync(engine, opts, context);
          assertActive();
          cursor = await replaceCursor(engine, key, header(cursor), { ...discovery, authority, processingOptions, syncOptions, runId: discoveryRun, index: 0, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 } }, assertActive);
        }
      }
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
      const discovery = await discoverManagedSync(engine, opts, context);
      assertActive();
      const fresh: Cursor = { ...discovery, authority, processingOptions, syncOptions, runId: discoveryRun, index: 0, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 }, ...(company ? { companyReceiptId: company.receiptId } : {}) };
      if (opts.dryRun) return dryRun(fresh);
      if (!fresh.entries.length && fresh.from === fresh.target) {
        await clearManagedSyncFailureAfterSuccess(engine, key);
        assertActive();
        return result(fresh, 'up_to_date');
      }
      if (company) await company.protect([{ op: OP, fingerprint: key, kind: 'managed_cursor' }, { op: `${OP}-manifest`, fingerprint: fresh.runId, kind: 'manifest' }]);
      assertActive();
      cursor = await saveCursor(engine, key, null, fresh, false, assertActive);
      if (fresh.retryTaken?.length) await clearGitHoldRetryPaths(engine, fresh.sourceId, fresh.incarnation, fresh.retryTaken);
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
    frozenRun.screen = company ? null : await loadSyncScreenRun(engine, cursor.sourceId, cursor.processingOptions ?? processingOptions, authority.writer.remote);
    const observedAt = frozenRun.observedAt = cursor.discoveredAt ?? runStartedAt;
    if (frozenRun.screen && !opts.retryFailed && cursor.pending && !cursor.done) {
      phase = 'freeze';
      cursor = await convertBlockedCursor(engine, cursor, key, assertActive, frozenRun);
    }
    const config = loadConfig() ?? { engine: engine.kind };
    const analyzeEvery = await importAnalyzeEveryPages(engine);
    let batchStart = performance.now(), batchPages = 0, foregroundWaitStart = 0, foregroundBaseline = 0;
    let creditedPages = 0, creditStarted = 0, foregroundQueued = false;
    const sliceStarted = performance.now(), sliceFirstIndex = cursor.index, drainStartedAt = opts.drainStartedAt ?? Date.now();
    const bulk: BulkPass = { settings: opts.bulk && !company ? opts.bulk : { enabled: false, reason: null, size: 1, maxTxnMs: 0 }, perMemberMs: null };
    opts.onProgress?.({ phase: 'managed_sync.start', bankedFiles: cursor.index, total: cursor.entries.length });
    while (!cursor.done) {
      assertActive();
      if (!cursor.pending) {
        // A source remains fair in both directions: foreground gets service,
        // then sync earns one bounded batch even if new interactive work keeps arriving.
        if (creditedPages && performance.now() - creditStarted >= 250) creditedPages = 0;
        const [foreground] = await engine.executeRaw(`SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid
          AND state IN ('queued','running','recovering') AND NOT(COALESCE(intent->>'kind','') LIKE 'managed_sync_%') LIMIT 1`, [cursor.binding.worktree_id]);
        assertActive();
        if ((foregroundQueued = Boolean(foreground))) bulk.foregroundAt = performance.now();
        if (foreground && creditedPages === 0) {
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
          cursor = await saveCursor(engine, key, cursor, advanceHeld(cursor), false, assertActive, heldWrite(cursor, frozen.hold, observedAt));
          opts.onProgress?.({ phase: 'managed_sync.page_committed', bankedFiles: cursor.index }); assertActive();
          if (slice && (cursor.index - sliceFirstIndex >= slice.maxPages || performance.now() - sliceStarted >= slice.maxMs)) return result(cursor, 'partial', 'writer_yield');
          continue;
        }
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
          holdClear(screened, pending.intent.path, observedAt)), tx => currentCursor(tx, key, screened));
      if (waived) {
        cursor = waived;
        opts.onProgress?.({ phase: 'managed_sync.page_committed', bankedFiles: cursor.index, total: cursor.entries.length, waived: true });
        assertActive();
        // A skipped entry still counts toward the caller's slice, so a sliced run yields at the same positions.
        if (slice && (cursor.index - sliceFirstIndex >= slice.maxPages || performance.now() - sliceStarted >= slice.maxMs)) return result(cursor, 'partial', 'writer_yield');
        continue;
      }
      const freezeAt: FreezeAt = base => async index => { const frozen = await freezeEntry(engine, { ...base, index }, key, assertActive, frozenRun); return 'hold' in frozen ? null : frozen; };
      if (bulk.settings.enabled && !foregroundQueued && !prior && !cursor.group && !pending.rebound && groupableIntent(pending.intent)) cursor = await formGroup(engine, cursor, pending, key, bulk, config, freezeAt, assertActive);
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
        // ENG-A7: after the counter locks (the publication lock order), admit only while the cursor still holds this entry.
        const [held] = await tx.executeRaw<{ request_id: string | null }>(`SELECT completed_keys->0->'pending'->>'requestId' AS request_id
          FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 FOR SHARE`, [OP, key]);
        if (held?.request_id !== pending.requestId) throw new CursorMoved();
        assertActive();
        return accepted;
      })).catch(error => { if (error instanceof CursorMoved) return null; throw error; });
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
        const { failure, ledgerRecorded } = await recordManagedSyncFailure(engine, { source_id: cursor.sourceId, source_incarnation: cursor.incarnation, path: pending.intent.path ?? '<checkpoint>',
          code: done.error_code ?? (done.state === 'cancelled' ? 'cancelled' : 'storage_error'), message: done.error_message ?? 'The accepted sync request did not commit.',
        request_id: pending.requestId, run_id: cursor.runId, target: cursor.target, cursor_key: key,
        phase: pending.intent.kind === 'managed_sync_checkpoint' ? 'checkpoint' : 'receipt', state: done.state, observation_id: pending.requestId,
        first_seen: new Date(done.completed_at ?? done.updated_at).toISOString() });
        // #5762: the hint is built after the failed transaction, from a fresh read of the request indexes.
        const hint = done.error_code === CHECKPOINT_VALIDATION_TIMEOUT && !authority.writer.remote ? await checkpointTimeoutHint(engine,
          { requestId: pending.requestId, sourceId: cursor.sourceId, processingOptions: pending.intent.processingOptions, syncOptions: pending.intent.syncOptions ?? syncOptions, repoPath: pending.intent.repoPath ?? frozenRun.repoPath }) : null;
        return { ...result(cursor, 'blocked_by_failures'), failedFiles: 1,
          failureCodes: [{ code: failure.code, count: 1 }], ...(authority.writer.remote ? {} : { failures: [failure],
            managedWrite: { ...writeDiagnostic(cursor, pending, done), ...hint, ledger_recorded: ledgerRecorded } }) };
      }
      if (pending.intent.kind === 'managed_sync_checkpoint') {
        cursor = (await readCursor(engine, key))!;
        if (!cursor?.done) throw syncRunRefusal('storage_error', 'Committed sync checkpoint lost its cursor.',
          { sourceId: context.sourceId, processingOptions: pending.intent.processingOptions, syncOptions: pending.intent.syncOptions ?? syncOptions, repoPath: pending.intent.repoPath ?? frozenRun.repoPath },
          `The final checkpoint request ${pending.requestId} of this sync committed, but its cursor could not be read back to finish the run.`);
        await clearManagedSyncFailureAfterSuccess(engine, key);
        if (cursor.counts.added + cursor.counts.modified + cursor.counts.deleted > 0) await refreshProjectionStatistics(engine);
        assertActive();
        return withLinks(cursor, result(cursor, cursor.from === null ? 'first_sync' : 'synced'));
      }
      // The frozen manifest is shared; only the cursor header changes per page.
      const next: Cursor = { ...cursor, index: cursor.index + 1, counts: { ...cursor.counts }, progress: stampProgress(cursor.progress, cursor.index, cursor.index + 1, drainStartedAt) }; delete next.pending; delete next.group;
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
      // A refresh fence is transient admission back-pressure, not a sync failure to record.
      if (!['permission_denied', 'worktree_refreshing', 'refresh_recovery_required'].includes(code)) {
        const [stored] = cursor ? [] : await engine.executeRaw<{ completed_keys: [CursorHeader] }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [OP, key]);
        const failedCursor = cursor ?? stored?.completed_keys?.[0];
        const { failure } = await recordManagedSyncFailure(engine, { source_id: context.sourceId, source_incarnation: context.incarnation, path: cursor?.entries[cursor.index]?.path ?? failedCursor?.pending?.intent.path ?? `<${phase}>`, code,
          message: error instanceof Error ? error.message : String(error), request_id: failedCursor?.pending?.requestId ?? null,
          run_id: failedCursor?.runId ?? discoveryRun, target: failedCursor?.target ?? discoveryTarget, cursor_key: key, phase, state: 'failed',
          observation_id: failedCursor ? `${failedCursor.runId}:${failedCursor.index}:${phase}:${code}` : `${key}:discovery:${discoveryTarget}:${code}` });
        if (error instanceof Error) error.message = authority.writer.remote ? 'Managed sync is blocked; ask the host operator to inspect doctor.' : formatManagedSyncFailure(failure) + ' Fix the cause, then run gbrain sync --no-pull --retry-failed with the same source and options.';
      }
    }
    throw error;
  }
}
