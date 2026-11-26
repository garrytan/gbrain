/**
 * The embedding effect's install path the Rust store answers (engine-sql/embedding-install.ts): the completion read
 * (readEmbeddingCompletion), the effect claim check (lockEffectClaimRow), the embedding switch's share lock
 * (lockEmbeddingSwitch) and one batch of the vector install (installChunkEmbeddings).
 *
 * The store has one vector column, `embedding`, and no image vectors: another column or an image row is refused, not
 * written to the wrong space. The row locks are skipped while explicit transactions hold the writer
 * (`serialized_transactions`; `lockEmbeddingSwitch` asserts it): the claim check is the read, and the switch lock takes
 * nothing.
 *
 * What each member answers and why: rust/docs/store/embeddings.md ("Embedding install").
 */
import type { ResolvedColumn } from '../../types.ts';
import type { EffectInstallClaim, EmbeddingCompletionOpts, EmbeddingCompletionRow } from '../../engine-sql/embedding-install.ts';
import { assertStoreSerializedTransactions, refuseMember, storeCall, type StoreMember } from './common.ts';

/** The page's visible chunks and which already carry a vector from their current text under the model. */
export const readEmbeddingCompletion: StoreMember<[pageId: number, opts: EmbeddingCompletionOpts], EmbeddingCompletionRow[]> =
  async (brain, pageId, opts) => {
    if (opts.column.name !== 'embedding') refuseMember('readEmbeddingCompletion', `column ${opts.column.name}`);
    return storeCall({ member: 'readEmbeddingCompletion' }, () => brain.readEmbeddingCompletion(pageId,
      { signature: opts.signature, model: opts.model ?? null })) as Promise<EmbeddingCompletionRow[]>;
  };

/** The effect's state and execution token, or null when no effect has the id. */
export const lockEffectClaimRow: StoreMember<[effectId: number | string, claim?: EffectInstallClaim], { state: string; execution_token: string | null } | null> =
  (brain, effectId, claim) => storeCall({ member: 'lockEffectClaimRow' }, () => brain.lockEffectClaimRow(Number(effectId),
    claim ? { effectId: String(effectId), token: claim.token, ...(claim.fence ? { fence: claim.fence } : {}) } : undefined)) as
    Promise<{ state: string; execution_token: string | null } | null>;

/** The FOR SHARE is skipped while explicit transactions hold the writer (`serialized_transactions`); it asserts that. */
export const lockEmbeddingSwitch: StoreMember<[], void> = async brain => {
  assertStoreSerializedTransactions(brain, 'lockEmbeddingSwitch');
  // Multi-user mode: the share lock becomes a read of the `embedding_disabled` config row, so a flip committed before the
  // commit refuses it and the transaction runs again. Single-user mode reads nothing, as before.
  if (brain.multiuser === true) await storeCall({ member: 'lockEmbeddingSwitch' }, () => brain.getConfig('embedding_disabled'));
};

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
