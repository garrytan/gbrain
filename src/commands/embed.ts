import type { BrainEngine } from '../core/engine.ts';
import { embedBatch } from '../core/embedding.ts';
import type { Chunk, ChunkInput, Page } from '../core/types.ts';
import { chunkText } from '../core/chunkers/recursive.ts';

/**
 * Return the chunks for a page, creating them on first call.
 *
 * Chunks are the unit of embedding. Sync and extract never create them —
 * chunking happens lazily the first time we try to embed a page.
 * Without this helper, the `--stale`/`--all` paths would silently skip any
 * page that had never been individually embedded (getChunks returns [],
 * filter returns [], page is "skipped, nothing to do"). Autopilot would
 * then report `0 chunks embedded` forever even with unembedded content.
 */
async function ensureChunks(engine: BrainEngine, page: Page): Promise<Chunk[]> {
  const existing = await engine.getChunks(page.slug);
  if (existing.length > 0) return existing;

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
  if (inputs.length === 0) return existing; // page has no content to chunk

  await engine.upsertChunks(page.slug, inputs);
  return engine.getChunks(page.slug);
}

export interface EmbedOpts {
  /** Embed ALL pages (every chunk). */
  all?: boolean;
  /** Embed only stale chunks (missing embedding). */
  stale?: boolean;
  /** Embed specific pages by slug. */
  slugs?: string[];
  /** Embed a single page. */
  slug?: string;
}

/**
 * Library-level embed. Throws on validation errors; per-page embed failures
 * are logged to stderr but do not throw (matches the existing CLI semantics
 * for batch runs). Safe to call from Minions handlers — no process.exit.
 */
export async function runEmbedCore(engine: BrainEngine, opts: EmbedOpts): Promise<void> {
  if (opts.slugs && opts.slugs.length > 0) {
    for (const s of opts.slugs) {
      try { await embedPage(engine, s); } catch (e: unknown) {
        console.error(`  Error embedding ${s}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return;
  }
  if (opts.all || opts.stale) {
    await embedAll(engine, !!opts.stale);
    return;
  }
  if (opts.slug) {
    await embedPage(engine, opts.slug);
    return;
  }
  throw new Error('No embed target specified. Pass { slug }, { slugs }, { all }, or { stale }.');
}

export async function runEmbed(engine: BrainEngine, args: string[]) {
  const slugsIdx = args.indexOf('--slugs');
  const all = args.includes('--all');
  const stale = args.includes('--stale');

  let opts: EmbedOpts;
  if (slugsIdx >= 0) {
    opts = { slugs: args.slice(slugsIdx + 1).filter(a => !a.startsWith('--')) };
  } else if (all || stale) {
    opts = { all, stale };
  } else {
    const slug = args.find(a => !a.startsWith('--'));
    if (!slug) {
      console.error('Usage: gbrain embed [<slug>|--all|--stale|--slugs s1 s2 ...]');
      process.exit(1);
    }
    opts = { slug };
  }

  try {
    await runEmbedCore(engine, opts);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

async function embedPage(engine: BrainEngine, slug: string) {
  const page = await engine.getPage(slug);
  if (!page) {
    throw new Error(`Page not found: ${slug}`);
  }

  const chunks = await ensureChunks(engine, page);

  // Embed chunks without embeddings
  const toEmbed = chunks.filter(c => !c.embedded_at);
  if (toEmbed.length === 0) {
    console.log(`${slug}: all ${chunks.length} chunks already embedded`);
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
  console.log(`${slug}: embedded ${toEmbed.length} chunks`);
}

async function embedAll(engine: BrainEngine, staleOnly: boolean) {
  const pages = await engine.listPages({ limit: 100000 });
  let total = 0;
  let embedded = 0;
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
    const chunks = await ensureChunks(engine, page);
    const toEmbed = staleOnly
      ? chunks.filter(c => !c.embedded_at)
      : chunks;

    if (toEmbed.length === 0) {
      processed++;
      process.stdout.write(`\r  ${processed}/${pages.length} pages, ${embedded} chunks embedded`);
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
      embedded += toEmbed.length;
    } catch (e: unknown) {
      console.error(`\n  Error embedding ${page.slug}: ${e instanceof Error ? e.message : e}`);
    }

    total += toEmbed.length;
    processed++;
    process.stdout.write(`\r  ${processed}/${pages.length} pages, ${embedded} chunks embedded`);
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

  console.log(`\n\nEmbedded ${embedded} chunks across ${pages.length} pages`);
}
