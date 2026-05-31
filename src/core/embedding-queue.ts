import {
  estimateTokenCount,
  type EmbeddedChunkBatch,
  type EmbeddingBatchProgress,
} from './embedding.ts';
import { modelUsesNomicTaskPrefixes, type ResolvedEmbeddingProvider } from './embedding/provider.ts';
import type { ChunkInput } from './types.ts';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 2;
const MAX_CHARS = 8000;

export interface EmbeddingQueueOptions {
  provider: ResolvedEmbeddingProvider;
  batchSize?: number;
  concurrency?: number;
  autoFlush?: boolean;
  onBatchStart?: (progress: EmbeddingBatchProgress) => void;
  onBatchComplete?: (progress: EmbeddingBatchProgress) => void;
}

export interface EmbeddingQueue {
  submit(chunks: ChunkInput[]): Promise<EmbeddedChunkBatch>;
  flush(): Promise<void>;
}

interface QueuedSubmission {
  updates: ChunkInput[];
  remaining: number;
  rejected: boolean;
  resolve: (result: EmbeddedChunkBatch) => void;
  reject: (error: unknown) => void;
}

interface QueuedChunk {
  chunk: ChunkInput;
  submission: QueuedSubmission;
  submissionIndex: number;
}

export function createEmbeddingQueue(options: EmbeddingQueueOptions): EmbeddingQueue {
  const provider = options.provider;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const autoFlush = options.autoFlush ?? true;
  const pending: QueuedChunk[] = [];
  let scheduledFlush: Promise<void> | null = null;
  let activeFlush: Promise<void> | null = null;

  const queue: EmbeddingQueue = {
    submit(chunks: ChunkInput[]): Promise<EmbeddedChunkBatch> {
      if (chunks.length === 0) {
        return Promise.resolve({
          capability: provider.capability,
          chunks: [],
          deferred: false,
        });
      }

      if (!provider.capability.available) {
        return Promise.resolve({
          capability: provider.capability,
          deferred: true,
          chunks: chunks.map(chunk => withTokenCount(chunk)),
        });
      }

      const promise = new Promise<EmbeddedChunkBatch>((resolve, reject) => {
        const submission: QueuedSubmission = {
          updates: new Array(chunks.length),
          remaining: chunks.length,
          rejected: false,
          resolve,
          reject,
        };

        for (let index = 0; index < chunks.length; index++) {
          pending.push({
            chunk: chunks[index],
            submission,
            submissionIndex: index,
          });
        }
      });

      if (autoFlush && !scheduledFlush) {
        scheduledFlush = Promise.resolve().then(async () => {
          scheduledFlush = null;
          await queue.flush();
        }).catch(() => {
          scheduledFlush = null;
        });
      }

      return promise;
    },

    async flush(): Promise<void> {
      if (activeFlush) {
        await activeFlush;
      }

      const entries = pending.splice(0);
      if (entries.length === 0) {
        return;
      }

      activeFlush = flushEntries(entries).finally(() => {
        activeFlush = null;
      });
      await activeFlush;
    },
  };

  async function flushEntries(entries: QueuedChunk[]): Promise<void> {
    const batches: QueuedChunk[][] = [];
    for (let index = 0; index < entries.length; index += batchSize) {
      batches.push(entries.slice(index, index + batchSize));
    }

    let nextBatchIndex = 0;
    let completed = 0;
    const workers = Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
      while (true) {
        const batchIndex = nextBatchIndex++;
        const batch = batches[batchIndex];
        if (!batch) return;
        const completedBeforeBatch = completed;

        options.onBatchStart?.({
          batchIndex: batchIndex + 1,
          batchCount: batches.length,
          batchSize: batch.length,
          completed: completedBeforeBatch,
          total: entries.length,
        });

        await runBatch(batch);
        completed += batch.length;
        const completedAfterBatch = completed;

        options.onBatchComplete?.({
          batchIndex: batchIndex + 1,
          batchCount: batches.length,
          batchSize: batch.length,
          completed: completedAfterBatch,
          total: entries.length,
        });
      }
    });

    await Promise.all(workers);
  }

  async function runBatch(batch: QueuedChunk[]): Promise<void> {
    try {
      const embeddings = await provider.embedBatch(
        batch.map(entry => prepareEmbeddingInput(entry.chunk.chunk_text, provider)),
      );
      if (embeddings.length !== batch.length) {
        throw new Error('Embedding provider returned an unexpected result count');
      }

      for (let index = 0; index < batch.length; index++) {
        const entry = batch[index];
        const submission = entry.submission;
        if (submission.rejected) continue;

        submission.updates[entry.submissionIndex] = {
          ...entry.chunk,
          embedding: embeddings[index],
          model: provider.capability.model ?? entry.chunk.model,
          token_count: entry.chunk.token_count ?? estimateTokenCount(entry.chunk.chunk_text),
        };
        submission.remaining -= 1;
        if (submission.remaining === 0) {
          submission.resolve({
            capability: provider.capability,
            deferred: false,
            chunks: submission.updates,
          });
        }
      }
    } catch (error) {
      for (const submission of new Set(batch.map(entry => entry.submission))) {
        if (!submission.rejected) {
          submission.rejected = true;
          submission.reject(error);
        }
      }
    }
  }

  return queue;
}

function withTokenCount(chunk: ChunkInput): ChunkInput {
  return {
    ...chunk,
    token_count: chunk.token_count ?? estimateTokenCount(chunk.chunk_text),
  };
}

function prepareEmbeddingInput(text: string, provider: ResolvedEmbeddingProvider): string {
  const truncated = text.slice(0, MAX_CHARS);
  if (!modelUsesNomicTaskPrefixes(provider.capability.model)) {
    return truncated;
  }
  return `search_document: ${truncated}`;
}
