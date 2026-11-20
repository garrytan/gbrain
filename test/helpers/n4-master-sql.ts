/**
 * Master's text for the reads N4 moved behind BrainEngine members, run through `executeRaw` exactly as the call sites
 * ran it (land-s2b-ns2 eeee2cd11b, before the move). Each literal below is expanded from the call site by file and line
 * (the line is the one scripts/sql-move-check.mjs reports as the statement's origin); nothing is retyped. The run-time
 * text building and the row mapping each site did around its statement are copied with it.
 *
 * test/n4-sql-move-parity.test.ts runs these against the members in src/core/engine-sql/*.ts.
 */
import type { BrainEngine } from '../../src/core/engine.ts';

type Q = Pick<BrainEngine, 'executeRaw'>;

/** Driver-tolerant 42703 detector, as sources-load.ts kept it. */
function isUndefinedColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  if (e.code === '42703') return true;
  return typeof e.message === 'string' && /column .* does not exist/i.test(e.message);
}

/** src/core/sources-load.ts:250 and :260 (loadAllSources). */
export async function sourcesLoadRows(e: Q): Promise<Array<Record<string, unknown>>> {
  try {
    return await e.executeRaw(
      `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at, archived, newest_content_at
         FROM sources
       ORDER BY (id = 'default') DESC, id`,
    );
  } catch (err) {
    if (isUndefinedColumnError(err)) {
      return await e.executeRaw(
        `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at
           FROM sources
         ORDER BY (id = 'default') DESC, id`,
      );
    }
    throw err;
  }
}

/** src/core/company-brain/profile.ts:33. */
export const sourceIncarnationRows = (e: Q, sourceId: string) => e.executeRaw<{ config: unknown; incarnation: string }>('SELECT config,incarnation FROM sources WHERE id=$1', [sourceId]);

/** src/core/company-brain/profile.ts:34. */
export const companyReceiptRows = (e: Q, sourceId: string) => e.executeRaw(`SELECT r.id FROM source_ingestion_receipts r JOIN sources s ON s.id=r.source_id AND s.incarnation=r.source_incarnation
      WHERE r.source_id=$1 AND r.profile='company-brain' LIMIT 1`, [sourceId]);

