/**
 * The queue reads the doctor checks and the dream breaker make: which embed-backfill sources stalled, how the brain-wide
 * maintenance job and its dream children died, which facts-absorb jobs are still dead, who holds legacy submission
 * authority and what queued paid jobs spend under, which jobs recorded a build-skew line, and how many dead dream
 * submissions a key has. SQL once for both engines, so a store that is not SQL can serve the same members.
 *
 * Every function takes the engine (or transaction) it runs on and returns plain rows. Windows, limits and key prefixes
 * are arguments, not SQL text, so no statement is built from data. Where a read had no ORDER BY the check never
 * depended on one, an order is added so the engines agree on it.
 */
import type { BrainEngine } from '../engine.ts';
import { listUnreviewedJobAuthorities } from './jobs-queue.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

const TERMINAL = "('completed', 'failed', 'dead', 'cancelled')";

/**
 * The distinct `sourceId` of the embed-backfill jobs that ended failed or dead carrying a stall record in their
 * progress (`progress ? 'stall'`), in bytewise order with a job that has no source last.
 */
export async function listStalledEmbedBackfillSources(tx: Raw): Promise<Array<string | null>> {
  const rows = await tx.executeRaw<{ source_id: string | null }>(
    `SELECT source_id FROM (
       SELECT DISTINCT data->>'sourceId' AS source_id FROM minion_jobs
        WHERE name = 'embed-backfill' AND status IN ('failed', 'dead') AND progress ? 'stall') s
      ORDER BY source_id COLLATE "C"`);
  return rows.map(r => r.source_id);
}

/** How the brain-wide maintenance job and its dream children died: the last `deaths` of each, as the check reads them. */
export interface GlobalMaintenanceDeaths {
  /** The last `deaths` finished `autopilot-global-maintenance` jobs, newest first. */
  recent: Array<{ id: number; status: string; error_text: string | null }>;
  /** Dream phases whose last `deaths` finished `subagent` children all died at their subagent timeout. */
  child_timeouts: Array<{ phase: 'patterns' | 'synthesize'; deaths: number; last_at: string | null }>;
}

export async function readGlobalMaintenanceDeaths(tx: Raw, spec: { deaths: number }): Promise<GlobalMaintenanceDeaths> {
  const recent = await tx.executeRaw<{ id: number | string; status: string; error_text: string | null }>(
    `SELECT id, status, error_text FROM minion_jobs
      WHERE name = 'autopilot-global-maintenance' AND status IN ('completed', 'failed', 'dead', 'cancelled')
      ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT $1`, [spec.deaths]);
  const children = await tx.executeRaw<{ phase: 'patterns' | 'synthesize'; deaths: number | string; last_at: string | null }>(
    `SELECT phase, count(*)::int AS deaths, max(finished_at)::text AS last_at FROM (
       SELECT phase, status, error_text, finished_at,
              row_number() OVER (PARTITION BY phase ORDER BY finished_at DESC NULLS LAST, id DESC) AS n
         FROM (SELECT id, status, error_text, finished_at,
                      CASE WHEN key LIKE 'dream:patterns:%' THEN 'patterns' ELSE 'synthesize' END AS phase
                 FROM (SELECT id, status, error_text, finished_at,
                              COALESCE(idempotency_key, data->>'__released_idempotency_key') AS key
                         FROM minion_jobs
                        WHERE name = 'subagent' AND status IN ('completed', 'failed', 'dead', 'cancelled')) keyed
                WHERE key LIKE 'dream:patterns:%' OR key LIKE 'dream:synth%') phased
     ) recent
      WHERE n <= $1
      GROUP BY phase
     HAVING count(*) = $1 AND bool_and(status = 'dead' AND error_text ~ 'timeout exceeded')
      ORDER BY phase COLLATE "C"`, [spec.deaths]);
  return {
    recent: recent.map(r => ({ id: Number(r.id), status: r.status, error_text: r.error_text })),
    child_timeouts: children.map(c => ({ phase: c.phase, deaths: Number(c.deaths), last_at: c.last_at })),
  };
}

/** The newest `autopilot-global-maintenance` job that ended without completing after `since`, and how many did. */
export interface LastFailedGlobalMaintenanceJob {
  id: number;
  status: string;
  error_text: string | null;
  /** Every such job, not only this one. */
  total: number;
  /** The earliest finish among them, as `timestamptz::text`; null when none has a finish time. */
  since: string | null;
}

