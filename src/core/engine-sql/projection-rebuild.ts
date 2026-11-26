/**
 * The statements a projection rebuild sends (page-state/projections.ts rebuildPendingPageProjections,
 * installPageProjection, planProjectionKeep and the statistics' drained probe). Each function runs the statement its
 * caller ran through `executeRaw` on the engine's own `executeRaw`. The queue listing, the keep plan and the vector
 * clears, the stale-vector list, the pending count and the two composed queue stamps are built with sqlFragment, so their
 * placeholders are numbered in text order; every other text is unchanged.
 * `test/projection-rebuild-sql-pin.test.ts` pins each statement and its binds against the ones recorded before the
 * move. The deferred chunk replacement's statements (continueDeferredProjectionStep), the rebuild loop's queue
 * stamps, the re-seal's pending count (resealSafeChunks), the resident's window probe (selectWindowJobs), the continuation's
 * claim release, the queue insert (queuePageProjection) and the drain's backlog, preview, clock, work probe and row estimate
 * are members too, so projections.ts sends no raw SQL.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { sealableImageSql } from '../page-state/projection-class.ts';
import { movableChunkSql } from '../search/safe-chunks.ts';
import { chunkModelMatchesSql } from '../embedding-invalidation.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';

/**
 * The live inline page (Markdown or code, not segmented; with `media`, also a sealable image) of an active source
 * that a queue row `j` names: the `s` and `p` lateral probes the rebuild's selections join.
 */
export function projectionJobProbes(opts: { media?: boolean } = {}): string {
  const inline = "p.page_kind IN ('markdown','code') AND p.body_storage IS DISTINCT FROM 'segmented'";
  return `CROSS JOIN LATERAL (SELECT s.id FROM sources s
      WHERE s.incarnation=j.source_incarnation AND NOT s.archived OFFSET 0) s
    CROSS JOIN LATERAL (SELECT p.page_kind FROM pages p WHERE p.id=(SELECT k.id FROM pages k WHERE k.source_id=s.id AND k.slug=j.slug)
      AND p.deleted_at IS NULL AND ${opts.media ? `((${inline}) OR ${sealableImageSql('p')})` : inline} OFFSET 0) p`;
}

/** A queue row's exact key: the row a rebuild listed. */
export interface ProjectionJobKey { sourceIncarnation: string; slug: string; revision: string }

/** The vector column a keep plan compares against. */
export interface KeepColumn { name: string; dimensions: number }

export interface ChunkKeepState { id: number; embedding_input_hash: string | null; movable: boolean }

/**
 * Each chunk of the page with its recorded embedding input and whether its vector in `column` is current: present,
 * embedded from the chunk's text as it is now, and labelled `provenanceModel` (or its bare name at the column's width).
 */
export async function readChunkKeepState(raw: EngineRawRead, pageId: number, provenanceModel: string | null, column: KeepColumn): Promise<ChunkKeepState[]> {
  const col = quoteIdentifier(column.name);
  const { text, params } = renderFragment(
    // chunk-visibility-ok: the keep plan compares every stored chunk row of the page it is about to replace
    sqlFragment`SELECT id,embedding_input_hash,${trustedSql(movableChunkSql(col))} AND ${keptModelFragment(col, column.dimensions, provenanceModel)} AS movable FROM content_chunks WHERE page_id=${pageId}`);
  return raw<ChunkKeepState>(text, params);
}

/**
 * Clears the vector in `column` and its embedding record on each chunk of the page that is not labelled
 * `provenanceModel` (or its bare name at the column's width), whose recorded text hash is not its text's, or whose id
 * is not in `currentIds`, and marks it pending.
 */
export async function clearUnkeptChunkVectors(raw: EngineRawRead, pageId: number, provenanceModel: string | null, column: KeepColumn, currentIds: readonly number[]): Promise<void> {
  const col = quoteIdentifier(column.name);
  const { text, params } = renderFragment(sqlFragment`UPDATE content_chunks SET ${trustedSql(col)}=NULL,
        embedded_at=NULL,embedded_text_hash=NULL,embedding_input_hash=NULL,
        embedding_pending_since=COALESCE(embedding_pending_since,now()) WHERE page_id=${pageId} AND
        (NOT ${keptModelFragment(col, column.dimensions, provenanceModel)} OR embedded_text_hash <> md5(chunk_text) OR NOT(id=ANY(${[...currentIds]}::int[])))`);
  await raw(text, params);
}