/** src/core/wanted-links-store.ts:37 (wantedReadAt). */
export async function wantedReadAt(e: Q): Promise<string> {
  const [row] = await e.executeRaw<{ at: string }>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`);
  return row!.at;
}

/** src/core/link-reconciliation.ts:25 (loadLinkPageMetadata). */
export const linkPageMetadata = (e: Q, sourceId?: string) => e.executeRaw<Record<string, unknown>>(`SELECT slug, source_id, type, title, frontmatter->'aliases' AS aliases, knowledge_revision FROM pages
    WHERE deleted_at IS NULL${sourceId ? ' AND source_id=$1' : ''} ORDER BY source_id, slug`, sourceId ? [sourceId] : []);

/** src/core/timeline-extract.ts:305 (storedTimelineRows). */
export const storedTimelineRows = (e: Q, sourceId: string, slug: string) => e.executeRaw<Record<string, unknown>>(
    `SELECT t.id, to_char(t.date, 'YYYY-MM-DD') AS date, t.source, t.summary, t.detail FROM timeline_entries t
      JOIN pages p ON p.id = t.page_id
      WHERE p.source_id = $1 AND p.slug = $2 AND t.event_page_id IS NULL`, [sourceId, slug]);

/** src/commands/extract.ts:150 (stampCompletedIntersection); `chunk` is the [source_id, slug, revision] triples. */
export const pagesAtRevision = (e: Q, chunk: string[][]) => e.executeRaw<{ slug: string; source_id: string }>(`SELECT p.slug,p.source_id FROM pages p
      JOIN unnest($1::text[],$2::text[],$3::text[]) AS t(source_id,slug,revision) ON p.source_id=t.source_id AND p.slug=t.slug
      WHERE p.knowledge_revision::text=t.revision AND p.deleted_at IS NULL`, [chunk.map(k => k[0]), chunk.map(k => k[1]), chunk.map(k => k[2])]);

/** src/core/search/exact-scan.ts:193 (the scan's timeout fallback). */
export async function nextLivePage(e: Q, after: number): Promise<{ id: number; slug: string; source_id: string } | undefined> {
  const [next] = await e.executeRaw<{ id: number; slug: string; source_id: string }>(
        'SELECT id, slug, source_id FROM pages WHERE id > $1::int AND deleted_at IS NULL ORDER BY id LIMIT 1', [after]);
  return next;
}

/** src/core/mentions/stale.ts:26 (previewMentionPass). */
export const mentionLastPass = (e: Q, sourceId?: string) => e.executeRaw<{ last: string | null }>(
      `SELECT to_char(max(last_pass_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last FROM mention_index_status
        WHERE ($1::text IS NULL OR source_id = $1)`, [sourceId ?? null]);

/** src/core/entities/resolve.ts:367 (findExactBasenameCandidates). */
export const exactBasenameRows = (e: Q, source_id: string, slugs: string[]) => e.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])
        LIMIT 2`,
      [source_id, slugs],
    );

/** src/core/minions/job-insight.ts:149 (describeJobs: submitter and parent owner). */
export const insightMeta = (e: Q, ids: number[]) => e.executeRaw<{ id: number; submitter: string | null; parent_owner: string | null }>(
    `SELECT j.id, CASE WHEN j.submission_authority->>'kind' = 'application' THEN j.data->>'__submitter' END AS submitter,
            p.data->>'__owner_client_id' AS parent_owner
       FROM minion_jobs j LEFT JOIN minion_jobs p ON p.id = j.parent_job_id
      WHERE j.id = ANY($1::int[])`, [ids]);

/** src/core/minions/job-insight.ts:159 (queue position). */
export const insightAhead = (e: Q, waitingIds: number[]) => e.executeRaw<{ id: number; ahead: number | string }>(
      `SELECT j.id, (SELECT count(*) FROM minion_jobs w
                      WHERE w.queue = j.queue AND w.status = 'waiting'
                        AND (w.priority, w.created_at, w.id) < (j.priority, j.created_at, j.id)) AS ahead
         FROM minion_jobs j WHERE j.id = ANY($1::int[])`, [waitingIds]);

/** src/core/minions/job-insight.ts:165 (slot holders). */
export const insightHolders = (e: Q, queues: string[], holderQueue: string) => e.executeRaw<{ id: number; name: string; queue: string; owner: string | null }>(
      `SELECT id, name, queue, data->>'__owner_client_id' AS owner FROM minion_jobs
        WHERE status = 'active' AND queue = ANY($1::text[]) AND queue <> $2 ORDER BY started_at ASC NULLS LAST, id ASC LIMIT 500`,
      [queues, holderQueue]);

/** src/core/minions/job-insight.ts:179 (live children of waiting-children parents). */
export const insightChildren = (e: Q, parentIds: number[]) => e.executeRaw<{ id: number; parent_job_id: number; owner: string | null }>(
      `SELECT id, parent_job_id, data->>'__owner_client_id' AS owner FROM minion_jobs
        WHERE parent_job_id = ANY($1::int[]) AND status NOT IN ('completed','failed','dead','cancelled') ORDER BY id ASC`,
      [parentIds]);

/** src/core/minions/job-insight.ts:193 (blocking locks and their drain-lease beacon). */
export const insightLocks = (e: Q, lockIds: string[], holderQueue: string) => e.executeRaw<Record<string, unknown>>(
      `SELECT l.id, l.holder_pid, l.holder_host, l.acquired_at, l.ttl_expires_at, b.data->'drain_lease_beacon' AS beacon,
              h.data->>'__owner_client_id' AS holder_owner
         FROM gbrain_cycle_locks l
         LEFT JOIN minion_jobs b ON b.queue = $2 AND b.lock_token = l.acquisition_token::text
         LEFT JOIN minion_jobs h ON (b.data->'drain_lease_beacon'->>'kind') = 'job'
                                AND h.id::text = (b.data->'drain_lease_beacon'->>'id')
        WHERE l.id = ANY($1::text[]) AND l.ttl_expires_at > now()`, [lockIds, holderQueue]);

/** src/core/minions/job-insight.ts:219 (tokens of completed children another owner submitted). */
export const insightForeignTokens = (e: Q, ids: number[], owner: string) => e.executeRaw<{ parent_job_id: number; i: number | string; o: number | string; c: number | string }>(
      `SELECT parent_job_id, sum(tokens_input) AS i, sum(tokens_output) AS o, sum(tokens_cache_read) AS c FROM minion_jobs
        WHERE parent_job_id = ANY($1::int[]) AND status = 'completed' AND data->>'__owner_client_id' IS DISTINCT FROM $2::text
        GROUP BY 1`, [ids, owner]);
