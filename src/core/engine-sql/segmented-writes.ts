/**
 * The statements a segmented write, a segmented re-chunk and a fence rewrite ran through executeRaw
 * (persistence/segmented-apply.ts, persistence/searchable.ts, page-body/ingest.ts, page-body/projection.ts,
 * page-body/rechunk.ts, page-body/segment-rewrite.ts, page-body/segment-derive.ts, page-body/segmented-embedding.ts,
 * import-chunk-reuse.ts and trust/fence-append.ts), one function per BrainEngine member. PGLite and Postgres run the
 * same text the callers ran before; the Rust engine answers from its store (rust/docs/store/page_body.md). Each runs on
 * the engine it is given, so a call on a transaction engine reads and writes inside that transaction.
 */
import type { BrainEngine } from '../engine.ts';
import type { SegmentDerivationInput } from '../page-body/derivations.ts';
import type { JsonObject } from '../page-body/types.ts';
import type { ResolvedColumn } from '../types.ts';
import { jsonRowBatches } from '../batch-rows.ts';
import { quoteIdentifier, vectorCastSuffix } from '../search/embedding-column.ts';
import { chunkGenerationFilter, currentTextProjectionFilter } from '../search/safe-chunks.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The live page a segmented write diffs against, read by id (metadata only). */
export interface SegmentedLivePageRow {
  id: number; body_generation: number | string; body_storage: string; title: string; type: string; body_flags: JsonObject | null;
}

/** The live segmented page a projection builds, by source and slug. */
export interface SegmentedProjectionPage {
  id: number; body_generation: number | string; body_bytes: number | string; knowledge_revision: string; text_projection_revision: string | null;
  title: string; frontmatter: JsonObject | null; body_flags: JsonObject | null; timeline_lead: string | null;
}

/** The segmented page a re-chunk reads, deleted or not: its body columns, revision, seal and updated_at in microseconds. */
export interface SegmentedRechunkPageRow {
  id: number; slug: string; source_id: string; title: string; type: string; page_kind: string; frontmatter: JsonObject | null;
  body_generation: number | string; body_flags: JsonObject | null; chunker_version: number | null; contextual_retrieval_mode: string | null;
  corpus_generation: string | null; knowledge_revision: string; sealed: boolean; updated_us: string; deleted_at: string | null;
  content_hash: string; body_bytes: number | string; truth_bytes: number | string; body_lines: number | string; segment_count: number;
  segmenter_version: number; truth_lead: string | null; timeline_lead: string | null;
}

/** One visible chunk row of an occurrence, as a re-chunk compares it with today's chunker. */
export interface OccurrenceChunkRow {
  occurrence_id: unknown; chunk_source: string; chunk_text: string; raw_byte_start: unknown; raw_byte_end: unknown;
  projected_byte_start: unknown; projected_byte_end: unknown;
}

/** A stored vector of a retired occurrence's visible chunk, with what reuse checks it against. */
export interface RetiredChunkVectorRow {
  chunk_text: string; chunk_source: string; embedding: unknown; token_count: number | null; model: string | null;
  embedding_input_hash: string | null; contextual_retrieval_mode: string | null; slug: string; source_id: string; corpus_generation: string | null;
}



/** The scope of a re-chunk run: one source, one slug, both or neither. */
export interface RechunkCandidateScope { sourceId?: string; slug?: string }



