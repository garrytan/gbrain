/**
 * The grouped-publication statements (BrainEngine groupPublishStore; SQL in engine-sql/group-publish-store.ts), served from the
 * store's request, effect, counter, source and binding records (gbrain-store `persistence::group_publish_store`).
 *
 * Each read is one `groupRows({ kind, ... })` call and each write one `groupWrite({ kind, ... })` call, with the answers of the
 * SQL they replace. The row locks the SQL takes become stated guarantees (nothing is locked here): an explicit transaction is
 * Serialized (it holds the store's writer, so no other commit interleaves with what it read); under optimistic transactions
 * the rows read are in the transaction's read set, so a racing change aborts the commit with `write_conflict` instead.
 */
import type { GroupPublishStore } from '../../engine-sql/group-publish-store.ts';
import type { WriteRequest } from '../../persistence/model.ts';
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { requestRow } from '../store-codec.ts';
import type { FenceOpts } from '../../engine-sql/lease-token.ts';
import { storeCall } from './common.ts';
import { heldStore } from './managed-hold.ts';
import { applyTransactionSettings } from './transactions.ts';

const MEMBER = 'groupPublishStore';
/** `{ fence }` when the call carries one (the Rust store runs its claim lifecycle under it), else nothing: an unfenced call sends what it always sent. */
const fenceOf = (opts?: FenceOpts): FenceOpts => opts?.fence ? { fence: opts.fence } : {};

function rustGroupPublishStore(engine: RustEngine, brain: StoreBrain): GroupPublishStore {
  const call = <T>(run: () => Promise<T>): Promise<T> => storeCall({ member: MEMBER }, run);
  const rows = <T>(kind: string, args: Record<string, unknown>): Promise<T> => call<T>(() => brain.groupRows({ kind, ...args }));
  const write = <T>(kind: string, args: Record<string, unknown>): Promise<T> => call<T>(() => brain.groupWrite({ kind, ...args }));
  const claims = (members: ReadonlyArray<{ id: string; token: string; stamp?: string | null }>) => members.map(m => ({ id: m.id, token: m.token, stamp: m.stamp ?? null }));
  return {
    async claimFollowers(head, group, max, leaseMs, owner, opts) {
      const claimed = await write<Array<WriteRequest & { previous_claim_phase: unknown }>>('claim_followers', { worktreeId: head.worktree_id,
        headSequence: String(head.sequence), group, max, leaseMs, owner, ...fenceOf(opts) });
      return claimed.map(row => ({ ...requestRow<WriteRequest>(row)!, previous_claim_phase: row.previous_claim_phase }));
    },
    renewClaims: (members, leaseMs, opts) => write<string[]>('renew_claims', { members: claims(members), leaseMs, ...fenceOf(opts) }),
    markDispatched: (members, opts) => write<string[]>('mark_dispatched', { members: claims(members), ...fenceOf(opts) }),
    recoveryBlocked: (worktreeId, excluded) => rows<boolean>('recovery_blocked', { worktreeId, excluded: [...excluded] }),
    startPublication: (members, opts) => write<string[]>('start_publication', { members: claims(members), ...fenceOf(opts) }),
    async completeGroup(members, _keys, version, hostId, opts) {
      const done = await write<Array<WriteRequest & { principal_key: string }>>('complete_group', { members: members.map(m => ({ id: m.id, token: m.token,
        outcome: m.outcome, need: m.need, principalKey: m.principalKey, retained: m.retained })), version, hostId, ...fenceOf(opts) });
      return done.map(row => ({ ...requestRow<WriteRequest>(row)!, principal_key: row.principal_key }));
    },
    importRoots: hostId => rows('import_roots', { hostId }),
    async hostBinding(worktreeId) { const path = await call(() => brain.readOwnerHostBinding(worktreeId)) as string | null; return path === null ? [] : [{ local_path: path }]; },
    async requestState(principalKind, principalId, requestId) { return (await call(() => brain.readWriteRequest({ kind: principalKind, id: principalId }, requestId)) as { state: string } | null)?.state ?? null; },
    async sourceTrustConfig(sourceId) { const source = await call(() => brain.getSource(sourceId)) as { config: Record<string, unknown> } | null; return source ? [{ config: source.config }] : []; },
    async setMemberSettings(_sql, names, values) { await call(() => applyTransactionSettings.call(engine, brain, names, values)); },
    recordRecoveries: (members, total, counterKeys, opts) => write<string[]>('record_recoveries', { members: members.map(m => ({ id: m.id, token: m.token, record: m.record, bytes: m.bytes })), total, counterKeys: [...counterKeys], ...fenceOf(opts) }),
    clearRecoveries: (resolved, counterKeys, worktreeId, opts) => write<string[]>('clear_recoveries', { resolved: resolved.map(r => ({ id: r.id, record: r.record })), counterKeys: [...counterKeys], worktreeId, ...fenceOf(opts) }),
    readImportCheckpoints: <R>(op: string, fingerprints: readonly string[]) => rows<Array<{ fingerprint: string; completed_keys: [R] }>>('import_checkpoints', { op, fingerprints: [...fingerprints] }),
    async insertImportCheckpoints(op, fingerprints, docs) { await write('insert_import_checkpoints', { op, fingerprints: [...fingerprints], docs: [...docs] }); },
    async deleteImportCheckpoints(op, fingerprints, docs) { await write('delete_import_checkpoints', { op, fingerprints: [...fingerprints], docs: [...docs] }); },
  };
}

/** `groupPublishStore()`: the store over this engine's store handle; called on a transaction, every call runs in it. */
export const groupPublishStore = async function groupPublishStore(this: RustEngine, brain: StoreBrain): Promise<GroupPublishStore> {
  return heldStore(this, rustGroupPublishStore(this, brain));
};