/**
 * `chunkModelMatchesSql` (embedding-invalidation.ts) over the chunk's `model` as a fragment: built from its text, with
 * `model` bound in place of its model parameter (as chunks.ts currentSpaceChunkFragment does), so the two cannot drift.
 */
function keptModelFragment(col: string, dimensions: number, model: string | null): SqlFragment {
  if (!Number.isInteger(dimensions)) throw new Error(`embedding column width must be an integer, got ${dimensions}`);
  const strings = chunkModelMatchesSql('model', '$9001', `vector_dims(${col}) = ${dimensions}`).split('$9001');
  return sqlFragment(Object.assign([...strings], { raw: [...strings] }), model);
}

/** Stamps the chunker version a sealed projection was built with on the page. */
export async function setProjectionChunkerVersion(raw: EngineRawRead, sourceId: string, slug: string, version: number): Promise<void> {
  await raw(`UPDATE pages SET chunker_version=$3
        WHERE source_id=$1 AND slug=$2`, [sourceId, slug, version]);
}

/** #7172: `<claim>:<token>`, the reason while a continuation holds a deferred chunk replacement (renewed each step). */
export const DEFERRED_CHUNK_CLAIM = 'chunk_replacement_continuing';
/** #7172: the queue reason of a revision whose publication left its chunk replacement to `continueDeferredProjection`. */
export const DEFERRED_CHUNK_REPLACEMENT = 'chunk_replacement_deferred';

/**
 * The page's chunk rows as (id, index) pairs, hashed; no chunk text is read. The value is opaque: a caller compares
 * two values from one engine and never reads it.
 */
export async function readChunkRowsFingerprint(raw: EngineRawRead, pageId: number): Promise<string> {
  // chunk-visibility-ok: identity of a deferred replacement's rows (ids and indexes), never returned to a reader
  const [row] = await raw<{ f: string }>(`SELECT count(*)::text||':'||COALESCE(sum(hashtext(id::text||':'||chunk_index::text)::bigint),0)::text AS f
    FROM content_chunks WHERE page_id=$1`, [pageId]);
  return row!.f;
}

/** Deletes each chunk row of the page whose id is not in `keptIds`. */
export async function deleteUnkeptChunks(raw: EngineRawRead, pageId: number, keptIds: readonly number[]): Promise<void> {
  await raw('DELETE FROM content_chunks WHERE page_id=$1 AND NOT(id=ANY($2::int[]))', [pageId, [...keptIds]]);
}

/**
 * The ids, in chunk order, of the page's chunks that hold a vector in `column` the page no longer accepts: not
 * labelled `provenanceModel` (or its bare name at the column's width), embedded from other text, or not in `currentIds`.
 */
export async function listStaleChunkVectors(raw: EngineRawRead, pageId: number, provenanceModel: string | null, column: KeepColumn,
  currentIds: readonly number[]): Promise<number[]> {
  const col = quoteIdentifier(column.name);
  const { text, params } = renderFragment(
    // chunk-visibility-ok: the kept rows of a deferred replacement whose vector the current page no longer accepts
    sqlFragment`SELECT id FROM content_chunks WHERE page_id=${pageId} AND ${trustedSql(col)} IS NOT NULL
    AND (NOT ${keptModelFragment(col, column.dimensions, provenanceModel)} OR embedded_text_hash <> md5(chunk_text) OR NOT(id=ANY(${[...currentIds]}::int[]))) ORDER BY chunk_index`);
  const rows = await raw<{ id: number }>(text, params);
  return rows.map(row => Number(row.id));
}