/** Page `pageId`'s storage class, generation, title, type and body flags, deleted or not; null when there is no such page. */
export async function readSegmentedLivePage(tx: Raw, pageId: number): Promise<SegmentedLivePageRow | null> {
  const [row] = await tx.executeRaw<SegmentedLivePageRow>(
    'SELECT id, body_generation, body_storage, title, type, body_flags FROM pages WHERE id=$1', [pageId]);
  return row ?? null;
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

/** The ids of sealed, live segmented pages below `chunkerVersion` within the scope, in (source_id, slug) order. */
export async function listSegmentedRechunkCandidates(tx: Raw, chunkerVersion: number, scope: RechunkCandidateScope = {}): Promise<number[]> {
  const bySource = scope.sourceId ? sqlFragment` AND source_id=${scope.sourceId}` : sqlFragment``;
  const bySlug = scope.slug ? sqlFragment` AND slug=${scope.slug}` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT id FROM pages WHERE body_storage='segmented' AND deleted_at IS NULL
    AND chunker_version < ${chunkerVersion} AND (text_projection_revision = knowledge_revision) IS TRUE${bySource}${bySlug} ORDER BY source_id, slug`);
  return (await tx.executeRaw<{ id: number }>(text, params)).map(row => Number(row.id));
}

const RECHUNK_PAGE_SQL = `SELECT id, slug, source_id, title, type, page_kind, frontmatter, body_generation, body_flags, chunker_version,
    contextual_retrieval_mode, corpus_generation, knowledge_revision::text AS knowledge_revision,
    (text_projection_revision = knowledge_revision) IS TRUE AS sealed, (extract(epoch FROM updated_at) * 1000000)::bigint::text AS updated_us, deleted_at, content_hash, body_bytes, truth_bytes,
    body_lines, segment_count, segmenter_version, truth_lead, timeline_lead
  FROM pages WHERE id=$1 AND body_storage='segmented'`;

/** Segmented page `pageId` as a re-chunk reads it, deleted or not; null when there is no such segmented page. */
export async function readSegmentedRechunkPage(tx: Raw, pageId: number): Promise<SegmentedRechunkPageRow | null> {
  return (await tx.executeRaw<SegmentedRechunkPageRow>(RECHUNK_PAGE_SQL, [pageId]))[0] ?? null;
}

/** The visible chunk rows of `occurrences` on page `pageId`, by occurrence then local ordinal. */
export async function listOccurrenceChunks(tx: Raw, pageId: number, occurrences: readonly number[]): Promise<OccurrenceChunkRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT c.occurrence_id, c.chunk_source, c.chunk_text, c.raw_byte_start, c.raw_byte_end,
      c.projected_byte_start, c.projected_byte_end FROM content_chunks c JOIN pages p ON p.id = c.page_id
     WHERE c.page_id = ${pageId} AND c.occurrence_id = ANY(${occurrences}::bigint[]) AND ${trustedSql(chunkGenerationFilter('p', 'c'))}
     ORDER BY c.occurrence_id, c.local_ordinal`);
  return tx.executeRaw<OccurrenceChunkRow>(text, params);
}

/** The transaction's `gbrain.materializing_revision` setting: null when never set, '' once cleared. */
export async function readMaterializingRevision(tx: Raw): Promise<string | null> {
  const [prior] = await tx.executeRaw<{ revision: string | null }>("SELECT current_setting('gbrain.materializing_revision', true) AS revision");
  return prior?.revision ?? null;
}

/**
 * Set `gbrain.materializing_revision` for the rest of the transaction: a body flip of the page at that revision keeps
 * the revision (and so its seal), as a materialization does. '' clears it.
 */
export async function setMaterializingRevision(tx: Raw, revision: string): Promise<void> {
  await tx.executeRaw("SELECT set_config('gbrain.materializing_revision', $1, true)", [revision]);
}

/** Set page `pageId`'s updated_at to `updatedUs` microseconds after the epoch, exactly. */
export async function restorePageUpdatedAt(tx: Raw, pageId: number, updatedUs: string): Promise<void> {
  await tx.executeRaw(`UPDATE pages SET updated_at = 'epoch'::timestamptz + $2::bigint * interval '1 microsecond' WHERE id=$1`, [pageId, updatedUs]);
}




/** The page a live fence rewrite reads (page-body/segment-rewrite.ts), deleted or not, with its tags in order. */
export interface SegmentedRewritePageRow {
  id: number; slug: string; source_id: string; title: string; type: string; page_kind: string; frontmatter: JsonObject | null;
  body_generation: number | string; body_bytes: number | string; body_flags: JsonObject | null; body_storage: string; deleted_at: string | null;
  contextual_retrieval_mode: string | null; corpus_generation: string | null; tags: string[];
}

