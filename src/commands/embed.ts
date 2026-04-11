import type { BrainEngine } from '../core/engine.ts';
import { embedBatch, getProvider } from '../core/embedding/index.ts';
import type { ChunkInput } from '../core/types.ts';
import { chunkText } from '../core/chunkers/recursive.ts';

export async function runEmbed(engine: BrainEngine, args: string[]) {
  const slug = args.find(a => !a.startsWith('--'));
  const all = args.includes('--all');
  const stale = args.includes('--stale');

  if (slug) {
    await embedPage(engine, slug);
  } else if (all || stale) {
    await embedAll(engine, stale);
  } else {
    console.error('Usage: gbrain embed [<slug>|--all|--stale]');
    process.exit(1);
  }
}

async function embedPage(engine: BrainEngine, slug: string) {
  const page = await engine.getPage(slug);
  if (!page) {
    console.error(`Page not found: ${slug}`);
    process.exit(1);
  }

  // Get existing chunks or create new ones
  let chunks = await engine.getChunks(slug);
  if (chunks.length === 0) {
    // Create chunks first
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
    if (inputs.length > 0) {
      await engine.upsertChunks(slug, inputs);
      chunks = await engine.getChunks(slug);
    }
  }

  // Embed chunks without embeddings
  const toEmbed = chunks.filter(c => !c.embedded_at);
  if (toEmbed.length === 0) {
    console.log(`${slug}: all ${chunks.length} chunks already embedded`);
    return;
  }

  const provider = getProvider();
  const embeddings = await embedBatch(toEmbed.map(c => c.chunk_text));
  const updated: ChunkInput[] = chunks.map((c, i) => {
    const needsEmbed = toEmbed.find(te => te.chunk_index === c.chunk_index);
    const embIdx = needsEmbed ? toEmbed.indexOf(needsEmbed) : -1;
    return {
      chunk_index: c.chunk_index,
      chunk_text: c.chunk_text,
      chunk_source: c.chunk_source,
      embedding: embIdx >= 0 ? embeddings[embIdx] : undefined,
      model: embIdx >= 0 ? `${provider.name}:${provider.model}` : c.model,
      token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
    };
  });

  await engine.upsertChunks(slug, updated);
  console.log(`${slug}: embedded ${toEmbed.length} chunks`);
}

async function embedAll(engine: BrainEngine, staleOnly: boolean) {
  const pages = await engine.listPages({ limit: 100000 });
  const provider = getProvider();
  let total = 0;
  let embedded = 0;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const chunks = await engine.getChunks(page.slug);
    const toEmbed = staleOnly
      ? chunks.filter(c => !c.embedded_at)
      : chunks;

    if (toEmbed.length === 0) continue;

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
        model: embeddingMap.has(c.chunk_index) ? `${provider.name}:${provider.model}` : c.model,
        token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
      }));
      await engine.upsertChunks(page.slug, updated);
      embedded += toEmbed.length;
    } catch (e: unknown) {
      console.error(`\n  Error embedding ${page.slug}: ${e instanceof Error ? e.message : e}`);
    }

    total += toEmbed.length;
    process.stdout.write(`\r  ${i + 1}/${pages.length} pages, ${embedded} chunks embedded`);
  }

  console.log(`\n\nEmbedded ${embedded} chunks across ${pages.length} pages`);
}
