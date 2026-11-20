/**
 * The page repair reads of the access and orphan-children kinds and the origin index (BrainEngine countPageChildOrphans
 * through listOriginTwinCounts, the statements of engine-sql/repair-page-reads.ts). The store holds each invariant
 * those statements look for a breach of, so each member answers from that invariant, not a scan. Why each answer
 * holds: rust/docs/store/repair-bookkeeping.md, "Page repair reads".
 */
import type { OriginIndexState, OriginTwinCount, PageRef, TornPages } from '../../engine-sql/repair-page-reads.ts';
import { pageChildTarget } from '../../engine-sql/repair-page-reads.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

const isChunks = (target: { table: string; col: string }) => target.table === 'content_chunks' && target.col === 'page_id';

/**
 * Chunk rows with no page are counted from the store's chunk keys (countOrphanChunks). Every other child row is removed
 * in the same write that removes its page (cascade::remove_page_rows), so none can outlive it: 0. An unlisted column
 * throws as on PGLite.
 */
export const countPageChildOrphans: StoreMember<[target: { table: string; col: string }], number> = async (brain, target) => {
  pageChildTarget(target);
  if (!isChunks(target)) return 0;
  return Number(await storeCall({ member: 'countPageChildOrphans' }, () => brain.countOrphanChunks()));
};

/** Nothing to clear (see countPageChildOrphans); a chunk orphan the store counts refuses, as the store has no writer for it. */
export const clearPageChildOrphans: StoreMember<[target: { table: string; col: string }], number> = async (brain, target) => {
  pageChildTarget(target);
  if (isChunks(target) && Number(await storeCall({ member: 'clearPageChildOrphans' }, () => brain.countOrphanChunks())) > 0) {
    refuseMember('clearPageChildOrphans', 'the store has no writer for chunk rows whose page is gone');
  }
  return 0;
};

/** The store keeps each body in its own record, with no out-of-line value that can tear: none. */
export const probeTornPages: StoreMember<[], TornPages> = async () => ({ count: 0, named: [] });

/**
 * The store keeps no `page_readers` column: every read derives the readers from the page's frontmatter (the facts
 * privacy reader), so stored and named readers cannot differ. None, 0 and false.
 */
export const listAccessReaderDrift: StoreMember<[sourceIds: readonly string[], afterId: number], PageRef[]> = async () => [];
export const countAccessReaderDrift: StoreMember<[], number> = async () => 0;
export const deriveAccessReaders: StoreMember<[pageId: number], boolean> = async () => false;

/**
 * The store refuses a second live page of one source recording one source path (ORIGIN_CLAIMED, keys::page_origin), the
 * invariant `pages_live_origin_key` holds on a SQL brain, from its first write: present, and no twin group.
 */
export const readOriginIndexState: StoreMember<[], OriginIndexState> = async () => 'present';
export const listOriginTwinCounts: StoreMember<[limit: number], OriginTwinCount[]> = async () => [];