/** The page row a retained-generation rewrite locks for the rest of the transaction. */
export interface SegmentedGenerationLock {
  slug: string; source_id: string; body_flags: JsonObject | null; body_storage: string; body_generation: number | string;
}

/** Page `pageId` as a live fence rewrite reads it, deleted or not, or null. Tags sort bytewise (COLLATE "C") on every engine. */
export async function readSegmentedRewritePage(tx: Raw, pageId: number): Promise<SegmentedRewritePageRow | null> {
  const [row] = await tx.executeRaw<SegmentedRewritePageRow>(`SELECT p.id,p.slug,p.source_id,p.title,
      p.type,p.page_kind,p.frontmatter,p.body_generation,p.body_bytes,p.body_flags,p.body_storage,p.deleted_at,p.contextual_retrieval_mode,p.corpus_generation,
      COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id=p.id),'[]'::jsonb) AS tags FROM pages p WHERE p.id=$1`, [pageId]);
  return row ?? null;
}

/** Set page `pageId`'s deleted_at back to `deletedAt` (a rewrite of a soft-deleted page leaves it deleted). */
export async function restorePageDeletedAt(tx: Raw, pageId: number, deletedAt: string): Promise<void> {
  await tx.executeRaw('UPDATE pages SET deleted_at=$2 WHERE id=$1', [pageId, deletedAt]);
}

/** Lock page `pageId`'s row for the rest of the transaction and return its body columns, or null. */
export async function lockSegmentedGenerationPage(tx: Raw, pageId: number): Promise<SegmentedGenerationLock | null> {
  const [row] = await tx.executeRaw<SegmentedGenerationLock>(
    'SELECT slug,source_id,body_flags,body_storage,body_generation FROM pages WHERE id=$1 FOR UPDATE', [pageId]);
  return row ?? null;
}

/**
 * Give retained generation `generation` of page `pageId` rows of its own: the part of each published row after it moves
 * to a copy staged under `stagingId` (so the live-seq index sees one live row), the part before it ends at it, and rows
 * that began at it go.
 */
export async function splitManifestGeneration(tx: Raw, pageId: number, generation: number, stagingId: string): Promise<void> {
  const next = generation + 1;
  await tx.executeRaw(`INSERT INTO page_body_manifest (page_id,occurrence_id,seq,region,source_id,sha256,byte_start,byte_len,line_start,line_count,cut_kind,entry_state,
  protected_regions,facts_slots,static_proj_bytes,static_proj_lines,outline,date_min,date_max,hash_state,gen_from,gen_to,staging_id) SELECT page_id,occurrence_id,seq,region,source_id,sha256,byte_start,byte_len,line_start,line_count,cut_kind,entry_state,
  protected_regions,facts_slots,static_proj_bytes,static_proj_lines,outline,date_min,date_max,hash_state,$3::bigint,gen_to,$4::uuid
    FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_from<=$2 AND (gen_to IS NULL OR gen_to>$3)`, [pageId, generation, next, stagingId]);
  await tx.executeRaw('UPDATE page_body_manifest SET gen_to=$2 WHERE page_id=$1 AND staging_id IS NULL AND gen_from<$2 AND (gen_to IS NULL OR gen_to>$2)', [pageId, generation]);
  await tx.executeRaw('DELETE FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_from=$2', [pageId, generation]);
}

/** Publish the rows staged under `stagingId`: the rebuilt rows of `generation` cover exactly it, the moved copies keep their end. */
export async function publishRebuiltGeneration(tx: Raw, pageId: number, generation: number, stagingId: string): Promise<void> {
  await tx.executeRaw(`UPDATE page_body_manifest SET staging_id=NULL, gen_to=CASE WHEN gen_from=$2 THEN $3 ELSE gen_to END
    WHERE page_id=$1 AND staging_id=$4::uuid`, [pageId, generation, generation + 1, stagingId]);
}

/** Set content_hash and body_bytes of each segmented version row of page `pageId` at `generation`. */
export async function setSegmentedVersionHash(tx: Raw, pageId: number, generation: number, contentHash: string, bodyBytes: number): Promise<void> {
  await tx.executeRaw(`UPDATE page_versions SET content_hash=$3,body_bytes=$4 WHERE page_id=$1 AND body_generation=$2 AND body_storage='segmented'`,
    [pageId, generation, contentHash, bodyBytes]);
}




