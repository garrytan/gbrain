/**
 * The belief-ledger half of a purge (src/core/engine-sql/belief-purge-ledger.ts), served from
 * rust/crates/gbrain-store/src/trust/belief_purge_ledger.rs: the derived rows' streams, the preimage check, the
 * purged-key and carrying-field redactions, the live and version carriers, the page purge's lifetimes and claim
 * inventory, and the derived-hidden keys. The statements read an event by id and events by lifetime alone; the store
 * reads within the source the caller names. A purged claim's pre-v353 Postgres fingerprint (`legacyClaims`) matches
 * nothing here: the store has always folded the one explicit list. The version carriers' page policy is the
 * no-caller policy `privatePagesFilterFragment('p')`, sent as its flags (plainPageFlags: derived by the store under the
 * multi-user switch).
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';
import { plainPageFlags } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listDerivedStreamSlugs: Member<'listDerivedStreamSlugs'> = (brain, sourceId, factIds, takeIds, pageIds) =>
  storeCall({ member: 'listDerivedStreamSlugs', sourceId }, () => brain.listDerivedStreamSlugs({ sourceId, factIds: [...factIds], takeIds: [...takeIds], pageIds: [...pageIds] }));

export const listMissingPreimages: Member<'listMissingPreimages'> = (brain, pageIds, revisions) =>
  storeCall({ member: 'listMissingPreimages' }, () => brain.listMissingPreimages({ pageIds: [...pageIds], revisions: [...revisions] }));

export const redactPurgedBeliefKeys: Member<'redactPurgedBeliefKeys'> = (brain, input) =>
  storeCall({ member: 'redactPurgedBeliefKeys', sourceId: input.sourceId }, () => brain.redactPurgedBeliefKeys({ sourceId: input.sourceId,
    claimFps: [...input.claimFps], lifetimes: [...input.lifetimes], legacyClaims: [...input.legacyClaims] }));

export const listBeliefCarrierEvents: Member<'listBeliefCarrierEvents'> = (brain, sourceId, after) =>
  storeCall({ member: 'listBeliefCarrierEvents', sourceId }, () => brain.listBeliefCarrierEvents(sourceId, Number(after)));

export const readBeliefEventValue: Member<'readBeliefEventValue'> = async (brain, sourceId, id) =>
  (await storeCall({ member: 'readBeliefEventValue', sourceId }, () => brain.readBeliefEventValue(sourceId, Number(id)))) ?? null;

export const rewriteBeliefEventFields: Member<'rewriteBeliefEventFields'> = async (brain, input) => {
  await storeCall({ member: 'rewriteBeliefEventFields', sourceId: input.sourceId }, () => brain.rewriteBeliefEventFields({ sourceId: input.sourceId,
    id: Number(input.id), value: input.value, valueHash: input.valueHash, redactedFields: [...input.redactedFields] }));
};

export const rechainBeliefPriorHash: Member<'rechainBeliefPriorHash'> = async (brain, input) => {
  await storeCall({ member: 'rechainBeliefPriorHash', sourceId: input.sourceId }, () => brain.rechainBeliefPriorHash({ ...input, afterId: Number(input.afterId) }));
};

export const listBeliefQuotingRows: Member<'listBeliefQuotingRows'> = (brain, kind, sourceId, after) =>
  storeCall({ member: 'listBeliefQuotingRows', sourceId }, () => brain.listBeliefQuotingRows(kind, sourceId, Number(after)));

export const listPageBeliefLifetimes: Member<'listPageBeliefLifetimes'> = (brain, sourceId, slug, pageId) =>
  storeCall({ member: 'listPageBeliefLifetimes', sourceId }, () => brain.listPageBeliefLifetimes(sourceId, slug, Number(pageId)));

export const listPagePurgeLiveClaims: Member<'listPagePurgeLiveClaims'> = (brain, sourceId, slug, pageId) =>
  storeCall({ member: 'listPagePurgeLiveClaims', sourceId }, () => brain.listPagePurgeLiveClaims(sourceId, slug, Number(pageId)));

export const listPageVersionFenceBodies: Member<'listPageVersionFenceBodies'> = (brain, pageId, after) =>
  storeCall({ member: 'listPageVersionFenceBodies' }, () => brain.listPageVersionFenceBodies(Number(pageId), Number(after)));

export const listLifetimeClaimEvents: Member<'listLifetimeClaimEvents'> = (brain, sourceId, lifetimes, after) =>
  storeCall({ member: 'listLifetimeClaimEvents', sourceId }, () => brain.listLifetimeClaimEvents(sourceId, [...lifetimes], Number(after)));

export const listPurgeCarrierVersions: Member<'listPurgeCarrierVersions'> = (brain, sourceId, versionIds) =>
  storeCall({ member: 'listPurgeCarrierVersions', sourceId }, () => brain.listPurgeCarrierVersions({ sourceId, versionIds: versionIds.map(Number),
    visibility: plainPageFlags('listPurgeCarrierVersions') }));

export const listKnownBeliefSubjectKeys: Member<'listKnownBeliefSubjectKeys'> = (brain, sourceId, keys) =>
  storeCall({ member: 'listKnownBeliefSubjectKeys', sourceId }, () => brain.listKnownBeliefSubjectKeys(sourceId, [...keys]));
