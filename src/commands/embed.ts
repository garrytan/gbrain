import type { BrainEngine } from '../core/engine.ts';
import { embedBatch } from '../core/embedding.ts';
import type { ChunkInput } from '../core/types.ts';
import { chunkText } from '../core/chunkers/recursive.ts';
import { createProgress, type ProgressReporter } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

export interface EmbedOpts {
  /** Embed ALL pages (every chunk). */
  all?: boolean;
  /** Embed only stale chunks (missing embedding). */
  stale?: boolean;
  /** Embed specific pages by slug. */
  slugs?: string[];
  /** Embed a single page. */
  slug?: string;
  /**
   * v0.31.12: scope to a specific source. When set, only pages from this
   * source are embedded. When omitted, all sources are processed (but
   * source_id is still threaded correctly per-page via Page.source_id).
   */
  sourceId?: string;
  /**
   * Dry run: enumerate what WOULD be embedded (stale chunk counts)
   * without calling the embedding model or writing to the engine.
   * Safe to call with no API key. Used by runCycle's dryRun propagation.
   */
  dryRun?: boolean;
  /**
   * Optional progress callback. Called after each page. CLI wrappers
   * supply a reporter.tick()-backed implementation; Minion handlers
   * supply a job.updateProgress()-backed one so per-job progress lives
   * in the DB where `gbrain jobs get` can read it.
   */
  onProgress?: (done: number, total: number, embedded: number) => void;
}

/**
 * Structured result from a library-level embed run.
 *
 * In dryRun mode, `embedded = 0` and `would_embed` holds the count of
 * stale chunks that WOULD have been sent to the embedding model. In
 * non-dryRun mode, `embedded` holds the real count and `would_embed = 0`.
 * `skipped` counts chunks that already had embeddings (nothing to do).
 */
export interface EmbedResult {
  /** Chunks newly embedded in this run (0 in dryRun). */
  embedded: number;
  /** Chunks with pre-existing embeddings, skipped. */
  skipped: number;
  /** Chunks that would be embedded if not for dryRun (0 in non-dryRun). */
  would_embed: number;
  /** Total chunks considered across all processed pages. */
  total_chunks: number;
  /** Number of pages processed (whether or not they had stale chunks). */
  pages_processed: number;
  /** True if this run was a dry-run. */
  dryRun: boolean;
}

/**
 * Library-level embed. Throws on validation errors; per-page embed failures
 * are logged to stderr but do not throw (matches the existing CLI semantics
 * for batch runs). Safe to call from Minions handlers — no process.exit.
 *
 * Returns EmbedResult with accurate counts so callers (runCycle, sync
 * auto-embed step) can report embeddings in their own structured output.
 */