/** A segmented page's live row in keyset order, as an embed lists it. */
export interface SegmentedStaleRowRow { chunk_index: number; chunk_text: string; chunk_source: string }

/** The options of `listSegmentedStaleRows`: below `beforeChunkIndex` (null: from the newest), at most `limit`. */
export interface SegmentedStaleRowsOpts { beforeChunkIndex: number | null; limit: number; occurrenceIds?: readonly number[]; includeEmbedded?: boolean }

/** One vector to install: the row's chunk_index and text, the vector, its recorded input and the input read before. */
export interface SegmentedVectorInstall { chunk_index: number; chunk_text: string; vector: Float32Array; hash: string; expected: string | null }

/**
 * The effect claim an embedding effect's install runs under (L5): on a multi-user Rust brain the install's own write
 * checks the host fence and the claim's epoch, so a worker whose host lease was taken over during its provider call
 * installs nothing. The SQL engines and a plain Rust brain ignore it (they check the claim row under its lock).
 */
export interface SegmentedInstallClaim { effectId: number | string; token: string; fence?: import('./lease-token.ts').LeaseToken }

/** A live manifest row of a segmented page, as an embed walks its segments. */
export interface LiveEmbedSegmentRow { occurrence_id: number | string; sha256: Uint8Array; entry_state: unknown }

/** One live chunk row of a segment with its recorded embedding input. */
export interface SegmentChunkRowRow { chunk_index: number; chunk_text: string; chunk_source: string; embedding_input_hash: string | null }


/** Whether the page at `sourceId`/`slug` is segmented, not deleted and in a live source, sealed or not. */
export async function hasLiveSegmentedPage(tx: Raw, sourceId: string, slug: string): Promise<boolean> {
  return (await tx.executeRaw(`SELECT 1 FROM pages p JOIN sources s ON s.id = p.source_id
    WHERE p.source_id = $1 AND p.slug = $2 AND p.body_storage = 'segmented' AND p.deleted_at IS NULL AND NOT s.archived`, [sourceId, slug])).length > 0;
}

/** A sealed segmented page's live rows and those without a vector in `column`. */
export async function countSegmentedEmbedRows(tx: Raw, pageId: number, column: string): Promise<{ total: number; stale: number }> {
  const col = quoteIdentifier(column);
  const { text, params } = renderFragment(sqlFragment`SELECT count(*)::int AS total, count(*) FILTER (WHERE cc.${trustedSql(col)} IS NULL)::int AS stale
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = ${pageId} AND ${trustedSql(currentTextProjectionFilter('p'))} AND ${trustedSql(chunkGenerationFilter('p', 'cc'))}`);
  const [row] = await tx.executeRaw<{ total: number; stale: number }>(text, params);
  return { total: Number(row?.total ?? 0), stale: Number(row?.stale ?? 0) };
}

/** A sealed segmented page's live rows without a vector in `column` (any with `includeEmbedded`), newest first. */
export async function listSegmentedStaleRows(tx: Raw, pageId: number, column: string, opts: SegmentedStaleRowsOpts): Promise<SegmentedStaleRowRow[]> {
  const col = quoteIdentifier(column);
  const { text, params } = renderFragment(sqlFragment`SELECT cc.chunk_index, cc.chunk_text, cc.chunk_source
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = ${pageId} AND (${opts.includeEmbedded ?? false}::boolean OR cc.${trustedSql(col)} IS NULL)
        AND (${opts.beforeChunkIndex}::int IS NULL OR cc.chunk_index < ${opts.beforeChunkIndex}::int)
        AND (${opts.occurrenceIds ? [...opts.occurrenceIds] : null}::bigint[] IS NULL OR cc.occurrence_id = ANY(${opts.occurrenceIds ? [...opts.occurrenceIds] : null}::bigint[]))
        AND ${trustedSql(currentTextProjectionFilter('p'))} AND ${trustedSql(chunkGenerationFilter('p', 'cc'))}
      ORDER BY cc.chunk_index DESC LIMIT ${opts.limit}`);
  return tx.executeRaw<SegmentedStaleRowRow>(text, params);
}

