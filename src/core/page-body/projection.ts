/**
 * Segmented page projection (Wave B, lane 1d): chunk every live manifest
 * occurrence that has no chunk rows at the page's live body generation, stage
 * them, retire rows of occurrences no longer live, and seal the text
 * projection when the page is still at `expectedRevision` (or its current
 * revision). Reads one segment batch at a time. Used after a segmented create
 * (whose chunks cannot be staged before the page row exists), by the
 * projection job for a page left unsealed (crash, deferred retirement), and by
 * rebuilds.
 *
 * One process builds a page's projection at a time: it claims the page's
 * queue row (`SEGMENTED_PROJECTION_CLAIM`, renewed with each chunk batch), so
 * a write's post-commit build and the resident's queue route do not both
 * chunk the whole body; a claim left by a dead process lapses after
 * SEGMENTED_PROJECTION_LEASE_SECONDS, and a build that throws releases it
 * at once (the resident's queue route then marks its own failures
 * `rebuild_failed`). The claim is this build's while the row's reason is
 * the token it wrote (`SEGMENTED_PROJECTION_CLAIM:<uuid>`, one per
 * acquisition, never the lease timestamp two claims can share): each renewal,
 * the seal and the release match that token, so a build that outlived its
 * claim and lost it to another process stops at its next batch (`claimLost`)
 * without staging, sealing or releasing over the new owner's claim. Within a process, calls for one page
 * also run one after another, and a page an earlier call sealed returns at
 * once (#6143).
 *
 * Retirement runs in bounded statements and deletes, as the flip does: rows of
 * occurrences outside the live generation, inline rows a promotion deferred,
 * and older duplicates of a live occurrence (a projection that raced a flip).
 * GC would delete a marked row at once, and a delete leaves the HNSW index
 * alone where marking rewrote each row's entry.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { isQuarantined } from '../quarantine.ts';
import { faultPoint } from '../persistence/fault-points.ts';
import { sealSegmentedPage } from '../persistence/segmented-apply.ts';
import { PROJECTION_RETRY_READY_SQL, SEGMENTED_JOB_PROBES, SEGMENTED_PROJECTION_CLAIM, SEGMENTED_PROJECTION_CLAIMED_SQL, SEGMENTED_PROJECTION_LEASE_SECONDS,
  type ProjectionRebuildFailure } from '../page-state/projections.ts';
import { occurrencesWithoutChunks, stageOccurrenceChunks } from './ingest.ts';
import { DEFAULT_FLIP_RETIRE_MAX_ROWS } from './limits.ts';
import type { JsonObject } from './types.ts';
import { assertGenerationTiles } from './body-tiling.ts';

/** `claimLost`: another process took the page's claim over (or a write re-queued the page) during the build, which stopped unsealed. */
export interface SegmentedProjectionResult { chunks: number; retired: number; sealed: boolean; claimLost?: true }

interface ProjectionPage {
  id: number; body_generation: number | string; knowledge_revision: string; text_projection_revision: string | null;
  title: string; frontmatter: JsonObject | null; body_flags: JsonObject | null; timeline_lead: string | null;
}