/** `since` is a timestamp text, or null for every failed job. */
export async function readLastFailedGlobalMaintenanceJob(tx: Raw, since: string | null): Promise<LastFailedGlobalMaintenanceJob | null> {
  const [row] = await tx.executeRaw<{ id: number | string; status: string; error_text: string | null; total: number | string; since: string | null }>(
    `SELECT id, status, error_text, count(*) OVER ()::int AS total, min(finished_at) OVER ()::text AS since FROM minion_jobs
      WHERE name = 'autopilot-global-maintenance' AND status IN ('failed', 'dead', 'cancelled')
        AND ($1::timestamptz IS NULL OR finished_at > $1::timestamptz)
      ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1`, [since]);
  return row ? { id: Number(row.id), status: row.status, error_text: row.error_text, total: Number(row.total), since: row.since } : null;
}

/** Facts-absorb jobs that went dead or failed inside the window and no later job for the same page completed. */
export interface FactsAbsorbStillDead {
  /** Every such job; `jobs` holds the newest `limit`. */
  total: number;
  jobs: Array<{ id: number; slug: string | null; source_id: string; status: string }>;
}

export async function listFactsAbsorbJobsStillDead(tx: Raw, spec: { hours: number; limit: number }): Promise<FactsAbsorbStillDead> {
  const rows = await tx.executeRaw<{ id: number | string; slug: string | null; source_id: string; status: string; total: string | number }>(
    `SELECT j.id, j.data->>'slug' AS slug, COALESCE(j.data->>'sourceId', 'default') AS source_id, j.status, COUNT(*) OVER () AS total
       FROM minion_jobs j
      WHERE j.name = 'facts-absorb' AND j.status IN ('dead', 'failed')
        AND COALESCE(j.finished_at, j.updated_at) >= now() - ($1::double precision * interval '1 hour')
        AND NOT EXISTS (
          SELECT 1 FROM minion_jobs k
           WHERE k.name = 'facts-absorb' AND k.status = 'completed' AND k.id > j.id
             AND k.data->>'slug' = j.data->>'slug' AND COALESCE(k.data->>'sourceId', 'default') = COALESCE(j.data->>'sourceId', 'default'))
      ORDER BY j.id DESC
      LIMIT $2`, [spec.hours, spec.limit]);
  return { total: Number(rows[0]?.total ?? 0), jobs: rows.map(r => ({ id: Number(r.id), slug: r.slug, source_id: r.source_id, status: r.status })) };
}

/**
 * The claim gate's population as the `legacy_job_authority` check reads it. `live` is every live job whose authority is
 * not exactly the application authority (the check keeps the ones `parseSubmissionAuthority` rejects), by id;
 * `legacy_authority_is_null` tells SQL NULL from JSONB null. `active_ids` is the first 10 active jobs by id.
 * `terminal_keyed` counts finished jobs with SQL NULL authority and an idempotency key, by status.
 */
export interface LegacyJobAuthorityRead {
  live: Array<{ id: number; status: string; submission_authority: unknown; legacy_authority_is_null: boolean }>;
  active_ids: number[];
  terminal_keyed: Array<{ status: string; count: number }>;
}

export async function readLegacyJobAuthority(tx: Raw): Promise<LegacyJobAuthorityRead> {
  const live = await listUnreviewedJobAuthorities(tx);
  const active = await tx.executeRaw<{ id: number | string }>("SELECT id FROM minion_jobs WHERE status = 'active' ORDER BY id LIMIT 10");
  const terminal = await tx.executeRaw<{ status: string; count: number | string }>(
    `SELECT status, count(*) AS count FROM minion_jobs
      WHERE submission_authority IS NULL AND idempotency_key IS NOT NULL
        AND status IN ${TERMINAL}
      GROUP BY status ORDER BY status COLLATE "C"`);
  return {
    live: live.map(r => ({ id: Number(r.id), status: r.status, submission_authority: r.submission_authority, legacy_authority_is_null: r.legacy_authority_is_null })),
    active_ids: active.map(r => Number(r.id)),
    terminal_keyed: terminal.map(r => ({ status: r.status, count: Number(r.count) })),
  };
}

/**
 * Queued jobs by name and spend basis, and the spend-authorized rows that waited longer than `waitMs`. A queued row's
 * basis is its spend record's `kind`, else `legacy_default` when its name has an entry in `legacyPrefixes` and its
 * idempotency key is `LIKE` one of that entry's prefixes followed by `%` (the claim stamps those), else `unrecorded`.
 * A prefix is a LIKE pattern, as it was when doctor built this read inline: `_` and `%` in it are wildcards.
 */
