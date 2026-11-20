/**
 * The typed reads of stamped trust tiers (src/core/engine-sql/trust-tier-reads.ts), served from the trust store
 * (rust/crates/gbrain-store/src/trust/tier_reads.rs): `listCorePageRows`, `listTrustScanRows` and
 * `countUnscannedTrustRows` over pages and facts, `listVersionTrustTiers`, `listVersionReasonWriters` and
 * `listPageRefsByIds`, `listPageTrustTiersByKey` and `lockLivePagesByKey`; and the
 * valid-time reads (trust/valid_time.rs) `listValidTimeIdentities` and `pickValidTimeEdition`, and
 * `listAmendmentsNotApplied` (link_queries/link_temporal.rs), `readPageVersionEdition` and
 * `readCursorEdition` (trust/valid_time.rs). `pageAwaitsRederive` answers false: the store keeps no `needs_rederive`
 * queue (only a raw-SQL purge writes one, and `executeRaw` refuses here). `beginSnapshotRead` sets no isolation level: a store transaction is one
 * snapshot already. Its `READ ONLY` is enforced: every later write in the transaction refuses as Postgres refuses it.
 *
 * Refused (`engine_capability_missing`); the members this file does not export refuse as every unserved member does:
 *  - `listCorePageRows` under `excludePrivate` for a caller whose page policy is neither the no-caller one nor the
 *    canonical one for its reader identity and private-readable sources (the remote floor: for no readers), such as
 *    a lineage read or a labelled-only, owner or audience caller;
 *  - the trust scan over `takes` and `timeline_entries`, which the store does not stamp yet;
 *  - `readBeliefHistoryRows` and `listVisibleBeliefLifetimes`, always and before any store call: the store keeps no
 *    belief ledger (every `belief_events` and `belief_page_lifetimes` write goes through `executeRaw`), so a read could
 *    only answer an empty list where PGLite has events (TODOS.md `rust-belief-ledger`);
 *  - `listValidTimeIdentities` under `excludePrivate`, and `pickValidTimeEdition` always, for a caller whose page or
 *    snapshot policy is neither the no-caller one nor the canonical one for its reader identity and private-readable
 *    sources (a labelled-only, owner, audience or lineage caller; the pick reports every row's visibility);
 *  - `pickValidTimeEdition` on a date that is not `YYYY-MM-DD`, rather than guess at Postgres's text order. The store
 *    prunes versions as PGLite does (`version_prune.rs`), so the pick reads the same retained history, each version's
 *    change reason and `successor_pruned` mark, and the page's `version_history_gap_at`;
 *  - `listAmendmentsNotApplied` under `excludePrivate` for a caller whose remote read floor is not the page policy of
 *    no readers (a labelled-only caller), and on dates that are not `YYYY-MM-DD`;
 *  - a limit, cursor or id that is not an integer, rather than guess at PGLite's bind error.
 */
import type { BrainEngine } from '../../engine.ts';
import {
  callerReadersAllowedSql, privacyForCaller, privatePagesFilterForCaller, privatePagesFilterFragment, privateSnapshotFilterFragment,
  remoteReadFloorSql, withoutCallerAccess,
} from '../../search/private-visibility.ts';
import { validDate } from '../../valid-time.ts';
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { mapStoreError } from '../store-errors.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { judgeWidenedCaller, renderForStoreCaller, storePagePolicy, storePageTextPolicy } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const SCAN_TABLES = new Set(['pages', 'facts']);

function requireCount(member: string, name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) refuseMember(member, `a ${name} that is not a non-negative integer`);
}

function requireInteger(member: string, name: string, value: number): void {
  if (!Number.isSafeInteger(value)) refuseMember(member, `a ${name} that is not an integer`);
}

