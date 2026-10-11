/**
 * Embedding pass for typed take claims.
 *
 * Runs from `gbrain takes embed` and, unless `takes.auto_embed` is off, from
 * every `embed --stale` drain (which the cycle's embed phase and the
 * embedding-model migration drain both use). A take is stale when it has no
 * vector, its claim changed since it was embedded, or another model or width
 * produced its vector (#5885). Each write is bound to the claim text and model
 * it was computed from, so a claim edited mid-flight keeps its NULL vector.
 */

import type { BrainEngine, StaleTakeRow, TakeEmbeddingInput } from './engine.ts';
import { embedBatchWithBackoff } from '../commands/embed.ts';
import { getEmbeddingDimensions, getEmbeddingModel } from './ai/gateway.ts';
import { slog } from './console-prefix.ts';
import { currentEmbeddingSignature } from './embedding.ts';

const DEFAULT_BATCH_SIZE = 100;

export interface EmbedTakesOpts {
  batchSize?: number;
  dryRun?: boolean;
  signal?: AbortSignal;
  sourceId?: string;
  assertOwned?: (tx: BrainEngine) => Promise<void>;
  embedFn?: (texts: string[], opts: { abortSignal?: AbortSignal }) => Promise<Float32Array[]>;
  onProgress?: (done: number, total: number, embedded: number) => void;
}

export interface EmbedTakesResult {
  total_stale: number;
  embedded: number;
  would_embed: number;
  /** Vectors not written because the take's claim changed while they were computed; the next pass embeds the new claim. */
  discarded: number;
  failures: number;
  failure_samples: string[];
  dryRun: boolean;
}

/** `takes.auto_embed` (config) with `GBRAIN_EMBED_TAKES` (env) taking precedence; default on. */
export async function takesAutoEmbedEnabled(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  const raw = process.env.GBRAIN_EMBED_TAKES ?? await engine.getConfig('takes.auto_embed');
  return raw == null || !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

/** Width of `takes.embedding`, or null when the column is absent. */
export async function readTakesEmbeddingDim(engine: Pick<BrainEngine, 'executeRaw'>): Promise<number | null> {
  const rows = await engine.executeRaw<{ formatted: string | null }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS formatted
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'takes' AND a.attname = 'embedding' AND NOT a.attisdropped`,
  );
  const dims = Number(rows[0]?.formatted?.match(/^(?:halfvec|vector)\((\d+)\)$/)?.[1]);
  return Number.isInteger(dims) && dims > 0 ? dims : null;
}

/** Embed active takes that have no current-model vector for their current claim. */
export async function embedStaleTakes(
  engine: BrainEngine,
  opts: EmbedTakesOpts = {},
): Promise<EmbedTakesResult> {
  const model = getEmbeddingModel();
  const dims = getEmbeddingDimensions();
  const scope = { model, dims, ...(opts.sourceId ? { sourceId: opts.sourceId } : {}) };
  const stale = await engine.countStaleTakes(scope) > 0 ? await engine.listStaleTakes(scope) : [];
  const result: EmbedTakesResult = {
    total_stale: stale.length,
    embedded: 0,
    would_embed: opts.dryRun ? stale.length : 0,
    discarded: 0,
    failures: 0,
    failure_samples: [],
    dryRun: !!opts.dryRun,
  };
  if (opts.dryRun || stale.length === 0) {
    opts.onProgress?.(stale.length, stale.length, 0);
    return result;
  }
  const columnDims = await readTakesEmbeddingDim(engine);
  if (columnDims !== dims) {
    result.failures = stale.length;
    result.failure_samples.push(
      `takes_embedding_width_mismatch: takes.embedding is ${columnDims === null ? 'absent' : `${columnDims}d`}, the configured model is ${dims}d. ` +
      'Fix: gbrain migrate embeddings --status',
    );
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
        claim: row.claim,
        model,
      }));
      const written = opts.sourceId
        ? await engine.transaction(async tx => {
          await opts.assertOwned?.(tx);
          const takeIds = writes.map(row => row.take_id);
          const [source] = await tx.executeRaw<{ id: string }>(
            'SELECT id FROM sources WHERE id = $1 AND NOT archived FOR SHARE', [opts.sourceId],
          );
          if (!source) return 0;
          const pages = await tx.executeRaw<{ id: number }>(
            `SELECT p.id FROM pages p
              WHERE p.source_id = $2 AND p.deleted_at IS NULL
                AND EXISTS (SELECT 1 FROM takes t WHERE t.id = ANY($1::bigint[]) AND t.page_id = p.id)
              ORDER BY p.id
              FOR UPDATE OF p`,
            [takeIds, opts.sourceId],
          );
          const pageIds = pages.map(row => Number(row.id));
          if (pageIds.length === 0) return 0;
          const current = await tx.executeRaw<{ id: number }>(
            `SELECT t.id FROM takes t
               JOIN pages p ON p.id = t.page_id
              WHERE t.id = ANY($1::bigint[]) AND t.page_id = ANY($2::bigint[]) AND p.source_id = $3
                AND t.active AND p.deleted_at IS NULL
              ORDER BY t.id
              FOR UPDATE OF t`,
            [takeIds, pageIds, opts.sourceId],
          );
          const ids = new Set(current.map(row => Number(row.id)));
          return tx.updateTakeEmbeddings(writes.filter(row => ids.has(row.take_id)), { signal: opts.signal });
        })
        : opts.assertOwned
          ? await engine.transaction(async tx => { await opts.assertOwned!(tx); return tx.updateTakeEmbeddings(writes, { signal: opts.signal }); })
          : await engine.updateTakeEmbeddings(writes, { signal: opts.signal });
      result.embedded += written;
      result.discarded += batch.length - written;
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

/**
 * The takes pass of an `embed --stale` drain (#5885). Runs when `opts.takes`
 * is true, or when it is unset and takes.auto_embed allows it; records its
 * result on the drain result and counts its failures there too.
 */
export async function embedTakesForStaleDrain(
  engine: BrainEngine,
  opts: EmbedTakesOpts & { quiet?: boolean; takes?: boolean },
  result: { failures: number; failure_samples: string[]; takes?: EmbedTakesResult },
): Promise<void> {
  if (!(opts.takes ?? await takesAutoEmbedEnabled(engine))) return;
  // No configured model to bind a vector to (embedding_identity_unverified): the chunk drain runs signature-free; takes wait.
  if (currentEmbeddingSignature() === null) return;
  let takes: EmbedTakesResult;
  try {
    takes = await embedStaleTakes(engine, opts);
  } catch (error: unknown) {
    takes = { total_stale: 0, embedded: 0, would_embed: 0, discarded: 0, failures: 1, dryRun: !!opts.dryRun,
      failure_samples: [error instanceof Error ? error.message : String(error)] };
  }
  result.takes = takes;
  if (takes.failures > 0) {
    result.failures += takes.failures;
    result.failure_samples.push(...takes.failure_samples.slice(0, Math.max(0, 10 - result.failure_samples.length)).map(sample => `takes: ${sample}`));
  }
  if (opts.quiet || takes.total_stale === 0) return;
  slog(opts.dryRun
    ? `[dry-run] Would embed ${takes.would_embed} stale take(s)`
    : `[embed] takes: embedded ${takes.embedded} of ${takes.total_stale} stale take(s)${takes.discarded ? `, ${takes.discarded} changed mid-flight (re-embedded next run)` : ''}`);
}
