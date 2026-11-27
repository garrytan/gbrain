/**
 * The readable-slug read of a fact recall (src/core/engine-sql/facts-recall.ts), served from the facts store
 * (rust/crates/gbrain-store/src/facts/quoted.rs): `listReadablePageSlugs`. The quote reads (`listFactsFromQuotedPages`,
 * `listOwnerTierFacts`, `listPageRefsByIds`) are in facts-trust.ts and trust-tier-reads.ts.
 *
 * `listReadablePageSlugs` models `pageReadFilter(.., live = true)`: the page privacy policy
 * (storePagePolicy, caller readers included), the trust floor and flag suppression; the scope's sources are not read.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listReadablePageSlugs: Member<'listReadablePageSlugs'> = async (brain, sourceId, slugs, scope, limit) => {
  const member = 'listReadablePageSlugs';
  const wire = {
    excludePrivate: storePagePolicy(member, scope.excludePrivate, { callerReaders: true }) ?? null,
    minTrust: scope.minTrust || null,
    suppressFlagged: scope.suppressFlagged === true,
  };
  return storeCall({ member }, () => brain.listReadablePageSlugs({ sourceId, slugs: [...slugs], scope: wire, limit }));
};
