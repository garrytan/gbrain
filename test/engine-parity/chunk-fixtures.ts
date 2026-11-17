/**
 * Shared seeding for the chunks / search / extraction parity files.
 *
 * `putPage` + `upsertChunks` leave a page's text projection UNSEALED, and
 * search (and `getChunks` by default) only serves sealed pages. The only way
 * to seal one is the product's `installPageProjection`, which writes through
 * `executeRaw` (no typed engine method seals a page). So `installChunks` is
 * the ONE place these parity files reach `executeRaw`, and only through the
 * shared test fixture helper, never in a case body. A Rust arm replaces this
 * function (its own seal path) and no case changes.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChunkInput, PageInput } from '../../src/core/types.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';

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

/** Replace a page's chunks with a sealed projection. */
export async function installChunks(engine: BrainEngine, slug: string, chunks: ChunkInput[], opts?: { sourceId?: string }): Promise<void> {
  await installFixtureChunks(engine, slug, chunks, opts);
}

/** A compiled_truth chunk input. */
export function chunk(chunk_index: number, chunk_text: string, extra: Partial<ChunkInput> = {}): ChunkInput {
  return { chunk_index, chunk_text, chunk_source: 'compiled_truth', ...extra };
}
