import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { loadConfig } from '../config.ts';
import { OperationError } from '../ops/contract.ts';
import { currentSourceFilesystemSignal } from '../minions/source-filesystem.ts';
import { throwIfAborted } from '../abort-check.ts';
import { digest, sha256 } from './digest.ts';
import { getWriteRequest, admitWriteInTransaction, receiptFor } from './journal.ts';
import { retryWriteAdmission } from './admission-retry.ts';
import { assertPersistenceAccepting, foregroundWriteCompletions, startPersistenceConsumer, waitForWrite } from './service.ts';
import { assertSyncEntryOrigin, discoverManagedSync, resolveManagedSyncContext, readSyncContent, readSyncFile, syncGit, type SyncDiscovery } from './sync-discovery.ts';
import { assertSyncPageOrigin, sameSyncOrigin, syncOriginScope } from './sync-origin.ts';
import { assertManagedSyncActive, assertSyncDispatchActive, managedSyncAuthority, validateSyncAuthority, validateManagedSyncOptions, syncProcessingOptions, SYNC_PROCESSING_KEYS, type SyncAuthority, type SyncProcessingOptions } from './sync-authority.ts';
import { prepareManagedSyncMutation, type SyncCursorOptions, type SyncIntent } from './sync-prepare.ts';
import { inspectUnchanged, screeningRequest, type NoopKernelWaiver } from './noop-kernel.ts';
import type { GBrainConfig } from '../config.ts';
import { join, resolve } from 'node:path';
import { currentCompanyBrainSync, getCompanyBrainProfile, readCompanyBrainPlan } from '../company-brain/profile.ts';
import { readCommittedBlob } from '../company-brain/revision.ts';
import { refreshProjectionStatistics } from '../search/projection-statistics.ts';
import { recordManagedSyncFailure, clearManagedSyncFailureAfterSuccess, formatManagedSyncFailure, type ManagedSyncFailure } from './sync-failures.ts';
import { writeFailureDiagnostic } from './verb-errors.ts';
import { extractManagedStaleLinks } from './links-maintenance.ts';
import { CHECKPOINT_VALIDATION_TIMEOUT, checkpointTimeoutHint } from './checkpoint-validation.ts';
import { isTerminalWriteState, publicWriteReceipt, type WriteReceipt } from './types.ts';
import type { WriteRequest } from './model.ts';

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

interface Pending { requestId: string; slug: string; pageId: number | null; intent: SyncIntent; rebound?: true; }
interface Cursor extends SyncDiscovery { runId: string; index: number; authority: SyncAuthority; pending?: Pending; done?: boolean; companyReceiptId?: string;
  processingOptions?: SyncProcessingOptions; syncOptions?: SyncCursorOptions; overtaken?: true;
  counts: { added: number; modified: number; deleted: number; chunks: number; renamed?: number;
    /** #5751: unchanged working-tree files skipped only because a no-op publication could never resolve their admit reason. */
    skippedContextualMode?: number; skippedCanonicalBytes?: number }; }
