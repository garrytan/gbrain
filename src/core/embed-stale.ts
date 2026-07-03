/**
 * Stale-chunk embedding loop, extracted from `src/commands/embed.ts:embedAllStale`
 * for reuse by the v0.40 `embed-backfill` Minion handler (D15.2 — codex
 * outside-voice catch).
 *
 * Single source of truth for the cursor-paginated, source-grouped, rate-limit-
 * aware embedding pipeline. Both `gbrain embed --stale` (CLI) and the
 * `embed-backfill` job (Minion) call this helper so the working machinery
 * — keyset pagination, batch grouping by `source_id::slug`, merge-with-existing
 * via `getChunks` + `upsertChunks`, AbortSignal threading into in-flight HTTPs,
 * 429 backoff — lives in exactly one place.
 *
 * Why a separate file (vs. exporting from embed.ts): embed.ts is a CLI command
 * with logging side-effects and EmbedResult-shaped aggregation. The handler
 * needs a tighter functional surface (returns embedded count + done state, no
 * console.log). Extracting kept embed.ts's outer flow intact while letting the
 * handler call a clean primitive.
 */

import type { BrainEngine } from './engine.ts';
import type { ChunkInput } from './types.ts';
import { embedBatchWithBackoff } from '../commands/embed.ts';
import { type DbPacer, createNoopPacer, observed } from './db-pacer.ts';
import { AbortError } from './abort-check.ts';

/** Last visited (page_id, chunk_index) for keyset-resume across runs. */
export interface StaleCursor {
  afterPageId: number;
  afterChunkIndex: number;
}

export interface EmbedStaleOpts {
  /** Chunks per cursor page. Default 2000 (matches the legacy CLI default). */
  batchSize?: number;
  /** Max parallel slug-keys embedded inside a single batch. Default 20. */
  concurrency?: number;
  /** Resume cursor from a prior run. Default: from start. */
  cursor?: StaleCursor;
  /** AbortSignal honored at three sites: batch claim, retry sleep, HTTP body. */
  signal?: AbortSignal;
  /**
   * Fired once per batch with the cursor after that batch finishes. Caller
   * uses this for crash-resumable progress (Minion `job.updateProgress`).
   */
  onProgress?: (state: {
    embedded: number;
    chunksProcessed: number;
    cursor: StaleCursor;
  }) => void;
  /**
   * Optional caller-supplied embed fn. Defaults to `embedBatchWithBackoff`.
   * Test seam: lets unit tests inject a deterministic fake without mocking
   * the gateway. Production callers leave it unset.
   */
  embedFn?: (texts: string[], opts: { abortSignal?: AbortSignal }) => Promise<Float32Array[]>;
  /**
   * v0.41.31: current embedding provenance signature (`<provider:model>:<dims>`).
   * When set, embeddings stamped under a DIFFERENT signature are invalidated
   * (NULLed) at the start so they flow through the NULL cursor and get
   * re-embedded; each page's signature is stamped after its chunks land.
   * Omit to keep the legacy `embedding IS NULL`-only behavior.
   */
  embeddingSignature?: string;
  /**
   * DB-contention pacer (paced-backfill). When enabled it (a) supplies the
   * worker count via the caller passing `concurrency = bundle.maxConcurrency`
   * — E-1: no separate permit on this single-pool path — and (b) the loop
   * `observe()`s its DB-op latency and `pace()`s between keys. Omit (or pass a
   * disabled bundle) for a no-op. The pacer is NEVER used to acquire permits
   * here; concurrency is the worker count.
   */
  pacer?: DbPacer;
}

export interface EmbedStaleResult {
  /** Chunks newly embedded in this call. */
  embedded: number;
  /** Total chunks pulled across all batches (including ones that errored). */
  chunksProcessed: number;
  /** Pages whose embeddings landed. */
  pagesProcessed: number;
  /** Last cursor reached. null iff zero stale chunks existed at start. */
  lastCursor: StaleCursor | null;
  /** True iff the loop exited because every stale chunk was processed. */
  done: boolean;
  /** True iff the loop exited because `signal.aborted` fired. */
  aborted: boolean;
}

/**
 * Embed every stale chunk (embedding IS NULL) for a source.
 *
 * Re-entrancy contract: if interrupted, the next call resumes from the next
 * stale row. Idempotent — `embedding IS NULL` predicate naturally excludes
 * already-embedded chunks even without cursor persistence. The cursor is a
 * progress optimization, not a correctness mechanism.
 *
 * Returns when:
 *   - every stale chunk has been embedded (`done: true`), OR
 *   - `signal.aborted` fired (`aborted: true`), OR
 *   - the per-batch `embedFn` threw with the signal aborted (treated as abort).
 *
 * Per-page embed failures (network blip, dim mismatch) do NOT throw — the
 * embedding stays NULL and the next call retries the chunk. This matches the
 * existing CLI's "log + skip" semantics so a single bad page doesn't poison
 * the run. Caller is responsible for surfacing partial-success via the
 * returned `embedded` vs `chunksProcessed` delta.
 */
