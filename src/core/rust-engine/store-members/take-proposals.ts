/**
 * The take proposal queue (engine-sql/take-proposals.ts), served by the store (store A 0x08/0x09, gbrain-store
 * takes/proposals.rs; rust/docs/store/takes-reads.md, "Take proposals"): what the propose_takes cycle step reads and
 * writes, what `gbrain takes propose` lists, accepts and rejects, the op checkpoint document of its failure ledger and
 * the write requests an accept admitted under one request id.
 *
 * `proposed_at` and a claim's `acted_at` come back as Dates, as PGLite returns a timestamptz; a tombstone's
 * `proposed_at` is Postgres text (`proposed_at::text`). An id or row number that is not an integer refuses, as the
 * SQL's integer casts refuse it.
 */
import type {
  ProposeTakesCandidateScope, ProposeTakesPageRow, TakeProposalClaim, TakeProposalInsert, TakeProposalPageKey, TakeProposalRow,
  TakeProposalTombstone,
} from '../../engine-sql/take-proposals.ts';
import type { WriteRequest } from '../../persistence/model.ts';
import { requestRow, withDates } from '../store-codec.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

function int(member: string, value: number): number {
  if (!Number.isSafeInteger(value)) refuseMember(member, 'an id or row number that is not an integer');
  return value;
}

const proposalRow = (row: unknown): TakeProposalRow | null =>
  row === null || row === undefined ? null : withDates(row as TakeProposalRow, ['proposed_at']);

const claimRow = (row: unknown): TakeProposalClaim | null =>
  row === null || row === undefined ? null : withDates(row as TakeProposalClaim, ['acted_at']);

export const listPendingTakeProposals: StoreMember<[opts: { sourceId?: string; limit: number }], TakeProposalRow[]> = async (brain, opts) => {
  // The SQL engines clamp the same way before they bind LIMIT; an infinity reaches an end, and NaN fails as Postgres
  // fails the bigint LIMIT parameter (22P02) instead of crossing the addon as a JSON null.
  const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit)));
  if (Number.isNaN(limit)) throw Object.assign(new Error('invalid input syntax for type bigint: "NaN"'), { code: '22P02' });
  const spec: Record<string, unknown> = { limit };
  if (opts.sourceId) spec.sourceId = opts.sourceId;
  const rows = await storeCall({ member: 'listPendingTakeProposals' }, () => brain.listPendingTakeProposals(spec)) as unknown[];
  return rows.map(row => proposalRow(row)!);
};

export const readTakeProposal: StoreMember<[id: number, sourceId?: string], TakeProposalRow | null> = async (brain, id, sourceId) =>
  proposalRow(await storeCall({ member: 'readTakeProposal' }, () => brain.readTakeProposal(int('readTakeProposal', id), sourceId || null)));

export const claimTakeProposal: StoreMember<[id: number, actedBy: string], TakeProposalClaim | null> = async (brain, id, actedBy) =>
  claimRow(await storeCall({ member: 'claimTakeProposal' }, () => brain.claimTakeProposal(int('claimTakeProposal', id), actedBy)));

export const readStrandedTakeProposalClaim: StoreMember<[id: number], TakeProposalClaim | null> = async (brain, id) =>
  claimRow(await storeCall({ member: 'readStrandedTakeProposalClaim' }, () =>
    brain.readStrandedTakeProposalClaim(int('readStrandedTakeProposalClaim', id))));

export const releaseTakeProposalClaim: StoreMember<[id: number, claimedAt: string | null], void> = async (brain, id, claimedAt) => {
  await storeCall({ member: 'releaseTakeProposalClaim' }, () => brain.releaseTakeProposalClaim(int('releaseTakeProposalClaim', id), claimedAt));
};

export const setTakeProposalPromotedRow: StoreMember<[id: number, rowNum: number], void> = async (brain, id, rowNum) => {
  await storeCall({ member: 'setTakeProposalPromotedRow' }, () =>
    brain.setTakeProposalPromotedRow(int('setTakeProposalPromotedRow', id), int('setTakeProposalPromotedRow', rowNum)));
};

export const rejectTakeProposal: StoreMember<[id: number, actedBy: string], boolean> = async (brain, id, actedBy) =>
  Boolean(await storeCall({ member: 'rejectTakeProposal' }, () => brain.rejectTakeProposal(int('rejectTakeProposal', id), actedBy)));

