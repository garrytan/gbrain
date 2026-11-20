/**
 * The quote and slot-history reads of a fact recall (src/core/engine-sql/facts-recall.ts), served from the facts store
 * (rust/crates/gbrain-store/src/facts/quoted.rs): `listFactsFromQuotedPages`, `listFactIdsAtTrustFloor`,
 * `readPageTypesByIds` and `listReadablePageSlugs`.
 *
 * `listFactsFromQuotedPages` follows the holding page and the backstop session page. The SQL also follows
 * `derivation_inputs` edges; the store keeps none (only raw SQL writes them, which a Rust brain refuses), so that arm
 * finds nothing here. `listReadablePageSlugs` models `pageReadFilter(.., live = true)`: the page privacy policy
 * (storePagePolicy, caller readers included), the trust floor and flag suppression; the scope's sources are not read.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const idList = (ids: readonly number[]) => [...new Set(ids.map(Number))];

export const listFactsFromQuotedPages: Member<'listFactsFromQuotedPages'> = async (brain, ids, pageTypes, backstopSessions) => {
  if (!ids.length) return [];
  return storeCall({ member: 'listFactsFromQuotedPages' }, () => brain.listFactsFromQuotedPages({
    ids: idList(ids),
    pageTypes: [...pageTypes],
    backstopSessions: backstopSessions.map(([source, prefix]) => [source, prefix]),
  }));
};

export const listFactIdsAtTrustFloor: Member<'listFactIdsAtTrustFloor'> = async (brain, ids, floor) => {
  if (!ids.length) return [];
  return storeCall({ member: 'listFactIdsAtTrustFloor' }, () => brain.listFactIdsAtTrustFloor({ ids: idList(ids), floor }));
};

export const readPageTypesByIds: Member<'readPageTypesByIds'> = async (brain, ids) => {
  if (!ids.length) return [];
  return storeCall({ member: 'readPageTypesByIds' }, () => brain.readPageTypesByIds(idList(ids)));
};

export const listReadablePageSlugs: Member<'listReadablePageSlugs'> = async (brain, sourceId, slugs, scope, limit) => {
  const member = 'listReadablePageSlugs';
  const wire = {
    excludePrivate: storePagePolicy(member, scope.excludePrivate, { callerReaders: true }) ?? null,
    minTrust: scope.minTrust || null,
    suppressFlagged: scope.suppressFlagged === true,
  };
  return storeCall({ member }, () => brain.listReadablePageSlugs({ sourceId, slugs: [...slugs], scope: wire, limit }));
};
