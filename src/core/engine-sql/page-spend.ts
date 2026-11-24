/**
 * The page embedding reads around a page's lease (page-embedding-lease.ts), one function per BrainEngine member. The
 * name, argument list and statement text of `listVectorlessChunkIndexes` are the ones the segment-embed lane typed
 * (origin/rust-engine/segment-embed, commits 3ebc7aab90 and 76c4c4d3be), so the two branches merge by keeping one copy;
 * that lane's file also holds the lease, the per-page spend ledgers and the hold reads, which this branch does not move.
 * `embedStalePages` (embed-stale.ts) reads a page's stale chunk indexes through it. The Rust engine answers from its
 * store (rust/docs/store/page_spend.md).
 */
import type { BrainEngine } from '../engine.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';
import { chunkGenerationFilter } from '../search/safe-chunks.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** Chunk indexes of the page's live rows with no vector in `column`. */
export async function listVectorlessChunkIndexes(engine: Raw, pageId: number, column: string): Promise<number[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT cc.chunk_index FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = ${pageId} AND cc.${trustedSql(quoteIdentifier(column))} IS NULL AND ${trustedSql(chunkGenerationFilter('p', 'cc'))}`);
  const rows = await engine.executeRaw<{ chunk_index: number }>(text, params);
  return rows.map(row => Number(row.chunk_index));
}
