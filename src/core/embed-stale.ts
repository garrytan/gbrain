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
import type { Chunk, ChunkInput } from './types.ts';
import { embedBatchWithBackoff, restampIfDemotedToTitleTier } from './embed-retry.ts';
import { wrapChunkTextsForStoredMode } from './embedding-context.ts';
import { healOversizedPageChunks, healedChunksToStaleRows } from './embed-oversize-heal.ts';
import { invalidateStaleSignatureEmbeddingsGuarded } from './embedding-invalidation.ts';
import {
  resolveActiveEmbeddingColumnFromEngine,
  quoteIdentifier,
} from './search/embedding-column.ts';
import { type DbPacer, createNoopPacer, observed } from './db-pacer.ts';
import { AbortError } from './abort-check.ts';

/**
 * W0 fix-wave (Tier-1 #3, CONFIRMED): the ONE carry-through field list for
 * re-embed upserts. upsertChunks writes these columns as EXCLUDED.<col>
 * (overwrite, not COALESCE), so any re-embed path that omits a field resets
 * it — omitting `modality` flipped every image chunk to modality='text',
 * silently zeroing the image search arm (filter `cc.modality = 'image'`).
 * Pre-fix this list existed twice: here (correct, with modality) and in
 * commands/embed.ts preserveCodeMetadata (missing modality — the bug). Both
 * consumers now share THIS list; embedding_image is deliberately NOT carried
 * (the upsert COALESCEs it, and getChunks returns the pgvector as a string
 * which upsertChunks would mis-serialize).
 */
export function carryChunkMetadata(
  loaded: Pick<Partial<Chunk>,
    'modality' | 'language' | 'symbol_name' | 'symbol_type' | 'start_line'
    | 'end_line' | 'parent_symbol_path' | 'doc_comment' | 'symbol_name_qualified'>,
  base: ChunkInput,
): ChunkInput {
  return {
    ...base,
    modality: loaded.modality ?? undefined,
    language: loaded.language ?? undefined,
    symbol_name: loaded.symbol_name ?? undefined,
    symbol_type: loaded.symbol_type ?? undefined,
    start_line: loaded.start_line ?? undefined,
    end_line: loaded.end_line ?? undefined,
    parent_symbol_path: loaded.parent_symbol_path ?? undefined,
    doc_comment: loaded.doc_comment ?? undefined,
    symbol_name_qualified: loaded.symbol_name_qualified ?? undefined,
  };
}

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
  /**
   * #4283: chunks whose embeddings THIS run set to NULL (signature drift +
   * content drift). Callers use `invalidated > 0 && embedded === 0` as the
   * mass-null-without-replacement failure signal.
   */
  invalidated: number;
  /**
   * #4283: set when signature-drifted chunks existed but the pre-invalidation
   * embedder probe failed, so nothing was NULLed. The run degrades to
   * NULL-embedding-only staleness instead of destroying working vectors.
   */
  invalidationSkipped?: 'embedder_probe_failed';
  /** Last cursor reached. null iff zero stale chunks existed at start. */
  lastCursor: StaleCursor | null;
  /** True iff the loop exited because every stale chunk was processed. */
  done: boolean;
  /** True iff the loop exited because `signal.aborted` fired. */
  aborted: boolean;
}

/** Probe input for `probeEmbedder`. Exported so tests can detect probe calls. */
export const EMBED_PROBE_TEXT = 'gbrain embedder preflight probe';

/**
 * #4283: live embedder health check, run BEFORE any signature-drift
 * invalidation NULLs working vectors. A misresolved worker config (e.g. a
 * temp GBRAIN_HOME resolving the compile-time default model with no API key)
 * yields a signature that mismatches 100% of the corpus AND an embedder that
 * cannot write a single vector — pre-probe, that combination stripped every
 * embedding and reported success. The probe embeds one short string; when
 * `signature` carries a parseable trailing `:<dims>`, the returned vector
 * must match it (a wrong-dims vector would fail every upsert AFTER the
 * NULLing). Any throw or malformed result → false.
 */
