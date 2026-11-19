/**
 * The statements a projection rebuild sends (page-state/projections.ts rebuildPendingPageProjections,
 * installPageProjection, planProjectionKeep and the statistics' drained probe). Each function runs the statement its
 * caller ran through `executeRaw`, with the same text and parameters, on the engine's own `executeRaw`; only its home
 * moved. `test/projection-rebuild-sql-pin.test.ts` pins each text and its binds against the ones recorded before the
 * move. The rebuild's other queue statements (the segmented probe, the re-key, the deferred and failure stamps) stay
 * raw in projections.ts.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { PROJECTION_RETRY_READY_TEXT } from './persistence-housekeeping.ts';
import { sealableImageSql } from '../page-state/projection-class.ts';
import { ACTIVATION_SERVED_REVISION, movableChunkSql } from '../search/safe-chunks.ts';
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
const PROJECTION_JOB_PROBES = projectionJobProbes();

/** A queue row's position in the walk order (updated_at as text, so microseconds survive). */
export interface QueuedProjectionKey { updated_at: string; source_incarnation: string; slug: string }

/** Which queue rows `listQueuedPageProjections` returns. */
export interface QueuedProjectionFilter {
  /** At most this many rows; the caller clamps it to 1..100. */
  limit: number;
  /** Skip rows in their retry cooldown or held by another process (`PROJECTION_RETRY_READY_SQL`). */
  retryCooldown?: boolean;
  /** Only rows last queued or failed at or before this instant (timestamptz text). */
  notAfter?: string;
  /** Only rows whose reason is one of these. */
  reasons?: readonly string[];
  /** Only these pages of one source. */
  pages?: { sourceId: string; slugs: readonly string[] };
  /** Only rows after this key in the walk order. */
  after?: QueuedProjectionKey;
  /** Only pages search does not answer for yet ('waiting'), or only those it answers for from their pre-upgrade index. */
  served?: 'waiting' | 'answering';
}

export interface QueuedPageProjection {
  source_id: string; source_incarnation: string; slug: string; revision: string; page_kind: string; updated_at?: string;
}

/** A queue row's exact key: the row a rebuild listed. */
export interface ProjectionJobKey { sourceIncarnation: string; slug: string; revision: string }

/**
 * The queue rows of live inline pages of active sources, filtered, in walk order (`updated_at`, incarnation, slug in
 * the C collation), at most `limit`.
 */
export async function listQueuedPageProjections(raw: EngineRawRead, filter: QueuedProjectionFilter): Promise<QueuedPageProjection[]> {
  const params: unknown[] = [filter.limit];
  const filters: string[] = [];
  if (filter.retryCooldown) filters.push(PROJECTION_RETRY_READY_TEXT);
  if (filter.notAfter !== undefined) { params.push(filter.notAfter); filters.push(`j.updated_at<=$${params.length}::text::timestamptz`); }
  if (filter.reasons) { params.push(filter.reasons); filters.push(`j.reason=ANY($${params.length}::text[])`); }
  if (filter.pages) { params.push(filter.pages.slugs); filters.push(`j.slug=ANY($${params.length}::text[])`); }
  const after = filter.after;
  if (after) {
    params.push(after.updated_at, after.source_incarnation, after.slug);
    filters.push(`(j.updated_at,j.source_incarnation,j.slug COLLATE "C")>($${params.length - 2}::text::timestamptz,$${params.length - 1}::uuid,$${params.length} COLLATE "C")`);
  }
  const outer: string[] = [];
  if (filter.pages) outer.push(`s.id=$${params.push(filter.pages.sourceId)}`);
  if (filter.served) {
    outer.push(`${filter.served === 'waiting' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM pages q WHERE q.source_id=s.id AND q.slug=j.slug
      AND q.text_projection_revision='${ACTIVATION_SERVED_REVISION}'::uuid)`);
  }
  const sourceFilter = outer.length ? `WHERE ${outer.join(' AND ')}` : '';
  return raw<QueuedPageProjection>(`SELECT s.id AS source_id,j.source_incarnation,j.slug,j.revision,p.page_kind,j.updated_at::text AS updated_at
    FROM (SELECT source_incarnation,slug,revision,updated_at FROM page_projection_jobs j
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY updated_at,source_incarnation,slug COLLATE "C" OFFSET 0) j
    ${PROJECTION_JOB_PROBES} ${sourceFilter}
    ORDER BY j.updated_at,j.source_incarnation,j.slug COLLATE "C" LIMIT $1`, params);
}

