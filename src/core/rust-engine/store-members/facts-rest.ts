/**
 * Group 5 facts members of the claim-conflict sweep, the contested-proposal lookup, the live entity page read and the
 * purge's gone-page expiry (src/core/engine-sql/facts-trust.ts and facts-purge.ts), served from the facts store
 * (rust/crates/gbrain-store/src/facts/rest_sites.rs). A member not exported here refuses with `engine_capability_missing`.
 *
 * Served: `listClaimConflictPairs`, `countClaimConflictPairs`, `listAllUnarchivedSourceIds` (the store's unarchived source
 * list), `readLiveFactEntityPage`, `listContestedProposalPairs`, `lockAgentWritebackSetting` and `expireFactsOfGonePages`.
 *
 * `readLiveFactEntityPage` under `excludePrivate` serves the remote read floor for a caller with no widening member pages,
 * grants or lineage, and `listContestedProposalPairs` serves the fact privacy policy of `privateFactFilterForCaller` the
 * same way (reader identities and private-readable grants included); any other caller refuses.
 * `lockAgentWritebackSetting` skips the advisory lock while explicit transactions hold the writer
 * (`serialized_transactions`), and asserts it.
 */
import type { BrainEngine } from '../../engine.ts';
import { privateFactFilterForCaller, remoteReadFloorSql } from '../../search/private-visibility.ts';
import { assertStoreSerializedTransactions, storeCall, type StoreMember } from './common.ts';
import { storePageTextPolicy, storePrivacyPolicy } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listClaimConflictPairs: Member<'listClaimConflictPairs'> = (brain, sourceId, auditSources, cap) =>
  storeCall({ member: 'listClaimConflictPairs', sourceId }, () => brain.listClaimConflictPairs({ sourceId, auditSources, cap }));

export const countClaimConflictPairs: Member<'countClaimConflictPairs'> = (brain, sourceId, auditSources) =>
  storeCall({ member: 'countClaimConflictPairs', sourceId }, () => brain.countClaimConflictPairs({ sourceId, auditSources }));

/** The unarchived sources by id: the store's `listActiveSourceIds`, the same `{ id }` rows. */
export const listAllUnarchivedSourceIds: Member<'listAllUnarchivedSourceIds'> = brain =>
  storeCall({ member: 'listAllUnarchivedSourceIds' }, () => brain.listActiveSourceIds());

export const readLiveFactEntityPage: Member<'readLiveFactEntityPage'> = (brain, sourceId, slug, excludePrivate) => {
  const member = 'readLiveFactEntityPage';
  const policy = excludePrivate ? storePageTextPolicy(member, () => remoteReadFloorSql('p'), { fragment: 'floor' }) : undefined;
  return storeCall({ member, sourceId }, () => brain.readLiveFactEntityPage({ sourceId, slug, policy }));
};

export const listContestedProposalPairs: Member<'listContestedProposalPairs'> = async (brain, ids, policy) => {
  const member = 'listContestedProposalPairs';
  const excludePrivate = storePrivacyPolicy(member, policy.excludePrivate, () => privateFactFilterForCaller('facts'), { callerReaders: true, fragment: 'for_caller' });
  const rows = await storeCall({ member }, () => brain.listContestedProposalPairs({
    ids, remote: policy.remote, excludePrivate,
    minTrust: policy.eligibility?.floor || null, suppressFlagged: policy.eligibility?.suppressFlagged === true,
  }));
  return rows as never;
};

/** The advisory lock of one setting is skipped while explicit transactions hold the writer (`serialized_transactions`); it asserts that. */
export const lockAgentWritebackSetting: Member<'lockAgentWritebackSetting'> = async (brain, key) => {
  assertStoreSerializedTransactions(brain, 'lockAgentWritebackSetting');
  // Multi-user mode: the setting's advisory lock becomes a read of its config row, so a change committed before the commit
  // refuses it and the transaction runs again. Single-user mode reads nothing, as before.
  if (brain.multiuser === true) await storeCall({ member: 'lockAgentWritebackSetting' }, () => brain.getConfig(key));
};

export const expireFactsOfGonePages: Member<'expireFactsOfGonePages'> = async (brain, sourceIds, slugs) => {
  await storeCall({ member: 'expireFactsOfGonePages' }, () => brain.expireFactsOfGonePages({ sourceIds, slugs }));
};
