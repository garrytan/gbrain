/**
 * The write path shared by import, put_page and the concurrent writers.
 *
 * It mirrors the per-page transaction in src/core/import-file.ts (importFromContent): inside one
 * `engine.transaction`, `putPage` -> `upsertChunks` (with embeddings and the chunker seal) ->
 * `sealPageTextProjection` (the text-projection seal that makes the chunks visible to reads and search).
 * Left out on purpose because they are not store work or need a provider: markdown parsing, chunking,
 * embedding calls, tag/alias/link projection, fence screening and version snapshots.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../../../src/core/engine.ts';
import type { ChunkInput, PageInput, PageType } from '../../../../src/core/types.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../../../../src/core/chunkers/recursive.ts';
import { sealPageTextProjection } from '../../../../src/core/page-state/projections.ts';
import { EMBEDDING_MODEL } from './store.ts';

export interface PageSpec {
  slug: string;
  sourceId: string;
  type: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  chunks: { text: string; vector: Float32Array }[];
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function toPageInput(spec: PageSpec): PageInput {
  return {
    type: spec.type as PageType,
    title: spec.title,
    compiled_truth: spec.body,
    timeline: '',
    frontmatter: spec.frontmatter,
    content_hash: sha256(spec.body),
  };
}

export function toChunkInputs(spec: PageSpec): ChunkInput[] {
  return spec.chunks.map((c, idx) => ({
    chunk_index: idx,
    chunk_text: c.text,
    chunk_source: 'compiled_truth' as const,
    embedding: c.vector,
    model: EMBEDDING_MODEL,
    token_count: Math.ceil(c.text.length / 4),
  }));
}

export interface WriteOpts {
  /** Replace an existing page without a revision precondition (put_page over corpus pages). */
  force?: boolean;
  expectedRevision?: string | null;
}

/** One durable page write: a single transaction, committed before this returns. */
export async function writePage(engine: BrainEngine, spec: PageSpec, opts: WriteOpts = {}): Promise<void> {
  const page = toPageInput(spec);
  const chunks = toChunkInputs(spec);
  await engine.transaction(async tx => {
    await tx.putPage(spec.slug, page, {
      sourceId: spec.sourceId,
      inline: true,
      ...(opts.force ? { force: true } : {}),
      ...(opts.expectedRevision !== undefined ? { expectedRevision: opts.expectedRevision } : {}),
    });
    await tx.upsertChunks(spec.slug, chunks, { sourceId: spec.sourceId, sealChunkerVersion: MARKDOWN_CHUNKER_VERSION });
    await sealPageTextProjection(tx, spec.slug, spec.sourceId);
  });
}
