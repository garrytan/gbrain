/**
 * The embedding effect's install path (persistence/effects.ts embedPage, page-state/projections.ts
 * installPageEmbeddings): the completion read, the effect claim check under its row lock, the
 * embedding switch's share lock and one batch of the vector install. Both SQL engines run these
 * statements; the Rust store answers the same members (rust/docs/store/embeddings.md,
 * "Embedding install").
 */
import type { SqlExecutor } from './executor.ts';
import type { ResolvedColumn } from '../types.ts';
import { quoteIdentifier, vectorCastSuffix } from '../search/embedding-column.ts';
import { sqlFragment, trustedSql } from './fragment.ts';

/**
 * One batch of the vector install (jsonRowBatches of `{ id, chunk_text, embedding, image, model, input_hash }`):
 * each row's vectors land on the page's chunk with that id while it still holds the row's text.
 */
export async function installChunkEmbeddings(exec: SqlExecutor, pageId: number, column: ResolvedColumn, batch: string): Promise<void> {
  const col = trustedSql(quoteIdentifier(column.name));
  const cast = trustedSql(vectorCastSuffix(column));
  await exec.run(sqlFragment`UPDATE content_chunks SET
        ${col}=CASE WHEN v.embedding IS NULL THEN content_chunks.${col} ELSE v.embedding${cast} END,
        embedding_image=CASE WHEN v.image IS NULL THEN content_chunks.embedding_image ELSE v.image::vector END,
        embedding_input_hash=CASE WHEN v.embedding IS NULL THEN content_chunks.embedding_input_hash ELSE v.input_hash END,
        embedded_at=now(),embedded_text_hash=md5(content_chunks.chunk_text),model=COALESCE(v.model,content_chunks.model),
        embedding_pending_since=CASE WHEN v.embedding IS NULL THEN content_chunks.embedding_pending_since ELSE NULL END
        FROM jsonb_to_recordset(${batch}::text::jsonb) AS v(id int, chunk_text text, embedding text, image text, model text, input_hash text)
        WHERE content_chunks.id=v.id AND content_chunks.page_id=${pageId} AND content_chunks.chunk_text=v.chunk_text`);
}
