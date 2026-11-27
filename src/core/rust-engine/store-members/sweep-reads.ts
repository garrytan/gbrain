/**
 * The maintenance sweep's page reads (BrainEngine listFactsFencePages, listSweepStalePages, listSweepDeferredPages,
 * listPageRefsForSlugs; SQL in engine-sql/sweep-reads.ts). The store reads its page records, extraction watermarks, body states and body
 * manifests (rust/docs/store/sweep-reads.md). A tie on `updated_at` is broken by page id, newest first.
 */
import type { FactsFencePagesQuery, SweepPageRefRow, SweepDeferredPageRow, SweepDeferredPagesQuery, SweepStalePageRow, SweepStalePagesQuery } from '../../engine-sql/sweep-reads.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';

export const listFactsFencePages: StoreMember<[q: FactsFencePagesQuery], string[]> = (brain, q) => {
  const o = takeOptions('listFactsFencePages', q, ['sourceId', 'since', 'scanCap', 'limit']);
  return storeCall({ member: 'listFactsFencePages', sourceId: q.sourceId }, () => brain.listFactsFencePages(o));
};

export const listSweepStalePages: StoreMember<[q: SweepStalePagesQuery], SweepStalePageRow[]> = (brain, q) => {
  const o = takeOptions('listSweepStalePages', q, ['sourceId', 'since', 'limit', 'exclude']);
  return storeCall({ member: 'listSweepStalePages', sourceId: q.sourceId }, () => brain.listSweepStalePages({ ...o, exclude: [...q.exclude] }));
};

export const listSweepDeferredPages: StoreMember<[q: SweepDeferredPagesQuery], SweepDeferredPageRow[]> = async (brain, q) => {
  const o = takeOptions('listSweepDeferredPages', q, ['sourceId', 'since', 'slugs']);
  if (q.slugs.length === 0) return [];
  return storeCall({ member: 'listSweepDeferredPages', sourceId: q.sourceId }, () => brain.listSweepDeferredPages({ ...o, slugs: [...q.slugs] }));
};

export const listPageRefsForSlugs: StoreMember<[slugs: readonly string[]], SweepPageRefRow[]> = async (brain, slugs) => {
  if (slugs.length === 0) return [];
  return storeCall({ member: 'listPageRefsForSlugs' }, () => brain.listPageRefsForSlugs({ slugs: [...slugs] }));
};