export async function runEmbedCore(engine: BrainEngine, opts: EmbedOpts): Promise<EmbedResult> {
  const result: EmbedResult = {
    embedded: 0,
    skipped: 0,
    would_embed: 0,
    total_chunks: 0,
    pages_processed: 0,
    dryRun: !!opts.dryRun,
  };

  if (opts.slugs && opts.slugs.length > 0) {
    for (const s of opts.slugs) {
      try {
        await embedPage(engine, s, !!opts.dryRun, result, opts.sourceId);
      } catch (e: unknown) {
        console.error(`  Error embedding ${s}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return result;
  }
  if (opts.all || opts.stale) {
    await embedAll(engine, !!opts.stale, !!opts.dryRun, result, opts.onProgress, opts.sourceId);
    return result;
  }
  if (opts.slug) {
    await embedPage(engine, opts.slug, !!opts.dryRun, result, opts.sourceId);
    return result;
  }
  throw new Error('No embed target specified. Pass { slug }, { slugs }, { all }, or { stale }.');
}

export async function runEmbed(engine: BrainEngine, args: string[]): Promise<EmbedResult | undefined> {
  const slugsIdx = args.indexOf('--slugs');
  const all = args.includes('--all');
  const stale = args.includes('--stale');
  const dryRun = args.includes('--dry-run');
  // v0.31.12: --source <id> scopes to a single source.
  const sourceIdx = args.indexOf('--source');
  const sourceId = sourceIdx >= 0 ? args[sourceIdx + 1] : undefined;

  let opts: EmbedOpts;
  if (slugsIdx >= 0) {
    opts = { slugs: args.slice(slugsIdx + 1).filter(a => !a.startsWith('--')), dryRun, sourceId };
  } else if (all || stale) {
    opts = { all, stale, dryRun, sourceId };
  } else {
    const slug = args.find(a => !a.startsWith('--'));
    if (!slug) {
      console.error('Usage: gbrain embed [<slug>|--all|--stale|--slugs s1 s2 ...] [--dry-run]');
      process.exit(1);
    }
    opts = { slug, dryRun, sourceId };
  }

  // CLI path: wire a reporter so --progress-json / --quiet / TTY rendering
  // all work. Minion handlers call runEmbedCore directly with their own
  // onProgress (see jobs.ts).
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  let progressStarted = false;
  opts.onProgress = (done, total, _embedded) => {
    if (!progressStarted) {
      progress.start('embed.pages', total);
      progressStarted = true;
    }
    progress.tick(1);
  };

  try {
    const result = await runEmbedCore(engine, opts);
    if (progressStarted) progress.finish();
    return result;
  } catch (e) {
    if (progressStarted) progress.finish();
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

async function embedPage(
  engine: BrainEngine,
  slug: string,
  dryRun: boolean,
  result: EmbedResult,
  sourceId?: string,
) {
  const opts = sourceId ? { sourceId } : undefined;
  const page = await engine.getPage(slug, opts);
  if (!page) {
    throw new Error(`Page not found: ${slug}`);
  }

  // Get existing chunks or create new ones.
  // In dryRun, we still chunk the text locally to count what WOULD be
  // embedded — but we never write chunks or call the embedding model.
  let chunks = await engine.getChunks(slug, opts);
  if (chunks.length === 0) {
    const inputs: ChunkInput[] = [];
    if (page.compiled_truth.trim()) {
      for (const c of chunkText(page.compiled_truth)) {
        inputs.push({ chunk_index: inputs.length, chunk_text: c.text, chunk_source: 'compiled_truth' });
      }
    }
    if (page.timeline.trim()) {
      for (const c of chunkText(page.timeline)) {
        inputs.push({ chunk_index: inputs.length, chunk_text: c.text, chunk_source: 'timeline' });
      }
    }

    if (dryRun) {
      // Count what chunking WOULD produce, without writing.
      result.total_chunks += inputs.length;
      result.would_embed += inputs.length;
      result.pages_processed++;
      return;
    }

    if (inputs.length > 0) {
      await engine.upsertChunks(slug, inputs, opts);
      chunks = await engine.getChunks(slug, opts);
    }
  }

  // Embed chunks without embeddings
  const toEmbed = chunks.filter(c => !c.embedded_at);
  result.total_chunks += chunks.length;
  result.skipped += chunks.length - toEmbed.length;

  if (toEmbed.length === 0) {
    console.log(`${slug}: all ${chunks.length} chunks already embedded`);
    result.pages_processed++;
    return;
  }

  if (dryRun) {
    result.would_embed += toEmbed.length;
    result.pages_processed++;
    return;
  }

  const embeddings = await embedBatch(toEmbed.map(c => c.chunk_text));
  const embeddingMap = new Map<number, Float32Array>();
  for (let j = 0; j < toEmbed.length; j++) {
    embeddingMap.set(toEmbed[j].chunk_index, embeddings[j]);
  }
  const updated: ChunkInput[] = chunks.map(c => ({
    chunk_index: c.chunk_index,
    chunk_text: c.chunk_text,
    chunk_source: c.chunk_source,
    embedding: embeddingMap.get(c.chunk_index),
    token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
  }));

  await engine.upsertChunks(slug, updated, opts);
  result.embedded += toEmbed.length;
  result.pages_processed++;
  console.log(`${slug}: embedded ${toEmbed.length} chunks`);
}

async function embedAll(
  engine: BrainEngine,
  staleOnly: boolean,
  dryRun: boolean,
  result: EmbedResult,
  onProgress?: (done: number, total: number, embedded: number) => void,
  sourceId?: string,
) {
  // ─────────────────────────────────────────────────────────────
  // Stale-only fast path: avoid the listPages + per-page getChunks
  // bomb that pulled every page row + every chunk's embedding column
  // (~76 MB on a 1.5K-page brain) only to client-side-filter for
  // chunks where embedding IS NULL. The new path issues one SQL
  // pre-check + at most one slug-grouped SELECT excluding the
  // (always-null on stale rows) embedding column. On a 100%-embedded
  // brain (the autopilot common case) we exit after ~50 bytes wire.
  //
  // For --all (staleOnly=false) we keep the original behavior — the
  // user is explicitly asking to re-embed everything, including
  // chunks that already have embeddings.
  // ─────────────────────────────────────────────────────────────
  if (staleOnly) {
    return await embedAllStale(engine, dryRun, result, onProgress);
  }

  // v0.31.12: when sourceId is set, scope listPages to that source.
  const pages = await engine.listPages({ limit: 100000, ...(sourceId && { sourceId }) });
  let processed = 0;

  // Concurrency limit for parallel page embedding.
  // Each worker pulls pages from a shared queue and makes independent
  // embedBatch calls to OpenAI + upsertChunks to the engine.
  //
  // Default 20: keeps us well under OpenAI's embedding RPM limit
  // (3000+/min for tier 1 = 50+/sec, 20 parallel is safely below) and
  // avoids overwhelming postgres connection pools. Users can tune via
  // GBRAIN_EMBED_CONCURRENCY env var based on their tier/infra.
  const CONCURRENCY = parseInt(process.env.GBRAIN_EMBED_CONCURRENCY || '20', 10);

  async function embedOnePage(page: typeof pages[number]) {
    // v0.31.12: thread source_id from the page row so getChunks/upsertChunks
    // target the correct (source_id, slug) row, not the 'default' source.
    const pageSourceId = page.source_id;
    const pageOpts = pageSourceId ? { sourceId: pageSourceId } : undefined;
    const chunks = await engine.getChunks(page.slug, pageOpts);
    const toEmbed = chunks; // staleOnly path handled above via embedAllStale

    result.total_chunks += chunks.length;
    result.skipped += chunks.length - toEmbed.length;

    if (toEmbed.length === 0) {
      processed++;
      result.pages_processed++;
      onProgress?.(processed, pages.length, result.embedded);
      return;
    }

    if (dryRun) {
      result.would_embed += toEmbed.length;
      processed++;
      result.pages_processed++;
      onProgress?.(processed, pages.length, result.embedded);
      return;
    }

    try {
      const embeddings = await embedBatch(toEmbed.map(c => c.chunk_text));
      // Build a map of new embeddings by chunk_index
      const embeddingMap = new Map<number, Float32Array>();
      for (let j = 0; j < toEmbed.length; j++) {
        embeddingMap.set(toEmbed[j].chunk_index, embeddings[j]);
      }
      // Preserve ALL chunks, only update embeddings for stale ones
      const updated: ChunkInput[] = chunks.map(c => ({
        chunk_index: c.chunk_index,
        chunk_text: c.chunk_text,
        chunk_source: c.chunk_source,
        embedding: embeddingMap.get(c.chunk_index) ?? undefined,
        token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
      }));
      await engine.upsertChunks(page.slug, updated, pageOpts);
      result.embedded += toEmbed.length;
    } catch (e: unknown) {
      console.error(`\n  Error embedding ${page.slug}: ${e instanceof Error ? e.message : e}`);
    }

    processed++;
    result.pages_processed++;
    onProgress?.(processed, pages.length, result.embedded);
  }

  // Sliding worker pool: N workers share a queue and each pulls the
  // next page as soon as it finishes its current one. This handles
  // uneven per-page workloads (some pages have 1 chunk, others have 50)
  // much better than a fixed-window Promise.all, since fast workers
  // don't wait for slow workers to finish an entire window.
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < pages.length) {
      const idx = nextIdx++;
      await embedOnePage(pages[idx]);
    }
  }

  const numWorkers = Math.min(CONCURRENCY, pages.length);
  await Promise.all(Array.from({ length: numWorkers }, () => worker()));

  // Stdout summary preserved for scripts/tests that grep for counts.
  if (dryRun) {
    console.log(`[dry-run] Would embed ${result.would_embed} chunks across ${pages.length} pages`);
  } else {
    console.log(`Embedded ${result.embedded} chunks across ${pages.length} pages`);
  }
}

/**
 * SQL-side stale path: replaces the listPages + per-page getChunks
 * walk with a count + slug-grouped SELECT. Preserves the existing
 * functional contract (every chunk where embedding IS NULL gets
 * embedded; nothing else is touched) without paying egress on
 * already-embedded chunks.
 *
 * Why a separate function: the staleOnly path doesn't need
 * listPages at all and groups by slug differently. Forking the
 * function makes the read-bytes path explicit and keeps the --all
 * path verbatim from prior behavior.
 *
 * Staleness predicate: `embedding IS NULL`. We deliberately do NOT
 * use `embedded_at IS NULL` here — the bulk-import path can leave
 * embedded_at populated while embedding is NULL (see upsertChunks
 * consistency notes), and `embedding IS NULL` is the truth source
 * for "this chunk needs an embedding".
 */
async function embedAllStale(
  engine: BrainEngine,
  dryRun: boolean,
  result: EmbedResult,
  onProgress?: (done: number, total: number, embedded: number) => void,
) {
  // Pre-flight: 0 stale chunks → nothing to do, no further DB reads.
  const staleCount = await engine.countStaleChunks();
  if (staleCount === 0) {
    if (dryRun) {
      console.log('[dry-run] Would embed 0 chunks (0 stale found)');
    } else {
      console.log('Embedded 0 chunks (0 stale found)');
    }
    return;
  }

  if (dryRun) {
    result.would_embed += staleCount;
    result.total_chunks += staleCount;
    if (onProgress) onProgress(1, 1, 0);
    console.log(`[dry-run] Would embed ${staleCount} stale chunks`);
    return;
  }

  // v0.33.3: cursor-paginated stale loading. Instead of pulling all 48K+
  // rows in one query (which times out on Supabase's 2-min pooler timeout),
  // we page through 2000 rows at a time via keyset pagination on
  // (page_id, chunk_index). Each query finishes in <1s.
  const PAGE_SIZE = 2000;
  const CONCURRENCY = parseInt(process.env.GBRAIN_EMBED_CONCURRENCY || '20', 10);
  let totalProcessedPages = 0;
  let afterPageId = 0;
  let afterChunkIndex = -1;
  let totalChunksLoaded = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await engine.listStaleChunks({
      batchSize: PAGE_SIZE,
      afterPageId,
      afterChunkIndex,
    });
    if (batch.length === 0) break;
    totalChunksLoaded += batch.length;

    // Advance cursor to last row in this batch.
    const last = batch[batch.length - 1];
    afterPageId = last.page_id;
    afterChunkIndex = last.chunk_index;

    // Group by composite key (source_id::slug).
    const byKey = new Map<string, typeof batch>();
    for (const row of batch) {
      const key = `${row.source_id}::${row.slug}`;
      const list = byKey.get(key);
      if (list) list.push(row);
      else byKey.set(key, [row]);
    }

    const keys = Array.from(byKey.keys());
    result.total_chunks += batch.length;

    let nextIdx = 0;
    async function embedOneKey(key: string) {
      const stale = byKey.get(key)!;
      const sourceId = stale[0]?.source_id ?? 'default';
      const slug = stale[0].slug;
      try {
        const embeddings = await embedBatchWithBackoff(stale.map(c => c.chunk_text));
        // Re-fetch existing chunks and merge to avoid deleting non-stale chunks.
        const existing = await engine.getChunks(slug, { sourceId });
        const staleIdxToEmbedding = new Map<number, Float32Array>();
        for (let j = 0; j < stale.length; j++) {
          staleIdxToEmbedding.set(stale[j].chunk_index, embeddings[j]);
        }
        const merged: ChunkInput[] = existing.map(c => ({
          chunk_index: c.chunk_index,
          chunk_text: c.chunk_text,
          chunk_source: c.chunk_source,
          embedding: staleIdxToEmbedding.get(c.chunk_index) ?? undefined,
          token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
        }));
        await engine.upsertChunks(slug, merged, { sourceId });
        result.embedded += stale.length;
      } catch (e: unknown) {
        console.error(`\n  Error embedding ${slug}: ${e instanceof Error ? e.message : e}`);
      }
      totalProcessedPages++;
      result.pages_processed++;
      // Use staleCount as the estimated total for progress (not exact after
      // pagination starts, but directionally correct).
      onProgress?.(totalProcessedPages, Math.ceil(staleCount / PAGE_SIZE) * keys.length, result.embedded);
    }

    async function worker() {
      while (nextIdx < keys.length) {
        const idx = nextIdx++;
        await embedOneKey(keys[idx]);
      }
    }

    const numWorkers = Math.min(CONCURRENCY, keys.length);
    await Promise.all(Array.from({ length: numWorkers }, () => worker()));

    // If we got fewer rows than PAGE_SIZE, we've reached the end.
    if (batch.length < PAGE_SIZE) break;
  }

  console.log(`Embedded ${result.embedded} chunks across ${totalProcessedPages} pages`);
}

/**
 * v0.33.3: rate-limit-aware embedBatch wrapper.
 *
 * The OpenAI SDK has built-in retry with exponential backoff, but its
 * backoff window (max ~4s) is too short for TPM (tokens-per-minute)
 * rate limits on large pages (~90K tokens).  This wrapper catches
 * 429-shaped errors, parses the retry delay from the error message
 * (e.g. "Please try again in 248ms"), and sleeps before retrying.
 *
 * Up to MAX_RATE_LIMIT_RETRIES attempts with the parsed delay
 * (or a 60s fallback when the message can't be parsed).
 */
const MAX_RATE_LIMIT_RETRIES = 5;

async function embedBatchWithBackoff(texts: string[]): Promise<Float32Array[]> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    try {
      return await embedBatch(texts);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isRateLimit = msg.includes('Rate limit') || msg.includes('429') || msg.includes('rate_limit');
      if (!isRateLimit || attempt === MAX_RATE_LIMIT_RETRIES) throw e;

      // Parse "Please try again in 248ms" or "try again in 1.5s".
      let delayMs = 60_000; // conservative fallback
      const msMatch = msg.match(/try again in (\d+)ms/i);
      const secMatch = msg.match(/try again in ([\d.]+)s/i);
      if (msMatch) delayMs = parseInt(msMatch[1], 10) + 500; // pad 500ms
      else if (secMatch) delayMs = Math.ceil(parseFloat(secMatch[1]) * 1000) + 500;

      console.error(`  [rate-limit] attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}, waiting ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  // Unreachable, but TypeScript needs it.
  return embedBatch(texts);
}
