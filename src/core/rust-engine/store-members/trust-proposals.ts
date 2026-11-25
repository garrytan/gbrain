/**
 * Trust decisions: the `trust_proposals` members (BrainEngine insertTrustProposal, getTrustProposal, listTrustProposals,
 * pendingTrustProposalsFor, updatePendingTrustProposalAfter, transitionTrustProposal), over
 * `rust/crates/gbrain-store/src/trust/proposals.rs`. The store returns rows with the `SELECT *` column names and ISO times;
 * `normalizeTrustProposal` turns them into the rows the SQL engines return. The proposer principal and write request read
 * NULL on the store (rust/docs/store/trust.md, "Trust proposals"). `listPendingContradictions` reads the pending
 * `decide_proposals` (the store keeps them under the eval-capture family) with their two facts.
 * `listUnreadablePrivacyHoldIds` sends the store what widens the caller's world-only
 * fact reads (storeVisibility, store-members/fact-visibility.ts): a caller the store cannot model refuses there.
 */
import type { BrainEngine } from '../../engine.ts';
import { normalizeTrustProposal, trustProposalLimit, type PendingContradictionRow } from '../../engine-sql/trust-proposals.ts';
import { assertStoreSerializedTransactions, storeCall, type StoreMember } from './common.ts';
import { storeVisibility } from './fact-visibility.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const rows = (value: unknown) => (value as Array<Record<string, unknown>>).map(normalizeTrustProposal);

export const insertTrustProposal: Member<'insertTrustProposal'> = async (brain, input) => {
  const out: { id: number; created: boolean } = await storeCall({ member: 'insertTrustProposal', sourceId: input.sourceId },
    () => brain.insertTrustProposal({
      action: input.action, sourceId: input.sourceId, target: { table: input.target.table, id: input.target.id },
      related: input.related ? { table: input.related.table, id: input.related.id } : null,
      before: input.before, after: input.after ?? {}, proposer: input.proposer,
    }));
  return { id: Number(out.id), created: out.created };
};

/** `lock` skips the FOR UPDATE while explicit transactions hold the writer (`serialized_transactions`); it asserts that. */
export const getTrustProposal: Member<'getTrustProposal'> = async (brain, id, lock) => {
  if (lock) assertStoreSerializedTransactions(brain, 'getTrustProposal');
  const row: Record<string, unknown> | null = await storeCall({ member: 'getTrustProposal' }, () => brain.getTrustProposal(id));
  return row ? normalizeTrustProposal(row) : null;
};

export const listUnreadablePrivacyHoldIds: Member<'listUnreadablePrivacyHoldIds'> = async (brain, ids) => {
  if (!ids.length) return [];
  const widen = storeVisibility('listUnreadablePrivacyHoldIds', ['world']).widen ?? { privateFactSources: [] };
  const out: number[] = await storeCall({ member: 'listUnreadablePrivacyHoldIds' },
    () => brain.listUnreadablePrivacyHoldIds({ ids: ids.map(Number), widen }));
  return out.map(Number);
};

export const listTrustProposals: Member<'listTrustProposals'> = async (brain, filter = {}) =>
  rows(await storeCall({ member: 'listTrustProposals', sourceId: filter.sourceId }, () => brain.listTrustProposals({
    status: filter.status ?? null, sourceId: filter.sourceId ?? null, action: filter.action ?? null,
    since: filter.since?.toISOString() ?? null, limit: trustProposalLimit(filter.limit),
  })));

export const pendingTrustProposalsFor: Member<'pendingTrustProposalsFor'> = async (brain, table, id) =>
  rows(await storeCall({ member: 'pendingTrustProposalsFor' }, () => brain.pendingTrustProposalsFor(table, id)));

export const updatePendingTrustProposalAfter: Member<'updatePendingTrustProposalAfter'> = async (brain, id, after) => {
  await storeCall({ member: 'updatePendingTrustProposalAfter' }, () => brain.updatePendingTrustProposalAfter(id, after));
};

export const transitionTrustProposal: Member<'transitionTrustProposal'> = (brain, id, from, to, opts = {}) =>
  storeCall({ member: 'transitionTrustProposal' }, () => brain.transitionTrustProposal(id, from, to, opts.after ?? null,
    opts.decidedBy ? { kind: opts.decidedBy.kind, id: opts.decidedBy.id } : null));

/** The pending decide proposals whose two facts are both active, from the store; `created_at` is the millisecond ISO string the SQL engines return. */
export const listPendingContradictions: Member<'listPendingContradictions'> = async (brain, filter = {}) => {
  const rows: PendingContradictionRow[] = await storeCall({ member: 'listPendingContradictions', sourceId: filter.sourceId },
    () => brain.listPendingContradictions({ sourceId: filter.sourceId ?? null, since: filter.since?.toISOString() ?? null }));
  return rows.map(row => ({ ...row, created_at: new Date(row.created_at as string).toISOString() }));
};
