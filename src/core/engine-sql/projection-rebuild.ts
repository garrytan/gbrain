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
import { joinFragments, renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { projectionRetryReadyFragment, SEGMENTED_JOB_PROBES_SQL, segmentedProjectionClaimedFragment } from './persistence-housekeeping.ts';
import { projectionClassSql, sealableImageSql } from '../page-state/projection-class.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import type { PageReadScope } from '../types.ts';
import { ACTIVATION_SERVED_REVISION, chunkGenerationFilter, chunkGenerationProbe, movableChunkSql } from '../search/safe-chunks.ts';
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
  const filters: SqlFragment[] = [];
  if (filter.retryCooldown) filters.push(projectionRetryReadyFragment());
  if (filter.notAfter !== undefined) filters.push(sqlFragment`j.updated_at<=${filter.notAfter}::text::timestamptz`);
  if (filter.reasons) filters.push(sqlFragment`j.reason=ANY(${[...filter.reasons]}::text[])`);
  if (filter.pages) filters.push(sqlFragment`j.slug=ANY(${[...filter.pages.slugs]}::text[])`);
  const after = filter.after;
  if (after) {
    filters.push(sqlFragment`(j.updated_at,j.source_incarnation,j.slug COLLATE "C")>(${after.updated_at}::text::timestamptz,${after.source_incarnation}::uuid,${after.slug} COLLATE "C")`);
  }
  const outer: SqlFragment[] = [];
  if (filter.pages) outer.push(sqlFragment`s.id=${filter.pages.sourceId}`);
  if (filter.served) {
    outer.push(sqlFragment`${trustedSql(filter.served === 'waiting' ? 'NOT ' : '')}EXISTS (SELECT 1 FROM pages q WHERE q.source_id=s.id AND q.slug=j.slug
      AND q.text_projection_revision='${trustedSql(ACTIVATION_SERVED_REVISION)}'::uuid)`);
  }
  const where = filters.length ? sqlFragment`WHERE ${joinFragments(filters, ' AND ')}` : sqlFragment``;
  const sourceFilter = outer.length ? sqlFragment`WHERE ${joinFragments(outer, ' AND ')}` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT s.id AS source_id,j.source_incarnation,j.slug,j.revision,p.page_kind,j.updated_at::text AS updated_at
    FROM (SELECT source_incarnation,slug,revision,updated_at FROM page_projection_jobs j
      ${where}
      ORDER BY updated_at,source_incarnation,slug COLLATE "C" OFFSET 0) j
    ${trustedSql(PROJECTION_JOB_PROBES)} ${sourceFilter}
    ORDER BY j.updated_at,j.source_incarnation,j.slug COLLATE "C" LIMIT ${filter.limit}`);
  return raw<QueuedPageProjection>(text, params);
}

/** The reason of the queue row `key`, or null when no such row is queued (another worker consumed it). */
export async function readProjectionJobReason(raw: EngineRawRead, key: ProjectionJobKey): Promise<string | null> {
  const rows = await raw<{ reason: string }>(`SELECT reason FROM page_projection_jobs
          WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid`, [key.sourceIncarnation, key.slug, key.revision]);
  return rows.length ? rows[0]!.reason : null;
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

/** A chunk's id and its recorded embedding input hash. */
export interface ChunkInputHash { id: number; embedding_input_hash: string | null }

/** Every stored chunk of the page with its recorded embedding input hash (page-state/contextual-proof.ts). */
export async function readChunkInputHashes(raw: EngineRawRead, pageId: number): Promise<ChunkInputHash[]> {
  // chunk-visibility-ok: the contextual-mode proof compares every stored chunk row of the page, as before
  return raw<ChunkInputHash>('SELECT id,embedding_input_hash FROM content_chunks WHERE page_id=$1', [pageId]);
}

/** Clears the vector in `column` and its embedding record on the named chunks of the page and marks them pending now. */
export async function clearChunkEmbeddingsByIds(raw: EngineRawRead, pageId: number, column: KeepColumn, ids: readonly number[]): Promise<void> {
  const { text, params } = renderFragment(sqlFragment`UPDATE content_chunks SET ${trustedSql(quoteIdentifier(column.name))}=NULL,
    embedded_at=NULL,embedded_text_hash=NULL,embedding_input_hash=NULL,embedding_pending_since=now() WHERE page_id=${pageId} AND id=ANY(${[...ids]}::int[])`);
  await raw(text, params);
}

/** Records `hashes[i]` as the embedding input hash of the page's chunk `ids[i]`. */
export async function writeChunkInputHashes(raw: EngineRawRead, pageId: number, ids: readonly number[], hashes: readonly string[]): Promise<void> {
  await raw(`UPDATE content_chunks c SET embedding_input_hash=proof.hash
    FROM unnest($2::int[],$3::text[]) AS proof(id,hash) WHERE c.page_id=$1 AND c.id=proof.id`, [pageId, [...ids], [...hashes]]);
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

/** Whether a queue row of a live inline page (with `media`, or a sealable image) is queued and not marked failed. */
export async function hasDrainableProjectionJob(raw: EngineRawRead, opts: { media?: boolean } = {}): Promise<boolean> {
  return (await raw(`SELECT 1 FROM page_projection_jobs j
      ${projectionJobProbes({ media: opts.media })}
      WHERE j.reason<>'rebuild_failed' LIMIT 1`)).length > 0;
}

/** The queue's class counts (projectionClassSql) as the backlog statement reads them. */
export type ProjectionBacklogRow = Record<'pending' | 'failed' | 'sealable' | 'sealable_with_visual' | 'reimport' | 'ocr_required' | 'protected' | 'archived', number>
  & { oldest: number | null; as_of: string };

/** One row of the drain preview. */
export interface ProjectionDrainPreviewRow { source_id: string; slug: string; page_kind: string; reason: string; updated_at: string }

/** The rows a media drain takes, images last, then pages answered from their pre-upgrade index, oldest first, at most `limit`. */
export async function listProjectionDrainPreview(raw: EngineRawRead, limit: number): Promise<ProjectionDrainPreviewRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT s.id AS source_id,j.slug,p.page_kind,j.reason,j.updated_at::text AS updated_at
    FROM page_projection_jobs j ${trustedSql(projectionJobProbes({ media: true }))}
    ORDER BY CASE WHEN p.page_kind NOT IN ('markdown','code') THEN 1
      WHEN EXISTS (SELECT 1 FROM pages q WHERE q.source_id=s.id AND q.slug=j.slug AND q.text_projection_revision='${trustedSql(ACTIVATION_SERVED_REVISION)}'::uuid) THEN 2
      ELSE 0 END,j.updated_at,j.source_incarnation,j.slug COLLATE "C" LIMIT ${limit}`);
  return raw<ProjectionDrainPreviewRow>(text, params);
}

