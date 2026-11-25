/**
 * Caller pins for engine-sql/segmented-writes.ts: each member sends Postgres and PGLite the exact statement and
 * parameters its caller sent before the statement moved behind a typed member (segmented-apply.ts, searchable.ts,
 * ingest.ts, import-chunk-reuse.ts, projection.ts, rechunk.ts, fence-append.ts at 1e1cfaabc2; segment-rewrite.ts and
 * segment-derive.ts at 8a7ded1c6d). The expected texts
 * below are those callers' own expressions, copied verbatim, so a drift in either direction fails here. The
 * segmented-embed members (segmented-embedding.ts at 91d7196870) keep each old clause, but the composed ones number
 * their placeholders in order, so those pins hold the renumbered text.
 */
import { describe, expect, test } from 'bun:test';
import * as sw from '../src/core/engine-sql/segmented-writes.ts';
import { quoteIdentifier } from '../src/core/search/embedding-column.ts';
import { chunkGenerationFilter, currentTextProjectionFilter } from '../src/core/search/safe-chunks.ts';

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
  test('segmented-apply.ts: the live page read', async () => {
    expect(await sends(tx => sw.readSegmentedLivePage(tx, 7))).toEqual([
      { sql: 'SELECT id, body_generation, body_storage, title, type, body_flags FROM pages WHERE id=$1', params: [7] }]);
  });

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

  test('segment-rewrite.ts and segment-derive.ts: the fence rewrite statements', async () => {
    const MANIFEST_COLUMNS = `page_id,occurrence_id,seq,region,source_id,sha256,byte_start,byte_len,line_start,line_count,cut_kind,entry_state,
  protected_regions,facts_slots,static_proj_bytes,static_proj_lines,outline,date_min,date_max,hash_state`;
    const staging = 'u-1', next = 4;
    expect(await sends(tx => sw.readSegmentedRewritePage(tx, 7))).toEqual([{ sql: `SELECT p.id,p.slug,p.source_id,p.title,
      p.type,p.page_kind,p.frontmatter,p.body_generation,p.body_bytes,p.body_flags,p.body_storage,p.deleted_at,p.contextual_retrieval_mode,p.corpus_generation,
      COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id=p.id),'[]'::jsonb) AS tags FROM pages p WHERE p.id=$1`, params: [7] }]);
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
  });

  test('segmented-embedding.ts: the embed reads and the vector install', async () => {
    const gen = chunkGenerationFilter('p', 'cc'), sealed = currentTextProjectionFilter('p');
    const page = `SELECT p.id, p.slug, p.source_id, p.title, p.contextual_retrieval_mode, p.body_bytes
       FROM pages p JOIN sources s ON s.id = p.source_id
      WHERE `;
    const pageTail = ` AND p.body_storage = 'segmented' AND p.deleted_at IS NULL AND NOT s.archived AND ${sealed}`;
    expect(await sends(tx => sw.hasLiveSegmentedPage(tx, 'default', 'a'))).toEqual([{ sql: `SELECT 1 FROM pages p JOIN sources s ON s.id = p.source_id
    WHERE p.source_id = $1 AND p.slug = $2 AND p.body_storage = 'segmented' AND p.deleted_at IS NULL AND NOT s.archived`, params: ['default', 'a'] }]);
    expect(await sends(tx => sw.countSegmentedEmbedRows(tx, 7, 'embedding'))).toEqual([{ sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE cc.${quoteIdentifier('embedding')} IS NULL)::int AS stale
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = $1 AND ${sealed} AND ${gen}`, params: [7] }]);
    expect(await sends(tx => sw.listSegmentedStaleRows(tx, 7, 'embedding', { beforeChunkIndex: 9, limit: 5, occurrenceIds: [4], includeEmbedded: true }))).toEqual([
      { sql: `SELECT cc.chunk_index, cc.chunk_text, cc.chunk_source
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = $1 AND ($2::boolean OR cc.${quoteIdentifier('embedding')} IS NULL)
        AND ($3::int IS NULL OR cc.chunk_index < $4::int)
        AND ($5::bigint[] IS NULL OR cc.occurrence_id = ANY($6::bigint[]))
        AND ${sealed} AND ${gen}
      ORDER BY cc.chunk_index DESC LIMIT $7`, params: [7, true, 9, 9, [4], [4], 5] }]);
    expect((await sends(tx => sw.listSegmentedStaleRows(tx, 7, 'embedding', { beforeChunkIndex: null, limit: 5 })))[0]!.params).toEqual([7, false, null, null, null, null, 5]);
    expect(await sends(tx => sw.readSegmentChunkInputHashes(tx, 7, [1, 2]))).toEqual([{ sql: `SELECT cc.chunk_index, cc.embedding_input_hash FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = $1 AND cc.chunk_index = ANY($2::int[]) AND ${gen}`, params: [7, [1, 2]] }]);
    expect(await sends(tx => sw.installSegmentedVectors(tx, 7, { name: 'embedding', type: 'vector', dimensions: 2 } as never, 'm',
      [{ chunk_index: 1, chunk_text: 't', vector: new Float32Array([0.5, 1]), hash: 'h', expected: null }]))).toEqual([
      { sql: `UPDATE content_chunks cc SET ${quoteIdentifier('embedding')} = v.embedding::vector,
          embedding_input_hash = v.hash, embedded_at = now(), embedded_text_hash = md5(cc.chunk_text), model = COALESCE($1, cc.model),
          embedding_pending_since = NULL
        FROM jsonb_to_recordset($2::text::jsonb) AS v(chunk_index int, chunk_text text, embedding text, hash text, expected text), pages p
        WHERE cc.page_id = $3 AND p.id = cc.page_id AND cc.chunk_index = v.chunk_index AND cc.chunk_text = v.chunk_text
          AND cc.embedding_input_hash IS NOT DISTINCT FROM v.expected AND ${gen}
        RETURNING cc.id`, params: ['m', JSON.stringify([{ chunk_index: 1, chunk_text: 't', embedding: '[0.5,1]', hash: 'h', expected: null }]), 7] }]);
    expect(await sends(tx => sw.listLiveEmbedSegments(tx, 7))).toEqual([{ sql: `SELECT m.occurrence_id, m.sha256, m.entry_state FROM page_body_manifest m JOIN pages p ON p.id = m.page_id
      WHERE m.page_id = $1 AND m.staging_id IS NULL AND m.gen_from <= p.body_generation AND (m.gen_to IS NULL OR m.gen_to > p.body_generation)
      ORDER BY m.seq DESC`, params: [7] }]);
    expect(await sends(tx => sw.listSegmentChunkRows(tx, 7, 4))).toEqual([{ sql: `SELECT cc.chunk_index, cc.chunk_text, cc.chunk_source, cc.embedding_input_hash
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = $1 AND cc.occurrence_id = $2 AND ${sealed} AND ${gen}
      ORDER BY cc.chunk_index`, params: [7, 4] }]);
  });

  test('results keep the callers\' shapes', async () => {
    const { tx } = recorder([]);
    expect(await sw.readMaterializingRevision(tx)).toBeNull();
    expect(await sw.listChunkedOccurrences(recorder([{ occurrence_id: '4' }]).tx, 7, [4, 5], 3)).toEqual([4]);
    expect(await sw.retireStaleSegmentChunks(recorder([{ id: 1 }, { id: 2 }]).tx, 7, 3, [], 500)).toBe(2);
    expect(await sw.listSegmentedRechunkCandidates(recorder([{ id: '12' }]).tx, 2)).toEqual([12]);
    expect(await sw.readSegmentedRewritePage(tx, 7)).toBeNull();
    expect(await sw.lockSegmentedGenerationPage(tx, 7)).toBeNull();
    expect(await sw.hasLiveSegmentedPage(tx, 'default', 'a')).toBe(false);
    expect(await sw.countSegmentedEmbedRows(recorder([{ total: '3', stale: '1' }]).tx, 7, 'embedding')).toEqual({ total: 3, stale: 1 });
    expect(await sw.installSegmentedVectors(recorder([{ id: 1 }]).tx, 7, { name: 'embedding', type: 'vector', dimensions: 1 } as never, null,
      [{ chunk_index: 1, chunk_text: 't', vector: new Float32Array([1]), hash: 'h', expected: null }])).toBe(1);
  });
});