/** The recorded embedding input of a segmented page's live rows at `chunkIndexes`, sealed or not. */
export async function readSegmentChunkInputHashes(tx: Raw, pageId: number, chunkIndexes: readonly number[]): Promise<Array<{ chunk_index: number; embedding_input_hash: string | null }>> {
  const { text, params } = renderFragment(sqlFragment`SELECT cc.chunk_index, cc.embedding_input_hash FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = ${pageId} AND cc.chunk_index = ANY(${[...chunkIndexes]}::int[]) AND ${trustedSql(chunkGenerationFilter('p', 'cc'))}`);
  return tx.executeRaw<{ chunk_index: number; embedding_input_hash: string | null }>(text, params);
}

/**
 * Put each vector, with its recorded input, in `column` of the live row with the same chunk_index and text whose
 * recorded input is still `expected`, embedded now, labelled `model` (the row's own label when null). Returns how many
 * rows took a vector. The caller holds the page lock and checks the page and write target first.
 */
export async function installSegmentedVectors(tx: Raw, pageId: number, column: ResolvedColumn, model: string | null,
  vectors: readonly SegmentedVectorInstall[]): Promise<number> {
  const col = quoteIdentifier(column.name);
  const cast = vectorCastSuffix(column);
  const updates = vectors.map(v => ({ chunk_index: v.chunk_index, chunk_text: v.chunk_text, embedding: `[${Array.from(v.vector).join(',')}]`, hash: v.hash, expected: v.expected }));
  let installed = 0;
  for (const batch of jsonRowBatches(updates, update => update)) {
    const { text, params } = renderFragment(sqlFragment`UPDATE content_chunks cc SET ${trustedSql(col)} = v.embedding${trustedSql(cast)},
          embedding_input_hash = v.hash, embedded_at = now(), embedded_text_hash = md5(cc.chunk_text), model = COALESCE(${model}, cc.model),
          embedding_pending_since = NULL
        FROM jsonb_to_recordset(${batch}::text::jsonb) AS v(chunk_index int, chunk_text text, embedding text, hash text, expected text), pages p
        WHERE cc.page_id = ${pageId} AND p.id = cc.page_id AND cc.chunk_index = v.chunk_index AND cc.chunk_text = v.chunk_text
          AND cc.embedding_input_hash IS NOT DISTINCT FROM v.expected AND ${trustedSql(chunkGenerationFilter('p', 'cc'))}
        RETURNING cc.id`);
    installed += (await tx.executeRaw(text, params)).length;
  }
  return installed;
}

/** A segmented page's live manifest rows, newest (highest seq) first. */
export async function listLiveEmbedSegments(tx: Raw, pageId: number): Promise<LiveEmbedSegmentRow[]> {
  return tx.executeRaw<LiveEmbedSegmentRow>(`SELECT m.occurrence_id, m.sha256, m.entry_state FROM page_body_manifest m JOIN pages p ON p.id = m.page_id
      WHERE m.page_id = $1 AND m.staging_id IS NULL AND m.gen_from <= p.body_generation AND (m.gen_to IS NULL OR m.gen_to > p.body_generation)
      ORDER BY m.seq DESC`, [pageId]);
}

/** A sealed segmented page's live rows of one occurrence in chunk_index order, with their recorded inputs. */
export async function listSegmentChunkRows(tx: Raw, pageId: number, occurrenceId: number): Promise<SegmentChunkRowRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT cc.chunk_index, cc.chunk_text, cc.chunk_source, cc.embedding_input_hash
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = ${pageId} AND cc.occurrence_id = ${occurrenceId} AND ${trustedSql(currentTextProjectionFilter('p'))} AND ${trustedSql(chunkGenerationFilter('p', 'cc'))}
      ORDER BY cc.chunk_index`);
  return tx.executeRaw<SegmentChunkRowRow>(text, params);
}
