/**
 * Caller pins for the members of engine-sql/segmented-writes.ts a segmented replace of a page body reaches: each sends
 * Postgres and PGLite the exact statement and parameters its caller sent before the statement moved behind a typed
 * member (ingest.ts, import-chunk-reuse.ts and projection.ts at 1e1cfaabc2). The expected texts below are those
 * callers' own expressions, copied verbatim, so a drift in either direction fails here. Owner of the file: the
 * segmented-write lane (rust-engine/fingerprint-v3), whose test of the same name pins all of its members.
 */
import { describe, expect, test } from 'bun:test';
import * as sw from '../src/core/engine-sql/segmented-writes.ts';
import { quoteIdentifier } from '../src/core/search/embedding-column.ts';
import { chunkGenerationFilter } from '../src/core/search/safe-chunks.ts';

const OLD_STALE_CHUNKS_SQL = `WITH RECURSIVE occ(o) AS (
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

/** A recording executor: every statement and its parameters, answering `rows`. */
function recorder(rows: Record<string, unknown>[] = []) {
  const sent: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const tx = { executeRaw: async (sql: string, params?: unknown[]) => { sent.push({ sql, params }); return rows; } } as never;
  return { tx, sent };
}

async function sends(run: (tx: never) => Promise<unknown>, rows?: Record<string, unknown>[]) {
  const { tx, sent } = recorder(rows);
  await run(tx);
  return sent;
}

describe('engine-sql/segmented-writes sends each caller its old statement', () => {
  test('ingest.ts: the chunked-occurrence probe', async () => {
    expect(await sends(tx => sw.listChunkedOccurrences(tx, 7, [4, 5], 3))).toEqual([
      { sql: `SELECT o AS occurrence_id FROM unnest($2::bigint[]) AS o
    WHERE EXISTS (SELECT 1 FROM content_chunks c
      -- chunk-visibility-ok: write path; the generation predicate is explicit, at the generation the caller diffed against
      WHERE c.page_id=$1 AND c.occurrence_id=o AND c.body_generation<=$3::bigint)`, params: [7, [4, 5], 3] }]);
  });

  test('import-chunk-reuse.ts: the retired-vector read, column quoted', async () => {
    const col = quoteIdentifier('embedding');
    expect(await sends(tx => sw.readRetiredChunkVectors(tx, 7, [20], 'embedding'))).toEqual([{
      sql: `SELECT c.chunk_text, c.chunk_source, c.${col} AS embedding, c.token_count, c.model, c.embedding_input_hash, p.contextual_retrieval_mode,
            p.slug, p.source_id, p.corpus_generation
       FROM content_chunks c JOIN pages p ON p.id = c.page_id
      WHERE c.page_id = $1 AND c.occurrence_id = ANY($2::bigint[]) AND c.${col} IS NOT NULL AND ${chunkGenerationFilter('p', 'c')}
      ORDER BY c.chunk_index`, params: [7, [20]] }]);
  });

  test('projection.ts: the page read, the stale-row probe and the bounded retirement', async () => {
    expect(sw.STALE_CHUNKS_SQL).toBe(OLD_STALE_CHUNKS_SQL);
    expect(await sends(tx => sw.readSegmentedProjectionPage(tx, 'default', 'a'))).toEqual([{
      sql: `SELECT id, body_generation, body_bytes, knowledge_revision::text AS knowledge_revision,
      text_projection_revision::text AS text_projection_revision, title, frontmatter, body_flags, timeline_lead
    FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL AND body_storage='segmented'`, params: ['default', 'a'] }]);
    expect(await sends(tx => sw.hasStaleSegmentChunks(tx, 7, 3, [4]))).toEqual([{ sql: `${OLD_STALE_CHUNKS_SQL} LIMIT 1`, params: [7, 3, [4]] }]);
    expect(await sends(tx => sw.retireStaleSegmentChunks(tx, 7, 3, [4], 500))).toEqual([{
      sql: `DELETE FROM content_chunks c WHERE c.id=ANY(ARRAY(${OLD_STALE_CHUNKS_SQL} LIMIT $4)) RETURNING c.id`, params: [7, 3, [4], 500] }]);
  });
});
