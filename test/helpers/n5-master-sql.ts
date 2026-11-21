/**
 * Master's text for the reads N5 moved behind BrainEngine members, as the call sites ran it through `executeRaw` at the N5 base
 * (7969eaabc5, before the move). Every literal below was extracted from its call site's blob at that commit by script (the
 * literal around an anchor in the file; n5-logs/tools/genmaster.py), never retyped; each constant names its master path:line.
 * The two statements master composed at run time (the held fence list, the stored-vector presence probe) are the functions at
 * the end, with the call site's own `${}` text.
 *
 * test/n5-sql-move-parity.test.ts runs these against the members in src/core/engine-sql/{jobs-status,embedding-catalog,fence-holds}.ts
 * and the typed config read behind src/core/config-values.ts.
 */

/** src/commands/status.ts:254 */
export const CYCLE_FULL =
`SELECT finished_at, name, status, started_at, result
         FROM minion_jobs
        WHERE name = 'autopilot-cycle' AND status = 'completed'
        ORDER BY finished_at DESC NULLS LAST
        LIMIT 1`;

/** src/commands/status.ts:266 */
export const CYCLE_TARGETED =
`SELECT finished_at, name, status, started_at, result
         FROM minion_jobs
        WHERE name LIKE 'autopilot-%' AND status = 'completed'
        ORDER BY finished_at DESC NULLS LAST
        LIMIT 1`;

/** src/commands/status.ts:320 */
export const QUEUE_COUNTS =
`SELECT status, COUNT(*)::text AS count FROM minion_jobs GROUP BY status`;

/** src/commands/status.ts:348 */
export const QUEUE_DEPTHS =
`SELECT queue,
            count(*)::int AS depth,
            EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS oldest_waiting_age_seconds
       FROM minion_jobs
      WHERE status = 'waiting'
      GROUP BY queue
      ORDER BY depth DESC`;

/** src/commands/status.ts:397 */
export const LAST_COMPLETED =
`SELECT max(updated_at) AS last_completed FROM minion_jobs WHERE status = 'completed'`;

/** src/commands/jobs/stats.ts:36 */
export const TTL_CANCELLED =
`SELECT name, count(*)::text AS count FROM minion_jobs
            WHERE status = 'cancelled' AND error_text LIKE $1
              AND finished_at > now() - interval '24 hours'
            GROUP BY name ORDER BY count(*) DESC`;

/** src/commands/jobs/stats.ts:212 */
export const WAITING_SCOPE =
`WITH target AS (
                   SELECT id, started_at, status, lock_until,
                          COALESCE(data->>'sourceId', data->>'source_id') AS scope
                     FROM minion_jobs WHERE id = $3 AND name = $1 AND queue = $2
                 )
                 SELECT (SELECT count(*)::text FROM minion_jobs m, target t
                          WHERE m.name = $1 AND m.queue = $2 AND m.status = 'waiting'
                            AND COALESCE(m.data->>'sourceId', m.data->>'source_id') IS NOT DISTINCT FROM t.scope) AS waiting,
                        (SELECT id::text FROM target WHERE status = 'active' AND lock_until > now()) AS live_id,
                        (SELECT floor(EXTRACT(EPOCH FROM (now() - started_at)) / 60)::text FROM target
                          WHERE status = 'active' AND lock_until > now()) AS age_min`;

/** src/commands/jobs/stats.ts:254 */
export const RECENT_COMPLETED =
`SELECT count(*)::text AS count FROM minion_jobs
              WHERE finished_at > now() - interval '1 hour'
                AND status = 'completed' AND name = 'subagent'`;

/** src/commands/jobs/stats.ts:279 */
export const RECENT_FAILED =
`SELECT id, error_text AS last_error FROM minion_jobs
              WHERE status IN ('dead', 'failed')
                AND updated_at > now() - interval '24 hours'`;

/** src/core/facts/drain.ts:125 */
export const DRAIN_COUNTS =
`SELECT status, count(*)::int AS n FROM minion_jobs
      WHERE name = $1 AND queue = $2 AND status IN ('waiting', 'delayed', 'active') GROUP BY status`;

/** src/core/facts/drain.ts:191 */
export const DRAIN_CHARS =
`SELECT avg(LEAST(length(p.compiled_truth), $3))::float AS chars FROM minion_jobs j
       JOIN pages p ON p.slug = j.data->>'slug' AND p.source_id = COALESCE(j.data->>'sourceId', 'default')
      WHERE j.name = $1 AND j.queue = $2 AND j.status IN ('waiting', 'delayed')`;

