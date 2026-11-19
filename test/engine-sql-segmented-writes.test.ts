/**
 * Caller pins for engine-sql/segmented-writes.ts: each member sends Postgres and PGLite the exact statement and
 * parameters its caller sent before the statement moved behind a typed member (segmented-apply.ts, searchable.ts,
 * ingest.ts, import-chunk-reuse.ts, projection.ts, rechunk.ts, fence-append.ts at 1e1cfaabc2; segment-rewrite.ts and
 * segment-derive.ts at 8a7ded1c6d). The expected texts
 * below are those callers' own expressions, copied verbatim, so a drift in either direction fails here.
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

const OLD_RECHUNK_PAGE_SQL = `SELECT id, slug, source_id, title, type, page_kind, frontmatter, body_generation, body_flags, chunker_version,
    contextual_retrieval_mode, corpus_generation, knowledge_revision::text AS knowledge_revision,
    (text_projection_revision = knowledge_revision) IS TRUE AS sealed, (extract(epoch FROM updated_at) * 1000000)::bigint::text AS updated_us, deleted_at, content_hash, body_bytes, truth_bytes,
    body_lines, segment_count, segmenter_version, truth_lead, timeline_lead
  FROM pages WHERE id=$1 AND body_storage='segmented'`;

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
  test('segmented-apply.ts: the staging lock, the unstaged-chunk delete and the live page read', async () => {
    expect(await sends(tx => sw.lockBodyStagingState(tx, 'u-1'))).toEqual([
      { sql: 'SELECT state FROM page_body_stagings WHERE id=$1::uuid FOR UPDATE', params: ['u-1'] }]);
    expect(await sends(tx => sw.deleteUnstagedSegmentChunks(tx, 7, 3, [0, 2]))).toEqual([
      { sql: 'DELETE FROM content_chunks WHERE page_id=$1 AND body_generation=$2 AND NOT (chunk_index = ANY($3::int[]))', params: [7, 3, [0, 2]] }]);
    expect(await sends(tx => sw.readSegmentedLivePage(tx, 7))).toEqual([
      { sql: 'SELECT id, body_generation, body_storage, title, type, body_flags FROM pages WHERE id=$1', params: [7] }]);
  });

  test('searchable.ts and ingest.ts: the seal probe and the chunked-occurrence probe', async () => {
    expect(await sends(tx => sw.readSegmentedSealed(tx, 'default', 'a'))).toEqual([
      { sql: `SELECT text_projection_revision=knowledge_revision AS sealed FROM pages
    WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`, params: ['default', 'a'] }]);
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

  test('rechunk.ts: candidates in every scope, the page read, the occurrence chunks and the materializing revision', async () => {
    const candidates = (where: string) => `SELECT id FROM pages WHERE body_storage='segmented' AND deleted_at IS NULL
    AND chunker_version < $1 AND (text_projection_revision = knowledge_revision) IS TRUE${where} ORDER BY source_id, slug`;
    expect(await sends(tx => sw.listSegmentedRechunkCandidates(tx, 2))).toEqual([{ sql: candidates(''), params: [2] }]);
    expect(await sends(tx => sw.listSegmentedRechunkCandidates(tx, 2, { sourceId: 's' }))).toEqual([{ sql: candidates(' AND source_id=$2'), params: [2, 's'] }]);
    expect(await sends(tx => sw.listSegmentedRechunkCandidates(tx, 2, { slug: 'a' }))).toEqual([{ sql: candidates(' AND slug=$2'), params: [2, 'a'] }]);
    expect(await sends(tx => sw.listSegmentedRechunkCandidates(tx, 2, { sourceId: 's', slug: 'a' })))
      .toEqual([{ sql: candidates(' AND source_id=$2 AND slug=$3'), params: [2, 's', 'a'] }]);
    expect(await sends(tx => sw.readSegmentedRechunkPage(tx, 7))).toEqual([{ sql: OLD_RECHUNK_PAGE_SQL, params: [7] }]);
    expect(await sends(tx => sw.listOccurrenceChunks(tx, 7, [4, 5]))).toEqual([{
      sql: `SELECT c.occurrence_id, c.chunk_source, c.chunk_text, c.raw_byte_start, c.raw_byte_end,
      c.projected_byte_start, c.projected_byte_end FROM content_chunks c JOIN pages p ON p.id = c.page_id
     WHERE c.page_id = $1 AND c.occurrence_id = ANY($2::bigint[]) AND ${chunkGenerationFilter('p', 'c')}
     ORDER BY c.occurrence_id, c.local_ordinal`, params: [7, [4, 5]] }]);
    expect(await sends(tx => sw.readMaterializingRevision(tx))).toEqual([
      { sql: "SELECT current_setting('gbrain.materializing_revision', true) AS revision", params: undefined }]);
    expect(await sends(tx => sw.setMaterializingRevision(tx, '9'))).toEqual([
      { sql: "SELECT set_config('gbrain.materializing_revision', $1, true)", params: ['9'] }]);
    expect(await sends(tx => sw.restorePageUpdatedAt(tx, 7, '1700000000000000'))).toEqual([
      { sql: `UPDATE pages SET updated_at = 'epoch'::timestamptz + $2::bigint * interval '1 microsecond' WHERE id=$1`, params: [7, '1700000000000000'] }]);
  });

  test('fence-append.ts: the trust stamp by source and slug, and by id', async () => {
    expect(await sends(tx => sw.readPageTrustStamp(tx, { sourceId: 'default', slug: 'a' }))).toEqual([
      { sql: 'SELECT id, trust_tier, write_origin FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', params: ['default', 'a'] }]);
    expect(await sends(tx => sw.readPageTrustStamp(tx, { id: 7 }))).toEqual([
      { sql: 'SELECT id, trust_tier, write_origin FROM pages WHERE id=$1', params: [7] }]);
  });

  test('segment-rewrite.ts and segment-derive.ts: the fence rewrite statements', async () => {
    const MANIFEST_COLUMNS = `page_id,occurrence_id,seq,region,source_id,sha256,byte_start,byte_len,line_start,line_count,cut_kind,entry_state,
  protected_regions,facts_slots,static_proj_bytes,static_proj_lines,outline,date_min,date_max,hash_state`;
    const staging = 'u-1', next = 4;
    expect(await sends(tx => sw.readSegmentedRewritePage(tx, 7))).toEqual([{ sql: `SELECT p.id,p.slug,p.source_id,p.title,
      p.type,p.page_kind,p.frontmatter,p.body_generation,p.body_bytes,p.body_flags,p.body_storage,p.deleted_at,p.contextual_retrieval_mode,p.corpus_generation,
      COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id=p.id),'[]'::jsonb) AS tags FROM pages p WHERE p.id=$1`, params: [7] }]);
    expect(await sends(tx => sw.restorePageDeletedAt(tx, 7, '2026-01-01T00:00:00.000Z'))).toEqual([
      { sql: 'UPDATE pages SET deleted_at=$2 WHERE id=$1', params: [7, '2026-01-01T00:00:00.000Z'] }]);
    expect(await sends(tx => sw.lockSegmentedGenerationPage(tx, 7))).toEqual([
      { sql: 'SELECT slug,source_id,body_flags,body_storage,body_generation FROM pages WHERE id=$1 FOR UPDATE', params: [7] }]);
    expect(await sends(tx => sw.splitManifestGeneration(tx, 7, 3, staging))).toEqual([
      { sql: `INSERT INTO page_body_manifest (${MANIFEST_COLUMNS},gen_from,gen_to,staging_id) SELECT ${MANIFEST_COLUMNS},$3::bigint,gen_to,$4::uuid
    FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_from<=$2 AND (gen_to IS NULL OR gen_to>$3)`, params: [7, 3, next, staging] },
      { sql: 'UPDATE page_body_manifest SET gen_to=$2 WHERE page_id=$1 AND staging_id IS NULL AND gen_from<$2 AND (gen_to IS NULL OR gen_to>$2)', params: [7, 3] },
      { sql: 'DELETE FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_from=$2', params: [7, 3] }]);
    expect(await sends(tx => sw.publishRebuiltGeneration(tx, 7, 3, staging))).toEqual([{ sql: `UPDATE page_body_manifest SET staging_id=NULL, gen_to=CASE WHEN gen_from=$2 THEN $3 ELSE gen_to END
    WHERE page_id=$1 AND staging_id=$4::uuid`, params: [7, 3, next, staging] }]);
    expect(await sends(tx => sw.setSegmentedVersionHash(tx, 7, 3, 'h', 12))).toEqual([
      { sql: `UPDATE page_versions SET content_hash=$3,body_bytes=$4 WHERE page_id=$1 AND body_generation=$2 AND body_storage='segmented'`, params: [7, 3, 'h', 12] }]);
    expect(await sends(tx => sw.deleteRewrittenDerivationRows(tx, 7, { touched: [4], reach: [5], unpaidKinds: ['links', 'mentions'], live: [4, 5, 6] }))).toEqual([
      { sql: `DELETE FROM page_segment_derivations WHERE page_id=$1
    AND (occurrence_id = ANY($2::bigint[]) OR (pipeline = 'links' AND occurrence_id = ANY($3::bigint[]))
      OR (pipeline = ANY($4::text[]) AND NOT (occurrence_id = ANY($5::bigint[])))) RETURNING 1`, params: [7, [4], [5], ['links', 'mentions'], [4, 5, 6]] }]);
  });

  test('results keep the callers\' shapes', async () => {
    const { tx } = recorder([]);
    expect(await sw.lockBodyStagingState(tx, 'u-1')).toBeNull();
    expect(await sw.readSegmentedSealed(tx, 'default', 'a')).toBe(false);
    expect(await sw.readMaterializingRevision(tx)).toBeNull();
    expect(await sw.readPageTrustStamp(tx, { id: 7 })).toBeNull();
    expect(await sw.listChunkedOccurrences(recorder([{ occurrence_id: '4' }]).tx, 7, [4, 5], 3)).toEqual([4]);
    expect(await sw.retireStaleSegmentChunks(recorder([{ id: 1 }, { id: 2 }]).tx, 7, 3, [], 500)).toBe(2);
    expect(await sw.listSegmentedRechunkCandidates(recorder([{ id: '12' }]).tx, 2)).toEqual([12]);
    expect(await sw.readSegmentedSealed(recorder([{ sealed: true }]).tx, 'default', 'a')).toBe(true);
    expect(await sw.readSegmentedRewritePage(tx, 7)).toBeNull();
    expect(await sw.lockSegmentedGenerationPage(tx, 7)).toBeNull();
    expect(await sw.deleteRewrittenDerivationRows(recorder([{ '?column?': 1 }, { '?column?': 1 }]).tx, 7, { touched: [4], reach: [], unpaidKinds: [], live: [4] })).toBe(2);
  });
});
