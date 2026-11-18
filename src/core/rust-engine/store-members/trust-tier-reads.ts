/**
 * The typed reads of stamped trust tiers (src/core/engine-sql/trust-tier-reads.ts), served from the trust store
 * (rust/crates/gbrain-store/src/trust/tier_reads.rs): `listCorePageRows`, `listTrustScanRows` and
 * `countUnscannedTrustRows` over pages and facts, `listVersionTrustTiers` and `listVersionReasonWriters`.
 *
 * Refused (`engine_capability_missing`); the members this file does not export refuse as every unserved member does:
 *  - `listCorePageRows` under `excludePrivate` for a caller whose page policy is not the no-caller one (a member
 *    page, a grant, a lineage read, a labelled-only caller), as `storePagePolicy` refuses it;
 *  - the trust scan over `takes` and `timeline_entries`, which the store does not stamp yet;
 *  - `readBeliefHistoryRows` and `listVisibleBeliefLifetimes`: the store keeps no belief ledger;
 *  - `pickValidTimeEdition`: the store has no valid-time read;
 *  - a limit, cursor or id that is not an integer, rather than guess at PGLite's bind error.
 */
import type { BrainEngine } from '../../engine.ts';
import { privatePagesFilterForCaller, remoteReadFloorSql } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePageTextPolicy } from './private-provenance.ts';

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
    ? storePageTextPolicy(member, () => (spec.forCaller ? privatePagesFilterForCaller('p') : remoteReadFloorSql('p')))
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
