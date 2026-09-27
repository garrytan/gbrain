import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { loadConfig } from '../config.ts';
import { OperationError } from '../ops/contract.ts';
import { currentJobSignal } from '../minions/submission-authority.ts';
import { digest } from './digest.ts';
import { getWriteRequest, admitWrite } from './journal.ts';
import { assertPersistenceAccepting, foregroundWriteCompletions, startPersistenceConsumer, waitForWrite } from './service.ts';
import { discoverManagedSync, resolveManagedSyncContext, readSyncContent, syncRawHash, type SyncDiscovery } from './sync-discovery.ts';
import { managedSyncAuthority, validateSyncAuthority, validateManagedSyncOptions, type SyncAuthority } from './sync-authority.ts';
import type { SyncIntent } from './sync-prepare.ts';

interface Pending { requestId: string; slug: string; pageId: number | null; intent: SyncIntent; }
interface Cursor extends SyncDiscovery { runId: string; index: number; authority: SyncAuthority; pending?: Pending; done?: boolean;
  counts: { added: number; modified: number; deleted: number; chunks: number }; }
const OP = 'managed-sync';
type CursorHeader = Omit<Cursor, 'entries'> & { total: number };
const header = ({ entries, ...value }: Cursor): CursorHeader => ({ ...value, total: entries.length });
async function readCursor(engine: BrainEngine, key: string, cached?: Cursor): Promise<Cursor | null> {
  const [row] = await engine.executeRaw<{ completed_keys: [CursorHeader] }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [OP, key]);
  const value = row?.completed_keys?.[0];
  if (!value) return null;
  let entries = cached?.runId === value.runId ? cached.entries : undefined;
  if (!entries) {
    const [manifest] = await engine.executeRaw<{ completed_keys: Cursor['entries'] }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [`${OP}-manifest`, value.runId]);
    entries = manifest?.completed_keys;
  }
  if (!entries || entries.length !== value.total) throw new OperationError('storage_error', 'The durable sync manifest is unavailable.');
  return { ...value, entries };
}
async function saveCursor(engine: BrainEngine, key: string, before: Cursor | null, next: Cursor): Promise<Cursor> {
  return engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
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
function result(cursor: Cursor, status: SyncResult['status'], reason?: SyncResult['reason']): SyncResult {
  return { status, fromCommit: cursor.from, toCommit: cursor.target, added: cursor.counts.added, modified: cursor.counts.modified,
    deleted: cursor.counts.deleted, renamed: 0, chunksCreated: cursor.counts.chunks, embedded: 0, pagesAffected: [],
    filesImported: cursor.index, bankedFiles: cursor.index, ...(cursor.uncommitted ? { uncommitted: cursor.uncommitted } : {}), ...(reason ? { reason } : {}) };
}
async function freezeEntry(engine: BrainEngine, cursor: Cursor, key: string): Promise<Pending> {
  const entry = cursor.entries[cursor.index];
  let slug = '__managed_sync_checkpoint__', pageId: number | null = null, revision: string | null = null;
  let content: string | null = null, rawHash: string | null = null;
  if (entry) {
    rawHash = syncRawHash(cursor.root, entry.path);
    content = entry.action === 'import' ? readSyncContent(cursor, entry) : null;
    slug = entry.slug!; pageId = entry.pageId ?? null; revision = entry.revision ?? null;
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: cursor.sourceId, includeDeleted: true });
    if ((snapshot?.page.id ?? null) !== pageId || (snapshot?.revision ?? null) !== revision ||
        (snapshot?.page.source_path != null && snapshot.page.source_path !== entry.sourcePath)) {
      throw new OperationError('revision_conflict', 'A page changed after this sync cursor was enumerated.');
    }
  }
  await validateSyncAuthority(engine, cursor.authority, slug);
  return { requestId: randomUUID(), slug, pageId, intent: { kind: !entry ? 'managed_sync_checkpoint' : entry.action === 'import' ? 'managed_sync_import' : 'managed_sync_delete',
    expected_revision: revision, sourcePath: entry?.sourcePath ?? null, path: entry?.path ?? null, rawHash, content,
    ownerEpoch: String(cursor.binding.owner_epoch), syncAuthority: cursor.authority, cursorKey: key, runId: cursor.runId,
    slugMode: cursor.slugMode, index: cursor.index, total: cursor.entries.length, from: cursor.from, target: cursor.target } };
}

