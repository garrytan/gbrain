/**
 * Group 5 facts members, purge, withdrawal, relink and fence repair (src/core/engine-sql/facts-purge.ts), served from the facts
 * store (rust/crates/gbrain-store/src/facts/purge.rs). Each member sends the arguments of its BrainEngine member and
 * turns the ISO times the store returns into `Date`s, as PGLite returns them.
 *
 * `listFactsReconcileBacklog`, `settleFactsReconcile` and `selectFactsReconcileDrain` read and write the store's
 * `page_facts_reconcile` watermark (facts/reconcile.rs). `lockReconcileRevision` reads the page inside the caller's store
 * transaction, whose single writer is the lock, so the extract_facts commit step (lock, then 'complete' settle) runs whole.
 * `listSingleFactMetadata` is served by facts-trust-reads.ts. `readPurgeSourceLocalPath` and `lockPurgeSource` read the
 * source record, as memory-mutation-reads.ts's `readSourceLocalPath` and `readSourceWriteRow` do.
 * `recordDerivationEdges` and `listDerivedRows` (src/core/engine-sql/facts-trust.ts) write and walk one hop of the store's
 * `derivation_inputs` rows (generations/derivation_inputs.rs, keys `h 0x0A` and `h 0x0B`); the store calls the write
 * `recordDerivationInputs`. `countLegacyDerivedPages` (purge-plan.ts) reads the same rows (facts/purge_plan.rs).
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
import type { StoreBrain } from '../store.ts';
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

/** The store lists every unfenced row, with whether its entity page is live; `countUnfencedFactGroups` and `fenceableSourceIds` are answered from that list (the store has no member that counts or narrows them on its side). */
const unfencedRows = async (brain: StoreBrain, sourceId: string | undefined): Promise<Row[]> =>
  (await storeCall({ member: 'listUnfencedFactRows' }, () => brain.listUnfencedFactRows({ sourceId: sourceId ?? null }))) as Row[];

export const listUnfencedFactRows: Member<'listUnfencedFactRows'> = async (brain, opts) => {
  const fenceable = opts.fenceableSourceIds === undefined ? undefined : new Set(opts.fenceableSourceIds);
  const rows = (await unfencedRows(brain, opts.sourceId))
    .filter((row) => fenceable === undefined || (fenceable.has(row.source_id as string) && row.entity_slug !== null && row.page_exists === true));
  return rows.map((row) => withDates(row, FENCE_DATES)) as never;
};

