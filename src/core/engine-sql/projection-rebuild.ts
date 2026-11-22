/**
 * The statements a page's chunk reseal sends (page-state/projections.ts installPageProjection with `seal` and
 * `preserveEmbeddings`, planProjectionKeep, and resealSafeChunks' pending count). Each function runs the statement its
 * caller ran through `executeRaw` on the engine's own `executeRaw`; the keep read and the vector clear are built with
 * sqlFragment so their placeholders are numbered in text order, every other text is unchanged.
 * `test/projection-rebuild-sql-pin.test.ts` pins each statement and its binds against the ones recorded before the move.
 *
 * The names, argument lists and statement text are the ones the rust-rebuild-path lane typed
 * (origin/rust-engine/rust-rebuild-path, commits 7f1ee5198e and 170280a2cd), so the two branches merge by keeping one copy.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { movableChunkSql } from '../search/safe-chunks.ts';
import { chunkModelMatchesSql } from '../embedding-invalidation.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';

/** The vector column a keep plan compares against. */
export interface KeepColumn { name: string; dimensions: number }

export interface ChunkKeepState { id: number; embedding_input_hash: string | null; movable: boolean }

/**
 * Each chunk of the page with its recorded embedding input and whether its vector in `column` is current: present,
 * embedded from the chunk's text as it is now, and labelled `provenanceModel` (or its bare name at the column's width).
 */
export async function readChunkKeepState(raw: EngineRawRead, pageId: number, provenanceModel: string | null, column: KeepColumn): Promise<ChunkKeepState[]> {
  const col = quoteIdentifier(column.name);
  const { text, params } = renderFragment(
    // chunk-visibility-ok: the keep plan compares every stored chunk row of the page it is about to replace
    sqlFragment`SELECT id,embedding_input_hash,${trustedSql(movableChunkSql(col))} AND ${keptModelFragment(col, column.dimensions, provenanceModel)} AS movable FROM content_chunks WHERE page_id=${pageId}`);
  return raw<ChunkKeepState>(text, params);
}

/**
 * Clears the vector in `column` and its embedding record on each chunk of the page that is not labelled
 * `provenanceModel` (or its bare name at the column's width), whose recorded text hash is not its text's, or whose id
 * is not in `currentIds`, and marks it pending.
 */
export async function clearUnkeptChunkVectors(raw: EngineRawRead, pageId: number, provenanceModel: string | null, column: KeepColumn, currentIds: readonly number[]): Promise<void> {
  const col = quoteIdentifier(column.name);
  const { text, params } = renderFragment(sqlFragment`UPDATE content_chunks SET ${trustedSql(col)}=NULL,
        embedded_at=NULL,embedded_text_hash=NULL,embedding_input_hash=NULL,
        embedding_pending_since=COALESCE(embedding_pending_since,now()) WHERE page_id=${pageId} AND
        (NOT ${keptModelFragment(col, column.dimensions, provenanceModel)} OR embedded_text_hash <> md5(chunk_text) OR NOT(id=ANY(${[...currentIds]}::int[])))`);
  await raw(text, params);
}

/**
 * `chunkModelMatchesSql` (embedding-invalidation.ts) over the chunk's `model` as a fragment: built from its text, with
 * `model` bound in place of its model parameter (as chunks.ts currentSpaceChunkFragment does), so the two cannot drift.
 */
function keptModelFragment(col: string, dimensions: number, model: string | null): SqlFragment {
  if (!Number.isInteger(dimensions)) throw new Error(`embedding column width must be an integer, got ${dimensions}`);
  const strings = chunkModelMatchesSql('model', '$9001', `vector_dims(${col}) = ${dimensions}`).split('$9001');
  return sqlFragment(Object.assign([...strings], { raw: [...strings] }), model);
}

/** How many of the page's text chunks have no vector in `column`, and their characters: a re-seal's embedding work. */
export async function countPendingTextChunks(raw: EngineRawRead, pageId: number, column: KeepColumn): Promise<{ chunks: number; chars: number }> {
  // chunk-visibility-ok: a count of the page's unembedded text chunks after its own re-seal, never returned to a reader
  const { text, params } = renderFragment(sqlFragment`SELECT COUNT(*)::int AS chunks,
    COALESCE(SUM(length(chunk_text)),0)::int AS chars FROM content_chunks
    WHERE page_id=${pageId} AND ${trustedSql(quoteIdentifier(column.name))} IS NULL AND modality='text'`);
  const [pending] = await raw<{ chunks: number; chars: number }>(text, params);
  return { chunks: Number(pending?.chunks ?? 0), chars: Number(pending?.chars ?? 0) };
}