/** The reason of the queue row `key`, or null when no such row is queued (another worker consumed it). */
export async function readProjectionJobReason(raw: EngineRawRead, key: ProjectionJobKey): Promise<string | null> {
  const rows = await raw<{ reason: string }>(`SELECT reason FROM page_projection_jobs
          WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid`, [key.sourceIncarnation, key.slug, key.revision]);
  return rows.length ? rows[0]!.reason : null;
}

/** Deletes the queue row `key` (a row of another revision stays). */
export async function deleteProjectionJob(raw: EngineRawRead, key: ProjectionJobKey): Promise<void> {
  await raw('DELETE FROM page_projection_jobs WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid', [key.sourceIncarnation, key.slug, key.revision]);
}

/** The vector column a keep plan compares against. */
export interface KeepColumn { name: string; dimensions: number }

export interface ChunkKeepState { id: number; embedding_input_hash: string | null; movable: boolean }

/**
 * Each chunk of the page with its recorded embedding input and whether its vector in `column` is current: present,
 * embedded from the chunk's text as it is now, and labelled `provenanceModel` (or its bare name at the column's width).
 */
export async function readChunkKeepState(raw: EngineRawRead, pageId: number, provenanceModel: string | null, column: KeepColumn): Promise<ChunkKeepState[]> {
  const col = quoteIdentifier(column.name);
  return raw<ChunkKeepState>(
    `SELECT id,embedding_input_hash,${movableChunkSql(col)} AND ${chunkModelMatchesSql('model', '$2', `vector_dims(${col}) = ${column.dimensions}`)} AS movable FROM content_chunks WHERE page_id=$1`,
    [pageId, provenanceModel]);
}

/**
 * Clears the vector in `column` and its embedding record on each chunk of the page that is not labelled
 * `provenanceModel` (or its bare name at the column's width), whose recorded text hash is not its text's, or whose id
 * is not in `currentIds`, and marks it pending.
 */
export async function clearUnkeptChunkVectors(raw: EngineRawRead, pageId: number, provenanceModel: string | null, column: KeepColumn, currentIds: readonly number[]): Promise<void> {
  const col = quoteIdentifier(column.name);
  await raw(`UPDATE content_chunks SET ${col}=NULL,
        embedded_at=NULL,embedded_text_hash=NULL,embedding_input_hash=NULL,
        embedding_pending_since=COALESCE(embedding_pending_since,now()) WHERE page_id=$1 AND
        (NOT ${chunkModelMatchesSql('model', '$2', `vector_dims(${col}) = ${column.dimensions}`)} OR embedded_text_hash <> md5(chunk_text) OR NOT(id=ANY($3::int[])))`,
  [pageId, provenanceModel, currentIds]);
}

/** Stamps the chunker version a sealed projection was built with on the page. */
export async function setProjectionChunkerVersion(raw: EngineRawRead, sourceId: string, slug: string, version: number): Promise<void> {
  await raw(`UPDATE pages SET chunker_version=$3
        WHERE source_id=$1 AND slug=$2`, [sourceId, slug, version]);
}

/** Whether a queue row of a live inline page (with `media`, or a sealable image) is queued and not marked failed. */
export async function hasDrainableProjectionJob(raw: EngineRawRead, opts: { media?: boolean } = {}): Promise<boolean> {
  return (await raw(`SELECT 1 FROM page_projection_jobs j
      ${projectionJobProbes({ media: opts.media })}
      WHERE j.reason<>'rebuild_failed' LIMIT 1`)).length > 0;
}
