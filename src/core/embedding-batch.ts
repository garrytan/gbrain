import { DEFAULT_EMBEDDING_BATCH_MAX_TEXTS } from './config.ts';
import { embedBatch } from './embedding.ts';

export type EmbeddingBatchFn<TInput, TOutput> = (items: TInput[]) => Promise<TOutput[]>;

export async function embedItemsInBatches<TInput, TOutput>(
  items: TInput[],
  maxTexts: number = DEFAULT_EMBEDDING_BATCH_MAX_TEXTS,
  embedFn: EmbeddingBatchFn<TInput, TOutput>,
): Promise<TOutput[]> {
  if (!Number.isSafeInteger(maxTexts) || maxTexts <= 0) {
    throw new Error('[embed] embedding_batch_max_texts must be a positive integer');
  }
  if (items.length === 0) return [];
  if (items.length <= maxTexts) {
    return embedFn(items);
  }

  const outputs: TOutput[] = [];
  for (let start = 0; start < items.length; start += maxTexts) {
    const batch = items.slice(start, start + maxTexts);
    const batchOutputs = await embedFn(batch);
    outputs.push(...batchOutputs);
  }
  return outputs;
}

export async function embedTextsInBatches(
  texts: string[],
  maxTexts: number = DEFAULT_EMBEDDING_BATCH_MAX_TEXTS,
  embedFn: EmbeddingBatchFn<string, Float32Array> = embedBatch,
): Promise<Float32Array[]> {
  return embedItemsInBatches(texts, maxTexts, embedFn);
}
