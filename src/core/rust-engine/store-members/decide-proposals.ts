/**
 * The decide proposal members (BrainEngine insertDecideProposal ... applyDecideSweepDeferred): the supersede proposals,
 * the review proposals, the review queue and the conflict sweep's retry rows. The store keeps the four tables
 * (rust/docs/store/decide-proposals.md). All of them use the `eval_capture` capability, the one the eval-capture members
 * use, because the store keeps these records under that family's key tag.
 *
 * The supersede proposal rows carry millisecond ISO strings (`Date#toISOString`, as the SQL side does); the store sends
 * microseconds. The review proposal rows carry Postgres `timestamptz::text`, which the store sends already.
 * `getDecideProposal` and `getDecideReviewProposal` skip the FOR UPDATE a `lock` asks for while explicit transactions
 * hold the writer (`serialized_transactions`); with `lock` set they assert it.
 */
import type {
  NewProposal, NewReviewProposal, ProposalListing, ProposalReviewCounts, ProposalRow, ProposalStatus, ReviewProposalRecord,
  ReviewQueueOp, ReviewQueueRow, SweepDeferredOp,
} from '../../engine-sql/decide-proposals.ts';
import { assertStoreSerializedTransactions, storeCall, type StoreMember } from './common.ts';

/** A microsecond ISO timestamp from the store as the millisecond ISO string PGLite and Postgres members return. */
const millis = (value: unknown): string | null => (typeof value === 'string' ? new Date(value).toISOString() : null);

function proposalRow<R extends ProposalRow>(row: R): R {
  return { ...row, created_at: millis(row.created_at)!, decided_at: millis(row.decided_at) };
}

export const insertDecideProposal: StoreMember<[p: NewProposal], number | null> = (brain, p) =>
  storeCall({ member: 'insertDecideProposal' }, () => brain.insertDecideProposal(p));

export const getDecideProposal: StoreMember<[id: number, lock?: boolean], ProposalRow | null> = async (brain, id, lock) => {
  if (lock) assertStoreSerializedTransactions(brain, 'getDecideProposal');
  const row: ProposalRow | null = await storeCall({ member: 'getDecideProposal' }, () => brain.getDecideProposal(id));
  return row ? proposalRow(row) : null;
};

export const listDecideProposalIds: StoreMember<[sweepId: string, status: ProposalStatus], number[]> = (brain, sweepId, status) =>
  storeCall({ member: 'listDecideProposalIds' }, () => brain.listDecideProposalIds(sweepId, status));

export const listDecideProposals: StoreMember<[opts?: { status?: ProposalStatus | 'all'; limit?: number }], ProposalListing[]> =
  async (brain, opts) => {
    const rows: ProposalListing[] = await storeCall({ member: 'listDecideProposals' }, () => brain.listDecideProposals(opts ?? null));
    return rows.map(proposalRow);
  };

export const transitionDecideProposal: StoreMember<
  [id: number, from: ProposalStatus, to: ProposalStatus, state?: { before?: string | null; after?: string | null }], boolean> =
  (brain, id, from, to, state) =>
    storeCall({ member: 'transitionDecideProposal' }, () =>
      brain.transitionDecideProposal({ id, from, to, before: state?.before ?? null, after: state?.after ?? null }));

export const listDecideProposedPairs: StoreMember<[sourceId: string, factId: number], Array<{ a: number; b: number }>> = (brain, sourceId, factId) =>
  storeCall({ member: 'listDecideProposedPairs' }, () => brain.listDecideProposedPairs(sourceId, factId));

export const insertDecideReviewProposal: StoreMember<[p: NewReviewProposal], number | null> = (brain, p) =>
  storeCall({ member: 'insertDecideReviewProposal' }, () => brain.insertDecideReviewProposal(p));

export const listDecideReviewProposals: StoreMember<[status: string], ReviewProposalRecord[]> = (brain, status) =>
  storeCall({ member: 'listDecideReviewProposals' }, () => brain.listDecideReviewProposals(status));

export const getDecideReviewProposal: StoreMember<[id: number, lock?: boolean], ReviewProposalRecord | null> = async (brain, id, lock) => {
  if (lock) assertStoreSerializedTransactions(brain, 'getDecideReviewProposal');
  return storeCall({ member: 'getDecideReviewProposal' }, () => brain.getDecideReviewProposal(id));
};

export const transitionDecideReviewProposal: StoreMember<[id: number, from: string, to: string], boolean> = (brain, id, from, to) =>
  storeCall({ member: 'transitionDecideReviewProposal' }, () => brain.transitionDecideReviewProposal({ id, from, to }));

export const listDecideReviewProposalIds: StoreMember<[sweepId: string, includeWithdrawals: boolean], number[]> = (brain, sweepId, includeWithdrawals) =>
  storeCall({ member: 'listDecideReviewProposalIds' }, () => brain.listDecideReviewProposalIds(sweepId, includeWithdrawals));

export const readProposalReviewRates: StoreMember<[], ProposalReviewCounts[]> = (brain) =>
  storeCall({ member: 'readProposalReviewRates' }, () => brain.readProposalReviewRates());

export const listDueDecideReviewQueue: StoreMember<[kind: string, sourceId: string, limit: number], ReviewQueueRow[]> = (brain, kind, sourceId, limit) =>
  storeCall({ member: 'listDueDecideReviewQueue' }, () => brain.listDueDecideReviewQueue(kind, sourceId, limit));

export const applyDecideReviewQueue: StoreMember<[op: ReviewQueueOp], number> = (brain, op) =>
  storeCall({ member: 'applyDecideReviewQueue' }, () => brain.applyDecideReviewQueue(op));

export const listDueDecideSweepDeferred: StoreMember<[sourceId: string, limit: number], Array<{ fact_id: number; attempts: number }>> =
  (brain, sourceId, limit) => storeCall({ member: 'listDueDecideSweepDeferred' }, () => brain.listDueDecideSweepDeferred(sourceId, limit));

export const applyDecideSweepDeferred: StoreMember<[sourceId: string, op: SweepDeferredOp], number> = (brain, sourceId, op) =>
  storeCall({ member: 'applyDecideSweepDeferred' }, () => brain.applyDecideSweepDeferred(sourceId, op));
