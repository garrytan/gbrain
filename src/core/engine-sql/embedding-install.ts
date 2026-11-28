/**
 * The embedding effect's install path (persistence/effects.ts embedPage, page-state/projections.ts
 * installPageEmbeddings): the completion read, the effect claim check under its row lock, the
 * embedding switch's share lock and one batch of the vector install. Both SQL engines run these
 * statements; the Rust store answers the same members (rust/docs/store/embeddings.md,
 * "Embedding install").
 */
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import type { ResolvedColumn } from '../types.ts';
import { quoteIdentifier, vectorCastSuffix } from '../search/embedding-column.ts';
import { chunkGenerationFilter } from '../search/safe-chunks.ts';
import { sqlFragment, trustedSql } from './fragment.ts';

/** One visible chunk of the page and whether it already carries a current vector. */
export interface EmbeddingCompletionRow {
  id: number;
  chunk_text: string;
  chunk_source: string | null;
  embedding_input_hash: string | null;
  embedded: boolean;
  /** Null when the page has no signature yet. */
  stamped: boolean | null;
}

export interface EmbeddingCompletionOpts {
  signature: string;
  /** The chunk model a complete vector carries; null matches a chunk with no model. */
  model: string | null | undefined;
  column: Pick<ResolvedColumn, 'name'>;
  /** chunkManifestReads: whether the segmented-body manifest is readable here. */
  manifest: boolean;
}

/** The page's visible chunks with `embedded` (vector from the current text under `model`) and `stamped` (page signature = `signature`). */
export async function readEmbeddingCompletion(exec: LegacyUnscopedRead, pageId: number, opts: EmbeddingCompletionOpts): Promise<EmbeddingCompletionRow[]> {
  const col = trustedSql(quoteIdentifier(opts.column.name));
  const generation = trustedSql(chunkGenerationFilter('p', 'cc', opts.manifest));
  return (await exec.run<EmbeddingCompletionRow>(sqlFragment`SELECT cc.id,
      cc.chunk_text, cc.chunk_source, cc.embedding_input_hash,
      cc.${col} IS NOT NULL AND cc.embedded_at IS NOT NULL AND cc.embedded_text_hash=md5(cc.chunk_text)
        AND cc.model IS NOT DISTINCT FROM ${opts.model ?? null} AS embedded,
      p.embedding_signature=${opts.signature} AS stamped
      FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.id=${pageId} AND ${generation}`)).rows;
}

/** lockEffectClaimRow's one statement (a row lock on the effect journal; the shadow write sampler judges it by this text, src/shadow/write-capture.ts). */
export const EFFECT_CLAIM_ROW_LOCK_SQL = 'SELECT state,execution_token FROM persistence_effects WHERE id=$1 FOR UPDATE';

/** The effect's state and execution token under its row lock, or null when no effect has the id. */
export async function lockEffectClaimRow(exec: SqlExecutor, effectId: number | string): Promise<{ state: string; execution_token: string | null } | null> {
  const [claim] = await exec.executeRaw<{ state: string; execution_token: string | null }>(EFFECT_CLAIM_ROW_LOCK_SQL, [effectId]);
  return claim ?? null;
}

/** A share lock on the embedding switch, so `embedding_disabled` cannot flip while vectors install. */
export async function lockEmbeddingSwitch(exec: SqlExecutor): Promise<void> {
  await exec.executeRaw("SELECT key FROM config WHERE key='embedding_disabled' FOR SHARE");
}

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