export interface QueuedSpendRows {
  by_basis: Array<{ name: string; basis: string | null; n: number }>;
  waiting_ids: number[];
}

export async function readQueuedSpendRows(tx: Raw, spec: { legacyPrefixes: Readonly<Record<string, readonly string[]>>; waitMs: number }): Promise<QueuedSpendRows> {
  const rows = await tx.executeRaw<{ name: string; basis: string | null; n: number | string }>(
    `SELECT name, basis, count(*)::int AS n FROM (
       SELECT j.name,
              CASE WHEN j.spend_authorization IS NOT NULL THEN j.spend_authorization->>'kind'
                   WHEN EXISTS (SELECT 1 FROM jsonb_each($1::text::jsonb) AS p(job_name, prefixes),
                                       jsonb_array_elements_text(p.prefixes) AS pre(prefix)
                                 WHERE p.job_name = j.name AND j.idempotency_key IS NOT NULL
                                   AND j.idempotency_key LIKE pre.prefix || '%')
                   THEN 'legacy_default' ELSE 'unrecorded' END AS basis
         FROM minion_jobs j WHERE j.status IN ('waiting', 'delayed', 'paused', 'waiting-children')) b
      GROUP BY name, basis
      ORDER BY name COLLATE "C", basis COLLATE "C"`, [JSON.stringify(spec.legacyPrefixes)]);
  const waiting = await tx.executeRaw<{ id: number | string }>(
    `SELECT id FROM minion_jobs WHERE status = 'waiting' AND spend_authorization IS NOT NULL
        AND updated_at < now() - ($1::double precision * interval '1 millisecond') ORDER BY id`, [spec.waitMs]);
  return { by_basis: rows.map(r => ({ name: r.name, basis: r.basis, n: Number(r.n) })), waiting_ids: waiting.map(r => Number(r.id)) };
}

/**
 * The stacktrace lines `LIKE prefix || '%'` of the newest `scanJobs` jobs (by id) whose stacktrace is an array and
 * that were updated inside `windowHours`: newest job first, each job's lines in order. `prefix` is a LIKE pattern, as
 * in the original doctor read, so its `_` matches any one character (follow-up doctor-prefix-literal).
 */
export async function listBuildSkewStacktraceLines(tx: Raw, spec: { prefix: string; windowHours: number; scanJobs: number }): Promise<Array<{ id: number; line: string }>> {
  const rows = await tx.executeRaw<{ id: number | string; line: string }>(
    `SELECT j.id, e.line FROM (
       SELECT id, stacktrace FROM minion_jobs
        WHERE jsonb_typeof(stacktrace) = 'array' AND updated_at > now() - ($2::double precision * interval '1 hour')
        ORDER BY id DESC LIMIT $3) j
     CROSS JOIN LATERAL jsonb_array_elements_text(j.stacktrace) WITH ORDINALITY AS e(line, ord)
     WHERE e.line LIKE $1
     ORDER BY j.id DESC, e.ord`, [`${spec.prefix}%`, spec.windowHours, spec.scanJobs]);
  return rows.map(r => ({ id: Number(r.id), line: r.line }));
}

/** What `countDeadDreamSubmissionRows` needs from the dream breaker, as data. */
export interface DeadDreamSubmissionSpec {
  /** `[synthesize prefix, patterns prefix]`: the base-key families the breaker counts. */
  keyPrefixes: readonly [string, string];
  /** The per-source patterns key prefix; a patterns death counts under it plus its source. */
  patternsSourcePrefix: string;
  /** The per-transcript synthesize key prefix; a death of a `...:filename:<name>:<hash>` key counts under it plus source and name. */
  synthFilePrefix: string;
  /** `{ [base key]: ISO time }`: deaths that finished at or before a key's time do not count. */
  resets: Readonly<Record<string, string>>;
  windowHours: number;
}

/**
 * Dead (and paid-cancelled) subagent jobs that finished inside the window, counted per base key: distinct queues, and
 * the latest finish as `timestamptz::text`. Most deaths first, then base key.
 */
