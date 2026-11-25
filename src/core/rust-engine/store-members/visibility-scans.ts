/**
 * The preview reads of `gbrain repair visibility`, served from facts/visibility_scans.rs: listAtomLineageRows,
 * listChronicleEventVisibilityRows and listAliasOnlyPrivatePages (engine-sql/visibility-scans.ts), and
 * listConceptLineageRows, listConceptInputRows and listNamedVisibilityRows (engine-sql/facts-repair.ts), and the
 * open-twins scan listOpenTwinRows (engine-sql/open-twins.ts). `timeoutMs`
 * bounds a SQL statement; a store call is one in-process read, so it is not forwarded.
 */
import type { BrainEngine } from '../../engine.ts';
import { privacyAliasSql, privateSnapshotFilterFragment } from '../../search/private-visibility.ts';
import { validIdentity } from '../../access/principals.ts';
import { validQualifiedRuleId } from '../../access/folder-rules.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** Page ids bind as `integer[]` on PGLite and Postgres: an id that is not an integer refuses rather than guess at its cast. */
function pageIds(member: string, ids: readonly number[] | null): number[] | null {
  for (const id of ids ?? []) if (!Number.isSafeInteger(id)) refuseMember(member, 'a page id that is not an integer');
  return ids === null ? null : [...ids];
}

export const listAtomLineageRows: Member<'listAtomLineageRows'> = (brain, sourceIds, atomIds) =>
  storeCall({ member: 'listAtomLineageRows' }, () => brain.listAtomLineageRows({ sourceIds: [...sourceIds], ids: pageIds('listAtomLineageRows', atomIds) }));

export const listChronicleEventVisibilityRows: Member<'listChronicleEventVisibilityRows'> = (brain, sourceIds, ids) =>
  storeCall({ member: 'listChronicleEventVisibilityRows' }, () =>
    brain.listChronicleEventVisibilityRows({ sourceIds: [...sourceIds], ids: pageIds('listChronicleEventVisibilityRows', ids) }));

export const listAliasOnlyPrivatePages: Member<'listAliasOnlyPrivatePages'> = (brain, sourceIds, ids) =>
  storeCall({ member: 'listAliasOnlyPrivatePages' }, () =>
    brain.listAliasOnlyPrivatePages({ sourceIds: [...sourceIds], ids: pageIds('listAliasOnlyPrivatePages', ids) }));

export const listConceptLineageRows: Member<'listConceptLineageRows'> = (brain, sourceIds, conceptIds) =>
  storeCall({ member: 'listConceptLineageRows' }, () =>
    brain.listConceptLineageRows({ sourceIds: [...sourceIds], ids: pageIds('listConceptLineageRows', conceptIds) }));

export const listConceptInputRows: Member<'listConceptInputRows'> = (brain, conceptIds) =>
  storeCall({ member: 'listConceptInputRows' }, () => brain.listConceptInputRows({ ids: pageIds('listConceptInputRows', conceptIds) }));

export const listNamedVisibilityRows: Member<'listNamedVisibilityRows'> = (brain, sourceIds, slugs) =>
  storeCall({ member: 'listNamedVisibilityRows' }, () => brain.listNamedVisibilityRows({ sourceIds: [...sourceIds], slugs: [...slugs] }));

/**
 * `listOpenTwinRows`: each outside identity is rendered as readersAllowedSql and folderRulesAllowedSql render it (an
 * identity that is not valid names no reader; a satisfied set with an id that is not valid satisfies none, else sorted
 * and distinct), and `honorAliases` is read off the rendered snapshot filter. The folder coverage is read live, as the
 * builders read it outside a caller access scope.
 */
export const listOpenTwinRows: Member<'listOpenTwinRows'> = (brain, pages, outside) => {
  const honorAliases = privateSnapshotFilterFragment('t').includes(privacyAliasSql('t'));
  const readers = outside.map(reader => ({
    identity: reader.identity.length && validIdentity(reader.identity) ? [...reader.identity] : [],
    satisfied: reader.satisfied.length && reader.satisfied.every(validQualifiedRuleId) ? [...new Set(reader.satisfied)].sort() : [],
  }));
  return storeCall({ member: 'listOpenTwinRows' }, () =>
    brain.listOpenTwinRows({ pages: pages.map(({ source_id, slug }) => ({ source_id, slug })), outside: readers, honorAliases }));
};

