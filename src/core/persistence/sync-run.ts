import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { loadConfig } from '../config.ts';
import { OperationError } from '../ops/contract.ts';
import { currentJobSignal } from '../minions/submission-authority.ts';
import { digest, sha256 } from './digest.ts';
import { getWriteRequest, admitWrite, receiptFor } from './journal.ts';
import { assertPersistenceAccepting, foregroundWriteCompletions, startPersistenceConsumer, waitForWrite } from './service.ts';
import { discoverManagedSync, resolveManagedSyncContext, readSyncContent, readSyncFile, syncGit, type SyncDiscovery } from './sync-discovery.ts';
import { managedSyncAuthority, validateSyncAuthority, validateManagedSyncOptions, type SyncAuthority } from './sync-authority.ts';
import type { SyncIntent } from './sync-prepare.ts';
import { currentCompanyBrainSync, getCompanyBrainProfile, readCompanyBrainPlan } from '../company-brain/profile.ts';
import { readCommittedBlob } from '../company-brain/revision.ts';
import { refreshProjectionStatistics } from '../search/projection-statistics.ts';
import { recordManagedSyncFailure, clearManagedSyncFailureAfterSuccess, formatManagedSyncFailure, type ManagedSyncFailure } from './sync-failures.ts';
import { writeFailureDiagnostic } from './verb-errors.ts';
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
}

