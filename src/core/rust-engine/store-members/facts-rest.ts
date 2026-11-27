/**
 * Group 5 facts members of the claim-conflict sweep, the contested-proposal lookup, the live entity page read and the
 * purge's gone-page expiry (src/core/engine-sql/facts-trust.ts and facts-purge.ts), served from the facts store
 * (rust/crates/gbrain-store/src/facts/rest_sites.rs). A member not exported here refuses with `engine_capability_missing`.
 *
 * Served: `listClaimConflictPairs`, `countClaimConflictPairs`, `listAllUnarchivedSourceIds` and `listUnarchivedSourceRows` (the store's unarchived source
 * list), `readLiveFactEntityPage`, `listContestedProposalPairs`, `lockAgentWritebackSetting` and `expireFactsOfGonePages`.
 *
 * `readLiveFactEntityPage` under `excludePrivate` serves the remote read floor for a caller with no widening member pages,
 * grants or lineage, and `listContestedProposalPairs` serves the fact privacy policy of `privateFactFilterForCaller` the
 * same way (reader identities and private-readable grants included); any other caller refuses. The store has one writer,
 * so `lockAgentWritebackSetting` has nothing to take: it answers as the SQL does, with nothing.
 */
import type { BrainEngine } from '../../engine.ts';
import { privateFactFilterForCaller, remoteReadFloorSql } from '../../search/private-visibility.ts';
import { storeCall, type StoreMember } from './common.ts';
import { storePageTextPolicy, storePrivacyPolicy } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listClaimConflictPairs: Member<'listClaimConflictPairs'> = (brain, sourceId, auditSources, cap) =>
  storeCall({ member: 'listClaimConflictPairs', sourceId }, () => brain.listClaimConflictPairs({ sourceId, auditSources, cap }));

export const countClaimConflictPairs: Member<'countClaimConflictPairs'> = (brain, sourceId, auditSources) =>
  storeCall({ member: 'countClaimConflictPairs', sourceId }, () => brain.countClaimConflictPairs({ sourceId, auditSources }));

/** The unarchived sources by id: the store's `listActiveSourceIds`, the same `{ id }` rows. */
export const listAllUnarchivedSourceIds: Member<'listAllUnarchivedSourceIds'> = brain =>
  storeCall({ member: 'listAllUnarchivedSourceIds' }, () => brain.listActiveSourceIds());
/** The trust module's read of the same rows (`SELECT id FROM sources WHERE NOT archived ORDER BY id COLLATE "C"`). */
export const listUnarchivedSourceRows: Member<'listUnarchivedSourceRows'> = brain =>
  storeCall({ member: 'listUnarchivedSourceRows' }, () => brain.listActiveSourceIds());

export const readLiveFactEntityPage: Member<'readLiveFactEntityPage'> = (brain, sourceId, slug, excludePrivate) => {
  const member = 'readLiveFactEntityPage';
  const policy = excludePrivate ? storePageTextPolicy(member, () => remoteReadFloorSql('p')) : undefined;
  return storeCall({ member, sourceId }, () => brain.readLiveFactEntityPage({ sourceId, slug, policy }));
};

export const listContestedProposalPairs: Member<'listContestedProposalPairs'> = async (brain, ids, policy) => {
  const member = 'listContestedProposalPairs';
  const excludePrivate = storePrivacyPolicy(member, policy.excludePrivate, () => privateFactFilterForCaller('facts'), { callerReaders: true });
  const rows = await storeCall({ member }, () => brain.listContestedProposalPairs({
    ids, remote: policy.remote, excludePrivate,
    minTrust: policy.eligibility?.floor || null, suppressFlagged: policy.eligibility?.suppressFlagged === true,
  }));
  return rows as never;
};

/** The advisory lock serializes writers of one setting; the store runs one writer at a time, so there is nothing to take. */
export const lockAgentWritebackSetting: Member<'lockAgentWritebackSetting'> = async () => undefined;

export const expireFactsOfGonePages: Member<'expireFactsOfGonePages'> = async (brain, sourceIds, slugs) => {
  await storeCall({ member: 'expireFactsOfGonePages' }, () => brain.expireFactsOfGonePages({ sourceIds, slugs }));
};
