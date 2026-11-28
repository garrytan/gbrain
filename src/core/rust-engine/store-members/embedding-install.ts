/**
 * The embedding effect's install path the Rust store answers (engine-sql/embedding-install.ts): the completion read
 * (readEmbeddingCompletion), the effect claim check (lockEffectClaimRow), the embedding switch's share lock
 * (lockEmbeddingSwitch) and one batch of the vector install (installChunkEmbeddings).
 *
 * The store has one vector column, `embedding`, of 32-bit floats, and no image vectors: another column, a `halfvec`
 * descriptor, a vector of another width than the store keeps or an image row is refused before anything is written,
 * not stored in the wrong space or at the wrong width. The store write is exclusive, so the two locks need no row lock: the claim check is the
 * read, and the switch lock does nothing (the switch cannot flip inside the write that installs).
 *
 * What each member answers and why: rust/docs/store/embeddings.md ("Embedding install").
 */
import type { ResolvedColumn } from '../../types.ts';
import type { EmbeddingCompletionOpts, EmbeddingCompletionRow } from '../../engine-sql/embedding-install.ts';
import type { StoreBrain } from '../store.ts';
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

/**
 * Refuses a batch the store cannot write exactly. The store keeps float32 `vector` values of one width and checks none
 * on install, so a `halfvec` column (Postgres rounds to half precision) or a vector of another width than the store's
 * would be stored as written and marked complete, where Postgres rounds or rejects it. The descriptor's `dimensions` is
 * not read: the default descriptor carries a 1536 placeholder on every brain. The Rust analog of the column's width is
 * the width the store keeps (`readChunkVectorColumn`: the first stored vector, else the config `embedding_dimensions`);
 * with none known yet, the rows must at least agree with each other.
 */
async function requireStoredWidth(brain: StoreBrain, column: ResolvedColumn, vectors: number[][]): Promise<void> {
  const member = 'installChunkEmbeddings';
  if (column.type !== 'vector') refuseMember(member, `column ${column.name} ${String(column.type)}; the store writes float32 vector only`);
  const stored = await storeCall({ member }, () => brain.readChunkVectorColumn({ name: 'embedding' })) as { dims: number | null };
  const width = stored.dims ?? vectors[0]?.length;
  const off = vectors.find(vector => vector.length !== width);
  if (off) refuseMember(member, `a vector of ${off.length} dimensions for column ${column.name}; the store keeps ${width}`);
}

interface BatchRow { id: number; chunk_text: string; embedding: string | null; image: string | null; model: string | null; input_hash: string }

/** One batch of `{ id, chunk_text, embedding, image, model, input_hash }` rows (jsonRowBatches), vectors as `[...]` text. */
export const installChunkEmbeddings: StoreMember<[pageId: number, column: ResolvedColumn, batch: string], void> =
  async (brain, pageId, column, batch) => {
    if (column.name !== 'embedding') refuseMember('installChunkEmbeddings', `column ${column.name}`);
    const rows = JSON.parse(batch) as BatchRow[];
    if (rows.some(row => row.image !== null || row.embedding === null)) refuseMember('installChunkEmbeddings', 'an image vector');
    const vectors = rows.map(row => JSON.parse(row.embedding!) as number[]);
    await requireStoredWidth(brain, column, vectors);
    await storeCall({ member: 'installChunkEmbeddings' }, () => brain.installChunkEmbeddings(pageId, rows.map((row, i) => ({
      id: row.id, chunk_text: row.chunk_text, embedding: vectors[i]!, model: row.model, input_hash: row.input_hash,
    }))));
  };
