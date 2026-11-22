/**
 * Group 5 facts members, purge, withdrawal, relink and fence repair (src/core/engine-sql/facts-purge.ts), served from the facts
 * store (rust/crates/gbrain-store/src/facts/purge.rs). Each member sends the arguments of its BrainEngine member and
 * turns the ISO times the store returns into `Date`s, as PGLite returns them.
 *
 * `listFactsReconcileBacklog`, `settleFactsReconcile` and `selectFactsReconcileDrain` read and write the store's
 * `page_facts_reconcile` watermark (facts/reconcile.rs). `lockReconcileRevision` reads the page inside the caller's store
 * transaction, whose single writer is the lock, so the extract_facts commit step (lock, then 'complete' settle) runs whole.
 * `listSingleFactMetadata` is served by facts-trust-reads.ts.
 * `recordDerivationEdges` and `listDerivedRows` (src/core/engine-sql/facts-trust.ts) write and walk one hop of the store's
 * `derivation_inputs` rows (generations/derivation_inputs.rs, keys `h 0x0A` and `h 0x0B`); the store calls the write
 * `recordDerivationInputs`. `countLegacyDerivedPages` reads the same rows (derivation_lineage.rs).
 * `findActiveSingleFact` serves the remote provenance floor for a caller that does not change it (storeFloorPolicy) and
 * `listSimilarActiveFacts` serves `excludePrivate`; each refuses a caller whose policy the store does not model
 * (private-provenance.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import { privateProvenanceFilterUnderPolicy } from '../../search/private-visibility.ts';
import { withDates } from '../store-codec.ts';
import { FACTS_FENCE_BEGIN } from '../../facts-fence.ts';
import { FACTLESS_SETTLE_LIMIT } from '../../engine-sql/facts-purge.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { mapStoreError, storeErrorCode } from '../store-errors.ts';
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

/** `listFactsReconcileBacklog`: the store matches the fence marker as plain text, as the SQL's `LIKE '%marker%'` does. */
export const listFactsReconcileBacklog: Member<'listFactsReconcileBacklog'> = (brain) =>
  storeCall({ member: 'listFactsReconcileBacklog' }, () => brain.listFactsReconcileBacklog({ marker: FACTS_FENCE_BEGIN }));

/** `settleFactsReconcile`: an `undefined` revision settles at the page's current revision, as the SQL's `$5` flag does. */
export const settleFactsReconcile: Member<'settleFactsReconcile'> = (brain, sourceId, slug, outcome, revision) =>
  storeCall({ member: 'settleFactsReconcile' }, async () => {
    await brain.settleFactsReconcile({ sourceId, slug, outcome, revision: revision ?? null, anyRevision: revision === undefined });
  });

/** `lockReconcileRevision`: the store's transaction holds its single writer until commit, which is the row lock. */
export const lockReconcileRevision: Member<'lockReconcileRevision'> = (brain, sourceId, slug, revision) =>
  storeCall({ member: 'lockReconcileRevision' }, () => brain.lockReconcileRevision({ sourceId, slug, revision }));

/** `selectFactsReconcileDrain`: the store matches the fence marker as plain text and settles at most FACTLESS_SETTLE_LIMIT pages, as the SQL does. */
export const selectFactsReconcileDrain: Member<'selectFactsReconcileDrain'> = (brain, sourceId, pageLimit) =>
  storeCall({ member: 'selectFactsReconcileDrain' }, () => brain.selectFactsReconcileDrain({
    sourceId, marker: FACTS_FENCE_BEGIN, settleLimit: FACTLESS_SETTLE_LIMIT, pageLimit }));

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

/**
 * Each edge goes to the store as `{ table, id }`; the store keeps it once, as `ON CONFLICT DO NOTHING` does. A source the
 * store does not hold refuses as the SQL engines' foreign key does (code 23503), and records nothing.
 */
export const recordDerivationEdges: Member<'recordDerivationEdges'> = async (brain, derived, sourceId, edges) => {
  try {
    await brain.recordDerivationInputs({
      derived: { table: derived.table, id: derived.id }, sourceId, inputs: edges.map((e) => ({ table: e.table, id: e.id })) });
  } catch (error) {
    if (storeErrorCode(error) === 'source_not_found') {
      throw Object.assign(new Error('insert or update on table "derivation_inputs" violates foreign key constraint "derivation_inputs_source_id_fkey"'),
        { code: '23503' });
    }
    throw mapStoreError(error, { member: 'recordDerivationEdges' });
  }
};

export const listDerivedRows: Member<'listDerivedRows'> = (brain, frontier, limit) =>
  storeCall({ member: 'listDerivedRows' }, () => brain.listDerivedRows({
    frontier: frontier.map((f) => ({ table: f.table, id: f.id })), limit }));

/** The source's live atom and dream pages that no recorded edge explains. */
export const countLegacyDerivedPages: Member<'countLegacyDerivedPages'> = (brain, sourceId) =>
  storeCall({ member: 'countLegacyDerivedPages', sourceId }, () => brain.countLegacyDerivedPages(sourceId));