async function readProjectionPage(engine: Pick<BrainEngine, 'executeRaw'>, ref: { sourceId: string; slug: string }): Promise<ProjectionPage | null> {
  const [page] = await engine.executeRaw<ProjectionPage>(`SELECT id, body_generation, knowledge_revision::text AS knowledge_revision,
      text_projection_revision::text AS text_projection_revision, title, frontmatter, body_flags, timeline_lead
    FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL AND body_storage='segmented'`, [ref.sourceId, ref.slug]);
  return page ?? null;
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

/** The occurrence ids of page $1's manifest at generation $2. */
export async function liveOccurrenceIds(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number, generation: number): Promise<number[]> {
  return (await engine.executeRaw<{ occurrence_id: number | string }>(`SELECT occurrence_id FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL
    AND gen_from <= $2 AND (gen_to IS NULL OR gen_to > $2)`, [pageId, generation])).map(row => Number(row.occurrence_id));
}

/** The page still stores a chunk row its live generation does not hold (a deferred retirement): sealing it would show the row. */
export async function hasStaleChunks(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number, generation: number, live: readonly number[]): Promise<boolean> {
  return (await engine.executeRaw(`${STALE_CHUNKS_SQL} LIMIT 1`, [pageId, generation, live])).length > 0;
}

/**
 * Delete, in bounded batches, chunk rows the live generation does not hold: other occurrences, inline rows, older
 * duplicates. Each batch re-reads the page under its page lock and deletes only while the page is still segmented at
 * `generation` (a demotion's inline rows are the page's live chunks); `moved` when it was not.
 */
async function retireStaleChunks(engine: BrainEngine, ref: { sourceId: string; slug: string }, pageId: number, generation: number,
  live: readonly number[]): Promise<{ retired: number; moved: boolean }> {
  let retired = 0;
  for (;;) {
    const deleted = await engine.transaction(async tx => {
      await tx.lockPageKeys([ref]);
      const [page] = await tx.executeRaw<{ body_generation: number | string; body_storage: string }>('SELECT body_generation, body_storage FROM pages WHERE id=$1', [pageId]);
      if (page?.body_storage !== 'segmented' || Number(page.body_generation) !== generation) return null;
      return (await tx.executeRaw<{ id: number }>(`DELETE FROM content_chunks c WHERE c.id=ANY(ARRAY(${STALE_CHUNKS_SQL} LIMIT $4)) RETURNING c.id`,
        [pageId, generation, live, DEFAULT_FLIP_RETIRE_MAX_ROWS])).length;
    });
    if (deleted === null) return { retired, moved: true };
    retired += deleted;
    if (deleted < DEFAULT_FLIP_RETIRE_MAX_ROWS) return { retired, moved: false };
    if (engine.kind === 'pglite') await new Promise(resolve => setImmediate(resolve));
  }
}

const JOB_OF_PAGE = 'source_incarnation=(SELECT incarnation FROM sources WHERE id=$1) AND slug=$2';

/** This build's claim: the queue reason it wrote, `SEGMENTED_PROJECTION_CLAIM:<uuid>`, unique to this acquisition. Null for a page built unclaimed. */
type ProjectionClaim = string | null;

/** The page's queue row while it carries this build's claim ($3). */
const CLAIMED_BY_BUILD = `${JOB_OF_PAGE} AND reason=$3`;

/** Claim the page's queue row; false when another process holds it. A page with no queued row is built unclaimed (null). */
async function claimProjection(engine: Pick<BrainEngine, 'executeRaw'>, ref: { sourceId: string; slug: string }): Promise<ProjectionClaim | false> {
  const claim = `${SEGMENTED_PROJECTION_CLAIM}:${randomUUID()}`;
  const [job] = await engine.executeRaw<{ claimed: boolean }>(`WITH claimed AS (UPDATE page_projection_jobs SET reason=$3, updated_at=clock_timestamp()
      WHERE ${JOB_OF_PAGE} AND NOT (split_part(reason,':',1)='${SEGMENTED_PROJECTION_CLAIM}' AND updated_at>=now()-interval '${SEGMENTED_PROJECTION_LEASE_SECONDS} seconds') RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM claimed) AS claimed WHERE EXISTS (SELECT 1 FROM claimed) OR EXISTS (SELECT 1 FROM page_projection_jobs WHERE ${JOB_OF_PAGE})`,
  [ref.sourceId, ref.slug, claim]);
  if (!job) return null;
  return job.claimed ? claim : false;
}

/**
 * Renew this build's claim in `tx` (`clock_timestamp()`: a transaction that waited never renews with its start time),
 * holding the row until `tx` ends so no other process claims it meanwhile; false when the row no longer carries this
 * claim (another process took it over, or a write re-queued the page), changing nothing.
 */
async function renewClaim(tx: Pick<BrainEngine, 'executeRaw'>, ref: { sourceId: string; slug: string }, claim: ProjectionClaim): Promise<boolean> {
  if (!claim) return true;
  return (await tx.executeRaw(`UPDATE page_projection_jobs SET updated_at=clock_timestamp() WHERE ${CLAIMED_BY_BUILD} RETURNING 1`, [ref.sourceId, ref.slug, claim])).length > 0;
}

/** The projections of each engine's pages running in this process, by source and slug: the newest call of each page. */
const projecting = new WeakMap<BrainEngine, Map<string, Promise<unknown>>>();

/**
 * #6143: one projection of a page at a time in this process. A segmented
 * create's publication projects the page after commit while the resident
 * drain picks up the job its unsealed commit queued; run side by side, both
 * chunk the whole body and pin a pooled connection each, one waiting on the
 * other's page guard, for every batch. A call for a page another call is
 * projecting waits for it, and a page that call sealed has nothing left to project.
 */
export async function buildSegmentedProjection(engine: BrainEngine, ref: { sourceId: string; slug: string },
  opts: { expectedRevision?: string } = {}): Promise<SegmentedProjectionResult> {
  let pages = projecting.get(engine);
  if (!pages) projecting.set(engine, pages = new Map());
  const key = JSON.stringify([ref.sourceId, ref.slug]);
  const run = (pages.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => projectSegmentedPage(engine, ref, opts));
  pages.set(key, run);
  try { return await run; }
  finally { if (pages.get(key) === run) pages.delete(key); }
}

async function projectSegmentedPage(engine: BrainEngine, ref: { sourceId: string; slug: string },
  opts: { expectedRevision?: string }): Promise<SegmentedProjectionResult> {
  const page = await readProjectionPage(engine, ref);
  if (!page || (opts.expectedRevision !== undefined && page.knowledge_revision !== opts.expectedRevision)) return { chunks: 0, retired: 0, sealed: false };
  // A sealed page holding a retired occurrence's row (sealed by an older binary over a deferred retirement) is built again to retire it.
  if (page.text_projection_revision === page.knowledge_revision
    && !await hasStaleChunks(engine, Number(page.id), Number(page.body_generation), await liveOccurrenceIds(engine, Number(page.id), Number(page.body_generation)))) {
    return { chunks: 0, retired: 0, sealed: true };
  }
  const claim = await claimProjection(engine, ref);
  if (claim === false) return { chunks: 0, retired: 0, sealed: false };
  try {
    return await buildClaimedProjection(engine, ref, page, claim);
  } catch (error) {
    if (claim) await engine.executeRaw(`UPDATE page_projection_jobs SET reason='canonical_change', updated_at=clock_timestamp() WHERE ${CLAIMED_BY_BUILD}`,
      [ref.sourceId, ref.slug, claim]).catch(() => undefined);
    throw error;
  }
}

async function buildClaimedProjection(engine: BrainEngine, ref: { sourceId: string; slug: string }, page: ProjectionPage,
  claim: ProjectionClaim): Promise<SegmentedProjectionResult> {
  const generation = Number(page.body_generation);
  const pageId = Number(page.id);
  const liveRows = await engine.readManifest(pageId);
  await assertGenerationTiles(engine, pageId, generation, liveRows);
  const { retired, moved } = await retireStaleChunks(engine, ref, pageId, generation, liveRows.map(row => Number(row.occurrenceId)));
  if (moved) return { chunks: 0, retired, sealed: false };
  const frontmatter = page.frontmatter ?? {};
  const quarantined = isQuarantined(frontmatter);
  const unchunked = await occurrencesWithoutChunks(engine, pageId, generation, liveRows);
  let claimLost = false;
  const staged = await stageOccurrenceChunks(engine, { pageId, sourceId: ref.sourceId, slug: ref.slug, generation, occurrences: unchunked, title: page.title,
    frontmatter, flags: page.body_flags ?? {}, chunking: { quarantined, corpusGeneration: null, tier: 'none' }, retiredOccurrences: [], guarded: true,
    renew: async tx => { claimLost = !await renewClaim(tx, ref, claim); return !claimLost; } });
  if (claimLost) return { chunks: staged.rows, retired, sealed: false, claimLost: true };
  await faultPoint('segmented:projection_staged', { sourceId: ref.sourceId, slug: ref.slug });
  const sealed = await engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId: ref.sourceId, slug: ref.slug }]);
    const current = await readProjectionPage(tx, ref);
    if (!current || current.knowledge_revision !== page.knowledge_revision || Number(current.body_generation) !== generation) return false;
    if (current.text_projection_revision === current.knowledge_revision) return true;
    if (!await renewClaim(tx, ref, claim)) { claimLost = true; return false; }
    await sealSegmentedPage(tx, pageId, current.timeline_lead ?? '');
    return true;
  });
  return claimLost ? { chunks: staged.rows, retired, sealed: false, claimLost: true } : { chunks: staged.rows, retired, sealed };
}

