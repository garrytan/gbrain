/**
 * The page-set reads of the core commands (src/core/engine-sql/collate-page-reads.ts), served from the store's page, link and
 * source records (rust/crates/gbrain-store/src/collate_sets.rs, rust/docs/store/collate_sets.md).
 *
 * Export only BrainEngine members from this file (index.ts spreads the whole module into STORE_MEMBERS).
 *
 * `listChatChannelCensus` with `hidePrivate` sends the caller's page policy. The SQL text is `privatePagesFilterFragmentFast`,
 * which is the full page policy behind a cheap first test; the member serves it as the full policy
 * (`privatePagesFilterFragment`, which a caller with no readers renders as the no-caller policy) and refuses when the fast
 * form no longer wraps the full one.
 */
import type { BrainEngine } from '../../engine.ts';
import { privatePagesFilterFragment, privatePagesFilterFragmentFast } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePageTextPolicy } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

function text(member: string, name: string, value: string): string {
  if (value.includes('\0')) refuseMember(member, `${name} with a NUL byte`);
  return value;
}

export const readPageSizeRows: Member<'readPageSizeRows'> = async (brain, sourceId, maxBytes, slugs) => {
  const member = 'readPageSizeRows';
  return storeCall({ member }, () => brain.readPageSizeRows(text(member, 'source id', sourceId), maxBytes, slugs ? slugs.map(s => text(member, 'slug', s)) : null)) as never;
};

export const listChatChannelCensus: Member<'listChatChannelCensus'> = async (brain, sourceIds, chatTypes, dmTypes, hidePrivate) => {
  const member = 'listChatChannelCensus';
  const full = privatePagesFilterFragment('p');
  if (hidePrivate && !privatePagesFilterFragmentFast('p').endsWith(`\n    OR ${full}))`)) refuseMember(member, 'a fast page filter that no longer wraps the full page policy');
  const policy = hidePrivate ? storePageTextPolicy(member, () => full, { noReaders: true }) : null;
  return storeCall({ member }, () => brain.listChatChannelCensus(
    sourceIds.map(s => text(member, 'source id', s)), chatTypes.map(t => text(member, 'type', t)), dmTypes.map(t => text(member, 'type', t)), policy)) as never;
};

export const listLinkPageMetadataForSlugs: Member<'listLinkPageMetadataForSlugs'> = async (brain, sourceId, slugs) => {
  const member = 'listLinkPageMetadataForSlugs';
  return storeCall({ member }, () => brain.listLinkPageMetadataForSlugs(text(member, 'source id', sourceId), slugs.map(s => text(member, 'slug', s)))) as never;
};

export const listAttendedOriginSlugs: Member<'listAttendedOriginSlugs'> = async (brain, sourceId, slugs) => {
  const member = 'listAttendedOriginSlugs';
  return storeCall({ member }, () => brain.listAttendedOriginSlugs(text(member, 'source id', sourceId), slugs ? slugs.map(s => text(member, 'slug', s)) : null)) as never;
};

export const readCompanyBrainEvidenceRows: Member<'readCompanyBrainEvidenceRows'> = async (brain, sourceId) =>
  storeCall({ member: 'readCompanyBrainEvidenceRows' }, () => brain.readCompanyBrainEvidenceRows(text('readCompanyBrainEvidenceRows', 'source id', sourceId))) as never;

export const listShelfPageRows: Member<'listShelfPageRows'> = async (brain, sourceId) =>
  storeCall({ member: 'listShelfPageRows' }, () => brain.listShelfPageRows(text('listShelfPageRows', 'source id', sourceId))) as never;

export const listLiveSourceIncarnations: Member<'listLiveSourceIncarnations'> = async (brain, sourceIds) => {
  const member = 'listLiveSourceIncarnations';
  return storeCall({ member }, () => brain.listLiveSourceIncarnations(sourceIds.map(s => text(member, 'source id', s)))) as never;
};

export const listAttendanceScanWindow: Member<'listAttendanceScanWindow'> = async (brain, sourceId, afterSlug, limit) => {
  const member = 'listAttendanceScanWindow';
  return storeCall({ member }, () => brain.listAttendanceScanWindow(text(member, 'source id', sourceId), text(member, 'slug', afterSlug), limit)) as never;
};
