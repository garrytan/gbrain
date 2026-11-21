/**
 * The dream cycle's three journal reads (engine-sql/dream-cycle.ts), answered from the request rows the store keeps:
 * readDreamDeferralReceipt (a deferred write's receipt by journal row id), listLaterPersistenceRequests (the live
 * requests on an output page after a sequence, oldest first) and listCommittedOutputRequests (the committed put_page
 * rows of some client request ids, newest first). Each filters the store's rows with the predicates of its SQL twin.
 */
import type { DreamDeferralReceipt } from '../../engine-sql/dream-cycle.ts';
import type { WriteRequest } from '../../persistence/model.ts';
import { requestRow } from '../store-codec.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';

const LIVE_STATES: ReadonlySet<string> = new Set(['queued', 'running', 'recovering', 'committed']);

/** The durable receipt of a deferred write by request row id, or null when none exists. */
export const readDreamDeferralReceipt: StoreMember<[receiptId: string], DreamDeferralReceipt | null> = async (brain, receiptId) => {
  const row = requestRow<WriteRequest>(await storeCall({ member: 'readDreamDeferralReceipt' }, () => brain.readWriteRequestById(receiptId)));
  return row ? { state: row.state, error_code: row.error_code ?? null, error_message: row.error_message ?? null } : null;
};

/** The full rows of the requests admitted under `requestIds`, in sequence order. */
async function requestsByRequestIds(brain: StoreBrain, member: string, requestIds: readonly string[]): Promise<WriteRequest[]> {
  if (!requestIds.length) return [];
  const rows = await storeCall({ member }, () => brain.listWriteRequestsByRequestIds([...requestIds])) as unknown[];
  return rows.map(row => requestRow<WriteRequest>(row)!);
}

/** Committed-or-pending requests on the output page after `sequence`, oldest first. */
export const listLaterPersistenceRequests: StoreMember<[sourceId: string, incarnation: string, slug: string, sequence: number | string], WriteRequest[]> =
  async (brain, sourceId, incarnation, slug, sequence) => {
    const after = Number(sequence);
    const live = (r: { source_incarnation: string; state: string; sequence: number | string }) =>
      r.source_incarnation === incarnation && LIVE_STATES.has(r.state) && Number(r.sequence) > after;
    const heads = (await storeCall({ member: 'listLaterPersistenceRequests', sourceId }, () => brain.listSourceRequestRows(sourceId)) as Array<{
      request_id: string; source_incarnation: string; state: string; sequence: number }>).filter(live);
    const rows = await requestsByRequestIds(brain, 'listLaterPersistenceRequests', [...new Set(heads.map(r => r.request_id))]);
    return rows.filter(r => r.source_id === sourceId && r.slug === slug && live(r)).sort((a, b) => Number(a.sequence) - Number(b.sequence));
  };

/** The committed put_page journal rows of `requestIds` in the cycle's source and incarnation, newest first. */
export const listCommittedOutputRequests: StoreMember<[requestIds: string[], sourceId: string, incarnation: string], Array<{ request: WriteRequest }>> =
  async (brain, requestIds, sourceId, incarnation) => {
    const rows = await requestsByRequestIds(brain, 'listCommittedOutputRequests', requestIds);
    return rows
      .filter(r => r.source_id === sourceId && r.source_incarnation === incarnation && r.operation === 'put_page' && r.state === 'committed')
      .sort((a, b) => Number(b.sequence) - Number(a.sequence))
      .map(request => ({ request }));
  };
