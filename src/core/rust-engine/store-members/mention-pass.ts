/**
 * The mention pass's statements (engine-sql/mention-pass.ts) and the gazetteer, extract snapshot and explain reads
 * (engine-sql/mention-reads.ts) on the Rust store (rust/crates/gbrain-store/src/mention_state.rs,
 * cli_reads/mention_reads.rs; rust/docs/store/mention-state.md). The two advisory locks and the FOR SHARE reads are
 * skipped while explicit transactions hold the writer (`serialized_transactions`); each of those members asserts it.
 */
import type { BrainEngine } from '../../engine.ts';
import { assertStoreSerializedTransactions, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

import type { SegmentDerivationStoreRow } from '../../engine-sql/segment-derive-store.ts';

const call = <T>(member: string, run: () => Promise<unknown>): Promise<T> => storeCall({ member }, run) as Promise<T>;

export const listMentionSourceIds: Member<'listMentionSourceIds'> = (brain) => call('listMentionSourceIds', () => brain.listMentionSourceIds());
export const writeMentionIndexStatus: Member<'writeMentionIndexStatus'> = async (brain, sourceId, patch) => { await call('writeMentionIndexStatus', () => brain.writeMentionIndexStatus(sourceId, patch)); };
export const lockMentionSources: Member<'lockMentionSources'> = async brain => {
  assertStoreSerializedTransactions(brain, 'lockMentionSources');
};
export const listMentionLinkOrigins: Member<'listMentionLinkOrigins'> = (brain, sourceId) => call('listMentionLinkOrigins', () => brain.listMentionLinkOrigins(sourceId));
export const deleteSourceMentionLinks: Member<'deleteSourceMentionLinks'> = (brain, sourceId, origins) => call('deleteSourceMentionLinks', () => brain.deleteSourceMentionLinks(sourceId, origins === null ? null : [...origins]));
export const clearMentionSourceIndex: Member<'clearMentionSourceIndex'> = async (brain, sourceId) => { await call('clearMentionSourceIndex', () => brain.clearMentionSourceIndex(sourceId)); };
export const listStaleDerivedAliasSlugs: Member<'listStaleDerivedAliasSlugs'> = (brain, sourceId, types) => call('listStaleDerivedAliasSlugs', () => brain.listStaleDerivedAliasSlugs(sourceId, [...types]));
export const deleteDerivedAliasesForSlugs: Member<'deleteDerivedAliasesForSlugs'> = async (brain, sourceId, slugs) => { await call('deleteDerivedAliasesForSlugs', () => brain.deleteDerivedAliasesForSlugs(sourceId, [...slugs])); };
export const listAliasDuePages: Member<'listAliasDuePages'> = (brain, sourceId, types, after, version, limit) => call('listAliasDuePages', () => brain.listAliasDuePages(sourceId, [...types], after, version, limit));
export const listDerivedAliasRows: Member<'listDerivedAliasRows'> = (brain, sourceId, slugs) => call('listDerivedAliasRows', () => brain.listDerivedAliasRows(sourceId, [...slugs]));
export const readMentionPageRevisions: Member<'readMentionPageRevisions'> = async (brain, ids, opts) => {
  if (opts.forShare) assertStoreSerializedTransactions(brain, 'readMentionPageRevisions');
  return call('readMentionPageRevisions', () => brain.readMentionPageRevisions([...ids]));
};
export const insertDerivedAliasRows: Member<'insertDerivedAliasRows'> = async (brain, sourceId, rows) => { await call('insertDerivedAliasRows', () => brain.insertDerivedAliasRows(sourceId, [...rows])); };
export const upsertPageAliasState: Member<'upsertPageAliasState'> = async (brain, sourceId, pages, version) => { await call('upsertPageAliasState', () => brain.upsertPageAliasState(sourceId, pages.map(p => ({ id: Number(p.id), revision: p.revision })), version)); };
export const listMentionCandidatePages: Member<'listMentionCandidatePages'> = (brain, sourceIds, after, limit, patterns) => call('listMentionCandidatePages', () => brain.listMentionCandidatePages([...sourceIds], after, limit, patterns === null ? null : [...patterns]));
export const listGazetteerEntryKeys: Member<'listGazetteerEntryKeys'> = (brain, sourceId) => call('listGazetteerEntryKeys', () => brain.listGazetteerEntryKeys(sourceId));
export const listMentionLinkersOfTargets: Member<'listMentionLinkersOfTargets'> = (brain, sourceId, slugs) => call('listMentionLinkersOfTargets', () => brain.listMentionLinkersOfTargets(sourceId, [...slugs]));
export const lockMentionEntries: Member<'lockMentionEntries'> = async brain => {
  assertStoreSerializedTransactions(brain, 'lockMentionEntries');
};
export const applyGazetteerEntryChanges: Member<'applyGazetteerEntryChanges'> = async (brain, sourceId, removed, added) => { await call('applyGazetteerEntryChanges', () => brain.applyGazetteerEntryChanges(sourceId, [...removed], [...added])); };
export const resetMentionRevisions: Member<'resetMentionRevisions'> = async (brain, by) => { await call('resetMentionRevisions', () => 'afterPageId' in by ? brain.resetMentionRevisions([...by.sourceIds], [...by.pageIds], by.afterPageId) : 'sourceIds' in by ? brain.resetMentionRevisions([...by.sourceIds], null, null) : brain.resetMentionRevisions(null, [...by.pageIds], null)); };
export const readMentionGenerations: Member<'readMentionGenerations'> = async (brain, sourceIds, lock) => {
  if (lock) assertStoreSerializedTransactions(brain, 'readMentionGenerations');
  return call('readMentionGenerations', () => brain.readMentionGenerations([...sourceIds]));
};
export const listMentionDuePages: Member<'listMentionDuePages'> = (brain, sourceId, version, after, limit) => call('listMentionDuePages', () => brain.listMentionDuePages(sourceId, version, after, limit));
export const listPageOutLinks: Member<'listPageOutLinks'> = (brain, ids) => call('listPageOutLinks', () => brain.listPageOutLinks(ids.map(Number)));
export const deleteLinksById: Member<'deleteLinksById'> = async (brain, ids) => { await call('deleteLinksById', () => brain.deleteLinksById(ids.map(Number))); };
export const upsertPageMentionState: Member<'upsertPageMentionState'> = async (brain, sourceId, pages, version, generation) => { await call('upsertPageMentionState', () => brain.upsertPageMentionState(sourceId, pages.map(p => ({ id: Number(p.id), revision: p.revision })), version, generation)); };
export const readMentionStatusStates: Member<'readMentionStatusStates'> = (brain, sourceIds) => call('readMentionStatusStates', () => brain.readMentionStatusStates([...sourceIds]));
export const readMentionPolicyFingerprints: Member<'readMentionPolicyFingerprints'> = (brain, sourceIds) => call('readMentionPolicyFingerprints', () => brain.readMentionPolicyFingerprints([...sourceIds]));
export const resetSourceMentionIndexRevisions: Member<'resetSourceMentionIndexRevisions'> = async (brain, sourceId) => { await call('resetSourceMentionIndexRevisions', () => brain.resetSourceMentionIndexRevisions(sourceId)); };
export const listLivePageSourceIds: Member<'listLivePageSourceIds'> = (brain) => call('listLivePageSourceIds', () => brain.listLivePageSourceIds());
export const listGazetteerPages: Member<'listGazetteerPages'> = (brain, types, handleKeys) => call('listGazetteerPages', () => brain.listGazetteerPages([...types], [...handleKeys]));
export const listGazetteerAliases: Member<'listGazetteerAliases'> = (brain, types) => call('listGazetteerAliases', () => brain.listGazetteerAliases([...types]));
export const readPageStampTimes: Member<'readPageStampTimes'> = (brain, slugs, sourceIds) => call('readPageStampTimes', () => brain.readPageStampTimes([...slugs], [...sourceIds]));
export const readPageRevisionForShare: Member<'readPageRevisionForShare'> = (brain, sourceId, slug) => call('readPageRevisionForShare', () => brain.readPageRevisionForShare(sourceId, slug));
export const readExplainPage: Member<'readExplainPage'> = (brain, sourceId, slug) => call('readExplainPage', () => brain.readExplainPage(sourceId, slug));
export const readExplainScanPage: Member<'readExplainScanPage'> = (brain, sourceId, slug, version) => call('readExplainScanPage', () => brain.readExplainScanPage(sourceId, slug, version));
export const countMentionLinksTo: Member<'countMentionLinksTo'> = (brain, pageId, sourceId, targets) => call('countMentionLinksTo', () => brain.countMentionLinksTo(Number(pageId), sourceId, [...targets]));
export const readPageNameText: Member<'readPageNameText'> = (brain, sourceId, slug) => call('readPageNameText', () => brain.readPageNameText(sourceId, slug));
export const listFrontmatterAliasNorms: Member<'listFrontmatterAliasNorms'> = (brain, sourceId, slug) => call('listFrontmatterAliasNorms', () => brain.listFrontmatterAliasNorms(sourceId, slug));
export const listRejectedDeclarationPages: Member<'listRejectedDeclarationPages'> = (brain, sourceId, types, pattern) => call('listRejectedDeclarationPages', () => brain.listRejectedDeclarationPages(sourceId, [...types], pattern));

/** The live page's sealed flag: its text projection revision is its content revision (null while it has none). */
export const readSegmentedPageSealed: Member<'readSegmentedPageSealed'> = (brain, sourceId, slug) =>
  call('readSegmentedPageSealed', () => brain.readSegmentedPageSealed(sourceId, slug));

/** The derive pass's conditional store: done rows, written only while the page is live, segmented and at `generation`. */
export const storeSegmentDerivationsIfLive: Member<'storeSegmentDerivationsIfLive'> = async (brain, pageId, generation, rows) =>
  Number(await call('storeSegmentDerivationsIfLive', () => brain.storeSegmentDerivationsIfLive(Number(pageId), generation,
    rows.map((r: SegmentDerivationStoreRow) => ({ pageId: Number(pageId), kind: r.pipeline, occurrenceId: r.occurrence_id, version: r.pipeline_version,
      segmentSha256: r.segment_sha256, contextHash: r.context_hash, state: 'done', output: r.output ?? null, receipt: null })))));