export async function countDeadDreamSubmissionRows(tx: Raw, spec: DeadDreamSubmissionSpec): Promise<Array<{ base_key: string; dead_submissions: number; last_dead_at: string }>> {
  const rows = await tx.executeRaw<{ base_key: string; dead_submissions: number | string; last_dead_at: string }>(
    `WITH ended AS (
       SELECT regexp_replace(COALESCE(idempotency_key, data->>'__released_idempotency_key'), ':c[0-9]+of[0-9]+$', '') AS base_key,
              COALESCE(data->>'source_id', 'default') AS source_id, status, queue, finished_at
         FROM minion_jobs
        WHERE name = 'subagent' AND finished_at > now() - ($6::double precision * interval '1 hour')
          AND (status = 'dead' OR (status = 'cancelled' AND tokens_input + tokens_output > 0))
     ), counted AS (
       SELECT base_key, queue, finished_at, base_key AS content_key FROM ended
        WHERE status = 'dead' AND left(base_key, length($1::text)) = $1::text
       UNION ALL
       SELECT $4::text || source_id, queue, finished_at, NULL FROM ended
        WHERE left(base_key, length($2::text)) = $2::text
       UNION ALL
       SELECT $5::text || source_id || ':' || substring(base_key from ':filename:([^:]*):[^:]*$'), queue, finished_at, base_key FROM ended
        WHERE status = 'dead' AND left(base_key, length($1::text)) = $1::text AND base_key ~ ':filename:[^:]*:[^:]*$'
     )
     SELECT base_key, COUNT(DISTINCT queue)::int AS dead_submissions, MAX(finished_at)::text AS last_dead_at
       FROM counted
      WHERE finished_at > COALESCE(($3::text::jsonb ->> base_key)::timestamptz, '-infinity'::timestamptz)
      GROUP BY base_key
     -- A per-transcript count is its own row only once its deaths span two content keys; one key already counts itself.
     HAVING left(base_key, length($5::text)) <> $5::text OR COUNT(DISTINCT content_key) > 1
      ORDER BY dead_submissions DESC, base_key COLLATE "C"`,
    [spec.keyPrefixes[0], spec.keyPrefixes[1], JSON.stringify(spec.resets), spec.patternsSourcePrefix, spec.synthFilePrefix, spec.windowHours]);
  return rows.map(r => ({ base_key: r.base_key, dead_submissions: Number(r.dead_submissions), last_dead_at: r.last_dead_at }));
}

/** A facts-absorb job as the dead-write retry reads it. */
export interface FactsAbsorbJobRow {
  id: number;
  idempotency_key: string;
  status: string;
  error_text: string | null;
  slug: string | null;
  source_id: string;
  finished_at: Date | string | null;
}

type RawFactsAbsorbJob = Omit<FactsAbsorbJobRow, 'id'> & { id: number | string };
const factsAbsorbRow = (r: RawFactsAbsorbJob): FactsAbsorbJobRow => ({ ...r, id: Number(r.id) });

/**
 * The facts-absorb jobs whose idempotency key is `LIKE prefix || '%'` (a LIKE pattern, as in the original read) that are dead or whose key is in `keys` (the set
 * the dead-write retry already tracks), by id.
 */
export async function listFactsAbsorbJobsByKeyPrefix(tx: Raw, spec: { prefix: string; keys: readonly string[] }): Promise<FactsAbsorbJobRow[]> {
  const rows = await tx.executeRaw<RawFactsAbsorbJob>(
    `SELECT id, idempotency_key, status, error_text, data->>'slug' AS slug, COALESCE(data->>'sourceId', 'default') AS source_id, finished_at
       FROM minion_jobs
      WHERE name = 'facts-absorb' AND idempotency_key LIKE $1
        AND (status = 'dead' OR idempotency_key = ANY($2::text[]))
      ORDER BY id`, [`${spec.prefix}%`, spec.keys]);
  return rows.map(factsAbsorbRow);
}

/** The dead facts-absorb jobs whose idempotency key is in `keys`, by id. */
export async function listDeadFactsAbsorbJobsByKeys(tx: Raw, keys: readonly string[]): Promise<FactsAbsorbJobRow[]> {
  const rows = await tx.executeRaw<RawFactsAbsorbJob>(
    `SELECT id, idempotency_key, status, error_text, data->>'slug' AS slug, COALESCE(data->>'sourceId', 'default') AS source_id, finished_at
       FROM minion_jobs
      WHERE name = 'facts-absorb' AND status = 'dead' AND idempotency_key = ANY($1::text[])
      ORDER BY id`, [keys]);
  return rows.map(factsAbsorbRow);
}