/** src/core/source-health.ts:423 */
export const SOURCE_JOBS =
`SELECT data->>'sourceId' AS source_id,
              COUNT(*) FILTER (WHERE status IN ('failed','dead') AND created_at > NOW() - INTERVAL '24 hours')::int AS failed_24h,
              COUNT(*) FILTER (WHERE status IN ('waiting','active','delayed'))::int AS queue_depth,
              COUNT(*) FILTER (WHERE name = 'embed-backfill' AND status = 'active')::int AS backfill_active,
              COUNT(*) FILTER (WHERE name = 'embed-backfill' AND status IN ('waiting','delayed','waiting-children'))::int AS backfill_queued
         FROM minion_jobs
        WHERE name IN ('sync','embed-backfill')
          AND data->>'sourceId' IS NOT NULL
        GROUP BY data->>'sourceId'`;

/** src/core/sync-status-report.ts:188 */
export const EMBED_BACKFILL =
`SELECT data->>'sourceId' AS source_id,
                COUNT(*) FILTER (WHERE status IN ('waiting','delayed','waiting-children'))::int AS queued,
                COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                MAX(finished_at) FILTER (WHERE status = 'completed') AS last_completed_at
           FROM minion_jobs
          WHERE name = 'embed-backfill' AND data->>'sourceId' = ANY($1::text[])
          GROUP BY data->>'sourceId'`;

/** src/core/embedding-dim-check.ts:141 */
export const DIM_EXISTS =
`SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'content_chunks'
         AND column_name = $1
     ) AS exists`;

/** src/core/embedding-dim-check.ts:155 */
export const DIM_FORMAT =
`SELECT format_type(a.atttypid, a.atttypmod) AS formatted
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'content_chunks'
        AND a.attname = $1
        AND NOT a.attisdropped`;

/** src/core/stored-embedding-identity.ts:19 */
export const IDENTITY_FORMAT =
`
    SELECT format_type(a.atttypid, a.atttypmod) AS formatted
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'content_chunks'
      AND a.attname = 'embedding' AND NOT a.attisdropped
  `;

/** src/core/stored-embedding-identity.ts:28 */
export const IDENTITY_TABLES =
`
      SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'content_chunks') AS present
    `;

/** src/core/stored-embedding-identity.ts:8 */
export const IDENTITY_STORES =
`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'embedding'
      AND table_name = ANY($1::text[])
  `;

/** src/commands/doctor/checks/data-integrity.ts:245 */
export const COVERAGE_MULTIMODAL =
`SELECT
           COALESCE(p.source_id, 'default') AS source_id,
           COUNT(*)::text AS total,
           SUM(CASE WHEN cc.embedding_multimodal IS NOT NULL THEN 1 ELSE 0 END)::text AS covered
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         GROUP BY p.source_id`;

/** src/commands/doctor/checks/embedding-identity.ts:39 */
export const CONFIG_EMBEDDING_MODEL =
`SELECT value FROM config WHERE key = 'embedding_model'`;

/** src/core/eligibility/scan.ts:78 */
export const CONFIG_SCAN_BASELINE =
`SELECT value FROM config WHERE key = $1`;

/** src/core/trust/claim-state.ts:69 */
export const CONFIG_CLAIM_BASELINE =
`SELECT value FROM config WHERE key = $1`;

/** src/core/search/embedding-column.ts:702 */
export const CONFIG_EMBEDDING_COLUMNS =
`SELECT key, value FROM config WHERE key IN ('search_embedding_column', 'embedding_columns')`;

/** src/core/generations/fence.ts:181 (listFenceHolds): the held-rows read, `slug` set for one owner. */
export function fenceHoldsSql(slug: string | undefined): string {
  return `SELECT source_id, kind, owner_key, held_reason, held_context, created_at::text AS created_at FROM derived_generations
      WHERE source_id = ANY($1::text[]) AND kind = ANY($2::text[]) AND state = 'held'${slug === undefined ? '' : ' AND owner_key = $3'}
      ORDER BY created_at, id`;
}

/** src/commands/embeddings.ts:96, init.ts:1072, doctor/checks/embedding-plane.ts:25, init-embedding-plane.ts:24: the presence probe of one store. */
export function storedVectorsSql(table: string): string {
  return `SELECT EXISTS (SELECT 1 FROM ${table} WHERE embedding IS NOT NULL) AS present`;
}
