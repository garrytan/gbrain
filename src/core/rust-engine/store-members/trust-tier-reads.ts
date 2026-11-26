/**
 * The typed reads of stamped trust tiers (src/core/engine-sql/trust-tier-reads.ts), served from the trust store
 * (rust/crates/gbrain-store/src/trust/tier_reads.rs): `listCorePageRows`, `listTrustScanRows` and
 * `countUnscannedTrustRows` over pages, facts, takes and timeline entries, `listVersionTrustTiers`, `listVersionReasonWriters` and
 * `listPageRefsByIds`, `listPageQuoteTiers`, `listPageTrustTiersByKey` and `lockLivePagesByKey`; the belief history reads `readBeliefHistoryRows`
 * and `listVisibleBeliefLifetimes` (trust/belief_history.rs); and the valid-time reads (trust/valid_time.rs) `listValidTimeIdentities` and `pickValidTimeEdition`, and
 * `listAmendmentsNotApplied` (link_queries/link_temporal.rs), `readPageVersionEdition` and
 * `readCursorEdition` (trust/valid_time.rs). `pageAwaitsRederive` reads the store's `needs_rederive` queue
 * (generations/needs_rederive.rs, written by `markNeedsRederive`). `beginSnapshotRead` sets no isolation level: a store transaction is one
 * snapshot already. Its `READ ONLY` is enforced: every later write in the transaction refuses as Postgres refuses it.
 *
 * Refused (`engine_capability_missing`); the members this file does not export refuse as every unserved member does:
 *  - `listCorePageRows` under `excludePrivate` for a caller whose page policy is neither the no-caller one nor the
 *    canonical one for its reader identity and private-readable sources (the remote floor: for no readers), such as
 *    a lineage read or a labelled-only, owner or audience caller;
 *  - `readBeliefHistoryRows` and `listVisibleBeliefLifetimes` for a caller whose remote read floor is not the page
 *    policy of no readers (a labelled-only caller);
 *  - `listValidTimeIdentities` under `excludePrivate`, and `pickValidTimeEdition` always, for a caller whose page or
 *    snapshot policy is neither the no-caller one nor the canonical one for its reader identity and private-readable
 *    sources (a labelled-only, owner, audience or lineage caller; the pick reports every row's visibility);
 *  - `pickValidTimeEdition` on a date that is not `YYYY-MM-DD`, rather than guess at Postgres's text order, and over
 *    a history PGLite would have pruned (more large inline versions than it keeps, a segmented version, a long
 *    holding page): the store never prunes, so its answer would count editions PGLite no longer has and miss the gap
 *    it records (TODOS.md `rust-version-prune`). `reason`, `introduced_because` and `gap_at` read what
 *    `createVersion` stamped (a sync's Git reason and history gap); the raw-SQL reason writers are still refused
 *    (TODOS.md `rust-version-change-reason`);
 *  - `listAmendmentsNotApplied` under `excludePrivate` for a caller whose remote read floor is not the page policy of
 *    no readers (a labelled-only caller), and on dates that are not `YYYY-MM-DD`;
 *  - a limit, cursor or id that is not an integer, rather than guess at PGLite's bind error.
 */
import type { BrainEngine } from '../../engine.ts';
import { privatePagesFilterForCaller, privatePagesFilterFragment, remoteReadFloorSql } from '../../search/private-visibility.ts';
import { validDate } from '../../valid-time.ts';
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { mapStoreError } from '../store-errors.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { snapshotServed } from './access-policies.ts';
import { storePagePolicy, storePageTextPolicy } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const SCAN_TABLES = new Set(['pages', 'facts', 'takes', 'timeline_entries']);

function requireCount(member: string, name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) refuseMember(member, `a ${name} that is not a non-negative integer`);
}

function requireInteger(member: string, name: string, value: number): void {
  if (!Number.isSafeInteger(value)) refuseMember(member, `a ${name} that is not an integer`);
}

/**
 * `listPendingCoreEditNotices`: the store keeps no core edit notices (their only writer, the core guard in
 * persistence/core-guard.ts, goes through `executeRaw`, which this engine refuses), so none is pending.
 */