const SUBSTANTIVE = `NOT COALESCE(status IN ('waiting', 'delayed', 'waiting-children', 'paused') OR (status = 'active' AND lock_until > now())
  OR (status = 'completed' AND (result->>'skipped' = 'true' OR (result->>'stopped_on' = 'usage_limit' AND result->>'reason' IN ('writer_pending', 'timeout')))), false)`;
const LIMITED = `COALESCE(status = 'completed' AND result->>'status' = 'partial' AND result->>'stopped_on' = 'usage_limit'
  AND COALESCE(result->>'reason', '') NOT IN ('writer_pending', 'timeout'), false)`;
const LANDED = `COALESCE((result->>'added')::numeric, 0) + COALESCE((result->>'modified')::numeric, 0) + COALESCE((result->>'deleted')::numeric, 0) > 0`;

/**
 * GST-3452: the newest sync job of a source, plus, when `$2` (the fail age's start) is given, the newest limited run since then
 * that landed pages and the newest run since then that ended any other way. Queued, running (live job lock) and skipped jobs,
 * and limited runs whose writes were still pending, are neither; an active job whose lock expired ended the other way.
 */
const LAST_SYNC_JOB_SQL = `WITH jobs AS (SELECT id, status, result, created_at, started_at, lock_until, COALESCE(finished_at, started_at, created_at) AS at
    FROM minion_jobs WHERE name='sync'
      AND (COALESCE(data->>'sourceId', data->>'source_id')=$1 OR (COALESCE(data->>'sourceId', data->>'source_id') IS NULL
        AND (data->>'repoPath' IS NULL AND $1='default' OR data->>'repoPath'=(SELECT local_path FROM sources WHERE id=$1))))),
  chain AS (SELECT max(created_at) FILTER (WHERE ${LIMITED} AND ${LANDED}) AS landed_created, max(at) FILTER (WHERE ${LIMITED} AND ${LANDED}) AS landed_at,
      max(created_at) FILTER (WHERE ${SUBSTANTIVE} AND NOT (${LIMITED})) AS broken_created
    FROM jobs WHERE $2::timestamptz IS NOT NULL AND at >= $2::timestamptz)
SELECT j.id AS job_id, j.status, j.result->>'status' AS result_status, j.result->>'failedFiles' AS failed_files, j.result->'partial_causes' AS partial_causes,
    (j.status='active' AND j.lock_until > now()) AS live, j.started_at, j.at,
    CASE WHEN c.broken_created IS NULL OR c.broken_created < c.landed_created THEN c.landed_at END AS usage_limited_since
  FROM (SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT 1) j CROSS JOIN chain c`;

/**
 * The newest `sync` job of a source (by `created_at`, then id) for doctor `sync_freshness` (`src/core/sync-attempt.ts`),
 * or null when the source has none. A job names its source by `data.sourceId` (or `data.source_id`); one that names
 * none belongs to the source whose `local_path` is its `data.repoPath`, or to `default` when it has no `repoPath`.
 * `live` is null for an active job with no lock time. `usage_limited_since` is read only when `freshSince` (an ISO
 * timestamp, the fail age's start) is given.
 */
export interface LastSyncJobRow {
  job_id: number;
  status: string;
  result_status: string | null;
  failed_files: string | null;
  partial_causes: unknown;
  live: boolean | null;
  started_at: Date | null;
  at: Date | null;
  usage_limited_since: Date | null;
}

const timeOrNull = (v: Date | string | null | undefined): Date | null => (v == null ? null : v instanceof Date ? v : new Date(v));

export async function readLastSyncJob(tx: Raw, sourceId: string, freshSince: string | null): Promise<LastSyncJobRow | null> {
  const [row] = await tx.executeRaw<{ job_id: number | string; status: string; result_status: string | null; failed_files: string | null;
    partial_causes: unknown; live: boolean | null; started_at: Date | string | null; at: Date | string | null; usage_limited_since: Date | string | null }>(
    LAST_SYNC_JOB_SQL, [sourceId, freshSince]);
  if (!row) return null;
  return {
    job_id: Number(row.job_id), status: row.status, result_status: row.result_status, failed_files: row.failed_files,
    partial_causes: row.partial_causes ?? null, live: row.live ?? null, started_at: timeOrNull(row.started_at), at: timeOrNull(row.at),
    usage_limited_since: timeOrNull(row.usage_limited_since),
  };
}
