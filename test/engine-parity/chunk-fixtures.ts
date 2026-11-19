/**
 * Shared seeding for the chunks / search / extraction parity files.
 *
 * `putPage` + `upsertChunks` leave a page's text projection UNSEALED, and
 * search (and `getChunks` by default) only serves sealed pages. `installChunks`
 * seals through the typed `BrainEngine.sealChunks`, so every arm (a Rust arm
 * too) seeds through its own engine method and no case reaches `executeRaw`.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChunkInput, PageInput } from '../../src/core/types.ts';

export interface SeedPage {
  slug: string;
  input: PageInput;
  chunks?: ChunkInput[];
}

/** Write a page and install its chunks as a sealed (searchable) projection. */
export async function seedPage(engine: BrainEngine, page: SeedPage, opts?: { sourceId?: string }): Promise<void> {
  await engine.putPage(page.slug, page.input, opts);
  if (page.chunks) await installChunks(engine, page.slug, page.chunks, opts);
}

/**
 * Replace a page's chunks with a sealed projection. The Rust store keeps no chunk vectors and refuses a chunk that carries
 * one, so on that arm only, this seeding helper drops the vectors it was given (a text search never reads them). Only
 * fixtures seeded here lose them: a case that writes chunks itself, and so tests that write, is never rewritten.
 */
export async function installChunks(engine: BrainEngine, slug: string, chunks: ChunkInput[], opts?: { sourceId?: string }): Promise<void> {
  await engine.sealChunks(slug, (engine.kind as string) === 'rust' ? chunks.map(withoutVectors) : chunks, opts);
}

function withoutVectors(input: ChunkInput): ChunkInput {
  const { embedding: _embedding, embedding_image: _image, ...text } = input;
  return text;
}

/** A compiled_truth chunk input. */
export function chunk(chunk_index: number, chunk_text: string, extra: Partial<ChunkInput> = {}): ChunkInput {
  return { chunk_index, chunk_text, chunk_source: 'compiled_truth', ...extra };
}