export const listPendingCoreEditNotices: Member<'listPendingCoreEditNotices'> = async () => [];

export const listCorePageRows: Member<'listCorePageRows'> = (brain, spec) => {
  const member = 'listCorePageRows';
  requireCount(member, 'limit', spec.limit);
  const policy = spec.excludePrivate
    ? spec.forCaller
      ? storePageTextPolicy(member, () => privatePagesFilterForCaller('p'), { callerReaders: true, fragment: 'caller' })
      : storePageTextPolicy(member, () => remoteReadFloorSql('p'), { noReaders: true, fragment: 'floor' })
    : null;
  const e = spec.eligibility;
  return storeCall({ member }, () => brain.listCorePageRows({
    sourceIds: spec.sourceIds ? [...spec.sourceIds] : null,
    exclude: spec.exclude ?? null,
    excludePrivate: policy,
    eligible: e !== undefined,
    minTrust: e?.floor || null,
    suppressFlagged: e?.suppressFlagged === true,
    limit: spec.limit,
  }));
};

export const listTrustScanRows: Member<'listTrustScanRows'> = (brain, spec) => {
  const member = 'listTrustScanRows';
  requireInteger(member, 'cursor', spec.afterId);
  requireCount(member, 'limit', spec.limit);
  return storeCall({ member }, () => brain.listTrustScanRows({ table: spec.table, afterId: spec.afterId, limit: spec.limit, tiers: [...spec.tiers] }));
};

export const countUnscannedTrustRows: Member<'countUnscannedTrustRows'> = (brain, spec) => {
  const member = 'countUnscannedTrustRows';
  requireInteger(member, 'cursor', spec.afterId);
  if (spec.until !== null) requireInteger(member, 'ceiling', spec.until);
  return storeCall({ member }, () => brain.countUnscannedTrustRows({ table: spec.table, afterId: spec.afterId, until: spec.until, tiers: [...spec.tiers] }));
};

export const listVersionTrustTiers: Member<'listVersionTrustTiers'> = (brain, ids) => {
  const member = 'listVersionTrustTiers';
  for (const id of ids) requireInteger(member, 'version id', id);
  return storeCall({ member }, () => brain.listVersionTrustTiers({ ids: [...ids] }));
};

export const listVersionReasonWriters: Member<'listVersionReasonWriters'> = (brain, ids) => {
  const member = 'listVersionReasonWriters';
  for (const id of ids) requireInteger(member, 'version id', id);
  return storeCall({ member }, () => brain.listVersionReasonWriters({ ids: [...ids] }));
};

export const listPageRefsByIds: Member<'listPageRefsByIds'> = async (brain, ids) => {
  const member = 'listPageRefsByIds';
  if (ids.length === 0) return [];
  for (const id of ids) requireInteger(member, 'page id', id);
  const rows: Array<{ id: number; source_id: string; slug: string; type: string | null }> =
    await storeCall({ member }, () => brain.listPageRefsByIds({ ids: [...ids] }));
  return rows.map(r => ({ id: Number(r.id), source_id: r.source_id, slug: r.slug, type: r.type ?? null }));
};

export const listPageQuoteTiers: Member<'listPageQuoteTiers'> = async (brain, spec) => {
  const member = 'listPageQuoteTiers';
  let args: { ids: number[] } | { slug: string; sourceIds: string[] };
  if ('ids' in spec) {
    if (spec.ids.length === 0) return [];
    for (const id of spec.ids) requireInteger(member, 'page id', id);
    args = { ids: [...spec.ids] };
  } else {
    if (spec.sourceIds.length === 0) return [];
    args = { slug: spec.slug, sourceIds: [...spec.sourceIds] };
  }
  const rows: Array<{ id: number; type: string | null; trust_tier: string | null }> =
    await storeCall({ member }, () => brain.listPageQuoteTiers(args));
  return rows.map(r => ({ id: Number(r.id), type: r.type ?? null, trust_tier: r.trust_tier ?? null }));
};

