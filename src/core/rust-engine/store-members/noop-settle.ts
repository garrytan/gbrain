/**
 * The no-op embedding settle statements the Rust store answers (engine-sql/persistence-embedding-noop-settle.ts): the
 * due probe (probeNoopEmbeddingSettle), the locked window (lockNoopEmbeddingWindow), the candidate read
 * (readNoopEmbeddingCandidates) and the settle update (settleNoopEmbeddingRows).
 *
 * The store keeps one vector column, so a candidate read for another write column refuses. Ids that are not bigints
 * and a host that is not a uuid refuse as the Postgres casts do.
 *
 * What each member answers and why: rust/docs/store/persistence.md ("No-op embedding settle").
 */
import type { NoopSettleCandidate, NoopSettleCandidateSpec, NoopSettledRow, NoopSettleWindow } from '../../engine-sql/persistence-embedding-noop-settle.ts';
import { assertStoreSerializedTransactions, refuseMember, storeCall, type StoreMember } from './common.ts';

/** Whether an unattempted queued embedding effect lies past effect id `from`. */
export const probeNoopEmbeddingSettle: StoreMember<[from: string], boolean> = (brain, from) =>
  storeCall({ member: 'probeNoopEmbeddingSettle' }, () => brain.probeNoopEmbeddingSettle(String(from)));

/** The newest effect id and the next `limit` unattempted embedding effects past `from`. */
export const lockNoopEmbeddingWindow: StoreMember<[spec: { from: string; limit: number }], NoopSettleWindow> = (brain, spec) =>
  storeCall({ member: 'lockNoopEmbeddingWindow' }, () => brain.lockNoopEmbeddingWindow(String(spec.from), spec.limit));

/** The window effects with nothing left to embed, before their source guard. */
export const readNoopEmbeddingCandidates: StoreMember<[spec: NoopSettleCandidateSpec], NoopSettleCandidate[]> = async (brain, spec) => {
  // The SQL holds the candidates' pages FOR SHARE until it commits; skipped while explicit transactions hold the writer.
  assertStoreSerializedTransactions(brain, 'readNoopEmbeddingCandidates');
  if (spec.column !== 'embedding') refuseMember('readNoopEmbeddingCandidates', `column ${spec.column}`);
  return storeCall({ member: 'readNoopEmbeddingCandidates' }, () => brain.readNoopEmbeddingCandidates({
    hostId: spec.hostId, signature: spec.signature, expectedModel: spec.expectedModel,
    window: spec.window.map(String), pageIds: [...spec.pageIds],
  }));
};

/** Settles these queued effects; the settled ids and requests. */
export const settleNoopEmbeddingRows: StoreMember<[ids: readonly string[]], NoopSettledRow[]> = (brain, ids) =>
  storeCall({ member: 'settleNoopEmbeddingRows' }, () => brain.settleNoopEmbeddingRows(ids.map(String)));
