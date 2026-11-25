/**
 * The edge-contradictions dream phase and its proposal ledger (src/core/engine-sql/contradictions-cycle.ts), served
 * from the Rust store (rust/crates/gbrain-store/src/edge_proposals.rs): listEdgeContradictionCandidates,
 * listKnownEdgeProposals, recordEdgeProposal, readEdgeProposal, edgeClosureLanded, readEdgeProposalEvidence,
 * readEdgeProposalHash, markEdgeProposalStale, setEdgeProposalStatus, rejectOpenEdgeProposal, markEdgeProposalUndone and
 * markRevertedEdgeProposals; and the six members of `gbrain edge-proposals` (listEdgeProposalCliRows,
 * deleteHeldEdgeProposalErrors, listAppliedEdgeProposalIds, deleteEdgeProposalError, readEdgeProposalSourceId and
 * markEdgeProposalDated, edge_proposals/cli.rs). See rust/docs/store/edge_proposals.md.
 */
import type { BrainEngine } from '../../engine.ts';
import { withDates } from '../store-codec.ts';
import { NON_EMPLOYER_PREFIXES, NON_EMPLOYER_TYPES } from '../../link-target-roles.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;
type CandidateRow = Awaited<ReturnType<BrainEngine['listEdgeContradictionCandidates']>>[number];

export const listEdgeContradictionCandidates: Member<'listEdgeContradictionCandidates'> = async (brain, query) => {
  const rows: CandidateRow[] = await storeCall({ member: 'listEdgeContradictionCandidates' }, () =>
    brain.listEdgeContradictionCandidates({
      ...query,
      nonEmployerTypes: [...NON_EMPLOYER_TYPES],
      nonEmployerPrefixes: [...NON_EMPLOYER_PREFIXES],
    }));
  // PGLite parses a DATE into a Date at UTC midnight and a TIMESTAMPTZ into a Date; the store answers their text.
  return rows.map((row) => ({
    ...row,
    last_start: row.last_start === null ? null : new Date(`${row.last_start as string}T00:00:00Z`),
    recorded_at: new Date(row.recorded_at as string),
  }));
};

export const listKnownEdgeProposals: Member<'listKnownEdgeProposals'> = (brain, fromPageId, linkType, evidenceHashes) =>
  storeCall({ member: 'listKnownEdgeProposals' }, () => brain.listKnownEdgeProposals(fromPageId, linkType, evidenceHashes));

export const recordEdgeProposal: Member<'recordEdgeProposal'> = (brain, proposal) =>
  storeCall({ member: 'recordEdgeProposal' }, () => brain.recordEdgeProposal(proposal));

export const readEdgeProposal: Member<'readEdgeProposal'> = (brain, id) =>
  storeCall({ member: 'readEdgeProposal' }, () => brain.readEdgeProposal(id));

export const edgeClosureLanded: Member<'edgeClosureLanded'> = (brain, fromPageId, endingToPageId, linkType, closeDate) =>
  storeCall({ member: 'edgeClosureLanded' }, () => brain.edgeClosureLanded(fromPageId, endingToPageId, linkType, closeDate));

export const readEdgeProposalEvidence: Member<'readEdgeProposalEvidence'> = (brain, id) =>
  storeCall({ member: 'readEdgeProposalEvidence' }, () => brain.readEdgeProposalEvidence(id));

export const readEdgeProposalHash: Member<'readEdgeProposalHash'> = (brain, id) =>
  storeCall({ member: 'readEdgeProposalHash' }, () => brain.readEdgeProposalHash(id));

export const markEdgeProposalStale: Member<'markEdgeProposalStale'> = async (brain, id) => {
  await storeCall({ member: 'markEdgeProposalStale' }, () => brain.markEdgeProposalStale(id));
};

export const setEdgeProposalStatus: Member<'setEdgeProposalStatus'> = async (brain, id, status) => {
  await storeCall({ member: 'setEdgeProposalStatus' }, () => brain.setEdgeProposalStatus(id, status));
};

export const rejectOpenEdgeProposal: Member<'rejectOpenEdgeProposal'> = (brain, id) =>
  storeCall({ member: 'rejectOpenEdgeProposal' }, () => brain.rejectOpenEdgeProposal(id));

export const markEdgeProposalUndone: Member<'markEdgeProposalUndone'> = async (brain, id) => {
  await storeCall({ member: 'markEdgeProposalUndone' }, () => brain.markEdgeProposalUndone(id));
};

export const markRevertedEdgeProposals: Member<'markRevertedEdgeProposals'> = (brain) =>
  storeCall({ member: 'markRevertedEdgeProposals' }, () => brain.markRevertedEdgeProposals());

/** `listEdgeProposalCliRows`: the store answers `created_at` as ISO text; PGLite returns a `Date`. */
export const listEdgeProposalCliRows: Member<'listEdgeProposalCliRows'> = async (brain, filter, limit) => {
  // A limit outside 1 to 1000, or not whole, is refused by the store as by the SQL member (invalid_argument).
  const rows: Array<Record<string, unknown>> = await storeCall({ member: 'listEdgeProposalCliRows' }, () => brain.listEdgeProposalCliRows(filter, limit));
  return rows.map((row) => withDates(row, ['created_at'])) as never;
};

export const deleteHeldEdgeProposalErrors: Member<'deleteHeldEdgeProposalErrors'> = (brain) =>
  storeCall({ member: 'deleteHeldEdgeProposalErrors' }, () => brain.deleteHeldEdgeProposalErrors());

export const listAppliedEdgeProposalIds: Member<'listAppliedEdgeProposalIds'> = (brain) =>
  storeCall({ member: 'listAppliedEdgeProposalIds' }, () => brain.listAppliedEdgeProposalIds());

export const deleteEdgeProposalError: Member<'deleteEdgeProposalError'> = (brain, id) =>
  storeCall({ member: 'deleteEdgeProposalError' }, () => brain.deleteEdgeProposalError(id));

export const readEdgeProposalSourceId: Member<'readEdgeProposalSourceId'> = (brain, id) =>
  storeCall({ member: 'readEdgeProposalSourceId' }, () => brain.readEdgeProposalSourceId(id));

export const markEdgeProposalDated: Member<'markEdgeProposalDated'> = async (brain, id) => {
  await storeCall({ member: 'markEdgeProposalDated' }, () => brain.markEdgeProposalDated(id));
};
