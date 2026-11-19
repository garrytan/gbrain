/**
 * Group 5 facts members, purge, withdrawal, relink and fence repair (src/core/engine-sql/facts-purge.ts), served from the facts
 * store (rust/crates/gbrain-store/src/facts/purge.rs). Each member sends the arguments of its BrainEngine member and
 * turns the ISO times the store returns into `Date`s, as PGLite returns them.
 *
 * A member not exported here refuses with `engine_capability_missing`: `listFactsReconcileBacklog` reads
 * `page_facts_reconcile`, a table the store does not have. `listSingleFactMetadata` is served by facts-trust-reads.ts.
 * `findActiveSingleFact` serves the remote provenance floor for a caller that does not change it (storeFloorPolicy) and
 * `listSimilarActiveFacts` serves `excludePrivate`; each refuses a caller whose policy the store does not model
 * (private-provenance.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import { privateProvenanceFilterUnderPolicy } from '../../search/private-visibility.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';
import { storeFloorPolicy, storePrivacyPolicy } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;
type Row = Record<string, unknown>;

/** The date columns of a `SELECT * FROM facts` row. */
const FACT_DATES = ['valid_from', 'valid_until', 'expired_at', 'consolidated_at', 'embedded_at', 'created_at', 'last_written_at'] as const;
const FENCE_DATES = ['valid_from', 'valid_until'] as const;

export const countFactFingerprintLeftovers: Member<'countFactFingerprintLeftovers'> = (brain, sourceId, factHash, visibility, subject) =>
  storeCall({ member: 'countFactFingerprintLeftovers' }, () => brain.countFactFingerprintLeftovers({ sourceId, factHash, visibility, subject }));

export const loadPurgeTarget: Member<'loadPurgeTarget'> = (brain, id, sourceId) =>
  storeCall({ member: 'loadPurgeTarget' }, () => brain.loadPurgeTarget({ id, sourceId }));

export const planFactPurgeIds: Member<'planFactPurgeIds'> = (brain, sourceId, visibility, factHash, subject) =>
  storeCall({ member: 'planFactPurgeIds' }, () => brain.planFactPurgeIds({ sourceId, visibility, factHash, subject }));

export const listRelinkCandidateRows: Member<'listRelinkCandidateRows'> = (brain, opts) =>
  storeCall({ member: 'listRelinkCandidateRows' }, () => brain.listRelinkCandidateRows({
    sourceId: opts.sourceId, afterId: opts.afterId, since: opts.since ? opts.since.toISOString() : null, limit: opts.limit }));

export const countRelinkCandidates: Member<'countRelinkCandidates'> = (brain, sourceId) =>
  storeCall({ member: 'countRelinkCandidates' }, () => brain.countRelinkCandidates({ sourceId }));

export const listSimilarActiveFacts: Member<'listSimilarActiveFacts'> = (brain, opts) => {
  // A caller with a reader identity and a private-readable grant is served (`callerReaders`).
  const excludePrivate = storePrivacyPolicy('listSimilarActiveFacts', opts.excludePrivate, () => privateProvenanceFilterUnderPolicy('facts'),
    { callerReaders: true });
  return storeCall({ member: 'listSimilarActiveFacts' }, () => brain.listSimilarActiveFacts({
    sourceId: opts.sourceId, factId: opts.factId, remote: opts.remote, minCosine: opts.minCosine, limit: opts.limit, excludePrivate }));
};

export const findActiveSingleFact: Member<'findActiveSingleFact'> = async (brain, opts) => {
  const remoteFloor = opts.remoteFloor ? storeFloorPolicy('findActiveSingleFact') : undefined;
  const row: Row | null = await storeCall({ member: 'findActiveSingleFact' }, () => brain.findActiveSingleFact({
    sourceId: opts.sourceId, entitySlug: opts.entitySlug, visibility: opts.visibility, fact: opts.fact,
    attributedTo: opts.attributedTo, pageSlug: opts.pageSlug, remoteFloor, newest: opts.newest === true }));
  return row === null ? null : withDates(row, FACT_DATES) as never;
};

export const listUnfencedFactRows: Member<'listUnfencedFactRows'> = async (brain, opts) => {
  const rows: Row[] = await storeCall({ member: 'listUnfencedFactRows' }, () => brain.listUnfencedFactRows({ sourceId: opts.sourceId ?? null }));
  return rows.map((row) => withDates(row, FENCE_DATES)) as never;
};

export const listHeldFenceFactRows: Member<'listHeldFenceFactRows'> = async (brain, sourceId, slug) => {
  const rows: Row[] = await storeCall({ member: 'listHeldFenceFactRows' }, () => brain.listHeldFenceFactRows({ sourceId, slug }));
  return rows.map((row) => withDates(row, FENCE_DATES)) as never;
};

export const listWithdrawalSlugs: Member<'listWithdrawalSlugs'> = (brain, sourceId, visibility, factHash, subject) =>
  storeCall({ member: 'listWithdrawalSlugs' }, () => brain.listWithdrawalSlugs({ sourceId, visibility, factHash, subject }));

export const expireFactsByWithdrawal: Member<'expireFactsByWithdrawal'> = (brain, sourceId, visibility, fact, subject) =>
  storeCall({ member: 'expireFactsByWithdrawal' }, () => brain.expireFactsByWithdrawal({ sourceId, visibility, fact, subject }));

export const insertFactPurge: Member<'insertFactPurge'> = (brain, row) =>
  storeCall({ member: 'insertFactPurge', sourceId: row.sourceId }, () => brain.insertFactPurge(row));