export const listCorePageRows: Member<'listCorePageRows'> = (brain, spec) => {
  const member = 'listCorePageRows';
  requireCount(member, 'limit', spec.limit);
  const policy = spec.excludePrivate
    ? spec.forCaller
      ? storePageTextPolicy(member, () => privatePagesFilterForCaller('p'), { callerReaders: true })
      : storePageTextPolicy(member, () => remoteReadFloorSql('p'), { noReaders: true })
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
  if (!SCAN_TABLES.has(spec.table)) refuseMember(member, `the ${spec.table} table, whose rows the store does not stamp`);
  requireInteger(member, 'cursor', spec.afterId);
  requireCount(member, 'limit', spec.limit);
  return storeCall({ member }, () => brain.listTrustScanRows({ table: spec.table, afterId: spec.afterId, limit: spec.limit, tiers: [...spec.tiers] }));
};

export const countUnscannedTrustRows: Member<'countUnscannedTrustRows'> = (brain, spec) => {
  const member = 'countUnscannedTrustRows';
  if (!SCAN_TABLES.has(spec.table)) refuseMember(member, `the ${spec.table} table, whose rows the store does not stamp`);
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

/** Why the belief reads refuse: an answer from the store would be an empty ledger, never the one PGLite keeps. */
const NO_BELIEF_LEDGER = 'the belief ledger, which the store does not keep yet';

export const readBeliefHistoryRows: Member<'readBeliefHistoryRows'> = async () => refuseMember('readBeliefHistoryRows', NO_BELIEF_LEDGER);

export const listVisibleBeliefLifetimes: Member<'listVisibleBeliefLifetimes'> = async () => refuseMember('listVisibleBeliefLifetimes', NO_BELIEF_LEDGER);

export const listValidTimeIdentities: Member<'listValidTimeIdentities'> = (brain, spec) => {
  const member = 'listValidTimeIdentities';
  const excludePrivate = storePagePolicy(member, spec.excludePrivate, { callerReaders: true }) ?? null;
  const world = storePageTextPolicy(member, () => privatePagesFilterFragment('p'), { noReaders: true });
  return storeCall({ member }, () => brain.listValidTimeIdentities({
    slug: spec.slug, sourceId: spec.sourceId, sourceIds: spec.sourceIds ? [...spec.sourceIds] : null, excludePrivate, world,
  }));
};

/** The snapshot visibility the pick reports for a version row, in the current context. */
const snapshotVisibleSql = () => `${callerReadersAllowedSql('pv', 'snapshot')} AND ${privacyForCaller('p', privateSnapshotFilterFragment('pv'))}`;

const asDate = (v: unknown): Date | null => (typeof v === 'string' ? new Date(v) : null);

export const pickValidTimeEdition: Member<'pickValidTimeEdition'> = async (brain, spec) => {
  const member = 'pickValidTimeEdition';
  requireInteger(member, 'page id', spec.pageId);
  if (spec.pinOrd !== null) requireInteger(member, 'pinned ordinal', spec.pinOrd);
  requireCount(member, 'inline byte limit', spec.inlineMaxBytes);
  if (validDate(spec.asOf) !== spec.asOf) refuseMember(member, 'an as-of date that is not YYYY-MM-DD');
  const policy = storePageTextPolicy(member, () => privatePagesFilterForCaller('p'), { callerReaders: true });
  // The store judges a version by the page policy's readers: the caller's snapshot text must be the canonical one for them.
  const readers = { identity: policy.identity ?? [], privateReadableSources: policy.privateReadableSources ?? [] };
  const snapshotServed = judgeWidenedCaller(() => {
    const text = snapshotVisibleSql();
    if (text === withoutCallerAccess(snapshotVisibleSql)) return true;
    return text === renderForStoreCaller({ ...readers, hidePrivate: true }, snapshotVisibleSql) || undefined;
  });
  if (!snapshotServed) refuseMember(member, 'a caller whose snapshot policy is not the canonical one for its readers');
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
  const excludePrivate = spec.excludePrivate ? storePageTextPolicy(member, () => remoteReadFloorSql('p'), { noReaders: true }) : null;
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

/** No page awaits re-derivation: the store keeps no `needs_rederive` queue (rust/docs/store/takes.md). */
export const pageAwaitsRederive: Member<'pageAwaitsRederive'> = async (_brain, pageId) => {
  requireInteger('pageAwaitsRederive', 'page id', pageId);
  return false;
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