/** Fact ids bind as `bigint[]`: an id that is not an integer refuses rather than guess at its cast. */
function factIds(member: string, ids: readonly number[] | null): number[] | null {
  for (const id of ids ?? []) if (!Number.isSafeInteger(id)) refuseMember(member, 'a fact id that is not an integer');
  return ids === null ? null : [...ids];
}

/** `listOpenFactsWindow` (gbrain repair open-facts), served from facts/open_facts_scans.rs. */
export const listOpenFactsWindow: Member<'listOpenFactsWindow'> = (brain, sel, after, upper, classes, limit) =>
  storeCall({ member: 'listOpenFactsWindow' }, () => brain.listOpenFactsWindow({ sourceId: sel.sourceId, createdBefore: sel.createdBefore,
    ids: factIds('listOpenFactsWindow', sel.ids), after, upper, classes: [...classes], limit }));

/** `countOpenFactReasons` (gbrain repair open-facts), served from facts/open_facts_scans.rs. */
export const countOpenFactReasons: Member<'countOpenFactReasons'> = (brain, sel) =>
  storeCall({ member: 'countOpenFactReasons' }, () => brain.countOpenFactReasons({ sourceId: sel.sourceId, createdBefore: sel.createdBefore,
    ids: factIds('countOpenFactReasons', sel.ids) }));

/** `listLabelledPages` (gbrain repair private-labels), served from facts/private_label_scans.rs. */
export const listLabelledPages: Member<'listLabelledPages'> = (brain, sourceIds, after, ids) => {
  if (!Number.isSafeInteger(after)) refuseMember('listLabelledPages', 'a page id cursor that is not an integer');
  return storeCall({ member: 'listLabelledPages' }, () => brain.listLabelledPages({ sourceIds: [...sourceIds], after, ids: pageIds('listLabelledPages', ids) }));
};

/** `listLiveLabelRows` (gbrain repair private-labels restore), served from facts/private_label_scans.rs. */
export const listLiveLabelRows: Member<'listLiveLabelRows'> = (brain, ids) =>
  storeCall({ member: 'listLiveLabelRows' }, () => brain.listLiveLabelRows({ ids: pageIds('listLiveLabelRows', ids) }));

/**
 * `listClearDependents` (gbrain repair private-labels), served from facts/private_label_scans.rs. `honorAliases` is read
 * off the rendered snapshot filter, which the caller's readHonorAliases set for this brain.
 */
export const listClearDependents: Member<'listClearDependents'> = (brain, cleared) => {
  const honorAliases = privateSnapshotFilterFragment('p').includes(privacyAliasSql('p'));
  return storeCall({ member: 'listClearDependents' }, () => brain.listClearDependents({ ids: pageIds('listClearDependents', cleared.ids) ?? [],
    sourceIds: [...cleared.sourceIds], slugs: [...cleared.slugs], keys: [...cleared.keys], honorAliases }));
};

/** `listContextualRetrievalModes` (the private-labels re-embedding preview), served from facts/private_label_scans.rs. */
export const listContextualRetrievalModes: Member<'listContextualRetrievalModes'> = (brain, ids) =>
  storeCall({ member: 'listContextualRetrievalModes' }, () => brain.listContextualRetrievalModes({ ids: pageIds('listContextualRetrievalModes', ids) }));

/** `listUnembeddedChunkPages` (the private-labels re-embedding preview), served from facts/private_label_scans.rs. */
export const listUnembeddedChunkPages: Member<'listUnembeddedChunkPages'> = (brain, ids) =>
  storeCall({ member: 'listUnembeddedChunkPages' }, () => brain.listUnembeddedChunkPages({ ids: pageIds('listUnembeddedChunkPages', ids) }));
