/**
 * Group 5 facts members, conversation fact publication and relink (src/core/engine-sql/facts-conversation.ts), served from
 * the facts store (rust/crates/gbrain-store/src/facts/conversation.rs and conversation_reads.rs).
 *
 * Two members need no store call: a store write runs alone, so `lockPageById` has no row to lock, and the store always
 * keeps the `fact_relink_attempts` table, so `factRelinkAttemptsTableExists` is true. A fact id, page id or id list that
 * PGLite binds as `bigint` and the store cannot read the same way (a fraction) refuses rather than guess at PGLite's
 * cast error.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const readNewestConversationFactId: Member<'readNewestConversationFactId'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readNewestConversationFactId' }, () => brain.readNewestConversationFactId({ sourceId, slug }));

export const maxConversationRowNum: Member<'maxConversationRowNum'> = (brain, sourceId, slug) =>
  storeCall({ member: 'maxConversationRowNum' }, () => brain.maxConversationRowNum({ sourceId, slug }));

export const countActiveConversationFacts: Member<'countActiveConversationFacts'> = (brain, sourceId, slug) =>
  storeCall({ member: 'countActiveConversationFacts' }, () => brain.countActiveConversationFacts({ sourceId, slug }));

export const countPageConversationFacts: Member<'countPageConversationFacts'> = (brain, sourceId, slug) =>
  storeCall({ member: 'countPageConversationFacts' }, () => brain.countPageConversationFacts({ sourceId, slug }));

export const deleteConversationOutcomeRows: Member<'deleteConversationOutcomeRows'> = (brain, sourceId, slug) =>
  storeCall({ member: 'deleteConversationOutcomeRows' }, () => brain.deleteConversationOutcomeRows({ sourceId, slug }));

export const readReextractOutcomeRow: Member<'readReextractOutcomeRow'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readReextractOutcomeRow' }, () => brain.readReextractOutcomeRow({ sourceId, slug }));

export const listClearedRelinkedFacts: Member<'listClearedRelinkedFacts'> = (brain, sourceId, slug) =>
  storeCall({ member: 'listClearedRelinkedFacts' }, () => brain.listClearedRelinkedFacts({ sourceId, slug }));

/** PGLite reads `valid_from` as a `Date`; the store answers its ISO text. */
export const listHeldFactSlots: Member<'listHeldFactSlots'> = (brain, sourceId, slug) =>
  storeCall({ member: 'listHeldFactSlots' }, async () => {
    const rows = await brain.listHeldFactSlots({ sourceId, slug }) as Array<{ entity_slug: string; dimension: string; value_hash: string; valid_from: string | null }>;
    return rows.map(r => ({ ...r, valid_from: r.valid_from == null ? null : new Date(r.valid_from) }));
  });

export const countConversationWindowFacts: Member<'countConversationWindowFacts'> = (brain, sourceId, slug, key) =>
  storeCall({ member: 'countConversationWindowFacts' }, () => brain.countConversationWindowFacts({ sourceId, slug, key }));

export const countConversationFactsOutsideWindows: Member<'countConversationFactsOutsideWindows'> = (brain, sourceId, slug, keys) =>
  storeCall({ member: 'countConversationFactsOutsideWindows' }, () => brain.countConversationFactsOutsideWindows({ sourceId, slug, keys: [...keys] }));

export const stampConversationSourceWindows: Member<'stampConversationSourceWindows'> = (brain, pairs) => {
  if (pairs.some(p => !Number.isInteger(p.id))) refuseMember('stampConversationSourceWindows', 'a fact id that is not an integer');
  return storeCall({ member: 'stampConversationSourceWindows' }, async () => {
    await brain.stampConversationSourceWindows({ pairs: pairs.map(p => ({ id: p.id, w: p.w ?? null })) });
  });
};

export const moveConversationSourceWindows: Member<'moveConversationSourceWindows'> = (brain, sourceId, slug, moves) =>
  storeCall({ member: 'moveConversationSourceWindows' }, async () => {
    await brain.moveConversationSourceWindows({ sourceId, slug, moves: moves.map(m => ({ from: m.from, to: m.to ?? null })) });
  });

export const clearConversationPageFacts: Member<'clearConversationPageFacts'> = (brain, sourceId, slug, windows) =>
  storeCall({ member: 'clearConversationPageFacts' }, () => brain.clearConversationPageFacts({
    sourceId, slug, windows: windows ? { keys: [...windows.keys], keep: windows.keep, unanchored: windows.unanchored } : null,
  }));

/** #10443: the page's wider expired extractor copies of these claims go private (facts/conversation.rs narrow_conversation_expired_copies). */
export const narrowConversationExpiredCopies: Member<'narrowConversationExpiredCopies'> = (brain, sourceId, slug, facts) =>
  storeCall({ member: 'narrowConversationExpiredCopies' }, async () => {
    await brain.narrowConversationExpiredCopies({ sourceId, slug, facts: [...facts] });
  });