/**
 * Whether a queue row of any reason names a live inline page of an active source (with `media`, or a sealable image)
 * or a live segmented page of one: the work a limited drain left.
 */
export async function hasQueuedProjectionWork(raw: EngineRawRead, opts: { media?: boolean } = {}): Promise<boolean> {
  return (await raw(`SELECT 1 FROM page_projection_jobs j ${projectionJobProbes({ media: opts.media })}
      UNION ALL SELECT 1 FROM page_projection_jobs j ${SEGMENTED_JOB_PROBES_SQL} LIMIT 1`)).length > 0;
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

/** One queue row the resident's window selection probes. */
export interface ProjectionWindowCandidate { source_incarnation: string; slug: string }

/** A candidate's source (`source_id`, `archived`) and live page (`page_kind`, `body_storage`); each part null when missing. */
export interface ProjectionWindowProbe {
  i: number; source_id: string | null; archived: boolean | null; page_kind: string | null; body_storage: string | null;
}

/**
 * The resident's window probe (projections.ts selectWindowJobs): for each candidate, at its index `i`, the source of
 * its incarnation and that source's live page at its slug, each looked up by key. Rows come in no set order.
 */
export async function probeProjectionWindowCandidates(raw: EngineRawRead, candidates: readonly ProjectionWindowCandidate[]): Promise<ProjectionWindowProbe[]> {
  return raw<ProjectionWindowProbe>(
    `SELECT k.i,s.id AS source_id,s.archived,p.page_kind,p.body_storage
      FROM jsonb_to_recordset($1::text::jsonb) AS k(i int, source_incarnation uuid, slug text)
      LEFT JOIN LATERAL (SELECT s.id,s.archived FROM sources s WHERE s.incarnation=k.source_incarnation OFFSET 0) s ON true
      LEFT JOIN LATERAL (SELECT p.page_kind,p.body_storage FROM (SELECT p.id FROM pages p WHERE p.source_id=s.id AND p.slug=k.slug OFFSET 0) q
        JOIN pages p ON p.id=q.id WHERE p.deleted_at IS NULL) p ON true`,
    [JSON.stringify(candidates.map((row, i) => ({ i, source_incarnation: row.source_incarnation, slug: row.slug })))]);
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

/** The planner's estimate of the pages table's rows (0 before statistics); the drain's statistics debt is sized by it. */
export async function readPagesRowEstimate(raw: EngineRawRead): Promise<number> {
  const [pages] = await raw<{ rows: number }>("SELECT GREATEST(reltuples,0)::float8 AS rows FROM pg_class WHERE oid='pages'::regclass");
  return Number(pages?.rows ?? 0);
}

/** The drain's run start: the database clock as `now()::text`. */
export async function readDrainRunStart(raw: EngineRawRead): Promise<string> {
  const [{ runStart }] = await raw<{ runStart: string }>('SELECT now()::text AS "runStart"');
  return runStart;
}

/** Whether the database clock is past `runStart` (a coarse clock repeats a time, so the drain waits for this). */
export async function isDrainClockPast(raw: EngineRawRead, runStart: string): Promise<boolean> {
  return (await raw<{ passed: boolean }>('SELECT now()>$1::text::timestamptz AS passed', [runStart]))[0]?.passed === true;
}

/** Queues the live page at its knowledge revision with `reason` at now, or moves its queued row there (queuePageProjection). */
export async function queuePageProjectionJob(raw: EngineRawRead, sourceId: string, slug: string, reason: string): Promise<void> {
  await raw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
    SELECT s.incarnation,p.slug,p.knowledge_revision,$3 FROM pages p JOIN sources s ON s.id=p.source_id
    WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL
    ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason,updated_at=now()`, [sourceId, slug, reason]);
}

/** Whether the page is a live segmented page. */
export async function hasSegmentedPage(raw: EngineRawRead, sourceId: string, slug: string): Promise<boolean> {
  return (await raw(`SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND body_storage='segmented' AND deleted_at IS NULL`,
    [sourceId, slug])).length > 0;
}

/** Moves the job still queued at `job.revision` to `revision` at now. */
export async function rekeyProjectionJob(raw: EngineRawRead, job: ProjectionJobKey, revision: string): Promise<void> {
  await raw(`UPDATE page_projection_jobs SET revision=$4::uuid,updated_at=now()
          WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid`, [job.sourceIncarnation, job.slug, job.revision, revision]);
}

/**
 * Moves the time of the job still queued at `job.revision` to now; with `requeue`, its reason becomes
 * `canonical_change` too, so the ordinary rebuild takes it.
 */
export async function stampDeferredProjectionJob(raw: EngineRawRead, job: ProjectionJobKey, requeue: boolean): Promise<void> {
  const { text, params } = renderFragment(sqlFragment`UPDATE page_projection_jobs SET updated_at=now()${trustedSql(requeue ? ",reason='canonical_change'" : '')}
            WHERE source_incarnation=${job.sourceIncarnation}::uuid AND slug=${job.slug} AND revision=${job.revision}::uuid`);
  await raw(text, params);
}

/** Moves the time of the job still queued at `job.revision` to now unless a live segmented claim holds it. */
export async function touchUnclaimedProjectionJob(raw: EngineRawRead, job: ProjectionJobKey): Promise<void> {
  const { text, params } = renderFragment(sqlFragment`UPDATE page_projection_jobs j SET updated_at=now() WHERE j.source_incarnation=${job.sourceIncarnation}::uuid AND j.slug=${job.slug} AND j.revision=${job.revision}::uuid
            AND NOT ${segmentedProjectionClaimedFragment()}`);
  await raw(text, params);
}

/** Moves the time of the job still queued at `job.revision` to now; false when no such job is queued. */
export async function deferProjectionJob(raw: EngineRawRead, job: ProjectionJobKey): Promise<boolean> {
  return (await raw(`UPDATE page_projection_jobs SET updated_at=now()
        WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid RETURNING slug`, [job.sourceIncarnation, job.slug, job.revision])).length > 0;
}

/** One queue row of the image seal's window (`sealImageProjections`): `sealable` when its live page is a sealable image at the row's revision. */
export interface ImageSealCandidate { source_id: string | null; source_incarnation: string; slug: string; revision: string; sealable: boolean }

/**
 * A primary-key window of queue rows after `after` (incarnation, slug in the C collation), at most `limit`, last
 * queued at or before `notAfter` when given, each probed by its page's unique key only (sealImageProjections).
 */
export async function listImageSealWindow(raw: EngineRawRead, after: { sourceIncarnation: string; slug: string }, limit: number,
  notAfter?: string): Promise<ImageSealCandidate[]> {
  const before = notAfter === undefined ? sqlFragment`` : sqlFragment`AND j.updated_at<=${notAfter}::text::timestamptz`;
  const { text, params } = renderFragment(sqlFragment`SELECT s.id AS source_id,j.source_incarnation::text AS source_incarnation,
        j.slug,j.revision::text AS revision,p.sealable IS TRUE AS sealable
      FROM (SELECT source_incarnation,slug,revision FROM page_projection_jobs j WHERE (j.source_incarnation,j.slug COLLATE "C") > (${after.sourceIncarnation}::uuid,${after.slug} COLLATE "C") ${before}
        ORDER BY j.source_incarnation,j.slug COLLATE "C" LIMIT ${limit}) j
      LEFT JOIN LATERAL (SELECT s.id FROM sources s WHERE s.incarnation=j.source_incarnation AND NOT s.archived OFFSET 0) s ON true
      LEFT JOIN LATERAL (SELECT p.deleted_at IS NULL AND p.knowledge_revision=j.revision AND ${trustedSql(sealableImageSql('p'))} AS sealable
        FROM pages p WHERE p.source_id=s.id AND p.slug=j.slug OFFSET 0) p ON true
      ORDER BY j.source_incarnation,j.slug COLLATE "C"`);
  return raw<ImageSealCandidate>(text, params);
}

/** A sealable image page of a seal group, as the seal re-reads it under the page guard. */
export interface ImageSealPage { id: number; revision: string; title: string; mode: string | null; corpus_generation: string | null }

/** The pages of `rows` still live at their queued revision and still sealable images of an active source, in no set order. */
export async function readImageSealPages(raw: EngineRawRead, rows: ReadonlyArray<{ source_id: string; slug: string; revision: string }>): Promise<ImageSealPage[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.id,p.knowledge_revision::text AS revision,p.title,
          p.contextual_retrieval_mode AS mode,p.corpus_generation
        FROM jsonb_to_recordset(${JSON.stringify(rows.map(({ source_id, slug, revision }) => ({ source_id, slug, revision })))}::text::jsonb) AS v(source_id text, slug text, revision uuid)
        JOIN sources s ON s.id=v.source_id AND NOT s.archived
        CROSS JOIN LATERAL (SELECT p.id FROM pages p WHERE p.source_id=v.source_id AND p.slug=v.slug OFFSET 0) k
        JOIN pages p ON p.id=k.id
        WHERE p.deleted_at IS NULL AND p.knowledge_revision=v.revision AND ${trustedSql(sealableImageSql('p'))}`);
  return raw<ImageSealPage>(text, params);
}

/** A live chunk of a seal group's pages that holds a vector in the write column. */
export interface ImageSealChunk { id: number; page_id: number; chunk_text: string; chunk_source: string; embedding_input_hash: string | null; current: boolean }

/**
 * The live chunks of `pageIds` holding a vector in `column`, each with whether that vector is its text's and of
 * `provenanceModel` (`current`).
 */
export async function listImageSealChunks(raw: EngineRawRead, pageIds: readonly number[], column: KeepColumn, provenanceModel: string | null): Promise<ImageSealChunk[]> {
  const col = quoteIdentifier(column.name);
  const { text, params } = renderFragment(sqlFragment`SELECT id,page_id,chunk_text,chunk_source,embedding_input_hash,
          ${trustedSql(movableChunkSql(col))} AND model IS NOT DISTINCT FROM ${provenanceModel} AS current
        FROM content_chunks c WHERE c.page_id=ANY(${[...pageIds]}::int[]) AND c.${trustedSql(col)} IS NOT NULL AND ${trustedSql(chunkGenerationProbe('c'))}`);
  return raw<ImageSealChunk>(text, params);
}

/** Clears and marks pending the vector in `column` of the chunks `chunks` (by id; the page id is for engines keyed by page). */
export async function clearImageSealVectors(raw: EngineRawRead, column: KeepColumn, chunks: ReadonlyArray<{ id: number; page_id: number }>): Promise<void> {
  const col = quoteIdentifier(column.name);
  const { text, params } = renderFragment(sqlFragment`UPDATE content_chunks SET ${trustedSql(col)}=NULL,embedded_at=NULL,embedded_text_hash=NULL,embedding_input_hash=NULL,
          embedding_pending_since=COALESCE(embedding_pending_since,now()) WHERE id=ANY(${chunks.map(chunk => chunk.id)}::int[])`);
  await raw(text, params);
}

/** Seals each page of `pages` still at its revision; one row per sealed page, with whether a live chunk holds a visual vector. */
export async function sealImagePages(raw: EngineRawRead, pages: ReadonlyArray<{ id: number; revision: string }>): Promise<Array<{ has_visual: boolean }>> {
  const { text, params } = renderFragment(sqlFragment`UPDATE pages SET text_projection_revision=pages.knowledge_revision
          FROM jsonb_to_recordset(${JSON.stringify(pages)}::text::jsonb) AS v(id int, revision uuid)
          WHERE pages.id=v.id AND pages.knowledge_revision=v.revision
          RETURNING EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=pages.id AND c.embedding_image IS NOT NULL
            AND ${trustedSql(chunkGenerationFilter('pages', 'c'))}) AS has_visual`);
  return raw<{ has_visual: boolean }>(text, params);
}