export async function embedStaleForSource(
  engine: BrainEngine,
  sourceId: string,
  opts: EmbedStaleOpts = {},
): Promise<EmbedStaleResult> {
  const batchSize = opts.batchSize ?? 2000;
  const concurrency = opts.concurrency ?? 20;
  const signal = opts.signal;
  const embedFn = opts.embedFn ?? ((texts, fnOpts) =>
    embedBatchWithBackoff(texts, { abortSignal: fnOpts.abortSignal }));
  // Defaulted no-op when pacing is off, so the observe()/pace() call sites
  // below are unconditional and cost ~nothing on the unpaced path.
  const pacer = opts.pacer ?? createNoopPacer();

  let afterPageId = opts.cursor?.afterPageId ?? 0;
  let afterChunkIndex = opts.cursor?.afterChunkIndex ?? -1;

  const result: EmbedStaleResult = {
    embedded: 0,
    chunksProcessed: 0,
    pagesProcessed: 0,
    lastCursor: null,
    done: false,
    aborted: false,
  };
  const signature = opts.embeddingSignature;

  // v0.41.31: invalidate embeddings stamped under a prior model signature so
  // the NULL cursor below re-embeds them. GRANDFATHER: NULL signature
  // untouched. Best-effort — a failure here must not abort the backfill.
  if (signature) {
    try {
      await engine.invalidateStaleSignatureEmbeddings({ signature, sourceId });
    } catch {
      // Non-fatal: fall through to the NULL-only stale loop.
    }
  }

  for (;;) {
    if (signal?.aborted) {
      result.aborted = true;
      return result;
    }

    const batch = await observed(pacer, () =>
      engine.listStaleChunks({
        batchSize,
        afterPageId,
        afterChunkIndex,
        sourceId,
      }),
    );
    if (batch.length === 0) {
      result.done = true;
      return result;
    }

    result.chunksProcessed += batch.length;
    const last = batch[batch.length - 1];
    afterPageId = last.page_id;
    afterChunkIndex = last.chunk_index;
    result.lastCursor = { afterPageId, afterChunkIndex };

    // Group by composite key (source_id::slug). Within a source-scoped run
    // every row carries the same source_id, but the helper accepts batches
    // shaped by `listStaleChunks` which carry source_id per row for parity
    // with the cross-source CLI path.
    const byKey = new Map<string, typeof batch>();
    for (const row of batch) {
      const key = `${row.source_id}::${row.slug}`;
      const list = byKey.get(key);
      if (list) list.push(row);
      else byKey.set(key, [row]);
    }

    const keys = Array.from(byKey.keys());
    let nextIdx = 0;

    async function embedOneKey(key: string): Promise<void> {
      const stale = byKey.get(key)!;
      const keySourceId = stale[0]?.source_id ?? sourceId;
      const slug = stale[0].slug;
      try {
        const embeddings = await embedFn(
          stale.map((c) => c.chunk_text),
          { abortSignal: signal },
        );
        const existing = await observed(pacer, () =>
          engine.getChunks(slug, { sourceId: keySourceId }),
        );
        const staleIdxToEmbedding = new Map<number, Float32Array>();
        for (let j = 0; j < stale.length; j++) {
          staleIdxToEmbedding.set(stale[j].chunk_index, embeddings[j]);
        }
        const merged: ChunkInput[] = existing.map((c) => ({
          chunk_index: c.chunk_index,
          chunk_text: c.chunk_text,
          chunk_source: c.chunk_source,
          embedding: staleIdxToEmbedding.get(c.chunk_index) ?? undefined,
          token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
        }));
        await observed(pacer, () => engine.upsertChunks(slug, merged, { sourceId: keySourceId }));
        // v0.41.31: stamp provenance only when EVERY chunk was stale (fully
        // re-embedded this pass) — a partially-stale page keeps preserved
        // chunks of unknown provenance, so don't claim current. After the
        // invalidate pass above, signature-drifted pages ARE fully stale.
        if (signature && stale.length === existing.length) {
          await observed(pacer, () =>
            engine.setPageEmbeddingSignature(slug, { sourceId: keySourceId, signature }),
          );
        }
        result.embedded += stale.length;
        result.pagesProcessed += 1;
      } catch (e: unknown) {
        // Aborted mid-fetch is expected; treat as graceful exit.
        if (signal?.aborted) return;
        // Otherwise log and skip — the chunk stays NULL and next call retries.
        process.stderr.write(
          `\n  [embed-stale] error on ${keySourceId}/${slug}: ${
            e instanceof Error ? e.message : String(e)
          }\n`,
        );
      }
    }

    async function worker(): Promise<void> {
      while (nextIdx < keys.length && !signal?.aborted) {
        const idx = nextIdx++;
        await embedOneKey(keys[idx]);
        // Cooperative DB-contention pace between keys (no-op when unpaced).
        // pace() throws AbortError on cancel — treat as graceful worker exit;
        // the for(;;) loop sees signal.aborted and returns aborted next tick.
        try {
          await pacer.pace(signal);
        } catch (e) {
          if (e instanceof AbortError) return;
          throw e;
        }
      }
    }

    const numWorkers = Math.min(concurrency, keys.length);
    await Promise.all(Array.from({ length: numWorkers }, () => worker()));

    if (opts.onProgress) {
      opts.onProgress({
        embedded: result.embedded,
        chunksProcessed: result.chunksProcessed,
        cursor: { afterPageId, afterChunkIndex },
      });
    }

    // Short batch = end of stale set; advance and exit.
    if (batch.length < batchSize) {
      result.done = true;
      return result;
    }
  }
}
