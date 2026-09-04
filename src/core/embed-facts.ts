/**
 * Embedding backfill for hot-memory fact rows (#4812).
 *
 * Facts get their vector at write time (`embedOne(factText)` in
 * facts/write-single.ts + facts/extract.ts), but rows written while the
 * provider was down, keyless, or budget-capped land with `embedding IS NULL`
 * and nothing ever revisits them. The `migrate embeddings` status report counts those
 * rows as `facts_pending`; this pass drains them. Mirrors embed-takes.ts.
 *
 * The bare `fact` text is embedded, matching the write path, so backfilled
 * vectors share the space that consolidate / findCandidateDuplicates query.
 * No contextual wrapper is applied here on purpose.
 */

import type { BrainEngine, StaleFactRow, FactEmbeddingInput } from './engine.ts';
import { embedBatchWithBackoff } from './embed-retry.ts';
import { resolveMaxChunkTokens } from './embedding-input-limit.ts';
import { estimateTokens } from './chunkers/token-estimate.ts';

const DEFAULT_BATCH_SIZE = 100;

export interface EmbedFactsOpts {
  batchSize?: number;
  dryRun?: boolean;
  /** Scope to one source_id; undefined/null = every source. */
  sourceId?: string | null;
  signal?: AbortSignal;
  embedFn?: (texts: string[], opts: { abortSignal?: AbortSignal }) => Promise<Float32Array[]>;
  onProgress?: (done: number, total: number, embedded: number) => void;
  /** Test seam: per-input token ceiling. Defaults to resolveMaxChunkTokens(). */
  maxInputTokens?: number;
}

export interface EmbedFactsResult {
  total_stale: number;
  embedded: number;
  would_embed: number;
  failures: number;
  failure_samples: string[];
  dryRun: boolean;
}

/**
 * Same predicate as the `facts_pending` counter in embedding-migration.ts
 * (`WHERE embedding IS NULL AND expired_at IS NULL`), narrowed by source.
 */
async function countFactsNeedingEmbedding(engine: BrainEngine, sourceId: string | null): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM facts
      WHERE embedding IS NULL AND expired_at IS NULL
        AND ($1::text IS NULL OR source_id = $1)`,
    [sourceId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Embed active facts whose embedding column is NULL. */
export async function embedStaleFacts(
  engine: BrainEngine,
  opts: EmbedFactsOpts = {},
): Promise<EmbedFactsResult> {
  const sourceId = opts.sourceId ?? null;
  const total = await countFactsNeedingEmbedding(engine, sourceId);
  const result: EmbedFactsResult = {
    total_stale: total,
    embedded: 0,
    would_embed: opts.dryRun ? total : 0,
    failures: 0,
    failure_samples: [],
    dryRun: !!opts.dryRun,
  };
  if (opts.dryRun || total === 0) {
    opts.onProgress?.(total, total, 0);
    return result;
  }

  const batchSize = Math.min(500, Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE)));
  const embedFn = opts.embedFn ?? ((texts: string[], embedOpts: { abortSignal?: AbortSignal }) =>
    embedBatchWithBackoff(texts, embedOpts));
  const maxTokens = opts.maxInputTokens ?? resolveMaxChunkTokens();
  const noteFailure = (message: string): void => {
    if (result.failure_samples.length < 10) result.failure_samples.push(message);
  };

  // Cursor-paged on id so a failed batch (rows stay NULL) can never re-select
  // itself and spin; the next run picks those rows up again.
  let afterId = 0;
  let done = 0;
  for (;;) {
    if (opts.signal?.aborted) break;
    const batch = await engine.listFactsNeedingEmbedding({ limit: batchSize, afterId, sourceId });
    if (batch.length === 0) break;
    afterId = batch[batch.length - 1].fact_id;

    // Defensive: the write path never produced an over-limit fact, but a row
    // that would be rejected by the provider is reported, not sent.
    const sendable: StaleFactRow[] = [];
    for (const row of batch) {
      const tokens = estimateTokens(row.fact);
      if (tokens > maxTokens) {
        result.failures += 1;
        noteFailure(`fact_id=${row.fact_id} exceeds the embedding input limit (${tokens} > ${maxTokens} tokens); skipped`);
      } else {
        sendable.push(row);
      }
    }

    if (sendable.length > 0) {
      try {
        const embeddings = await embedFn(
          sendable.map((row) => row.fact),
          { abortSignal: opts.signal },
        );
        if (embeddings.length !== sendable.length) {
          throw new Error(`embedding provider returned ${embeddings.length} vectors for ${sendable.length} facts`);
        }
        const writes: FactEmbeddingInput[] = sendable.map((row, index) => ({
          fact_id: row.fact_id,
          embedding: embeddings[index],
        }));
        result.embedded += await engine.updateFactEmbeddings(writes, { signal: opts.signal });
      } catch (error: unknown) {
        result.failures += sendable.length;
        noteFailure(error instanceof Error ? error.message : String(error));
      }
    }
    done += batch.length;
    opts.onProgress?.(Math.min(done, total), total, result.embedded);
  }

  return result;
}
