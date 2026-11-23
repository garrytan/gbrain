/**
 * The dream cycle's persistence journal reads (BrainEngine readDreamDeferralReceipt, listLaterPersistenceRequests,
 * listCommittedOutputRequests; SQL in engine-sql/dream-cycle.ts), answered from the request records the store keeps
 * (rust/docs/store/dream.md, "Dream cycle statements").
 *
 * readDreamDeferralReceipt reads the request by journal id (`readWriteRequestById`, which refuses an id that is not a
 * UUID as the `::uuid` cast does). listLaterPersistenceRequests returns rows with Dates, as the driver returns them;
 * listCommittedOutputRequests returns each row as `{ request }` with its times as text, as `row_to_json` does.
 */
import type { DreamDeferralReceipt } from '../../engine-sql/dream-cycle.ts';
import type { WriteRequest } from '../../persistence/model.ts';
import { requestRow } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The state and recorded error of the request with journal id `receiptId`, or null. */
export const readDreamDeferralReceipt: StoreMember<[receiptId: string], DreamDeferralReceipt | null> = async (brain, receiptId) => {
  const row = requestRow<WriteRequest>(await storeCall({ member: 'readDreamDeferralReceipt' }, () => brain.readWriteRequestById(receiptId)));
  return row ? { state: row.state, error_code: row.error_code ?? null, error_message: row.error_message ?? null } : null;
};

/** The queued, running, recovering or committed requests on the page after `sequence`, oldest first. */
export const listLaterPersistenceRequests: StoreMember<[sourceId: string, incarnation: string, slug: string, sequence: number | string], WriteRequest[]> =
  async (brain, sourceId, incarnation, slug, sequence) => {
    const rows = await storeCall({ member: 'listLaterPersistenceRequests', slug, sourceId },
      () => brain.listLaterPersistenceRequests(sourceId, incarnation, slug, String(sequence))) as unknown[];
    return rows.map(row => requestRow<WriteRequest>(row)!);
  };

/** The committed put_page rows of `requestIds` in the source and incarnation, newest first. */
export const listCommittedOutputRequests: StoreMember<[requestIds: string[], sourceId: string, incarnation: string], Array<{ request: WriteRequest }>> =
  (brain, requestIds, sourceId, incarnation) =>
    storeCall({ member: 'listCommittedOutputRequests', sourceId },
      () => brain.listCommittedOutputRequests([...requestIds], sourceId, incarnation)) as Promise<Array<{ request: WriteRequest }>>;