export const takeProposalCached: StoreMember<[key: TakeProposalPageKey], boolean> = async (brain, key) =>
  Boolean(await storeCall({ member: 'takeProposalCached' }, () => brain.takeProposalCached({
    sourceId: key.sourceId, pageSlug: key.pageSlug, contentHash: key.contentHash, promptVersion: key.promptVersion,
  })));

export const listRejectedTakeProposalClaims: StoreMember<[sourceId: string, pageSlug: string], string[]> = (brain, sourceId, pageSlug) =>
  storeCall({ member: 'listRejectedTakeProposalClaims' }, () => brain.listRejectedTakeProposalClaims(sourceId, pageSlug));

export const insertTakeProposal: StoreMember<[p: TakeProposalInsert], number | null> = async (brain, p) => {
  const input: Record<string, unknown> = {
    sourceId: p.sourceId, pageSlug: p.pageSlug, contentHash: p.contentHash, promptVersion: p.promptVersion, proposalRunId: p.proposalRunId,
    claimText: p.claimText, kind: p.kind, holder: p.holder, weight: p.weight, domain: p.domain ?? null,
    // Stored as the JSON text the SQL binds (`$11::text::jsonb`): a value JSON cannot hold drops as it does there.
    dedupAgainst: JSON.parse(JSON.stringify(p.dedupAgainst ?? null)) as unknown, modelId: p.modelId,
  };
  if (p.status === 'rejected') input.status = 'rejected';
  const id = await storeCall({ member: 'insertTakeProposal' }, () => brain.insertTakeProposal(input)) as number | null;
  return id === null || id === undefined ? null : Number(id);
};

export const listTakeProposalTombstones: StoreMember<[sourceId: string, prefix: string], TakeProposalTombstone[]> = async (brain, sourceId, prefix) => {
  const rows = await storeCall({ member: 'listTakeProposalTombstones' }, () => brain.listTakeProposalTombstones(sourceId, prefix)) as TakeProposalTombstone[];
  return rows.map(row => ({ ...row, id: Number(row.id) }));
};

export const deleteTakeProposalTombstones: StoreMember<[sourceId: string, prefix: string, slug?: string], string[]> = (brain, sourceId, prefix, slug) =>
  storeCall({ member: 'deleteTakeProposalTombstones' }, () => brain.deleteTakeProposalTombstones(sourceId, prefix, slug ?? null));

export const listProposeTakesCandidatePages: StoreMember<[scope: ProposeTakesCandidateScope], ProposeTakesPageRow[]> = (brain, scope) => {
  const spec: Record<string, unknown> = { types: scope.types ? [...scope.types] : null, limit: int('listProposeTakesCandidatePages', scope.limit) };
  if (scope.sourceIds && scope.sourceIds.length > 0) spec.sourceIds = [...scope.sourceIds];
  else if (scope.sourceId) spec.sourceId = scope.sourceId;
  return storeCall({ member: 'listProposeTakesCandidatePages' }, () => brain.listProposeTakesCandidatePages(spec));
};

export const readOpCheckpointDoc: StoreMember<[op: string, fingerprint: string], unknown> = async (brain, op, fingerprint) =>
  (await storeCall({ member: 'readOpCheckpointDoc' }, () => brain.readOpCheckpointDoc(op, fingerprint))) ?? null;

export const writeOpCheckpointDoc: StoreMember<[op: string, fingerprint: string, doc: unknown], void> = async (brain, op, fingerprint, doc) => {
  // The SQL binds `JSON.stringify([doc])`: the store keeps what that text parses back to.
  const [stored] = JSON.parse(JSON.stringify([doc])) as unknown[];
  await storeCall({ member: 'writeOpCheckpointDoc' }, () => brain.writeOpCheckpointDoc(op, fingerprint, stored ?? null));
};

export const listWriteRequestsByRequestId: StoreMember<[requestId: string], WriteRequest[]> = async (brain, requestId) => {
  const rows = await storeCall({ member: 'listWriteRequestsByRequestId' }, () => brain.listWriteRequestsByRequestId(requestId)) as unknown[];
  return rows.map(row => requestRow<WriteRequest>(row)!);
};
