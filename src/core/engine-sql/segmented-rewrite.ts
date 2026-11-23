/**
 * The statements of a segmented page's write that ran through `engine.executeRaw` and are typed members now, so a Rust
 * brain answers each from its store (rust/docs/store/page_body.md): a live fence rewrite's page read and `deleted_at`
 * restore (page-body/segment-rewrite.ts), and the chunk probes and retirement of a projection and of a segmented write
 * (page-body/projection.ts, page-body/ingest.ts). PGLite and Postgres run the statements their callers ran.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { chunkGenerationFilter } from '../search/safe-chunks.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

export type { EngineRawRead };

/** The page a live fence rewrite reads (page-body/segment-rewrite.ts), deleted or not, with its tags in byte order. */
export interface SegmentedRewritePageRow {
  id: number; slug: string; source_id: string; title: string; type: string; page_kind: string; frontmatter: Record<string, unknown> | null;
  body_generation: number | string; body_bytes: number | string; body_flags: Record<string, unknown> | null; body_storage: string; deleted_at: string | null;
  contextual_retrieval_mode: string | null; corpus_generation: string | null; tags: string[];
}

/** Page `pageId` as a live fence rewrite reads it, deleted or not, or null. Tags sort bytewise (COLLATE "C") on every engine. */
export async function readSegmentedRewritePage(raw: EngineRawRead, pageId: number): Promise<SegmentedRewritePageRow | null> {
  const [row] = await raw<SegmentedRewritePageRow>(`SELECT p.id,p.slug,p.source_id,p.title,
      p.type,p.page_kind,p.frontmatter,p.body_generation,p.body_bytes,p.body_flags,p.body_storage,p.deleted_at,p.contextual_retrieval_mode,p.corpus_generation,
      COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id=p.id),'[]'::jsonb) AS tags FROM pages p WHERE p.id=$1`, [pageId]);
  return row ?? null;
}

/** Sets page `pageId`'s deleted_at back to `deletedAt` (a rewrite of a soft-deleted page leaves it deleted). */
export async function restorePageDeletedAt(raw: EngineRawRead, pageId: number, deletedAt: string): Promise<void> {
  await raw('UPDATE pages SET deleted_at=$2 WHERE id=$1', [pageId, deletedAt]);
}

// ─── the chunk probes and retirement of a segmented write ────────────────

/** The live segmented page at a source and slug a projection builds. */
export interface SegmentedProjectionPageRow {
  id: number; body_generation: number | string; body_bytes: number | string; knowledge_revision: string; text_projection_revision: string | null;
  title: string; frontmatter: Record<string, unknown> | null; body_flags: Record<string, unknown> | null; timeline_lead: string | null;
}

/** The live segmented page at `sourceId`/`slug` a projection builds; null when there is none. */
export async function readSegmentedProjectionPage(raw: EngineRawRead, sourceId: string, slug: string): Promise<SegmentedProjectionPageRow | null> {
  const [page] = await raw<SegmentedProjectionPageRow>(`SELECT id, body_generation, body_bytes, knowledge_revision::text AS knowledge_revision,
      text_projection_revision::text AS text_projection_revision, title, frontmatter, body_flags, timeline_lead
    FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL AND body_storage='segmented'`, [sourceId, slug]);
  return page ?? null;
}

/** The members of `occurrenceIds`, in their order, that have a chunk row of page `pageId` at or below `generation`. */
export async function listChunkedOccurrences(raw: EngineRawRead, pageId: number, occurrenceIds: readonly number[], generation: number): Promise<number[]> {
  return (await raw<{ occurrence_id: number }>(`SELECT o AS occurrence_id FROM unnest($2::bigint[]) AS o
    WHERE EXISTS (SELECT 1 FROM content_chunks c
      -- chunk-visibility-ok: write path; the generation predicate is explicit, at the generation the caller diffed against
      WHERE c.page_id=$1 AND c.occurrence_id=o AND c.body_generation<=$3::bigint)`,
  [pageId, [...occurrenceIds], generation])).map(row => Number(row.occurrence_id));
}

/**
 * Chunk rows of page $1 that generation $2 (live occurrences $3) does not hold: inline rows, rows of other occurrences,
 * and older duplicates of a live occurrence (any row of it below its newest generation at or below $2). Walks the page's
 * occurrences on content_chunks_occurrence_generation_idx (v256), one index probe per occurrence plus the stale rows it
 * returns, so the work is the page's occurrence count and the rows it retires, never its chunk count times anything.
 */
export const STALE_CHUNKS_SQL = `WITH RECURSIVE occ(o) AS (
    SELECT (SELECT c.occurrence_id FROM content_chunks c WHERE c.page_id=$1 AND c.occurrence_id IS NOT NULL ORDER BY c.occurrence_id LIMIT 1)
    UNION ALL
    SELECT (SELECT c.occurrence_id FROM content_chunks c WHERE c.page_id=$1 AND c.occurrence_id>occ.o ORDER BY c.occurrence_id LIMIT 1)
    FROM occ WHERE occ.o IS NOT NULL)
  SELECT s.id FROM occ CROSS JOIN LATERAL (SELECT CASE WHEN occ.o=ANY($3::bigint[])
      THEN (SELECT max(n.body_generation) FROM content_chunks n WHERE n.page_id=$1 AND n.occurrence_id=occ.o AND n.body_generation<=$2::bigint)
      ELSE $2::bigint+1 END AS bound) b
    CROSS JOIN LATERAL (SELECT c.id FROM content_chunks c WHERE c.page_id=$1 AND c.occurrence_id=occ.o AND c.body_generation<b.bound
      UNION ALL SELECT c.id FROM content_chunks c WHERE c.page_id=$1 AND c.occurrence_id=occ.o AND c.body_generation IS NULL) s
  WHERE occ.o IS NOT NULL
  UNION ALL
  SELECT c.id FROM content_chunks c -- chunk-visibility-ok: retirement selects the rows the live generation does not hold
  WHERE c.page_id=$1 AND c.occurrence_id IS NULL AND (c.body_generation IS NULL OR (cardinality($3::bigint[])=0 AND c.body_generation<=$2::bigint))`;