export const listPageTrustTiersByKey: Member<'listPageTrustTiersByKey'> = async (brain, refs) => {
  if (refs.length === 0) return [];
  const rows: Array<{ id: number; source_id: string; slug: string; trust_tier: string | null }> = await storeCall(
    { member: 'listPageTrustTiersByKey' }, () => brain.listPageTrustTiersByKey(refs.map(r => ({ source_id: r.source_id, slug: r.slug }))));
  return rows.map(r => ({ id: Number(r.id), source_id: r.source_id, slug: r.slug, trust_tier: r.trust_tier ?? null }));
};

/** A store transaction is serialized, so the live check needs no row lock: no other write runs until it commits. */
export const lockLivePagesByKey: Member<'lockLivePagesByKey'> = async (brain, refs) => {
  if (refs.length === 0) return [];
  return storeCall({ member: 'lockLivePagesByKey' }, () => brain.lockLivePagesByKey(refs.map(r => ({ source_id: r.source_id, slug: r.slug }))));
};

/** The remote read floor over `p` that `stream_visible` and the visible lifetimes are judged by. */
const beliefFloor = (member: string) => storePageTextPolicy(member, () => remoteReadFloorSql('p'), { noReaders: true, fragment: 'floor' });

export const readBeliefHistoryRows: Member<'readBeliefHistoryRows'> = async (brain, q) => {
  const member = 'readBeliefHistoryRows';
  requireInteger(member, 'cursor', q.afterId);
  requireCount(member, 'limit', q.limit);
  if (q.beforeId !== null) requireInteger(member, 'cursor', q.beforeId);
  const floor = beliefFloor(member);
  const rows: Array<Record<string, unknown>> = await storeCall({ member }, () => brain.readBeliefHistoryRows({
    sourceId: q.sourceId, slug: q.slug, subjectKey: q.subjectKey, afterId: q.afterId, limit: q.limit,
    recordedAfter: q.recordedAfter, recordedUntil: q.recordedUntil, subjectKeys: q.subjectKeys ? [...q.subjectKeys] : null,
    beforeId: q.beforeId, descending: q.descending, floor,
  }));
  // PGLite answers timestamptz columns as dates.
  return rows.map(r => ({ ...r, recorded_at: asDate(r.recorded_at), source_time: asDate(r.source_time) }));
};

export const listVisibleBeliefLifetimes: Member<'listVisibleBeliefLifetimes'> = async (brain, lifetimes) => {
  const member = 'listVisibleBeliefLifetimes';
  const floor = beliefFloor(member);
  return storeCall({ member }, () => brain.listVisibleBeliefLifetimes({ lifetimes: [...lifetimes], floor }));
};

export const listValidTimeIdentities: Member<'listValidTimeIdentities'> = (brain, spec) => {
  const member = 'listValidTimeIdentities';
  const excludePrivate = storePagePolicy(member, spec.excludePrivate, { callerReaders: true }) ?? null;
  const world = storePageTextPolicy(member, () => privatePagesFilterFragment('p'), { noReaders: true, fragment: 'plain' });
  return storeCall({ member }, () => brain.listValidTimeIdentities({
    slug: spec.slug, sourceId: spec.sourceId, sourceIds: spec.sourceIds ? [...spec.sourceIds] : null, excludePrivate, world,
  }));
};

const asDate = (v: unknown): Date | null => (typeof v === 'string' ? new Date(v) : null);

