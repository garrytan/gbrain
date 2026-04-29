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
  /**
   * Pages that have at least one chunk needing an embedding OR have no chunks
   * but do have indexable text. Always set; 0 when no work is pending or when
   * the call path doesn't compute a pending count (single-slug or explicit
   * --slugs paths).
   */
  pending_pages: number;
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
    pending_pages: 0,
    dryRun: !!opts.dryRun,
  };

  if (opts.slugs && opts.slugs.length > 0) {
    for (const s of opts.slugs) {
      try {
        await embedPage(engine, s, !!opts.dryRun, result);
      } catch (e: unknown) {
        console.error(`  Error embedding ${s}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return result;
  }
  if (opts.all || opts.stale) {
    await embedAll(engine, !!opts.stale, !!opts.dryRun, result, opts.onProgress);
    return result;
  }
  if (opts.slug) {
    await embedPage(engine, opts.slug, !!opts.dryRun, result);
    return result;
  }
  throw new Error('No embed target specified. Pass { slug }, { slugs }, { all }, or { stale }.');
}

export async function runEmbed(engine: BrainEngine, args: string[]): Promise<EmbedResult | undefined> {
  const slugsIdx = args.indexOf('--slugs');
  const all = args.includes('--all');
  const stale = args.includes('--stale');
  const dryRun = args.includes('--dry-run');

  let opts: EmbedOpts;
  if (slugsIdx >= 0) {
    opts = { slugs: args.slice(slugsIdx + 1).filter(a => !a.startsWith('--')), dryRun };
  } else if (all || stale) {
    opts = { all, stale, dryRun };
  } else {
    const slug = args.find(a => !a.startsWith('--'));
    if (!slug) {
      console.error('Usage: gbrain embed [<slug>|--all|--stale|--slugs s1 s2 ...] [--dry-run]');
      process.exit(1);
    }
    opts = { slug, dryRun };
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

/**
 * Build initial chunk inputs from a Page's compiled_truth + timeline text.
 * Pure function - no DB I/O, no embedding calls. Caller decides whether to
 * upsert or count for dry-run. Shared between embedPage (single-slug CLI path)
 * and embedOnePage (bulk worker-pool path) so zero-chunk pages get handled
 * identically in both.
 */
function buildInitialChunkInputs(page: { compiled_truth: string; timeline: string }): ChunkInput[] {
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
  return inputs;
}

async function embedPage(
  engine: BrainEngine,
  slug: string,
  dryRun: boolean,
  result: EmbedResult,
) {
  const page = await engine.getPage(slug);
  if (!page) {
    throw new Error(`Page not found: ${slug}`);
  }

  // Get existing chunks or create new ones.
  // In dryRun, we still chunk the text locally to count what WOULD be
  // embedded — but we never write chunks or call the embedding model.
  let chunks = await engine.getChunks(slug);
  if (chunks.length === 0) {
    const inputs = buildInitialChunkInputs(page);

    if (dryRun) {
      // Count what chunking WOULD produce, without writing.
      result.total_chunks += inputs.length;
      result.would_embed += inputs.length;
      result.pages_processed++;
      return;
    }

    if (inputs.length > 0) {
      await engine.upsertChunks(slug, inputs);
      chunks = await engine.getChunks(slug);
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

  await engine.upsertChunks(slug, updated);
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
) {
  // Stale-only fast path: SQL-side filter avoids the listPages + per-page
  // getChunks bomb that pulled every page row + every chunk's embedding
  // column (~76 MB on a 1.5K-page brain) only to client-side-filter for
  // chunks where embedding IS NULL. embedAllStale also handles zero-chunk
  // pages (created via direct putPage with no content_chunks rows yet)
  // via listSlugsPendingEmbedding so the autopilot common case stays
  // ~50 bytes wire AND new pages still get chunked + embedded.
  //
  // For --all (staleOnly=false) we keep the original behavior - the
  // user is explicitly asking to re-embed everything, including chunks
  // that already have embeddings.
  if (staleOnly) {
    return await embedAllStale(engine, dryRun, result, onProgress);
  }

  const pages = await engine.listPages({ limit: 100000 });
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
    const chunks = await engine.getChunks(page.slug);
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
      await engine.upsertChunks(page.slug, updated);
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
 * SQL-side stale path: replaces the listPages + per-page getChunks walk
 * with a count + slug-grouped SELECT for the common case (existing chunks
 * with NULL embeddings) AND a UNION-side enumeration of zero-chunk pages
 * for the bootstrap case (pages created via direct putPage that have no
 * content_chunks rows yet).
 *
 * Why a separate function: the staleOnly path doesn't need listPages and
 * groups by slug differently. Forking the function makes the read-bytes
 * path explicit and keeps the --all path verbatim from prior behavior.
 *
 * Staleness predicate: `embedding IS NULL`. We deliberately do NOT use
 * `embedded_at IS NULL` here - the bulk-import path can leave embedded_at
 * populated while embedding is NULL (see upsertChunks consistency notes),
 * and `embedding IS NULL` is the truth source for "this chunk needs an
 * embedding". The same predicate is used by listSlugsPendingEmbedding.
 *
 * Zero-chunk awareness: countStaleChunks/listStaleChunks only see
 * content_chunks rows. Pages with no chunk rows would be silently skipped
 * without listSlugsPendingEmbedding's UNION branch that surfaces them.
 * This matters for migrate-engine, enrichment-service, and output/writer
 * paths that putPage without chunking.
 */
async function embedAllStale(
  engine: BrainEngine,
  dryRun: boolean,
  result: EmbedResult,
  onProgress?: (done: number, total: number, embedded: number) => void,
) {
  // Two-signal pre-flight: stale chunks (existing rows with NULL embedding)
  // AND pending slugs (the UNION superset that also covers zero-chunk pages).
  // Run in parallel to keep the autopilot common case (both empty) cheap.
  const [staleCount, pendingSlugs] = await Promise.all([
    engine.countStaleChunks(),
    engine.listSlugsPendingEmbedding(),
  ]);

  // Surface pending_pages on the result so callers (cycle.ts runPhaseEmbed)
  // can report it without firing listSlugsPendingEmbedding a second time.
  result.pending_pages = pendingSlugs.length;

  if (staleCount === 0 && pendingSlugs.length === 0) {
    if (dryRun) {
      console.log('[dry-run] Would embed 0 chunks (nothing pending)');
    } else {
      console.log('Embedded 0 chunks (nothing pending)');
    }
    return;
  }

  // Pull stale chunks only when the count says they exist (no embedding column
  // shipped over the wire).
  const staleRows = staleCount > 0 ? await engine.listStaleChunks() : [];
  const bySlug = new Map<string, typeof staleRows>();
  for (const row of staleRows) {
    const list = bySlug.get(row.slug);
    if (list) list.push(row);
    else bySlug.set(row.slug, [row]);
  }

  // Master slug list = pendingSlugs ∪ bySlug.keys(). After the
  // listSlugsPendingEmbedding predicate fix (embedding IS NULL) the two
  // agree at the slug grain, but unioning is belt-and-suspenders for any
  // future divergence and a single bug-class barrier.
  const slugSet = new Set<string>();
  for (const slug of pendingSlugs) slugSet.add(slug);
  for (const slug of bySlug.keys()) slugSet.add(slug);
  const slugs = Array.from(slugSet);

  const totalStaleChunks = staleRows.length;
  result.total_chunks += totalStaleChunks;
  // skipped is "chunks we considered and skipped due to having an embedding".
  // We never considered the non-stale chunks here, so leave skipped at 0.
  // Callers reading EmbedResult who care about coverage should call
  // engine.getStats() / engine.getHealth() afterward.

  if (dryRun) {
    // Count what zero-chunk pages WOULD produce so the dry-run estimate is
    // honest about bootstrap work, not just the stale-rows subset.
    let zeroChunkWouldEmbed = 0;
    for (const slug of slugs) {
      if (bySlug.has(slug)) continue;
      try {
        const full = await engine.getPage(slug);
        if (!full) continue;
        zeroChunkWouldEmbed += buildInitialChunkInputs(full).length;
      } catch {
        // Best-effort in dry-run: skip pages we can't read instead of failing
        // the whole preview.
      }
    }
    result.total_chunks += zeroChunkWouldEmbed;
    result.would_embed += totalStaleChunks + zeroChunkWouldEmbed;
    result.pages_processed += slugs.length;
    if (onProgress) {
      // Emit a single tick to satisfy the contract (CLI progress reporters
      // expect at least one start/finish pair).
      onProgress(slugs.length, slugs.length, 0);
    }
    console.log(`[dry-run] Would embed ${totalStaleChunks + zeroChunkWouldEmbed} chunks across ${slugs.length} pages`);
    return;
  }

  const CONCURRENCY = parseInt(process.env.GBRAIN_EMBED_CONCURRENCY || '20', 10);
  let processed = 0;

  async function embedOneSlug(slug: string) {
    const stale = bySlug.get(slug);
    try {
      if (!stale) {
        // Zero-chunk path: page has no content_chunks rows yet (created via
        // direct putPage by migrate-engine, enrichment-service, output/writer).
        // Bootstrap chunks from compiled_truth + timeline, then embed them.
        const full = await engine.getPage(slug);
        if (!full) {
          // Page deleted between listing and processing; skip silently.
          processed++;
          result.pages_processed++;
          onProgress?.(processed, slugs.length, result.embedded);
          return;
        }
        const inputs = buildInitialChunkInputs(full);
        if (inputs.length === 0) {
          // listSlugsPendingEmbedding excludes empty pages, but defend in
          // depth in case of a race or a caller bypassing the primitive.
          processed++;
          result.pages_processed++;
          onProgress?.(processed, slugs.length, result.embedded);
          return;
        }
        await engine.upsertChunks(slug, inputs);
        const fresh = await engine.getChunks(slug);
        const embeddings = await embedBatch(fresh.map(c => c.chunk_text));
        const embeddingMap = new Map<number, Float32Array>();
        for (let j = 0; j < fresh.length; j++) {
          embeddingMap.set(fresh[j].chunk_index, embeddings[j]);
        }
        const updated: ChunkInput[] = fresh.map(c => ({
          chunk_index: c.chunk_index,
          chunk_text: c.chunk_text,
          chunk_source: c.chunk_source,
          embedding: embeddingMap.get(c.chunk_index),
          token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
        }));
        await engine.upsertChunks(slug, updated);
        result.total_chunks += fresh.length;
        result.embedded += fresh.length;
      } else {
        // Stale-rows path: upstream's merge-preserve.
        const embeddings = await embedBatch(stale.map(c => c.chunk_text));
        // CRITICAL: passing ONLY the stale indices to upsertChunks would
        // delete every non-stale chunk on the same page (the != ALL filter
        // wipes any chunk_index NOT in the input). Re-fetch + merge to
        // preserve existing embeddings.
        const existing = await engine.getChunks(slug);
        const staleIdxToEmbedding = new Map<number, Float32Array>();
        for (let j = 0; j < stale.length; j++) {
          staleIdxToEmbedding.set(stale[j].chunk_index, embeddings[j]);
        }
        const merged: ChunkInput[] = existing.map(c => ({
          chunk_index: c.chunk_index,
          chunk_text: c.chunk_text,
          chunk_source: c.chunk_source,
          // For stale chunks: pass the new embedding.
          // For non-stale chunks: undefined -> COALESCE preserves existing.
          embedding: staleIdxToEmbedding.get(c.chunk_index) ?? undefined,
          token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
        }));
        await engine.upsertChunks(slug, merged);
        result.embedded += stale.length;
      }
    } catch (e: unknown) {
      console.error(`\n  Error embedding ${slug}: ${e instanceof Error ? e.message : e}`);
    }
    processed++;
    result.pages_processed++;
    onProgress?.(processed, slugs.length, result.embedded);
  }

  let nextIdx = 0;
  async function worker() {
    while (nextIdx < slugs.length) {
      const idx = nextIdx++;
      await embedOneSlug(slugs[idx]);
    }
  }

  const numWorkers = Math.min(CONCURRENCY, slugs.length);
  await Promise.all(Array.from({ length: numWorkers }, () => worker()));

  console.log(`Embedded ${result.embedded} chunks across ${slugs.length} pages`);
}