/**
 * The projection queue's segmented route: the queued rows of live segmented
 * pages (failed rows after their retry window, unless `retryCooldown` is
 * false; never a row another process's live claim holds), rebuilt by
 * `buildSegmentedProjection` at the queued revision. A failure marks the row
 * `rebuild_failed` like the inline route; a page whose revision moved is
 * left to the row the trigger queued for its new revision. `listed` names
 * every row this call took (`<source_incarnation>/<slug>`), for a caller that
 * tries each row once (`exclude`: `gbrain projections drain`).
 */
export async function rebuildPendingSegmentedProjections(engine: BrainEngine, limit: number,
  opts: { deadlineMs?: number; now?: () => number; notAfter?: string; reasons?: readonly string[]; retryCooldown?: boolean; exclude?: readonly string[];
    onFailure?: (failure: ProjectionRebuildFailure) => void } = {}): Promise<{ rebuilt: number; failed: number; listed: string[] }> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const params: unknown[] = [Math.max(1, limit)];
  const filters = [opts.retryCooldown === false ? `NOT ${SEGMENTED_PROJECTION_CLAIMED_SQL}` : PROJECTION_RETRY_READY_SQL];
  if (opts.notAfter !== undefined) filters.push(`j.updated_at<=$${params.push(opts.notAfter)}::text::timestamptz`);
  if (opts.reasons) filters.push(`j.reason=ANY($${params.push(opts.reasons)}::text[])`);
  if (opts.exclude?.length) filters.push(`NOT (j.source_incarnation::text || '/' || j.slug)=ANY($${params.push(opts.exclude)}::text[])`);
  const jobs = await engine.executeRaw<{ source_id: string; source_incarnation: string; slug: string; revision: string }>(`SELECT s.id AS source_id,
      j.source_incarnation::text AS source_incarnation, j.slug, j.revision::text AS revision
    FROM page_projection_jobs j ${SEGMENTED_JOB_PROBES}
    WHERE ${filters.join(' AND ')} ORDER BY j.updated_at, j.slug LIMIT $1`, params);
  let rebuilt = 0, failed = 0;
  const listed: string[] = [];
  for (const [index, job] of jobs.entries()) {
    if (opts.deadlineMs !== undefined && index > 0 && now() - startedAt >= opts.deadlineMs) break;
    listed.push(`${job.source_incarnation}/${job.slug}`);
    try {
      if (!(await buildSegmentedProjection(engine, { sourceId: job.source_id, slug: job.slug }, { expectedRevision: job.revision })).sealed) continue;
      rebuilt++;
      await engine.executeRaw('DELETE FROM page_projection_jobs WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid', [job.source_incarnation, job.slug, job.revision]);
    } catch (error) {
      failed++;
      await engine.executeRaw(`UPDATE page_projection_jobs j SET reason='rebuild_failed', updated_at=now()
        WHERE j.source_incarnation=$1::uuid AND j.slug=$2 AND j.revision=$3::uuid AND NOT ${SEGMENTED_PROJECTION_CLAIMED_SQL}`, [job.source_incarnation, job.slug, job.revision]);
      opts.onFailure?.({ source_id: job.source_id, slug: job.slug, reason: (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 300) });
    }
  }
  return { rebuilt, failed, listed };
}