export const pickValidTimeEdition: Member<'pickValidTimeEdition'> = async (brain, spec) => {
  const member = 'pickValidTimeEdition';
  requireInteger(member, 'page id', spec.pageId);
  if (spec.pinOrd !== null) requireInteger(member, 'pinned ordinal', spec.pinOrd);
  requireCount(member, 'inline byte limit', spec.inlineMaxBytes);
  if (validDate(spec.asOf) !== spec.asOf) refuseMember(member, 'an as-of date that is not YYYY-MM-DD');
  const policy = storePageTextPolicy(member, () => privatePagesFilterForCaller('p'), { callerReaders: true, fragment: 'caller' });
  // The store judges a version by the page policy's readers: the caller's snapshot text must be the canonical one for them.
  const readers = { identity: policy.identity ?? [], privateReadableSources: policy.privateReadableSources ?? [] };
  snapshotServed(member, readers);
  const got = await storeCall({ member }, () => brain.pickValidTimeEdition({
    pageId: spec.pageId, asOf: spec.asOf, excludePrivate: spec.excludePrivate, pinOrd: spec.pinOrd, inlineMaxBytes: spec.inlineMaxBytes,
    policy,
  })) as { row: Record<string, unknown> | null };
  if (!got.row) return null;
  const row = got.row;
  return {
    ...row, replaced_at: asDate(row.replaced_at), recorded_since: asDate(row.recorded_since), gap_at: asDate(row.gap_at),
    created_at: asDate(row.created_at),
  };
};

export const listAmendmentsNotApplied: Member<'listAmendmentsNotApplied'> = (brain, spec) => {
  const member = 'listAmendmentsNotApplied';
  requireInteger(member, 'page id', spec.pageId);
  requireCount(member, 'limit', spec.limit);
  if (validDate(spec.editionFrom) !== spec.editionFrom || validDate(spec.asOf) !== spec.asOf) {
    refuseMember(member, 'an edition or as-of date that is not YYYY-MM-DD');
  }
  const excludePrivate = spec.excludePrivate ? storePageTextPolicy(member, () => remoteReadFloorSql('p'), { noReaders: true, fragment: 'floor' }) : null;
  return storeCall({ member }, () => brain.listAmendmentsNotApplied({
    pageId: spec.pageId, editionFrom: spec.editionFrom, asOf: spec.asOf, excludePrivate,
    sourceIds: spec.sourceIds ? [...spec.sourceIds] : null, limit: spec.limit,
  }));
};

export const readPageVersionEdition: Member<'readPageVersionEdition'> = (brain, spec) => {
  const member = 'readPageVersionEdition';
  requireInteger(member, 'page id', spec.pageId);
  requireInteger(member, 'version id', spec.versionId);
  return storeCall({ member }, () => brain.readPageVersionEdition({ pageId: spec.pageId, versionId: spec.versionId }));
};

export const readCursorEdition: Member<'readCursorEdition'> = (brain, spec) => {
  const member = 'readCursorEdition';
  requireInteger(member, 'page id', spec.pageId);
  return storeCall({ member }, () => brain.readCursorEdition({ pageId: spec.pageId, revision: String(spec.revision) }));
};

/** Whether a purge marked the page in `needs_rederive` (generations/needs_rederive.rs); false for a missing page. */
export const pageAwaitsRederive: Member<'pageAwaitsRederive'> = async (brain, pageId) => {
  requireInteger('pageAwaitsRederive', 'page id', pageId);
  return storeCall({ member: 'pageAwaitsRederive' }, () => brain.pageAwaitsRederive(pageId));
};

/**
 * `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ [READ ONLY]`. A store transaction holds the store's one writer
 * from its start, so its reads already see one state and there is no isolation level to set. `READ ONLY` makes the
 * store refuse every later write in the transaction with `read_only_transaction`, which `mapStoreError` turns into
 * Postgres's SQLSTATE 25006 refusal. Outside a transaction it does nothing, as `SET TRANSACTION` there only warns on
 * Postgres. Refuses on a transaction that has ended, as the other transaction members do.
 */
export const beginSnapshotRead = async function beginSnapshotRead(this: RustEngine, _brain: StoreBrain, opts?: { readOnly?: boolean }): Promise<void> {
  const scope = this._txScope;
  if (scope?.ended) throw mapStoreError({ code: 'store_closed' }, { member: 'beginSnapshotRead' });
  if (!scope || opts?.readOnly !== true) return;
  try {
    await scope.brain.setTransactionReadOnly();
  } catch (error) {
    throw mapStoreError(error, { member: 'beginSnapshotRead' });
  }
};
