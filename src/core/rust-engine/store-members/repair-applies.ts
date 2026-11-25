/**
 * The rechecks and writes of `gbrain repair` applies (engine-sql/repair-applies.ts), served from
 * facts/repair_applies.rs: restoreConsolidationTie (consolidate-ties), listLiveDuplicateRows, supersedeDuplicateFacts
 * and linkStruckDuplicateFacts (duplicate-facts), listCommittedRestorePages, listActivePositionedFactIds,
 * readFactRestorePage and restoreExtractorFact (extractor-facts), moveFactClaimDates (fact-claim-dates), lockApprovedFacts
 * (no store call: the store's write transaction already holds every row) and expireApprovedFacts (purged-page-facts), tightenDatabaseFactVisibility (visibility), listPageAccessKeys (moved-pages),
 * detachFenceRowFacts and hasDatabaseOnlyClaim (url-clone-fences) and readSourceCloneRow (the url-clone check). The fact writes go through the store's fact writer, so the trust stamp, the
 * withdrawal guard and the unique indexes run as their triggers and indexes do on SQL.
 *
 * An id list binds as `bigint[]` on PGLite, so an id that is not an integer refuses rather than guess at its cast error.
 */
import type { BrainEngine } from '../../engine.ts';
import { privacyAliasSql, privateSnapshotFilterFragment } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

function wholeIds(member: string, ids: readonly number[]): number[] {
  for (const id of ids) if (!Number.isSafeInteger(id)) refuseMember(member, 'a fact id that is not an integer');
  return [...ids];
}

/** A `timestamptz` parameter as postgres.js sends a `Date` (ISO, milliseconds), or the text as given. */
const timeText = (value: string | Date): string => (value instanceof Date ? value.toISOString() : value);

export const restoreConsolidationTie: Member<'restoreConsolidationTie'> = (brain, tie) =>
  storeCall({ member: 'restoreConsolidationTie' }, () => brain.restoreConsolidationTie({ source_id: tie.source_id, id: tie.id,
    entity_slug: tie.entity_slug, take_id: tie.take_id, valid_from: timeText(tie.valid_from) }));

export const listLiveDuplicateRows: Member<'listLiveDuplicateRows'> = (brain, sourceId, ids, visibility, fingerprint) =>
  storeCall({ member: 'listLiveDuplicateRows' }, () =>
    brain.listLiveDuplicateRows({ sourceId, ids: wholeIds('listLiveDuplicateRows', ids), visibility, fingerprint }));

export const supersedeDuplicateFacts: Member<'supersedeDuplicateFacts'> = (brain, sourceId, ids, keptId, visibility, fingerprint) =>
  storeCall({ member: 'supersedeDuplicateFacts' }, () =>
    brain.supersedeDuplicateFacts({ sourceId, ids: wholeIds('supersedeDuplicateFacts', ids), keptId, visibility, fingerprint }));

export const linkStruckDuplicateFacts: Member<'linkStruckDuplicateFacts'> = (brain, sourceId, ids, keptId) =>
  storeCall({ member: 'linkStruckDuplicateFacts' }, () =>
    brain.linkStruckDuplicateFacts({ sourceId, ids: wholeIds('linkStruckDuplicateFacts', ids), keptId }));

export const listCommittedRestorePages: Member<'listCommittedRestorePages'> = (brain, sourceIds, slugs, hash, requestIds) =>
  storeCall({ member: 'listCommittedRestorePages' }, () =>
    brain.listCommittedRestorePages({ sourceIds: [...sourceIds], slugs: [...slugs], hash, requestIds: [...requestIds] }));

export const listActivePositionedFactIds: Member<'listActivePositionedFactIds'> = (brain, ids) =>
  storeCall({ member: 'listActivePositionedFactIds' }, () => brain.listActivePositionedFactIds(wholeIds('listActivePositionedFactIds', ids)));

export const readFactRestorePage: Member<'readFactRestorePage'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readFactRestorePage' }, () => brain.readFactRestorePage(sourceId, slug));

export const restoreExtractorFact: Member<'restoreExtractorFact'> = (brain, sourceId, id, rowNum, expiredAt) =>
  storeCall({ member: 'restoreExtractorFact' }, () => brain.restoreExtractorFact({ sourceId, id, rowNum, expiredAt }));

export const moveFactClaimDates: Member<'moveFactClaimDates'> = (brain, sourceId, rows) =>
  storeCall({ member: 'moveFactClaimDates' }, () =>
    brain.moveFactClaimDates({ sourceId, rows: rows.map(({ id, valid_from, date }) => ({ id, valid_from, date })) }));

/** No store call: a store write transaction holds the whole store until it ends, as the SQL's `FOR UPDATE` holds the rows. */
export const lockApprovedFacts: Member<'lockApprovedFacts'> = async (_brain, _sourceId, ids) => {
  wholeIds('lockApprovedFacts', ids);
};

export const expireApprovedFacts: Member<'expireApprovedFacts'> = (brain, sourceId, ids) =>
  storeCall({ member: 'expireApprovedFacts' }, () => brain.expireApprovedFacts({ sourceId, ids: wholeIds('expireApprovedFacts', ids) }));

export const tightenDatabaseFactVisibility: Member<'tightenDatabaseFactVisibility'> = (brain, sourceId, ids) =>
  storeCall({ member: 'tightenDatabaseFactVisibility' }, () =>
    brain.tightenDatabaseFactVisibility({ sourceId, ids: wholeIds('tightenDatabaseFactVisibility', ids) }));

/**
 * `listPageAccessKeys`: `world` is the snapshot filter's answer, so `honorAliases` is read off the rendered filter, the one
 * process-wide setting the SQL engines render (as listWorldFactsFromPrivateSources does).
 */
export const listPageAccessKeys: Member<'listPageAccessKeys'> = (brain, pageIds) => {
  const honorAliases = privateSnapshotFilterFragment('p').includes(privacyAliasSql('p'));
  return storeCall({ member: 'listPageAccessKeys' }, () => brain.listPageAccessKeys({ ids: wholeIds('listPageAccessKeys', pageIds), honorAliases }));
};

export const detachFenceRowFacts: Member<'detachFenceRowFacts'> = (brain, sourceId, slug, rowNum) =>
  storeCall({ member: 'detachFenceRowFacts' }, () => brain.detachFenceRowFacts({ sourceId, slug, rowNum }));

export const hasDatabaseOnlyClaim: Member<'hasDatabaseOnlyClaim'> = (brain, sourceId, entitySlug, fact) =>
  storeCall({ member: 'hasDatabaseOnlyClaim' }, () => brain.hasDatabaseOnlyClaim({ sourceId, entitySlug, fact }));

export const readSourceCloneRow: Member<'readSourceCloneRow'> = (brain, sourceId) =>
  storeCall({ member: 'readSourceCloneRow' }, () => brain.readSourceCloneRow(sourceId));
