/**
 * The statements a segmented replace of a page body runs through executeRaw (page-body/ingest.ts,
 * page-body/projection.ts, import-chunk-reuse.ts and trust/fence-append.ts), one function per BrainEngine member. PGLite
 * and Postgres run the same text the callers ran before; the Rust engine answers from its store
 * (rust/docs/store/page_body.md). Each runs on the engine it is given, so a call on a transaction engine reads and
 * writes inside that transaction.
 *
 * Owner: the segmented-write lane (rust-engine/fingerprint-v3, commits 86ac9f51ef, 0aceee20e0, 27c7e0d7ab), which holds
 * the whole file. This branch carries only the members the secret-spans segmented body write reaches, each copied
 * byte-identical (name, arguments, SQL text); the lane's other members of this file are not here.
 */
import type { BrainEngine } from '../engine.ts';
import type { JsonObject } from '../page-body/types.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';
import { chunkGenerationFilter } from '../search/safe-chunks.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The live segmented page a projection builds, by source and slug. */
export interface SegmentedProjectionPage {
  id: number; body_generation: number | string; body_bytes: number | string; knowledge_revision: string; text_projection_revision: string | null;
  title: string; frontmatter: JsonObject | null; body_flags: JsonObject | null; timeline_lead: string | null;
}

/** A stored vector of a retired occurrence's visible chunk, with what reuse checks it against. */
export interface RetiredChunkVectorRow {
  chunk_text: string; chunk_source: string; embedding: unknown; token_count: number | null; model: string | null;
  embedding_input_hash: string | null; contextual_retrieval_mode: string | null; slug: string; source_id: string; corpus_generation: string | null;
}

/** The members of `occurrenceIds`, in their order, that have a chunk row of page `pageId` at or below `generation`. */
export async function listChunkedOccurrences(tx: Raw, pageId: number, occurrenceIds: readonly number[], generation: number): Promise<number[]> {
  return (await tx.executeRaw<{ occurrence_id: number }>(`SELECT o AS occurrence_id FROM unnest($2::bigint[]) AS o
    WHERE EXISTS (SELECT 1 FROM content_chunks c
      -- chunk-visibility-ok: write path; the generation predicate is explicit, at the generation the caller diffed against
      WHERE c.page_id=$1 AND c.occurrence_id=o AND c.body_generation<=$3::bigint)`,
  [pageId, occurrenceIds, generation])).map(row => Number(row.occurrence_id));
}

/**
 * The visible chunk rows of `occurrences` on page `pageId` that store a vector in `column` (an embedding column name),
 * in chunk_index order, with the page fields vector reuse checks.
 */
export async function readRetiredChunkVectors(tx: Raw, pageId: number, occurrences: readonly number[], column: string): Promise<RetiredChunkVectorRow[]> {
  const col = quoteIdentifier(column);
  const { text, params } = renderFragment(sqlFragment`SELECT c.chunk_text, c.chunk_source, c.${trustedSql(col)} AS embedding, c.token_count, c.model, c.embedding_input_hash, p.contextual_retrieval_mode,
            p.slug, p.source_id, p.corpus_generation
       FROM content_chunks c JOIN pages p ON p.id = c.page_id
      WHERE c.page_id = ${pageId} AND c.occurrence_id = ANY(${[...occurrences]}::bigint[]) AND c.${trustedSql(col)} IS NOT NULL AND ${trustedSql(chunkGenerationFilter('p', 'c'))}
      ORDER BY c.chunk_index`);
  return tx.executeRaw<RetiredChunkVectorRow>(text, params);
}

/**
 * Chunk rows of page $1 that generation $2 (live occurrences $3) does not hold: inline rows, rows of other occurrences,
 * and older duplicates of a live occurrence (any row of it below its newest generation at or below $2). Walks the page's
 * occurrences on content_chunks_occurrence_generation_idx (v256), one index probe per occurrence plus the stale rows it
 * returns, so the work is the page's occurrence count and the rows it retires, never its chunk count times anything: the
 * earlier form tested each row for a newer duplicate with a per-row subquery, which scanned every newer row of the page.
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

/**
 * STALE_CHUNKS_SQL bounded to $4 rows and deleted, written out whole: engine-sql splices no text holding a placeholder
 * (check-engine-sql-dynamic). test/segmented-writes-sql.test.ts pins it to `DELETE … ARRAY(${STALE_CHUNKS_SQL} LIMIT $4) …`.
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

/** Whether page `pageId` stores a chunk row that generation `generation` (live occurrences `live`) does not hold. */
export async function hasStaleSegmentChunks(tx: Raw, pageId: number, generation: number, live: readonly number[]): Promise<boolean> {
  return (await tx.executeRaw(`${STALE_CHUNKS_SQL} LIMIT 1`, [pageId, generation, live])).length > 0;
}

/** Delete up to `maxRows` of the chunk rows `hasStaleSegmentChunks` finds; returns how many it deleted. */
export async function retireStaleSegmentChunks(tx: Raw, pageId: number, generation: number, live: readonly number[], maxRows: number): Promise<number> {
  return (await tx.executeRaw<{ id: number }>(RETIRE_STALE_CHUNKS_SQL, [pageId, generation, live, maxRows])).length;
}

/** The live segmented page at `sourceId`/`slug` a projection builds; null when there is none. */
export async function readSegmentedProjectionPage(tx: Raw, sourceId: string, slug: string): Promise<SegmentedProjectionPage | null> {
  const [page] = await tx.executeRaw<SegmentedProjectionPage>(`SELECT id, body_generation, body_bytes, knowledge_revision::text AS knowledge_revision,
      text_projection_revision::text AS text_projection_revision, title, frontmatter, body_flags, timeline_lead
    FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL AND body_storage='segmented'`, [sourceId, slug]);
  return page ?? null;
}
