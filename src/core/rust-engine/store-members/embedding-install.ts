/**
 * The embedding effect's install path the Rust store answers (engine-sql/embedding-install.ts): the completion read
 * (readEmbeddingCompletion), the effect claim check (lockEffectClaimRow), the embedding switch's share lock
 * (lockEmbeddingSwitch) and one batch of the vector install (installChunkEmbeddings).
 *
 * The store has one vector column, `embedding`, and no image vectors: another column or an image row is refused, not
 * written to the wrong space. The store write is exclusive, so the two locks need no row lock: the claim check is the
 * read, and the switch lock does nothing (the switch cannot flip inside the write that installs).
 *
 * What each member answers and why: rust/docs/store/embeddings.md ("Embedding install").
 */
import type { ResolvedColumn } from '../../types.ts';
import type { EmbeddingCompletionOpts, EmbeddingCompletionRow } from '../../engine-sql/embedding-install.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

/** The page's visible chunks and which already carry a vector from their current text under the model. */
export const readEmbeddingCompletion: StoreMember<[pageId: number, opts: EmbeddingCompletionOpts], EmbeddingCompletionRow[]> =
  async (brain, pageId, opts) => {
    if (opts.column.name !== 'embedding') refuseMember('readEmbeddingCompletion', `column ${opts.column.name}`);
    return storeCall({ member: 'readEmbeddingCompletion' }, () => brain.readEmbeddingCompletion(pageId,
      { signature: opts.signature, model: opts.model ?? null })) as Promise<EmbeddingCompletionRow[]>;
  };

/** The effect's state and execution token, or null when no effect has the id. */
export const lockEffectClaimRow: StoreMember<[effectId: number | string], { state: string; execution_token: string | null } | null> =
  (brain, effectId) => storeCall({ member: 'lockEffectClaimRow' }, () => brain.lockEffectClaimRow(Number(effectId))) as
    Promise<{ state: string; execution_token: string | null } | null>;

/** Nothing to lock: the store write that installs is exclusive. */
export const lockEmbeddingSwitch: StoreMember<[], void> = async () => {};

interface BatchRow { id: number; chunk_text: string; embedding: string | null; image: string | null; model: string | null; input_hash: string }

/** One batch of `{ id, chunk_text, embedding, image, model, input_hash }` rows (jsonRowBatches), vectors as `[...]` text. */
export const installChunkEmbeddings: StoreMember<[pageId: number, column: ResolvedColumn, batch: string], void> =
  async (brain, pageId, column, batch) => {
    if (column.name !== 'embedding') refuseMember('installChunkEmbeddings', `column ${column.name}`);
    const rows = JSON.parse(batch) as BatchRow[];
    if (rows.some(row => row.image !== null || row.embedding === null)) refuseMember('installChunkEmbeddings', 'an image vector');
    await storeCall({ member: 'installChunkEmbeddings' }, () => brain.installChunkEmbeddings(pageId, rows.map(row => ({
      id: row.id, chunk_text: row.chunk_text, embedding: JSON.parse(row.embedding!) as number[], model: row.model, input_hash: row.input_hash,
    }))));
  };
