/**
 * Doctor search and knowledge reads (src/core/engine-sql/doctor-search.ts), served from the page, alias, body, link,
 * source and projection-queue records each check reads (rust/crates/gbrain-store/src/cli_reads/doctor_search.rs,
 * rust/docs/store/cli-reads-doctor-search.md).
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';
import { coverageScope } from './coverage-scope.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listOrphanedAliasCounts: Member<'listOrphanedAliasCounts'> = async (brain) =>
  storeCall({ member: 'listOrphanedAliasCounts' }, () => brain.listOrphanedAliasCounts());

export const readSoftDeletedAliasCounts: Member<'readSoftDeletedAliasCounts'> = async (brain) =>
  storeCall({ member: 'readSoftDeletedAliasCounts' }, () => brain.readSoftDeletedAliasCounts());

export const listPageTypePairs: Member<'listPageTypePairs'> = async (brain) =>
  storeCall({ member: 'listPageTypePairs' }, () => brain.listPageTypePairs());

export const listTruncatedMarkdownBodies: Member<'listTruncatedMarkdownBodies'> = async (brain) =>
  storeCall({ member: 'listTruncatedMarkdownBodies' }, async () =>
    (await brain.listTruncatedMarkdownBodies()).map((row: { slug: string; body_len: unknown; raw_len: unknown }) => ({ ...row, body_len: Number(row.body_len), raw_len: Number(row.raw_len) })));

export const countSegmentedMarkdownBodies: Member<'countSegmentedMarkdownBodies'> = async (brain) =>
  storeCall({ member: 'countSegmentedMarkdownBodies' }, async () => Number(await brain.countSegmentedMarkdownBodies()));

export const listRecentPageBodies: Member<'listRecentPageBodies'> = async (brain, sourceIds) =>
  storeCall({ member: 'listRecentPageBodies' }, () => brain.listRecentPageBodies(sourceIds));

export const countSegmentedRecentPages: Member<'countSegmentedRecentPages'> = async (brain, sourceIds) =>
  storeCall({ member: 'countSegmentedRecentPages' }, async () => Number(await brain.countSegmentedRecentPages(sourceIds)));

export const countPagesHiddenByPrefix: Member<'countPagesHiddenByPrefix'> = async (brain, pattern, sourceIds) =>
  storeCall({ member: 'countPagesHiddenByPrefix' }, async () => Number(await brain.countPagesHiddenByPrefix(pattern, sourceIds)));

export const listGitImageHoldCounts: Member<'listGitImageHoldCounts'> = async (brain, sourceIds) =>
  storeCall({ member: 'listGitImageHoldCounts' }, async () =>
    (await brain.listGitImageHoldCounts(sourceIds)).map((row: { source_id: string; images: unknown }) => ({ source_id: row.source_id, images: Number(row.images) })));


export const readProjectionBacklog: Member<'readProjectionBacklog'> = async (brain, scope) => {
  const input = coverageScope('readProjectionBacklog', scope);
  return storeCall({ member: 'readProjectionBacklog' }, async () => {
    const row = await brain.readProjectionBacklog(input);
    const n = (value: unknown) => Number(value ?? 0);
    return {
      pending: n(row.pending), failed: n(row.failed), sealable: n(row.sealable), sealable_with_visual: n(row.sealable_with_visual),
      reimport: n(row.reimport), ocr_required: n(row.ocr_required), protected: n(row.protected), archived: n(row.archived),
      oldest_age_seconds: row.oldest === null || row.oldest === undefined ? null : Math.max(0, Math.floor(Number(row.oldest))),
      as_of: String(row.as_of ?? ''),
    };
  });
};

export const countAtomExtractionBacklog: Member<'countAtomExtractionBacklog'> = async (brain, query) =>
  storeCall({ member: 'countAtomExtractionBacklog' }, async () => Number(await brain.countAtomExtractionBacklog(query)));

/** The sources with a live page: the store lists them by id in byte order (cli_reads/mention_reads.rs). */
export const listAtomBacklogSourceIds: Member<'listAtomBacklogSourceIds'> = async (brain) =>
  ((await storeCall({ member: 'listAtomBacklogSourceIds' }, () => brain.listLivePageSourceIds())) as Array<{ id: string }>)
    .map(row => ({ source_id: row.id }));
