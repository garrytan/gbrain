/**
 * Wave B fixture: turn a page into a segmented page with hand-placed manifest
 * and chunk rows (raw SQL, no segmenter or flip), so chunk-visibility,
 * vector-reuse and version tests can put rows in exactly the generation
 * states they probe: live, staged (body_generation above the page's) and
 * retired (rows of an occurrence whose manifest row is closed, not yet deleted:
 * a deferred retirement, whose page stays unsealed until they are). The page is sealed as an inline page first, then its body columns
 * are cleared the way a segmented row stores them (NULL bodies, body_bytes).
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveActiveEmbeddingColumnFromEngine } from '../../src/core/search/embedding-column.ts';
import { installFixtureChunks } from './page-projection.ts';
import { SEGMENTED_CHUNKER_VERSION } from '../../src/core/page-body/segment-chunks.ts';

export interface FixtureChunk {
  text: string;
  /** Insertion sequence (segmented chunk_index); defaults to the order rows are listed across occurrences. */
  chunkIndex?: number;
  /** First generation the row is part of; defaults to the occurrence's genFrom. */
  generation?: number;
  /** A unit vector seed: the row gets a vector with 1 at this dimension. */
  vector?: number;
}

export interface FixtureOccurrence {
  id: number;
  byteStart: number;
  genFrom: number;
  genTo?: number | null;
  /** Bytes the manifest row pins (defaults to the chunk texts' length). */
  byteLen?: number;
  chunks: FixtureChunk[];
}

export interface SegmentedFixture { pageId: number; chunkIds: Map<string, number> }

export const sha256 = (text: string) => createHash('sha256').update(text).digest();

/** A unit vector of the active column's dimensions with 1 at `seed`. */
export async function unitVector(engine: BrainEngine, seed: number): Promise<number[]> {
  const col = await resolveActiveEmbeddingColumnFromEngine(engine);
  return Array.from({ length: col.dimensions }, (_, i) => (i === seed ? 1 : 0));
}

export async function segmentPage(engine: BrainEngine, slug: string, opts: {
  generation: number;
  occurrences: FixtureOccurrence[];
  title?: string;
  bodyBytes?: number;
  sourceId?: string;
  /** Leave the text projection unsealed, as a flip that deferred its retirement does (default sealed). */
  unsealed?: boolean;
}): Promise<SegmentedFixture> {
  const sourceId = opts.sourceId ?? 'default';
  await engine.putPage(slug, { type: 'note', title: opts.title ?? slug, compiled_truth: 'Segmented fixture.', timeline: '', frontmatter: {} }, { sourceId });
  await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: 'Segmented fixture.', chunk_source: 'compiled_truth' }], { sourceId });
  const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2', [slug, sourceId]);
  const pageId = Number(page!.id);
  const live = opts.occurrences.filter(o => o.genFrom <= opts.generation && (o.genTo == null || o.genTo > opts.generation));
  const bodyBytes = opts.bodyBytes ?? live.reduce((n, o) => n + (o.byteLen ?? o.chunks.map(c => c.text).join('\n\n').length), 0);
  await engine.executeRaw('DELETE FROM content_chunks WHERE page_id = $1', [pageId]);
  await engine.executeRaw(`UPDATE pages SET body_storage = 'segmented', compiled_truth = NULL, timeline = NULL,
      body_bytes = $2, body_generation = $3, content_hash = $4 WHERE id = $1`,
  [pageId, bodyBytes, opts.generation, sha256(`${slug}@${opts.generation}`).toString('hex')]);
  const col = await resolveActiveEmbeddingColumnFromEngine(engine);
  const chunkIds = new Map<string, number>();
  let nextIndex = 0;
  for (const [seq, occ] of opts.occurrences.entries()) {
    const text = occ.chunks.map(c => c.text).join('\n\n');
    await engine.executeRaw(`INSERT INTO page_segment_texts (source_id, sha256, byte_len, line_count, body)
        VALUES ($1, $2, $3, 1, $4) ON CONFLICT DO NOTHING`, [sourceId, sha256(text), Buffer.byteLength(text), Buffer.from(text)]);
    await engine.executeRaw(`INSERT INTO page_body_manifest (page_id, occurrence_id, gen_from, gen_to, seq, region, source_id, sha256,
        byte_start, byte_len, line_start, line_count, cut_kind, entry_state, static_proj_bytes, static_proj_lines, hash_state)
        VALUES ($1, $2, $3, $4, $5, 'truth', $6, $7, $8, $9, 0, 1, 'heading', '{}'::jsonb, $10, 1, '\\x00'::bytea)`,
    [pageId, occ.id, occ.genFrom, occ.genTo ?? null, seq, sourceId, sha256(text), occ.byteStart, occ.byteLen ?? Buffer.byteLength(text), occ.byteLen ?? Buffer.byteLength(text)]);
    for (const [ordinal, chunk] of occ.chunks.entries()) {
      const chunkIndex = chunk.chunkIndex ?? nextIndex;
      nextIndex = Math.max(nextIndex, chunkIndex) + 1;
      const vector = chunk.vector === undefined ? null : `[${(await unitVector(engine, chunk.vector)).join(',')}]`;
      const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, token_count,
          occurrence_id, local_ordinal, body_generation, ${col.name}, model, embedded_at, embedded_text_hash)
          VALUES ($1, $2, $3, 'compiled_truth', $4, $5, $6, $7, $8::vector, $9, $10, $11) RETURNING id`,
      [pageId, chunkIndex, chunk.text, Math.ceil(chunk.text.length / 4), occ.id, ordinal, chunk.generation ?? occ.genFrom,
        vector, col.embeddingModel, vector ? new Date() : null,
        vector ? createHash('md5').update(chunk.text).digest('hex') : null]);
      chunkIds.set(chunk.text, Number(row!.id));
    }
  }
  // Clearing the body and replacing the rows unseals the projection; the fixture's rows are the projection, sealed at
  // the chunker version sealSegmentedPage stamps.
  if (!opts.unsealed) await engine.executeRaw('UPDATE pages SET text_projection_revision = knowledge_revision, chunker_version = $2 WHERE id = $1', [pageId, SEGMENTED_CHUNKER_VERSION]);
  return { pageId, chunkIds };
}