export const countUnfencedFactGroups: Member<'countUnfencedFactGroups'> = async (brain, opts) => {
  const groups = new Map<string, { source_id: string; has_entity: boolean; page_exists: boolean; n: number }>();
  for (const row of await unfencedRows(brain, opts.sourceId)) {
    const group = { source_id: row.source_id as string, has_entity: row.entity_slug !== null, page_exists: row.page_exists === true, n: 0 };
    const key = `${group.source_id}\0${group.has_entity}\0${group.page_exists}`;
    const seen = groups.get(key) ?? group;
    seen.n += 1;
    groups.set(key, seen);
  }
  return [...groups.values()];
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

export const upsertPagePurges: Member<'upsertPagePurges'> = async (brain, row) => {
  await storeCall({ member: 'upsertPagePurges', sourceId: row.sourceId }, () => brain.upsertPagePurges(row));
};

export const insertTakePurge: Member<'insertTakePurge'> = (brain, row) =>
  storeCall({ member: 'insertTakePurge', sourceId: row.sourceId }, () => brain.insertTakePurge(row));

/** `readPurgeSourceLocalPath`: the source's checkout from the source record, as `readSourceLocalPath` reads it. */
export const readPurgeSourceLocalPath: Member<'readPurgeSourceLocalPath'> = (brain, sourceId) =>
  storeCall({ member: 'readPurgeSourceLocalPath' }, () => brain.readSourceLocalPath(sourceId));

/**
 * `lockPurgeSource`: the source's incarnation and archived flag from the source record. FOR UPDATE changes nothing
 * here. The purge runs in `engine.transaction`, and the store opens every explicit transaction with the writer held
 * until it ends (`Store::begin_transaction` in rust/crates/gbrain-store/src/transactions.rs: `Kv::begin_write` on
 * redb; `Kv::begin_write_exclusive` when concurrent writes are on, where the commit pipeline lands nothing else until
 * the transaction ends and a concurrent writer that read the source record reruns). So no other write reaches the
 * source record before the purge commits or rolls back.
 */
export const lockPurgeSource: Member<'lockPurgeSource'> = async (brain, sourceId) => {
  const row: { incarnation: string; archived: boolean } | null = await storeCall({ member: 'lockPurgeSource' }, () => brain.readSourceWriteRow(sourceId));
  return row ? { incarnation: row.incarnation, archived: row.archived } : null;
};

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

/**
 * One hop of the walk over the store's `derivation_inputs` rows (facts/purge.rs list_derived_rows, the `h 0x0B` index).
 * A limit or id that is not what PGLite binds is refused rather than answered.
 */
export const listDerivedRows: Member<'listDerivedRows'> = (brain, frontier, limit) => {
  const member = 'listDerivedRows';
  if (!Number.isSafeInteger(limit)) refuseMember(member, 'a limit that is not an integer');
  for (const ref of frontier) if (typeof ref.table !== 'string' || typeof ref.id !== 'string') refuseMember(member, 'a frontier row whose table or id is not text');
  return storeCall({ member }, () => brain.listDerivedRows({ frontier: frontier.map((f) => ({ table: f.table, id: f.id })), limit }));
};

/** The ids of a `bigint[]` argument as the store reads them; an id that is not a safe integer is refused, not rounded. */
function purgeIds(member: string, ids: readonly number[]): number[] {
  for (const id of ids) if (!Number.isSafeInteger(id)) refuseMember(member, 'an id that is not an integer');
  return [...ids];
}

/*
 * The writes a purge runs in its transaction (facts/purge_writes.rs). Each answers what the SQL member answers: the
 * number of rows deleted, or the deleted hold ids as text.
 */
export const deletePurgedTakes: Member<'deletePurgedTakes'> = (brain, takeIds) =>
  storeCall({ member: 'deletePurgedTakes' }, () => brain.deletePurgedTakes(purgeIds('deletePurgedTakes', takeIds)));

export const deletePurgeReviewQueue: Member<'deletePurgeReviewQueue'> = (brain, sourceId, refs) =>
  storeCall({ member: 'deletePurgeReviewQueue', sourceId }, () => brain.deletePurgeReviewQueue(sourceId, [...refs]));

export const deletePurgeReviewProposals: Member<'deletePurgeReviewProposals'> = (brain, sourceId, refs) =>
  storeCall({ member: 'deletePurgeReviewProposals', sourceId }, () => brain.deletePurgeReviewProposals(sourceId, [...refs]));

export const deletePurgeDecideProposals: Member<'deletePurgeDecideProposals'> = (brain, sourceId, factIds) =>
  storeCall({ member: 'deletePurgeDecideProposals', sourceId }, () =>
    brain.deletePurgeDecideProposals(sourceId, purgeIds('deletePurgeDecideProposals', factIds)));

export const deletePurgeTrustProposals: Member<'deletePurgeTrustProposals'> = (brain, sourceId, factIds, takeIds) =>
  storeCall({ member: 'deletePurgeTrustProposals', sourceId }, () => brain.deletePurgeTrustProposals(sourceId,
    purgeIds('deletePurgeTrustProposals', factIds), purgeIds('deletePurgeTrustProposals', takeIds)));

export const deletePurgeOpenLoops: Member<'deletePurgeOpenLoops'> = (brain, sourceId, factIds) =>
  storeCall({ member: 'deletePurgeOpenLoops', sourceId }, () => brain.deletePurgeOpenLoops(sourceId, purgeIds('deletePurgeOpenLoops', factIds)));

export const deletePurgeWriteGateHolds: Member<'deletePurgeWriteGateHolds'> = (brain, sourceId, factHash) =>
  storeCall({ member: 'deletePurgeWriteGateHolds', sourceId }, () => brain.deletePurgeWriteGateHolds(sourceId, factHash));

export const deletePurgeWriteGateReceipts: Member<'deletePurgeWriteGateReceipts'> = (brain, factIds, takeIds, holdIds) =>
  storeCall({ member: 'deletePurgeWriteGateReceipts' }, () => brain.deletePurgeWriteGateReceipts([...factIds], [...takeIds], [...holdIds]));

/**
 * `blankPurgeCoreEditNotices`: the store keeps no core edit notices (their only writer, the core guard in
 * persistence/core-guard.ts, goes through `executeRaw`, which this engine refuses), so it blanks none.
 */
export const blankPurgeCoreEditNotices: Member<'blankPurgeCoreEditNotices'> = async () => 0;

export const deletePurgedFacts: Member<'deletePurgedFacts'> = (brain, factIds, sourceId) =>
  storeCall({ member: 'deletePurgedFacts', sourceId }, () => brain.deletePurgedFacts(purgeIds('deletePurgedFacts', factIds), sourceId));

export const deletePurgedChunks: Member<'deletePurgedChunks'> = (brain, pageIds) =>
  storeCall({ member: 'deletePurgedChunks' }, () => brain.deletePurgedChunks(purgeIds('deletePurgedChunks', pageIds)));

/** The date columns of a page row, which come back `Date`s, as PGLite returns `SELECT p.*`. */
const PAGE_DATES = ['created_at', 'updated_at', 'deleted_at', 'effective_date', 'ingested_at'] as const;

/** `listPagesForPurgeRewrite`: each page as `getPage` gives it, with `body_storage` and its tags as `purge_tags`. */
export const listPagesForPurgeRewrite: Member<'listPagesForPurgeRewrite'> = async (brain, sourceId, pageIds) => {
  const rows: Row[] = await storeCall({ member: 'listPagesForPurgeRewrite', sourceId }, () =>
    brain.listPagesForPurgeRewrite(sourceId, purgeIds('listPagesForPurgeRewrite', pageIds)));
  return rows.map(row => withDates(row, [...PAGE_DATES]));
};

export const updatePageBodyForPurge: Member<'updatePageBodyForPurge'> = async (brain, sourceId, pageId, compiled, timeline, hash) => {
  if (!Number.isSafeInteger(pageId)) refuseMember('updatePageBodyForPurge', 'a page id that is not an integer');
  await storeCall({ member: 'updatePageBodyForPurge', sourceId }, () => brain.updatePageBodyForPurge(sourceId, pageId, compiled, timeline, hash));
};
