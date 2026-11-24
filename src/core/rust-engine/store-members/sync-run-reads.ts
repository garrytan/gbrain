/**
 * A managed sync run's journal reads and the `sync.admission` statements (SQL in engine-sql/sync-run-reads.ts and
 * engine-sql/sync-admission.ts), served by gbrain-store `persistence::sync_run_reads`. What the store keeps and how it
 * differs: rust/docs/store/persistence.md, "Sync run reads".
 */
import type { WriteRequest } from '../../persistence/model.ts';
import type { PageRevisionWriter, RevisionWriterRequest } from '../../engine-sql/sync-run-reads.ts';
import type { SyncAdmissionEffectsInput } from '../../engine-sql/sync-admission.ts';
import { requestRow } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The principal's request rows under `requestIds`, each once; only committed ones when `committedOnly`. */
export const readAdmittedWriteRequests: StoreMember<[principalKind: string, principalId: string, requestIds: readonly string[], committedOnly: boolean], WriteRequest[]> =
  async (brain, kind, id, requestIds, committedOnly) => {
    const rows = await storeCall({ member: 'readAdmittedWriteRequests' }, () => brain.readAdmittedWriteRequests({ kind, id }, [...requestIds], committedOnly)) as unknown[];
    return rows.map(row => requestRow<WriteRequest>(row)!);
  };

/** The page's live revision and the request row id that wrote it, or null. */
export const readPageRevisionWriter: StoreMember<[pageId: number, sourceId: string], PageRevisionWriter | null> = (brain, pageId, sourceId) =>
  storeCall({ member: 'readPageRevisionWriter' }, () => brain.readPageRevisionWriter(pageId, sourceId));

/** The request with row id `id`, projected to the `concurrent_write` proof's columns, or null. */
export const readRevisionWriterRequest: StoreMember<[id: string], RevisionWriterRequest | null> = (brain, id) =>
  storeCall({ member: 'readRevisionWriterRequest' }, () => brain.readRevisionWriterRequest(id));

/** The `sync.admission` dating row written with the store clock; returns `set_at` as stored. */
export const writeSyncAdmissionStamp: StoreMember<[op: string, fingerprint: string, value: string], string> = (brain, op, fingerprint, value) =>
  storeCall({ member: 'writeSyncAdmissionStamp' }, () => brain.writeSyncAdmissionStamp(op, fingerprint, value));

/** `sync status`'s two `effective` probes. */
export const readSyncAdmissionEffects: StoreMember<[input: SyncAdmissionEffectsInput], { pinned: boolean; destructive: boolean }> = (brain, input) =>
  storeCall({ member: 'readSyncAdmissionEffects' }, () => brain.readSyncAdmissionEffects({ ...input, kinds: [...input.kinds] }));