/** Whether page `pageId` stores a chunk row that generation `generation` (live occurrences `live`) does not hold. */
export async function hasStaleSegmentChunks(raw: EngineRawRead, pageId: number, generation: number, live: readonly number[]): Promise<boolean> {
  return (await raw(`${STALE_CHUNKS_SQL} LIMIT 1`, [pageId, generation, [...live]])).length > 0;
}

/**
 * STALE_CHUNKS_SQL bounded to $4 rows and deleted, written out whole: engine-sql splices no text holding a placeholder
 * (check-engine-sql-dynamic). It is `DELETE … ARRAY(${STALE_CHUNKS_SQL} LIMIT $4) …`.
 */
const RETIRE_STALE_CHUNKS_SQL = `DELETE FROM content_chunks c WHERE c.id=ANY(ARRAY(WITH RECURSIVE occ(o) AS (
    SELECT (SELECT c.occurrence_id FROM content_chunks c WHERE c.page_id=$1 AND c.occurrence_id IS NOT NULL ORDER BY c.occurrence_id LIMIT 1)
    UNION ALL
    SELECT (SELECT c.occurrence_id FROM content_chunks c WHERE c.page_id=$1 AND c.occurrence_id>occ.o ORDER BY c.occurrence_id LIMIT 1)
    FROM occ WHERE occ.o IS NOT NULL)
  SELECT s.id FROM occ CROSS JOIN LATERAL (SELECT CASE WHEN occ.o=ANY($3::bigint[])
      THEN (SELECT max(n.body_generation) FROM content_chunks n WHERE n.page_id=$1 AND n.occurrence_id=occ.o AND n.body_generation<=$2::bigint)
      ELSE $2::bigint+1 END AS bound) b
    CROSS JOIN LATERAL (SELECT c.id FROM content_chunks c WHERE c.page_id=$1 AND c.occurrence_id=occ.o AND c.body_generation<b.bound
      UNION ALL SELECT c.id FROM content_chunks c WHERE c.page_id=$1 AND c.occurrence_id=occ.o AND c.body_generation IS NULL) s
  WHERE occ.o IS NOT NULL
  UNION ALL
  SELECT c.id FROM content_chunks c -- chunk-visibility-ok: retirement selects the rows the live generation does not hold
  WHERE c.page_id=$1 AND c.occurrence_id IS NULL AND (c.body_generation IS NULL OR (cardinality($3::bigint[])=0 AND c.body_generation<=$2::bigint)) LIMIT $4)) RETURNING c.id`;

/** Deletes up to `maxRows` of the chunk rows `hasStaleSegmentChunks` finds; returns how many it deleted. */
export async function retireStaleSegmentChunks(raw: EngineRawRead, pageId: number, generation: number, live: readonly number[], maxRows: number): Promise<number> {
  return (await raw<{ id: number }>(RETIRE_STALE_CHUNKS_SQL, [pageId, generation, [...live], maxRows])).length;
}

/** The live page a segmented write diffs against, read by id (metadata only). */
export interface SegmentedLivePageRow {
  id: number; body_generation: number | string; body_storage: string; title: string; type: string; body_flags: Record<string, unknown> | null;
}

/** Page `pageId`'s storage class, generation, title, type and body flags, deleted or not; null when there is no such page. */
export async function readSegmentedLivePage(raw: EngineRawRead, pageId: number): Promise<SegmentedLivePageRow | null> {
  const [row] = await raw<SegmentedLivePageRow>('SELECT id, body_generation, body_storage, title, type, body_flags FROM pages WHERE id=$1', [pageId]);
  return row ?? null;
}

/** A stored vector of a retired occurrence's visible chunk, with what reuse checks it against. */
export interface RetiredChunkVectorRow {
  chunk_text: string; chunk_source: string; embedding: unknown; token_count: number | null; model: string | null;
  embedding_input_hash: string | null; contextual_retrieval_mode: string | null; slug: string; source_id: string; corpus_generation: string | null;
}

/**
 * The visible chunk rows of `occurrences` on page `pageId` that store a vector in `column` (an embedding column name),
 * in chunk_index order, with the page fields vector reuse checks.
 */
export async function readRetiredChunkVectors(raw: EngineRawRead, pageId: number, occurrences: readonly number[], column: string): Promise<RetiredChunkVectorRow[]> {
  const col = quoteIdentifier(column);
  const { text, params } = renderFragment(sqlFragment`SELECT c.chunk_text, c.chunk_source, c.${trustedSql(col)} AS embedding, c.token_count, c.model, c.embedding_input_hash, p.contextual_retrieval_mode,
            p.slug, p.source_id, p.corpus_generation
       FROM content_chunks c JOIN pages p ON p.id = c.page_id
      WHERE c.page_id = ${pageId} AND c.occurrence_id = ANY(${[...occurrences]}::bigint[]) AND c.${trustedSql(col)} IS NOT NULL AND ${trustedSql(chunkGenerationFilter('p', 'c'))}
      ORDER BY c.chunk_index`);
  return raw<RetiredChunkVectorRow>(text, params);
}
