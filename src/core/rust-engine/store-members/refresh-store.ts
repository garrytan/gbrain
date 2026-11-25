/**
 * The worktree refresh statements (BrainEngine refreshStore; SQL in engine-sql/refresh-store.ts), served from the store's
 * refresh, request, effect, source, checkpoint and topology-change records (gbrain-store `persistence::refresh_store`).
 *
 * Each read is one `refreshRows({ kind, ... })` call and each write one `refreshWrite({ kind, ... })` call, with the answers
 * of the SQL they replace. The row locks and session settings the SQL takes become stated guarantees (nothing is taken here):
 * - `settings` changes nothing: the store commits durably and has no lock wait to bound. An explicit transaction is Serialized
 *   (it holds the store's writer, so no other commit interleaves with what it read); under optimistic transactions the rows
 *   read are in the transaction's read set, so a racing change aborts the commit with `write_conflict` instead.
 * - The unique index that allows one active refresh per worktree is checked by the insert in its own transaction; a second
 *   active refresh ends with the `23505` violation the SQL engines raise.
 */
import type { RefreshRow, RefreshStore } from '../../engine-sql/refresh-store.ts';
import type { WriteRequest } from '../../persistence/model.ts';
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { requestRow } from '../store-codec.ts';
import { storeCall } from './common.ts';
import { heldStore } from './managed-hold.ts';

const MEMBER = 'refreshStore';

function rustRefreshStore(brain: StoreBrain): RefreshStore {
  const call = <T>(run: () => Promise<T>): Promise<T> => storeCall({ member: MEMBER }, run);
  const rows = <T>(kind: string, args: Record<string, unknown>): Promise<T> => call<T>(() => brain.refreshRows({ kind, ...args }));
  const write = <T>(kind: string, args: Record<string, unknown>): Promise<T> => call<T>(() => brain.refreshWrite({ kind, ...args }));
  return {
    async settings() {},
    readActive: worktreeId => rows<RefreshRow | null>('active', { worktreeId }),
    read: id => rows<RefreshRow | null>('row', { id }),
    transition: (id, from, to, outcome, terminal) => write<boolean>('transition', { id, from: [...from], to, outcome, terminal }),
    replan: (id, oldHead, targetHead) => write<RefreshRow | null>('replan', { id, oldHead, targetHead }),
    async insertDraining(insert) {
      const row = await write<RefreshRow | { conflict: true }>('insert_draining', { worktreeId: insert.worktreeId, sourceIds: [...insert.sourceIds],
        principalId: insert.principalId, ownerEpoch: insert.ownerEpoch, topologyGeneration: insert.topologyGeneration, oldHead: insert.oldHead,
        targetHead: insert.targetHead, upstreamRef: insert.upstreamRef, preserved: [...insert.preserved], outcome: insert.outcome });
      if ('conflict' in row) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "persistence_worktree_refreshes_active"'), { code: '23505' });
      }
      return row;
    },
    markMergeStarted: (id, atMs) => write<boolean>('mark_merge_started', { id, atMs }),
    async setHolder(id, holder) { await write('set_holder', { id, holder }); },
    async recordMergedUpstream(sourceIds, targetHead) { await write('record_merged_upstream', { sourceIds: [...sourceIds], targetHead }); },
    completedTargets: (worktreeId, upstreamRef) => rows<string[]>('completed_targets', { worktreeId, upstreamRef }),
    newest: worktreeId => rows('newest', { worktreeId }),
    blocking: worktreeId => rows('blocking', { worktreeId }),
    recoveryProbe: worktreeId => rows('recovery_probe', { worktreeId }),
    drainCounts: worktreeId => rows('drain_counts', { worktreeId }),
    unfinishedSyncCursor: members => rows('unfinished_sync_cursor', { members: [...members] }),
    membersPastStart: (sourceIds, barrierSequence) => rows('members_past_start', { sourceIds: [...sourceIds], barrierSequence }),
    sourceCommits: sourceIds => rows('source_commits', { sourceIds: [...sourceIds] }),
    memberCommits: sourceIds => rows('member_commits', { sourceIds: [...sourceIds] }),
    ownerActivity: worktreeIds => rows('owner_activity', { ids: [...worktreeIds] }),
    async memberIds(worktreeId) { return (await call(() => brain.topologyRows({ kind: 'worktree_members', worktreeId })) as Array<{ source_id: string }>).map(row => row.source_id); },
    async hostLocalPath(worktreeId, hostId) { return (await call(() => brain.topologyRows({ kind: 'host_binding', worktreeId, hostId })) as { local_path: string } | null)?.local_path ?? null; },
    async sourceLastCommit(sourceId) { return (await call(() => brain.getSource(sourceId)) as { last_commit?: string | null } | null)?.last_commit ?? null; },
    async sourceIncarnation(sourceId) { return (await call(() => brain.readSourceMembership(sourceId)) as { incarnation: string } | null)?.incarnation ?? null; },
    async holdForImport(id, token, importFrom) { return requestRow<WriteRequest>(await write('hold_for_import', { id, token, importFrom })); },
    readReleased: id => rows('released', { id }),
    laterWrite: (sourceId, slug, sequence) => rows<string | null>('later_write', { sourceId, slug, sequence }),
    async deferredBacklog() {
      const row = await rows<{ count: number; oldest_age_ms: number | null }>('deferred_backlog', {});
      return { count: Number(row.count), oldest_age_ms: Number(row.oldest_age_ms ?? 0) };
    },
    async deferredWaiting(row) {
      return (await rows<{ waiting: boolean }>('deferred_waiting', { sourceId: row.source_id, deferredRefreshId: row.deferred_refresh_id ?? null,
        deferredImportFrom: row.deferred_import_from ?? null })).waiting;
    },
  };
}

/** `refreshStore()`: the store over this engine's store handle; called on a transaction, every call runs in it. */
export const refreshStore = async function refreshStore(this: RustEngine, brain: StoreBrain): Promise<RefreshStore> {
  return heldStore(this, rustRefreshStore(brain));
};