export const findSpentConversationRequest: Member<'findSpentConversationRequest'> = (brain, principalKind, principalId, requestId, digest) =>
  storeCall({ member: 'findSpentConversationRequest' }, () => brain.findSpentConversationRequest({ principalKind, principalId, requestId, digest }));

export const listConversationBatchRequests: Member<'listConversationBatchRequests'> = (brain, principalKind, principalId, sourceId, anchorSlug) =>
  storeCall({ member: 'listConversationBatchRequests' }, () => brain.listConversationBatchRequests({ principalKind, principalId, sourceId, anchorSlug }));

export const readStoredConversationEntry: Member<'readStoredConversationEntry'> = (brain, id, generation) =>
  storeCall({ member: 'readStoredConversationEntry' }, () => brain.readStoredConversationEntry({ id, generation }));

export const readPrincipalCounters: Member<'readPrincipalCounters'> = (brain, key) =>
  storeCall({ member: 'readPrincipalCounters' }, () => brain.readPrincipalCounters({ key }));

export const countConversationPagesToExtract: Member<'countConversationPagesToExtract'> = (brain, sourceId, pageTypes, force) =>
  storeCall({ member: 'countConversationPagesToExtract' }, () => brain.countConversationPagesToExtract({ sourceId, pageTypes, force }));

export const listMergedEntityAliases: Member<'listMergedEntityAliases'> = (brain, sourceId, slugs) =>
  storeCall({ member: 'listMergedEntityAliases' }, () => brain.listMergedEntityAliases({ sourceId, slugs }));

export const listEntityHintPages: Member<'listEntityHintPages'> = (brain, sourceId, slugs) =>
  storeCall({ member: 'listEntityHintPages' }, () => brain.listEntityHintPages({ sourceId, slugs }));

export const readRelinkSource: Member<'readRelinkSource'> = (brain, sourceId) =>
  storeCall({ member: 'readRelinkSource' }, () => brain.readRelinkSource({ sourceId }));

export const readConversationSlotValueHash: Member<'readConversationSlotValueHash'> = (brain, sourceId, entitySlug, dimension, validFrom) =>
  storeCall({ member: 'readConversationSlotValueHash' }, () =>
    brain.readConversationSlotValueHash({ sourceId, entitySlug, dimension, validFrom: new Date(validFrom).toISOString() }));

export const listPurgeTombstoneMatches: Member<'listPurgeTombstoneMatches'> = (brain, sourceId, claims) =>
  storeCall({ member: 'listPurgeTombstoneMatches' }, () => brain.listPurgeTombstoneMatches({
    sourceId,
    claims: { facts: [...claims.facts], visibilities: [...claims.visibilities], entitySlugs: [...claims.entitySlugs], sources: [...claims.sources] },
  }));

export const findSameClaimFenceRow: Member<'findSameClaimFenceRow'> = (brain, sourceId, slug, fact, source) =>
  storeCall({ member: 'findSameClaimFenceRow' }, () => brain.findSameClaimFenceRow({ sourceId, slug, fact, source: source ?? null }));

export const findOntologyTwin: Member<'findOntologyTwin'> = (brain, sourceId, slug, factId) => {
  if (!Number.isInteger(factId)) refuseMember('findOntologyTwin', 'a fact id that is not an integer');
  return storeCall({ member: 'findOntologyTwin' }, () => brain.findOntologyTwin({ sourceId, slug, factId }));
};

export const listUnbackedConversationRows: Member<'listUnbackedConversationRows'> = (brain, sourceId, slugs) =>
  storeCall({ member: 'listUnbackedConversationRows' }, () => brain.listUnbackedConversationRows({ sourceId, slugs }));

export const listUnlinkedConversationRows: Member<'listUnlinkedConversationRows'> = (brain, sourceId, slugs) =>
  storeCall({ member: 'listUnlinkedConversationRows' }, () => brain.listUnlinkedConversationRows({ sourceId, slugs }));

export const countEmbeddedFactsAmong: Member<'countEmbeddedFactsAmong'> = (brain, sourceId, ids) => {
  if (ids.some(id => !Number.isInteger(id))) refuseMember('countEmbeddedFactsAmong', 'a fact id that is not an integer');
  return storeCall({ member: 'countEmbeddedFactsAmong' }, () => brain.countEmbeddedFactsAmong({ sourceId, ids }));
};

/** A store write runs alone, so there is no row to lock until the transaction ends. */
export const lockPageById: Member<'lockPageById'> = async (_brain, pageId) => {
  if (!Number.isInteger(pageId)) refuseMember('lockPageById', 'a page id that is not an integer');
};

/** The store keeps the `fact_relink_attempts` table on every brain (rust/crates/gbrain-store/src/facts/relink.rs). */
export const factRelinkAttemptsTableExists: Member<'factRelinkAttemptsTableExists'> = async () => true;