const OP = 'managed-sync';
type CursorHeader = Omit<Cursor, 'entries' | 'companyPlan'> & { total: number };
const header = ({ entries, companyPlan: _plan, ...value }: Cursor): CursorHeader => ({ ...value, total: entries.length });
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
async function saveCursor(engine: BrainEngine, key: string, before: Cursor | null, next: Cursor, requireIdle = false, assertActive?: () => void): Promise<Cursor> {
  return engine.transaction(async tx => {
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
    if (before === null) {
      await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb) ON CONFLICT DO NOTHING`, [`${OP}-manifest`, next.runId, JSON.stringify(next.entries)]);
      await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb) ON CONFLICT DO NOTHING`, [OP, key, JSON.stringify([header(next)])]);
    } else {
      await tx.executeRaw(`UPDATE op_checkpoints SET completed_keys=$4::text::jsonb,updated_at=now()
        WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb`, [OP, key, JSON.stringify([header(before)]), JSON.stringify([header(next)])]);
      await tx.executeRaw('UPDATE op_checkpoints SET updated_at=now() WHERE op=$1 AND fingerprint=$2', [`${OP}-manifest`, next.runId]);
    }
    const current = await readCursor(tx, key, next);
    if (!current) throw new OperationError('storage_error', 'The durable sync cursor disappeared.');
    assertActive?.();
    return current;
  });
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
    filesImported: cursor.index, bankedFiles: cursor.index, ...(cursor.uncommitted ? { uncommitted: cursor.uncommitted } : {}), ...(reason ? { reason } : {}),
    ...(cursor.counts.skippedContextualMode || cursor.counts.skippedCanonicalBytes ? { legacySkips: {
      contextualMode: cursor.counts.skippedContextualMode ?? 0, canonicalBytes: cursor.counts.skippedCanonicalBytes ?? 0 } } : {}) };
}
function writeDiagnostic(cursor: Cursor, pending: Pending, row: WriteRequest): ManagedSyncWriteDiagnostic {
  const terminal = isTerminalWriteState(row.state);
  const code = terminal ? row.error_code ?? (row.state === 'cancelled' ? 'cancelled' : 'storage_error') : 'write_pending';
  const blockedReason = ['writer_busy', 'writer_pool_capacity', 'owner_unavailable', 'recovery_required', 'writer_lock_unavailable',
    'database_contention', 'consumer_stopping', 'revision_changed_repreparing'].includes(row.blocked_reason ?? '') ? row.blocked_reason! : 'write_pending';
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
  run: { syncOptions: SyncCursorOptions; repoPath?: string }): Promise<Pending> {
  assertActive();
  const entry = cursor.entries[cursor.index];
  let slug = '__managed_sync_checkpoint__', pageId: number | null = null, revision: string | null = null;
  let content: string | null = null, rawHash: string | null = null;
  let lineEndingOnly = false, occupantRebound = false;
  if (entry) {
    assertSyncEntryOrigin(cursor, entry);
    const originScope = syncOriginScope(cursor);
    // #5522: another cursor of this source may have imported this new file since enumeration.
    const occupant = await alreadyImportedAtOrigin(engine, cursor, entry, originScope);
    assertActive();
    const bytes = readSyncFile(cursor.root, entry.path);
    rawHash = bytes === null ? null : sha256(bytes);
    if (entry.action === 'import' && cursor.companyPlan) {
      const company = currentCompanyBrainSync(cursor.sourceId);
      const blob = company?.entries.get(entry.path);
      if (company?.receiptId !== cursor.companyReceiptId || !blob || blob.disposition !== 'included') throw new OperationError('plan_stale', 'The durable cursor does not match its approved content manifest.');
      content = (await readCommittedBlob(cursor.companyPlan.revision!, blob, cursor.companyPlan.limits)).toString('utf8');
      assertActive();
    } else content = entry.action === 'import' ? readSyncContent(cursor, entry) : null;
    lineEndingOnly = bytes !== null && content !== null && bytes.equals(Buffer.from(bytes.toString('utf8'))) &&
      bytes.toString('utf8').replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n');
    slug = entry.slug!; pageId = occupant?.page.id ?? entry.pageId ?? null; revision = occupant ? occupant.revision : entry.revision ?? null;
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: cursor.sourceId, includeDeleted: true });
    assertActive();
    if (occupant && !await sameContentAtOrigin(engine, cursor, entry, key, snapshot, content!, rawHash, lineEndingOnly)) {
      throw new OperationError('page_identity_changed', 'The imported origin no longer identifies exactly the accepted page.');
    }
    occupantRebound = occupant !== null;
    const moved = entry.renameFrom;
    const recorded = moved?.slug === slug ? moved.sourcePath : entry.sourcePath;
    if ((snapshot?.page.id ?? null) !== pageId || (snapshot?.revision ?? null) !== revision ||
        (snapshot?.page.source_path != null && !sameSyncOrigin(snapshot.page.source_path, recorded, originScope, snapshot.page.slug))) {
      throw new OperationError('revision_conflict', 'A page changed after this sync cursor was enumerated.');
    }
    if (moved && moved.slug !== slug) {
      const previous = await engine.readPageSnapshot(moved.slug, { sourceId: cursor.sourceId, includeDeleted: true });
      assertActive();
      if (previous?.page.id !== moved.pageId || previous.revision !== moved.revision || previous.page.deleted_at != null ||
          previous.page.source_path == null || !sameSyncOrigin(previous.page.source_path, moved.sourcePath, originScope, previous.page.slug)) {
        throw new OperationError('revision_conflict', 'A renamed page changed after this sync cursor was enumerated.');
      }
    }
  }
  await validateSyncAuthority(engine, cursor.authority, slug);
  assertActive();
  return { requestId: randomUUID(), slug, pageId, ...(occupantRebound ? { rebound: true as const } : {}), intent: { kind: !entry ? 'managed_sync_checkpoint' : entry.action === 'import' ? 'managed_sync_import' : 'managed_sync_delete',
    expected_revision: revision, sourcePath: entry?.sourcePath ?? null, path: entry?.path ?? null, rawHash, content, lineEndingOnly,
    ...(entry?.renameFrom ? { renameFrom: entry.renameFrom } : {}),
    processingOptions: cursor.processingOptions,
    // A cursor created before its options were recorded has the same key, so this run's options are its options.
    ...(!entry ? { syncOptions: cursor.syncOptions ?? run.syncOptions, ...(run.repoPath ? { repoPath: run.repoPath } : {}) } : {}),
    ...(!entry && cursor.overtaken ? { overtaken: true } : {}),
    ownerEpoch: String(cursor.binding.owner_epoch), syncAuthority: cursor.authority, cursorKey: key, runId: cursor.runId,
    slugMode: cursor.slugMode, index: cursor.index, total: cursor.entries.length, from: cursor.from, target: cursor.target, working: entry?.working ?? false,
    ...(cursor.companyPlan ? { companyApproval: { schema: cursor.companyPlan.schema!, planDigest: cursor.companyPlan.plan_digest, extractorVersion: cursor.companyPlan.extractor_version,
      policyFingerprint: currentCompanyBrainSync(cursor.sourceId)!.policyFingerprint } } : {}) } };
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
    await assertSyncPageOrigin(engine, cursor.sourceId, entry.sourcePath, entry.pageId ?? null, entry.action === 'delete', originScope);
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

