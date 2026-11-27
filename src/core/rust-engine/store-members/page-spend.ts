/**
 * The page embedding reads around a page's lease (src/core/engine-sql/page-spend.ts), served from
 * rust/crates/gbrain-store/src/page_body/page_spend.rs: listVectorlessChunkIndexes. The name, arguments and file name are
 * the ones the segment-embed lane typed (origin/rust-engine/segment-embed); its file of this name also serves the lease,
 * the per-page spend ledgers and the hold reads, which this branch does not move.
 *
 * The store keeps one vector column, `embedding`, so the member refuses any other column.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts).
 */
import { refuseMember, storeCall, type StoreMember } from './common.ts';

/** The one vector column the store keeps; a member asked for another refuses. */
function storeColumn(member: string, column: string): void {
  if (column !== 'embedding') refuseMember(member, `column ${column}`);
}

export const listVectorlessChunkIndexes: StoreMember<[pageId: number, column: string], number[]> = async (brain, pageId, column) => {
  storeColumn('listVectorlessChunkIndexes', column);
  return storeCall({ member: 'listVectorlessChunkIndexes' }, () => brain.listVectorlessChunkIndexes(pageId));
};