interface Pending { requestId: string; slug: string; pageId: number | null; intent: SyncIntent; }
interface Cursor extends SyncDiscovery { runId: string; index: number; authority: SyncAuthority; pending?: Pending; done?: boolean; companyReceiptId?: string;
  counts: { added: number; modified: number; deleted: number; chunks: number }; }
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
async function saveCursor(engine: BrainEngine, key: string, before: Cursor | null, next: Cursor, requireIdle = false): Promise<Cursor> {
  return engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
    if (requireIdle) {
      await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR UPDATE', [next.binding.worktree_id]);
      const active = await tx.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) LIMIT 1", [next.sourceId]);
      if (active.length) return (await readCursor(tx, key, before ?? undefined))!;
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
    return current;
  });
}
async function replaceCursor(engine: BrainEngine, key: string, before: CursorHeader, next: Cursor): Promise<Cursor> {
  return engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
    await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR UPDATE', [next.binding.worktree_id]);
    const active = await tx.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) LIMIT 1", [next.sourceId]);
    if (active.length) return (await readCursor(tx, key))!;
    await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)`, [`${OP}-manifest`, next.runId, JSON.stringify(next.entries)]);
    await tx.executeRaw('UPDATE op_checkpoints SET completed_keys=$4::text::jsonb,updated_at=now() WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb',
      [OP, key, JSON.stringify([before]), JSON.stringify([header(next)])]);
    return (await readCursor(tx, key, next))!;
  });
}
function result(cursor: Cursor, status: SyncResult['status'], reason?: SyncResult['reason']): SyncResult {
  return { status, ...(cursor.authority.writer.remote ? {} : { runId: cursor.runId }), fromCommit: cursor.authority.writer.remote ? null : cursor.from,
    toCommit: cursor.authority.writer.remote ? '' : cursor.target, added: cursor.counts.added, modified: cursor.counts.modified,
    deleted: cursor.counts.deleted, renamed: 0, chunksCreated: cursor.counts.chunks, embedded: 0, pagesAffected: [],
    filesImported: cursor.index, bankedFiles: cursor.index, ...(cursor.uncommitted ? { uncommitted: cursor.uncommitted } : {}), ...(reason ? { reason } : {}) };
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
async function freezeEntry(engine: BrainEngine, cursor: Cursor, key: string): Promise<Pending> {
  const entry = cursor.entries[cursor.index];
  let slug = '__managed_sync_checkpoint__', pageId: number | null = null, revision: string | null = null;
  let content: string | null = null, rawHash: string | null = null;
  let lineEndingOnly = false;
  if (entry) {
    const bytes = readSyncFile(cursor.root, entry.path);
    rawHash = bytes === null ? null : sha256(bytes);
    if (entry.action === 'import' && cursor.companyPlan) {
      const company = currentCompanyBrainSync(cursor.sourceId);
      const blob = company?.entries.get(entry.path);
      if (company?.receiptId !== cursor.companyReceiptId || !blob || blob.disposition !== 'included') throw new OperationError('plan_stale', 'The durable cursor does not match its approved content manifest.');
      content = (await readCommittedBlob(cursor.companyPlan.revision!, blob, cursor.companyPlan.limits)).toString('utf8');
    } else content = entry.action === 'import' ? readSyncContent(cursor, entry) : null;
    lineEndingOnly = bytes !== null && content !== null && bytes.equals(Buffer.from(bytes.toString('utf8'))) &&
      bytes.toString('utf8').replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n');
    slug = entry.slug!; pageId = entry.pageId ?? null; revision = entry.revision ?? null;
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: cursor.sourceId, includeDeleted: true });
    if ((snapshot?.page.id ?? null) !== pageId || (snapshot?.revision ?? null) !== revision ||
        (snapshot?.page.source_path != null && snapshot.page.source_path !== entry.sourcePath)) {
      throw new OperationError('revision_conflict', 'A page changed after this sync cursor was enumerated.');
    }
  }
  await validateSyncAuthority(engine, cursor.authority, slug);
  return { requestId: randomUUID(), slug, pageId, intent: { kind: !entry ? 'managed_sync_checkpoint' : entry.action === 'import' ? 'managed_sync_import' : 'managed_sync_delete',
    expected_revision: revision, sourcePath: entry?.sourcePath ?? null, path: entry?.path ?? null, rawHash, content, lineEndingOnly,
    ownerEpoch: String(cursor.binding.owner_epoch), syncAuthority: cursor.authority, cursorKey: key, runId: cursor.runId,
    slugMode: cursor.slugMode, index: cursor.index, total: cursor.entries.length, from: cursor.from, target: cursor.target,
    ...(cursor.companyPlan ? { companyApproval: { schema: cursor.companyPlan.schema!, planDigest: cursor.companyPlan.plan_digest, extractorVersion: cursor.companyPlan.extractor_version,
      policyFingerprint: currentCompanyBrainSync(cursor.sourceId)!.policyFingerprint } } : {}) } };
}

/** One immutable page is admitted at a time; foreground writes can never sit behind a whole scan. */
export async function performManagedSync(engine: BrainEngine, opts: SyncOpts, slice?: { maxPages: number; maxMs: number }): Promise<SyncResult> {
  if (opts.sourceId && !currentCompanyBrainSync(opts.sourceId) && await getCompanyBrainProfile(engine, opts.sourceId)) {
    return (await import('../company-brain/runtime.ts')).performCompanyBrainSync(engine, opts);
  }
  assertPersistenceAccepting(engine);
  validateManagedSyncOptions(opts);
  const context = await resolveManagedSyncContext(engine, opts);
  const authority = await managedSyncAuthority(engine, context.sourceId, context.incarnation, context.root);
  const company = currentCompanyBrainSync(context.sourceId);
  const key = digest({ source: context.incarnation, principal: authority.writer.principal, authority, ...(company ? { company: { receiptId: company.receiptId, planDigest: company.plan.plan_digest } } : {}),
    options: { full: opts.full ?? false, workingTree: opts.workingTree ?? false, srcSubpath: opts.srcSubpath ?? null,
      exclude: opts.exclude ?? [], includeHidden: opts.includeHidden ?? [], strategy: opts.strategy ?? null } });
  let cursor: Cursor | null = null;
  let phase: ManagedSyncFailure['phase'] = 'resume';
  let discoveryTarget: string | null = null;
  const discoveryRun = randomUUID();
  try {
    try { cursor = await readCursor(engine, key); }
    catch (error) {
      if (!(error instanceof MissingSyncManifest) || !opts.retryFailed || opts.dryRun || company) throw error;
      phase = 'discovery';
      discoveryTarget = syncGit(context.gitRoot, ['rev-parse', 'HEAD']).trim();
      const discovery = await discoverManagedSync(engine, opts, context);
      cursor = await replaceCursor(engine, key, error.cursor, { ...discovery, authority, runId: discoveryRun, index: 0, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 } });
    }
    if (company && opts.retryFailed && cursor?.pending && !opts.dryRun) {
      const failed = await getWriteRequest(engine, cursor.authority.writer.principal, cursor.pending.requestId);
      const unfinished = await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) LIMIT 1", [cursor.sourceId]);
      if (!unfinished.length && failed && ['failed', 'conflict', 'cancelled'].includes(failed.state)) {
        phase = 'freeze';
        cursor = await saveCursor(engine, key, cursor, { ...cursor, pending: await freezeEntry(engine, cursor, key) }, true);
      }
    }
    if (cursor && opts.retryFailed && !opts.dryRun && !company && !cursor.done) {
      const unfinished = await engine.executeRaw(`SELECT id FROM persistence_requests WHERE source_id=$1
        AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) LIMIT 1`, [cursor.sourceId]);
      if (!unfinished.length) {
        const failed = cursor.pending ? await getWriteRequest(engine, cursor.authority.writer.principal, cursor.pending.requestId) : null;
        const recorded = await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=$1 AND completed_keys->0->>'run_id'=$2", [key, cursor.runId]);
        if ((failed && ['failed', 'conflict', 'cancelled'].includes(failed.state)) || (!failed && recorded.length)) {
          phase = 'discovery';
          discoveryTarget = syncGit(context.gitRoot, ['rev-parse', 'HEAD']).trim();
          const discovery = await discoverManagedSync(engine, opts, context);
          cursor = await replaceCursor(engine, key, header(cursor), { ...discovery, authority, runId: discoveryRun, index: 0, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 } });
        }
      }
    }
    if (cursor?.done && opts.dryRun) return result(cursor, 'dry_run');
    if (cursor?.done && company) { await clearManagedSyncFailureAfterSuccess(engine, key); return result(cursor, cursor.from === null ? 'first_sync' : 'synced'); }
    if (cursor?.done) {
      await clearManagedSyncFailureAfterSuccess(engine, key);
      await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb', [OP, key, JSON.stringify([header(cursor)])]);
      cursor = await readCursor(engine, key);
    }
    if (!cursor) {
      phase = 'discovery';
      discoveryTarget = company?.plan.revision?.commit ?? syncGit(context.gitRoot, ['rev-parse', 'HEAD']).trim();
      const discovery = await discoverManagedSync(engine, opts, context);
      const fresh: Cursor = { ...discovery, authority, runId: discoveryRun, index: 0, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 }, ...(company ? { companyReceiptId: company.receiptId } : {}) };
      if (opts.dryRun) return result(fresh, 'dry_run');
      if (!fresh.entries.length && fresh.from === fresh.target) { await clearManagedSyncFailureAfterSuccess(engine, key); return result(fresh, 'up_to_date'); }
      if (company) await company.protect([{ op: OP, fingerprint: key, kind: 'managed_cursor' }, { op: `${OP}-manifest`, fingerprint: fresh.runId, kind: 'manifest' }]);
      cursor = await saveCursor(engine, key, null, fresh);
    }
    if (cursor.incarnation !== context.incarnation || cursor.binding.worktree_id !== context.binding.worktree_id ||
        String(cursor.binding.topology_generation) !== String(context.binding.topology_generation) ||
        String(cursor.binding.owner_epoch) !== String(context.binding.owner_epoch) || cursor.root !== context.root) {
      throw new OperationError('source_changed', 'The unfinished sync cursor belongs to an older source binding.');
    }
    if (opts.dryRun) return result(cursor, 'dry_run');
    const config = loadConfig() ?? { engine: engine.kind };
    const signal = opts.signal && currentJobSignal() ? AbortSignal.any([opts.signal, currentJobSignal()!]) : opts.signal ?? currentJobSignal();
    let batchStart = performance.now(), batchPages = 0, foregroundWaitStart = 0, foregroundBaseline = 0;
    let creditedPages = 0, creditStarted = 0;
    const sliceStarted = performance.now(), sliceFirstIndex = cursor.index;
    while (!cursor.done) {
      assertPersistenceAccepting(engine);
      if (signal?.aborted) return result(cursor, 'partial', 'timeout');
      if (!cursor.pending) {
        // A source remains fair in both directions: foreground gets service,
        // then sync earns one bounded batch even if new interactive work keeps arriving.
        if (creditedPages && performance.now() - creditStarted >= 250) creditedPages = 0;
        const [foreground] = await engine.executeRaw(`SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid
          AND state IN ('queued','running','recovering') AND NOT(COALESCE(intent->>'kind','') LIKE 'managed_sync_%') LIMIT 1`, [cursor.binding.worktree_id]);
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
        cursor = await saveCursor(engine, key, cursor, { ...cursor, pending: await freezeEntry(engine, cursor, key) });
      }
      if (!cursor.pending) continue; // another owner-loop advanced the cursor
      const pending = cursor.pending;
      phase = 'admission';
      const prior = await getWriteRequest(engine, cursor.authority.writer.principal, pending.requestId);
      const row = prior ?? await admitWrite(engine, { requestId: pending.requestId, operation: 'submit_job',
        sourceId: cursor.sourceId, sourceIncarnation: cursor.incarnation, slug: pending.slug, pageId: pending.pageId,
        worktreeId: cursor.binding.worktree_id, topologyGeneration: cursor.binding.topology_generation,
        principal: cursor.authority.writer.principal, authority: cursor.authority.writer, callerIntent: pending.intent, intent: pending.intent });
      await validateSyncAuthority(engine, cursor.authority, pending.slug);
      const done = await waitForWrite(engine, row, config, 5000);
      if (!isTerminalWriteState(done.state)) return { ...result(cursor, 'partial', 'writer_pending'),
        ...(authority.writer.remote ? {} : { managedWrite: writeDiagnostic(cursor, pending, done) }) };
      if (done.state !== 'committed') {
        const { failure, ledgerRecorded } = await recordManagedSyncFailure(engine, { source_id: cursor.sourceId, source_incarnation: cursor.incarnation, path: pending.intent.path ?? '<checkpoint>',
          code: done.error_code ?? (done.state === 'cancelled' ? 'cancelled' : 'storage_error'), message: done.error_message ?? 'The accepted sync request did not commit.',
        request_id: pending.requestId, run_id: cursor.runId, target: cursor.target, cursor_key: key,
        phase: pending.intent.kind === 'managed_sync_checkpoint' ? 'checkpoint' : 'receipt', state: done.state, observation_id: pending.requestId,
        first_seen: new Date(done.completed_at ?? done.updated_at).toISOString() });
        return { ...result(cursor, 'blocked_by_failures'), failedFiles: 1,
          failureCodes: [{ code: failure.code, count: 1 }], ...(authority.writer.remote ? {} : { failures: [failure],
            managedWrite: { ...writeDiagnostic(cursor, pending, done), ledger_recorded: ledgerRecorded } }) };
      }
      if (pending.intent.kind === 'managed_sync_checkpoint') {
        cursor = (await readCursor(engine, key))!;
        if (!cursor?.done) throw new OperationError('storage_error', 'Committed sync checkpoint lost its cursor.');
        await clearManagedSyncFailureAfterSuccess(engine, key);
        if (cursor.counts.added + cursor.counts.modified + cursor.counts.deleted > 0) await refreshProjectionStatistics(engine);
        return result(cursor, cursor.from === null ? 'first_sync' : 'synced');
      }
      // The frozen manifest is shared; only the cursor header changes per page.
      const next: Cursor = { ...cursor, index: cursor.index + 1, counts: { ...cursor.counts } }; delete next.pending;
      if (done.outcome?.noop !== true) {
        if (pending.intent.kind === 'managed_sync_delete') next.counts.deleted++;
        else if (pending.pageId === null) next.counts.added++; else next.counts.modified++;
      }
      next.counts.chunks += Number(done.outcome?.chunks ?? 0);
      cursor = await saveCursor(engine, key, cursor, next);
      opts.onProgress?.({ phase: 'managed_sync.page_committed', bankedFiles: cursor.index });
      if (slice && (cursor.index - sliceFirstIndex >= slice.maxPages || performance.now() - sliceStarted >= slice.maxMs)) return result(cursor, 'partial', 'writer_yield');
      batchPages++;
      if (creditedPages) creditedPages--;
      if (batchPages >= 25 || performance.now() - batchStart >= 250) {
        opts.onProgress?.({ phase: 'managed_sync.yield', bankedFiles: cursor.index });
        await new Promise(resolve => setTimeout(resolve, 0));
        batchPages = 0; batchStart = performance.now();
      }
    }
    return result(cursor, cursor.from === null ? 'first_sync' : 'synced');
  } catch (error) {
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
