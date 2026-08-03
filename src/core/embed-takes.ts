/**
 * Embedding pass for typed take claims.
 *
 * Takes already have vector search and a stale-row contract, but no writer.
 * Keep this pass separate from page/chunk embedding so callers can opt into
 * the extra provider work and see its counts independently.
 */

import type { BrainEngine, StaleTakeRow, TakeEmbeddingInput } from './engine.ts';
import { embedBatchWithBackoff } from '../commands/embed.ts';

const DEFAULT_BATCH_SIZE = 100;

export interface EmbedTakesOpts {
  batchSize?: number;
  dryRun?: boolean;
  signal?: AbortSignal;
  embedFn?: (texts: string[], opts: { abortSignal?: AbortSignal }) => Promise<Float32Array[]>;
  onProgress?: (done: number, total: number, embedded: number) => void;
}

export interface EmbedTakesResult {
  total_stale: number;
  embedded: number;
  would_embed: number;
  failures: number;
  failure_samples: string[];
  dryRun: boolean;
}

/** Embed active takes whose embedding column is NULL. */
export async function embedStaleTakes(
  engine: BrainEngine,
  opts: EmbedTakesOpts = {},
): Promise<EmbedTakesResult> {
  const stale = await engine.listStaleTakes();
  const result: EmbedTakesResult = {
    total_stale: stale.length,
    embedded: 0,
    would_embed: opts.dryRun ? stale.length : 0,
    failures: 0,
    failure_samples: [],
    dryRun: !!opts.dryRun,
  };
  if (opts.dryRun || stale.length === 0) {
    opts.onProgress?.(stale.length, stale.length, 0);
    return result;
  }

  const batchSize = Math.min(500, Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE)));
  const embedFn = opts.embedFn ?? ((texts: string[], embedOpts: { abortSignal?: AbortSignal }) =>
    embedBatchWithBackoff(texts, embedOpts));

  for (let start = 0; start < stale.length; start += batchSize) {
    if (opts.signal?.aborted) break;
    const batch = stale.slice(start, start + batchSize);
    try {
      const embeddings = await embedFn(
        batch.map((row) => row.claim),
        { abortSignal: opts.signal },
      );
      if (embeddings.length !== batch.length) {
        throw new Error(`embedding provider returned ${embeddings.length} vectors for ${batch.length} takes`);
      }
      const writes: TakeEmbeddingInput[] = batch.map((row: StaleTakeRow, index) => ({
        take_id: row.take_id,
        embedding: embeddings[index],
      }));
      result.embedded += await engine.updateTakeEmbeddings(writes, { signal: opts.signal });
    } catch (error: unknown) {
      result.failures += batch.length;
      if (result.failure_samples.length < 10) {
        result.failure_samples.push(error instanceof Error ? error.message : String(error));
      }
    }
    opts.onProgress?.(Math.min(start + batch.length, stale.length), stale.length, result.embedded);
  }

  return result;
}