/** One immutable page is admitted at a time; foreground writes can never sit behind a whole scan. */
export async function performManagedSync(engine: BrainEngine, opts: SyncOpts, slice?: { maxPages: number; maxMs: number }): Promise<SyncResult> {
  assertPersistenceAccepting(engine);
  validateManagedSyncOptions(opts);
  const context = await resolveManagedSyncContext(engine, opts);
  const authority = await managedSyncAuthority(engine, context.sourceId, context.incarnation, context.root);
  const key = digest({ source: context.incarnation, principal: authority.writer.principal, authority,
    options: { full: opts.full ?? false, workingTree: opts.workingTree ?? false, srcSubpath: opts.srcSubpath ?? null,
      exclude: opts.exclude ?? [], includeHidden: opts.includeHidden ?? [], strategy: opts.strategy ?? null } });
  let cursor = await readCursor(engine, key);
  if (cursor && opts.retryFailed && !opts.dryRun) {
    const unfinished = await engine.executeRaw(`SELECT id FROM persistence_requests WHERE source_id=$1
      AND intent->>'runId'=$2 AND state IN ('queued','running','recovering') LIMIT 1`, [cursor.sourceId, cursor.runId]);
    if (!unfinished.length) {
      await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb', [OP, key, JSON.stringify([header(cursor)])]);
      cursor = await readCursor(engine, key);
    }
  }
  if (cursor?.done && opts.dryRun) return result(cursor, 'dry_run');
  if (cursor?.done) {
    await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb', [OP, key, JSON.stringify([header(cursor)])]);
    cursor = await readCursor(engine, key);
  }
  if (!cursor) {
    const discovery = await discoverManagedSync(engine, opts, context);
    const fresh: Cursor = { ...discovery, authority, runId: randomUUID(), index: 0, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 } };
    if (opts.dryRun) return result(fresh, 'dry_run');
    if (!fresh.entries.length && fresh.from === fresh.target) return result(fresh, 'up_to_date');
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
      cursor = await saveCursor(engine, key, cursor, { ...cursor, pending: await freezeEntry(engine, cursor, key) });
    }
    if (!cursor.pending) continue; // another owner-loop advanced the cursor
    const pending = cursor.pending;
    const prior = await getWriteRequest(engine, cursor.authority.writer.principal, pending.requestId);
    const row = prior ?? await admitWrite(engine, { requestId: pending.requestId, operation: 'submit_job',
      sourceId: cursor.sourceId, sourceIncarnation: cursor.incarnation, slug: pending.slug, pageId: pending.pageId,
      worktreeId: cursor.binding.worktree_id, topologyGeneration: cursor.binding.topology_generation,
      principal: cursor.authority.writer.principal, authority: cursor.authority.writer, callerIntent: pending.intent, intent: pending.intent });
    await validateSyncAuthority(engine, cursor.authority, pending.slug);
    const done = await waitForWrite(engine, row, config, 5000);
    if (!['committed','failed','conflict','cancelled'].includes(done.state)) return result(cursor, 'partial', 'writer_pending');
    if (done.state !== 'committed') {
      return { ...result(cursor, 'blocked_by_failures'), failedFiles: 1,
        failureCodes: [{ code: done.error_code ?? 'storage_error', count: 1 }] };
    }
    if (pending.intent.kind === 'managed_sync_checkpoint') {
      cursor = (await readCursor(engine, key))!;
      if (!cursor?.done) throw new OperationError('storage_error', 'Committed sync checkpoint lost its cursor.');
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
}
