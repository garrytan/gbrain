/**
 * The core edit notices (BrainEngine insertCoreEditNotice, readOldestPendingCoreEditNotice, findCoreEditNoticeIdByRevision,
 * ackCoreEditNotices; SQL once in engine-sql/core-edit-notices.ts), served from the store's core-edit-notices family
 * (rust/docs/store/core-edit-notices.md). The store allocates the ids and stamps `created_at` with its own clock, and
 * answers `created_at` in the `timestamptz::text` form the SQL engines return, so these members pass rows through.
 * `listPendingCoreEditNotices` is in trust-tier-reads.ts and `blankPurgeCoreEditNotices` in facts-purge.ts.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const insertCoreEditNotice: Member<'insertCoreEditNotice'> = async (brain, row) => ({
  id: Number(await storeCall({ member: 'insertCoreEditNotice', sourceId: row.sourceId }, () => brain.insertCoreEditNotice({
    sourceId: row.sourceId, slug: row.slug, pageId: row.pageId, revision: row.revision, baseRevision: row.baseRevision,
    baseText: row.baseText, actor: row.actor,
  }))),
});

export const readOldestPendingCoreEditNotice: Member<'readOldestPendingCoreEditNotice'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readOldestPendingCoreEditNotice', sourceId }, () => brain.readOldestPendingCoreEditNotice(sourceId, slug));

export const findCoreEditNoticeIdByRevision: Member<'findCoreEditNoticeIdByRevision'> = (brain, sourceId, slug, revision) =>
  storeCall({ member: 'findCoreEditNoticeIdByRevision', sourceId }, () => brain.findCoreEditNoticeIdByRevision(sourceId, slug, revision));

export const ackCoreEditNotices: Member<'ackCoreEditNotices'> = (brain, sourceId, slug, maxId) =>
  storeCall({ member: 'ackCoreEditNotices', sourceId }, () => brain.ackCoreEditNotices(sourceId, slug, maxId));
