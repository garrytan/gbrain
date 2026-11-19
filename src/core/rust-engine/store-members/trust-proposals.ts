/**
 * Trust decisions: the `trust_proposals` members (BrainEngine insertTrustProposal, getTrustProposal, listTrustProposals,
 * pendingTrustProposalsFor, updatePendingTrustProposalAfter, transitionTrustProposal), over
 * `rust/crates/gbrain-store/src/trust/proposals.rs`. The store returns rows with the `SELECT *` column names and ISO times;
 * `normalizeTrustProposal` turns them into the rows the SQL engines return. The proposer principal and write request read
 * NULL on the store (rust/docs/store/trust.md, "Trust proposals"). `listPendingContradictions` reads `decide_proposals`,
 * which the store does not keep: the decide sweep files them through raw SQL, which this engine refuses, so no Rust brain
 * holds one and the list is empty.
 */
import type { BrainEngine } from '../../engine.ts';
import { normalizeTrustProposal, trustProposalLimit } from '../../engine-sql/trust-proposals.ts';
import { storeCall, type StoreMember } from './common.ts';

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

export const getTrustProposal: Member<'getTrustProposal'> = async (brain, id) => {
  const row: Record<string, unknown> | null = await storeCall({ member: 'getTrustProposal' }, () => brain.getTrustProposal(id));
  return row ? normalizeTrustProposal(row) : null;
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

/** The store keeps no decide proposals (the sweep's insert is raw SQL, refused here), so no contradiction is pending. */
export const listPendingContradictions: Member<'listPendingContradictions'> = async () => [];