/** One immutable page is admitted at a time; foreground writes can never sit behind a whole scan. */
export async function performManagedSync(engine: BrainEngine, opts: SyncOpts, slice?: { maxPages: number; maxMs: number }): Promise<SyncResult> {
  await assertManagedSyncActive(engine);
  if (opts.sourceId && !currentCompanyBrainSync(opts.sourceId) && await getCompanyBrainProfile(engine, opts.sourceId)) {
    return (await import('../company-brain/runtime.ts')).performCompanyBrainSync(engine, opts);
  }
  assertPersistenceAccepting(engine);
  validateManagedSyncOptions(opts);
  const context = await resolveManagedSyncContext(engine, opts);
  const authority = await managedSyncAuthority(engine, context.sourceId, context.incarnation, opts.repoPath ?? context.root);
  const company = currentCompanyBrainSync(context.sourceId);
  const processingOptions = syncProcessingOptions(opts);
  const syncOptions: SyncCursorOptions = { full: opts.full ?? false, workingTree: opts.workingTree ?? false, srcSubpath: opts.srcSubpath ?? null,
    exclude: opts.exclude ?? [], includeHidden: opts.includeHidden ?? [], strategy: opts.strategy ?? null };
  const frozenRun = { syncOptions, ...(opts.repoPath ? { repoPath: resolve(opts.repoPath) } : {}) };
  const key = digest({ source: context.incarnation, principal: authority.writer.principal, authority, ...(company ? { company: { receiptId: company.receiptId, planDigest: company.plan.plan_digest } } : {}),
    options: syncOptions });
  let cursor: Cursor | null = null;
  let missingManifestCursor: CursorHeader | null = null;
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
    try { return { ...synced, links: await extractManagedStaleLinks(engine, { sourceId: done.sourceId, maxPages: 1000, signal,
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
          throw new OperationError('invalid_params', 'The approved company sync must retain its original processing options.');
        }
        phase = 'freeze';
        const retry = { ...cursor, processingOptions };
        cursor = await saveCursor(engine, key, cursor, { ...retry, pending: await freezeEntry(engine, retry, key, assertActive, frozenRun) }, true, assertActive);
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
        if ((failed && ['failed', 'conflict', 'cancelled'].includes(failed.state)) || (!failed && recorded.length)) {
          phase = 'discovery';
          discoveryTarget = syncGit(context.gitRoot, ['rev-parse', 'HEAD']).trim();
          const discovery = await discoverManagedSync(engine, opts, context);
          assertActive();
          cursor = await replaceCursor(engine, key, header(cursor), { ...discovery, authority, processingOptions, syncOptions, runId: discoveryRun, index: 0, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 } }, assertActive);
        }
      }
    }
    assertActive();
    if (cursor?.done && opts.dryRun) return result(cursor, 'dry_run');
    if (cursor?.done && company) {
      await clearManagedSyncFailureAfterSuccess(engine, key);
      assertActive();
      return result(cursor, cursor.from === null ? 'first_sync' : 'synced');
    }
    if (cursor?.done) {
      const completed = cursor;
      await engine.transaction(async tx => {
        assertActive();
        await tx.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb', [OP, key, JSON.stringify([header(completed)])]);
        assertActive();
      });
      assertActive();
      await clearManagedSyncFailureAfterSuccess(engine, key);
      cursor = await readCursor(engine, key);
    }
    if (!cursor) {
      assertActive();
      phase = 'discovery';
      discoveryTarget = company?.plan.revision?.commit ?? syncGit(context.gitRoot, ['rev-parse', 'HEAD']).trim();
      const discovery = await discoverManagedSync(engine, opts, context);
      assertActive();
      const fresh: Cursor = { ...discovery, authority, processingOptions, syncOptions, runId: discoveryRun, index: 0, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 }, ...(company ? { companyReceiptId: company.receiptId } : {}) };
      if (opts.dryRun) return result(fresh, 'dry_run');
      if (!fresh.entries.length && fresh.from === fresh.target) {
        await clearManagedSyncFailureAfterSuccess(engine, key);
        assertActive();
        return result(fresh, 'up_to_date');
      }
      if (company) await company.protect([{ op: OP, fingerprint: key, kind: 'managed_cursor' }, { op: `${OP}-manifest`, fingerprint: fresh.runId, kind: 'manifest' }]);
      assertActive();
      cursor = await saveCursor(engine, key, null, fresh, false, assertActive);
    }
    assertActive();
    if (cursor.incarnation !== context.incarnation || cursor.binding.worktree_id !== context.binding.worktree_id ||
        String(cursor.binding.topology_generation) !== String(context.binding.topology_generation) ||
        String(cursor.binding.owner_epoch) !== String(context.binding.owner_epoch) || cursor.root !== context.root) {
      throw new OperationError('source_changed', 'The unfinished sync cursor belongs to an older source binding.');
    }
    const stored = cursor.processingOptions;
    if (stored ? digest(stored) !== digest(processingOptions) : !cursor.pending) {
      // An unattended or flagless resume adopts the cursor's options; freezeEntry reads them from the cursor.
      const explicit = opts.explicitProcessing ?? SYNC_PROCESSING_KEYS;
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
    if (opts.dryRun) return result(cursor, 'dry_run');
    const config = loadConfig() ?? { engine: engine.kind };
    let batchStart = performance.now(), batchPages = 0, foregroundWaitStart = 0, foregroundBaseline = 0;
    let creditedPages = 0, creditStarted = 0;
    const sliceStarted = performance.now(), sliceFirstIndex = cursor.index;
    while (!cursor.done) {
      assertActive();
      if (!cursor.pending) {
        // A source remains fair in both directions: foreground gets service,
        // then sync earns one bounded batch even if new interactive work keeps arriving.
        if (creditedPages && performance.now() - creditStarted >= 250) creditedPages = 0;
        const [foreground] = await engine.executeRaw(`SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid
          AND state IN ('queued','running','recovering') AND NOT(COALESCE(intent->>'kind','') LIKE 'managed_sync_%') LIMIT 1`, [cursor.binding.worktree_id]);
        assertActive();
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
        cursor = await saveCursor(engine, key, cursor, { ...cursor, ...(frozen.rebound ? { overtaken: true as const } : {}), pending: frozen }, false, assertActive);
      }
      if (!cursor.pending) continue; // another owner-loop advanced the cursor
      const pending = cursor.pending;
      phase = 'admission';
      const prior = await getWriteRequest(engine, cursor.authority.writer.principal, pending.requestId);
      assertActive();
      // #5470: a frozen import whose publication would change nothing advances the cursor without an admission.
      const waived = prior ? null : await unchangedSyncImport(engine, cursor, pending, config);
      if (waived) {
        const skipped: Cursor = { ...cursor, index: cursor.index + 1, counts: { ...cursor.counts } }; delete skipped.pending;
        if (waived.includes('contextual_mode')) skipped.counts.skippedContextualMode = (skipped.counts.skippedContextualMode ?? 0) + 1;
        if (waived.includes('canonical_file_differs')) skipped.counts.skippedCanonicalBytes = (skipped.counts.skippedCanonicalBytes ?? 0) + 1;
        cursor = await saveCursor(engine, key, cursor, skipped);
        opts.onProgress?.({ phase: 'managed_sync.page_committed', bankedFiles: cursor.index });
        assertActive();
        // A skipped entry still counts toward the caller's slice, so a sliced run yields at the same positions.
        if (slice && (cursor.index - sliceFirstIndex >= slice.maxPages || performance.now() - sliceStarted >= slice.maxMs)) return result(cursor, 'partial', 'writer_yield');
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
        assertActive();
        return accepted;
      }));
      await validateSyncAuthority(engine, cursor.authority, pending.slug);
      assertSyncDispatchActive();
      // #5762: a checkpoint's validation runs under the coordinator's 5 s statement timeout, so its wait outlasts that
      // budget; a timed-out checkpoint then reports its terminal refusal and hint in this run instead of the next.
      const done = await waitForWrite(engine, row, config, pending.intent.kind === 'managed_sync_checkpoint' ? 8000 : 5000);
      assertSyncDispatchActive();
      if (!isTerminalWriteState(done.state)) {
        return { ...result(cursor, 'partial', signal?.aborted ? 'timeout' : 'writer_pending'),
          ...(authority.writer.remote ? {} : { managedWrite: writeDiagnostic(cursor, pending, done) }) };
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
        if (!cursor?.done) throw new OperationError('storage_error', 'Committed sync checkpoint lost its cursor.');
        await clearManagedSyncFailureAfterSuccess(engine, key);
        if (cursor.counts.added + cursor.counts.modified + cursor.counts.deleted > 0) await refreshProjectionStatistics(engine);
        assertActive();
        return withLinks(cursor, result(cursor, cursor.from === null ? 'first_sync' : 'synced'));
      }
      // The frozen manifest is shared; only the cursor header changes per page.
      const next: Cursor = { ...cursor, index: cursor.index + 1, counts: { ...cursor.counts } }; delete next.pending;
      if (done.outcome?.noop !== true) {
        if (pending.intent.kind === 'managed_sync_delete') next.counts.deleted++;
        else if (pending.intent.renameFrom) next.counts.renamed = (next.counts.renamed ?? 0) + 1;
        else if (pending.pageId === null) next.counts.added++; else next.counts.modified++;
      }
      next.counts.chunks += Number(done.outcome?.chunks ?? 0);
      cursor = await saveCursor(engine, key, cursor, next);
      opts.onProgress?.({ phase: 'managed_sync.page_committed', bankedFiles: cursor.index });
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
      if (code !== 'permission_denied') {
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

/**
 * #5470 no-op screen for working-tree and company-profile sync: runs the sync
 * preparer on the frozen, unadmitted entry. A rename or a canonical overlay is
 * always admitted. Returns null to admit, or the kernel waivers the skip used.
 * #5751: a managed working-tree entry waives the two admit reasons its no-op
 * publication can never resolve (a pending contextual-mode stamp, and file
 * bytes that differ from the prepared content yet parse to the same page), so
 * an unchanged legacy file stops taking a request ID on every run.
 */
async function unchangedSyncImport(engine: BrainEngine, cursor: Cursor, pending: Pending, config: GBrainConfig): Promise<NoopKernelWaiver[] | null> {
  const intent = pending.intent;
  if (intent.kind !== 'managed_sync_import' || intent.renameFrom || pending.pageId === null || typeof intent.path !== 'string' || typeof intent.content !== 'string') return null;
  try {
    const snapshot = await engine.readPageSnapshot(pending.slug, { sourceId: cursor.sourceId, includeDeleted: true });
    const row = screeningRequest({ source_id: cursor.sourceId, source_incarnation: cursor.incarnation, slug: pending.slug, page_id: pending.pageId,
      worktree_id: cursor.binding.worktree_id, authority: cursor.authority.writer, intent, request_id: pending.requestId });
    const prepared = await prepareManagedSyncMutation(engine, row, config);
    if (prepared.file || prepared.target === 'skill_bundle') return null;
    const file = { root: cursor.root, path: join(cursor.root, intent.path), content: intent.content };
    const inspected = await inspectUnchanged(engine, { prepared: { ...prepared, target: 'page', file }, snapshot, sourcePath: intent.sourcePath, databaseOnly: false,
      embeddingRequested: !prepared.deferEmbedding && !config.embedding_disabled && !!config.embedding_model?.trim(),
      waive: intent.working === true ? ['contextual_mode', 'canonical_file_differs'] : undefined });
    if (inspected.admitReason) return null;
    await prepared.validate?.(engine);
    return inspected.waived ?? [];
  } catch {
    return null;
  }
}