export async function probeEmbedder(
  embedFn: (texts: string[], opts: { abortSignal?: AbortSignal }) => Promise<Float32Array[]>,
  signature?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const vecs = await embedFn([EMBED_PROBE_TEXT], { abortSignal: signal });
    const vec = vecs?.[0];
    if (!vec || vec.length === 0) return false;
    const dims = signature ? Number(signature.split(':').pop()) : NaN;
    if (Number.isFinite(dims) && dims > 0 && vec.length !== dims) return false;
    return true;
  } catch {
    return false;
  }
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

/**
 * #4216 phase-end closure: embed the NULL-embedding chunks of an EXPLICIT
 * page list (pages a synthesis phase just wrote with deferEmbeds).
 * Deliberately NOT a source-wide sweep: no cursor walk over the backlog, no
 * global signature-invalidation pass (both belong to the budget-tracked
 * embed-backfill job) — the spend here is exactly the deferred cost of the
 * caller's own writes. Per-page mechanics mirror embedStaleForSource's
 * worker: stored-CR-mode wrapping, metadata carry, full-restale signature
 * stamp, title-tier restamp.
 */
export async function embedStalePages(
  engine: BrainEngine,
  slugs: string[],
  sourceId: string,
  opts: {
    signal?: AbortSignal;
    embedFn?: (texts: string[], o: { abortSignal?: AbortSignal }) => Promise<Float32Array[]>;
    embeddingSignature?: string;
  } = {},
): Promise<{ embedded: number; pagesProcessed: number; aborted: boolean }> {
  const embedFn = opts.embedFn ?? (async (texts: string[], fnOpts: { abortSignal?: AbortSignal }) =>
    embedBatchWithBackoff(texts, { abortSignal: fnOpts.abortSignal }));
  const result = { embedded: 0, pagesProcessed: 0, aborted: false };
  // S2: stale = NULL in the registry-ACTIVE column (the one upsertChunks
  // writes) — the literal legacy `embedding` stays NULL forever on a
  // registry-routed brain, which would re-embed every chunk on every phase
  // end. Resolved once per call; fallback keeps the per-page log+skip
  // contract (a broken registry surfaces at the upsert, loudly).
  const staleColId = quoteIdentifier(
    (await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name,
  );
  for (const slug of slugs) {
    if (opts.signal?.aborted) {
      result.aborted = true;
      return result;
    }
    try {
      // SUP-3874: split legacy oversized rows before embedding so a single
      // pre-cap chunk cannot permanently fail the page.
      await healOversizedPageChunks(engine, slug, { sourceId });
      const existing = await engine.getChunks(slug, { sourceId });
      const staleIdx = new Set(
        (await engine.executeRaw<{ chunk_index: number }>(
          `SELECT cc.chunk_index
             FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
            WHERE p.slug = $1 AND p.source_id = $2 AND cc.${staleColId} IS NULL
            ORDER BY cc.chunk_index`,
          [slug, sourceId],
        )).map(r => r.chunk_index),
      );
      if (staleIdx.size === 0) continue;
      const stale = existing.filter(c => staleIdx.has(c.chunk_index));
      const pageRow = await engine.getPage(slug, { sourceId });
      const embeddings = await embedFn(
        wrapChunkTextsForStoredMode(pageRow, stale),
        { abortSignal: opts.signal },
      );
      const staleIdxToEmbedding = new Map<number, Float32Array>();
      for (let j = 0; j < stale.length; j++) {
        staleIdxToEmbedding.set(stale[j].chunk_index, embeddings[j]);
      }
      const merged: ChunkInput[] = existing.map((c) => carryChunkMetadata(c, {
        chunk_index: c.chunk_index,
        chunk_text: c.chunk_text,
        chunk_source: c.chunk_source,
        embedding: staleIdxToEmbedding.get(c.chunk_index) ?? undefined,
        token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
      }));
      await engine.upsertChunks(slug, merged, { sourceId });
      if (opts.embeddingSignature && stale.length === existing.length) {
        await engine.setPageEmbeddingSignature(slug, { sourceId, signature: opts.embeddingSignature });
      }
      if (stale.length === existing.length) {
        await restampIfDemotedToTitleTier(engine, pageRow, slug, sourceId);
      }
      result.embedded += stale.length;
      result.pagesProcessed += 1;
    } catch (e) {
      if (opts.signal?.aborted) {
        result.aborted = true;
        return result;
      }
      process.stderr.write(`\n  [embed-stale] error on ${sourceId}/${slug}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return result;
}

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
    invalidated: 0,
    lastCursor: null,
    done: false,
    aborted: false,
  };
  const signature = opts.embeddingSignature;

  // v0.41.31: invalidate embeddings stamped under a prior model signature so
  // the NULL cursor below re-embeds them. GRANDFATHER: NULL signature
  // untouched. Best-effort — a failure here must not abort the backfill.
  //
  // #4283: NULLing is conditional on a WORKING embedder. The drift pre-count
  // (two cheap COUNTs; probe only fires when drift exists) keeps the probe's
  // one embed call off the no-drift common path; a failed probe skips the
  // invalidation entirely so a misresolved worker can't strip a corpus it
  // can never re-embed.
  if (signature) {
    try {
      const wide = await engine.countStaleChunks({ sourceId, signature });
      const nullOnly = await engine.countStaleChunks({ sourceId });
      if (wide - nullOnly > 0) {
        if (await probeEmbedder(embedFn, signature, signal)) {
          // #4306: guarded wrapper — never NULL embed_skip pages the stale
          // selectors below can't re-embed.
          result.invalidated += await invalidateStaleSignatureEmbeddingsGuarded(engine, { signature, sourceId });
        } else {
          result.invalidationSkipped = 'embedder_probe_failed';
          process.stderr.write(
            `\n  [embed-stale] ${wide - nullOnly} chunk(s) drifted from signature ${signature} but the embedder probe failed — ` +
            `SKIPPING invalidation (existing vectors preserved). Check embedding provider config/credentials.\n`,
          );
        }
      }
    } catch {
      // Non-fatal: fall through to the NULL-only stale loop.
    }
  }

  // #4246: invalidate chunks whose embedding was computed from a PREVIOUS
  // chunk_text revision (embedded_text_hash <> md5(chunk_text)) so content
  // edits flow through the NULL cursor. NOT probe-gated: the blast radius is
  // bounded by real content edits (config-independent, unlike signature
  // drift) and those vectors point at stale text either way. NULL hash
  // (pre-v133 rows) is grandfathered.
  try {
    result.invalidated += await engine.invalidateContentDriftEmbeddings({ sourceId });
  } catch {
    // Non-fatal: fall through to the NULL-only stale loop.
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
      let stale = byKey.get(key)!;
      const keySourceId = stale[0]?.source_id ?? sourceId;
      const slug = stale[0].slug;
      try {
        // SUP-3874: split legacy oversized chunk_text before embedding.
        const healed = await observed(pacer, () =>
          healOversizedPageChunks(engine, slug, { sourceId: keySourceId }),
        );
        if (healed.changed) {
          stale = healedChunksToStaleRows(healed.chunks, slug, keySourceId);
          if (stale.length === 0) {
            result.pagesProcessed += 1;
            return;
          }
        }

        // #3507: fetch the page row for its title + stored CR mode so the
        // re-embed reproduces the page's wrapping convention instead of
        // silently stripping contextual prefixes (mirrors
        // src/commands/embed.ts:embedAllStale).
        const pageRow = await observed(pacer, () =>
          engine.getPage(slug, { sourceId: keySourceId }),
        );
        const embeddings = await embedFn(
          wrapChunkTextsForStoredMode(pageRow, stale),
          { abortSignal: signal },
        );
        const existing = await observed(pacer, () =>
          engine.getChunks(slug, { sourceId: keySourceId }),
        );
        const staleIdxToEmbedding = new Map<number, Float32Array>();
        for (let j = 0; j < stale.length; j++) {
          staleIdxToEmbedding.set(stale[j].chunk_index, embeddings[j]);
        }
        const merged: ChunkInput[] = existing.map((c) => carryChunkMetadata(c, {
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
        // #3507: a FULLY re-embedded per_chunk_synopsis page landed at the
        // title tier — keep the stamped mode honest (mixed pages stay as-is).
        if (stale.length === existing.length) {
          await observed(pacer, () =>
            restampIfDemotedToTitleTier(engine, pageRow, slug, keySourceId),
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