/** Clears the vector in `column` and its embedding record on the page's chunks `ids`, and marks them pending. */
export async function clearChunkVectors(raw: EngineRawRead, pageId: number, column: KeepColumn, ids: readonly number[]): Promise<void> {
  const { text, params } = renderFragment(sqlFragment`UPDATE content_chunks SET ${trustedSql(quoteIdentifier(column.name))}=NULL,embedded_at=NULL,embedded_text_hash=NULL,embedding_input_hash=NULL,
        embedding_pending_since=COALESCE(embedding_pending_since,now()) WHERE page_id=${pageId} AND id=ANY(${[...ids]}::int[])`);
  await raw(text, params);
}

/** How many of the page's text chunks have no vector in `column`, and their characters: a re-seal's embedding work. */
export async function countPendingTextChunks(raw: EngineRawRead, pageId: number, column: KeepColumn): Promise<{ chunks: number; chars: number }> {
  // chunk-visibility-ok: a count of the page's unembedded text chunks after its own re-seal, never returned to a reader
  const { text, params } = renderFragment(sqlFragment`SELECT COUNT(*)::int AS chunks,
    COALESCE(SUM(length(chunk_text)),0)::int AS chars FROM content_chunks
    WHERE page_id=${pageId} AND ${trustedSql(quoteIdentifier(column.name))} IS NULL AND modality='text'`);
  const [pending] = await raw<{ chunks: number; chars: number }>(text, params);
  return { chunks: Number(pending?.chunks ?? 0), chars: Number(pending?.chars ?? 0) };
}

/** A live page's id, knowledge revision and whether its text projection is sealed at that revision. */
export interface ProjectionHead { id: number; revision: string; sealed: boolean }

/** The live page's projection head, or null when the page does not exist or is deleted. */
export async function readProjectionHead(raw: EngineRawRead, sourceId: string, slug: string): Promise<ProjectionHead | null> {
  const [head] = await raw<ProjectionHead>(`SELECT id, knowledge_revision::text AS revision,
      text_projection_revision IS NOT DISTINCT FROM knowledge_revision AS sealed FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`, [sourceId, slug]);
  return head ? { id: Number(head.id), revision: head.revision, sealed: head.sealed } : null;
}

/**
 * Whether another continuation holds the page's deferred chunk replacement at `revision`: its job carries a
 * `DEFERRED_CHUNK_CLAIM` other than `claim`, renewed within the last 60 seconds.
 */
export async function isDeferredReplacementHeld(raw: EngineRawRead, sourceId: string, slug: string, revision: string, claim: string): Promise<boolean> {
  return (await raw(`SELECT 1 FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation
      WHERE s.id=$1 AND j.slug=$2 AND j.revision=$3::uuid AND split_part(j.reason,':',1)=$4 AND j.reason<>$5
        AND j.updated_at>=now()-interval '60 seconds'`, [sourceId, slug, revision, DEFERRED_CHUNK_CLAIM, claim])).length > 0;
}

/** Gives the job still queued at `job.revision` the reason `claim` at now: the continuation's lease. */
export async function renewDeferredReplacementClaim(raw: EngineRawRead, job: ProjectionJobKey, claim: string): Promise<void> {
  await raw('UPDATE page_projection_jobs SET reason=$4,updated_at=now() WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid',
    [job.sourceIncarnation, job.slug, job.revision, claim]);
}

/**
 * Hands a continuation's claim back: every job of `slug` whose reason is still `claim` gets DEFERRED_CHUNK_REPLACEMENT
 * again, its time unchanged, so the next drain resumes it at once.
 */
export async function releaseDeferredReplacementClaim(raw: EngineRawRead, slug: string, claim: string): Promise<void> {
  await raw(`UPDATE page_projection_jobs SET reason=$1 WHERE slug=$2 AND reason=$3`, [DEFERRED_CHUNK_REPLACEMENT, slug, claim]);
}

/** Queues the live page at its knowledge revision with `reason` at now, or moves its queued row there (queuePageProjection). */
export async function queuePageProjectionJob(raw: EngineRawRead, sourceId: string, slug: string, reason: string): Promise<void> {
  await raw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
    SELECT s.incarnation,p.slug,p.knowledge_revision,$3 FROM pages p JOIN sources s ON s.id=p.source_id
    WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL
    ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason,updated_at=now()`, [sourceId, slug, reason]);
}
