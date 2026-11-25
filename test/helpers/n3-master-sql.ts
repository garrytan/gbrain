/**
 * Master's statements for the N3 read moves, verbatim, for test/n3-sql-move-parity.test.ts.
 *
 * Every function below is the call master made, at the commit the N3 branch's move check compares against
 * (5763c09b5c): the statement text copied byte for byte from the path:line named in its doc comment, the run-time
 * text building reproduced with master's local names, and master's parameters. Each runs through `executeRaw`, as
 * master's caller did, and answers master's raw rows; the test applies one canonical view to both sides.
 *
 * Do not edit a statement here to make a test pass: the text is the evidence. test/n3-sql-move-parity.test.ts fails
 * when a member's statement or mapping answers differently from it.
 */
import type { BrainEngine } from '../../src/core/engine.ts';

export type Raw = Pick<BrainEngine, 'executeRaw'>;
type Rows = Promise<Array<Record<string, unknown>>>;

// ---------------------------------------------------------------- alias fan-out

/** master 5763c09b5c src/core/search/alias-fanout.ts:118 (case-sensitive alias read). */
export const caseAliasRead = (exec: Raw, norms: string[], sources: string[]): Rows => exec.executeRaw(
  `SELECT slug, alias_norm, alias_text FROM page_aliases WHERE alias_norm = ANY($1::text[]) AND case_sensitive AND source_id = ANY($2::text[])`, [norms, sources]);

/** master 5763c09b5c src/core/search/alias-fanout.ts:146 (titleOf). */
export const titleOf = (exec: Raw, source_id: string, slug: string): Rows =>
  exec.executeRaw('SELECT title FROM pages WHERE source_id = $1 AND slug = $2', [source_id, slug]);

/** master 5763c09b5c src/core/search/alias-fanout.ts:161 (namesOf). */
export const namesOf = (exec: Raw, sourceIds: string[], slugs: string[]): Rows => exec.executeRaw(
  `SELECT slug, source_id, alias_norm, alias_text, origin FROM page_aliases
      WHERE source_id = ANY($1::text[]) AND slug = ANY($2::text[])`, [sourceIds, slugs]);

/** master 5763c09b5c src/core/verbs/entity-card-identity.ts:141 (readSiblingIdentity). */
export const siblingAliases = (exec: Raw, sourceId: string, slugs: string[]): Rows => exec.executeRaw(
  `SELECT slug, alias_norm, origin, alias_text FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) ORDER BY alias_norm`, [sourceId, slugs]);

// ---------------------------------------------------------------- belief, search vector, export

/** master 5763c09b5c src/core/belief/coverage-report.ts:347 (coveredSources). */
export const coveredSources = (exec: Raw, COVERAGE_KEY: string): Rows => exec.executeRaw(
  `SELECT s.id FROM sources s WHERE EXISTS (SELECT 1 FROM belief_events e
    WHERE e.source_id = s.id AND e.subject_kind = 'coverage' AND e.subject_key = $1 AND e.source_incarnation = s.incarnation) ORDER BY 1`, [COVERAGE_KEY]);

/** master 5763c09b5c src/commands/reindex-search-vector.ts:102 (the row inventory). */
export const searchVectorCounts = (exec: Raw): Rows => exec.executeRaw(
  `SELECT
       (SELECT COUNT(*)::int FROM pages WHERE search_vector IS NOT NULL) AS pages,
       (SELECT COUNT(*)::int FROM content_chunks WHERE search_vector IS NOT NULL) AS chunks`);

/** master 5763c09b5c src/commands/export.ts:125 (the next batch of page keys). */
export const exportPageKeys = (exec: Raw, cursor: string, source: string | null, type: string | null, prefix: string | null): Rows => exec.executeRaw(
  `SELECT p.id::text, p.body_storage='segmented' AS segmented, left(p.slug,4097) AS slug, p.source_id, left(p.source_path,4097) AS source_path, octet_length(p.source_path) AS source_path_bytes,
            (SELECT count(*) FROM raw_data r WHERE r.page_id=p.id) AS raw_count,
            CASE WHEN p.body_storage='segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth)::bigint + octet_length(p.timeline) END
              + octet_length(p.frontmatter::text)
              + octet_length(p.title) + octet_length(p.slug) + COALESCE(octet_length(p.source_path),0)
              + COALESCE((SELECT sum(octet_length(r.data::text)+octet_length(r.source)) FROM raw_data r WHERE r.page_id=p.id),0)
              + COALESCE((SELECT sum(octet_length(t.tag)) FROM tags t WHERE t.page_id=p.id),0) AS bytes
           FROM pages p WHERE p.id > $1::bigint AND p.deleted_at IS NULL
             AND ($2::text IS NULL OR p.source_id=$2) AND ($3::text IS NULL OR p.type=$3)
             AND ($4::text IS NULL OR starts_with(p.slug,$4)) ORDER BY p.id LIMIT 256`, [cursor, source, type, prefix]);

/** master 5763c09b5c src/core/export-snapshot.ts:18 (the ledger's size). */
export const ledgerBytes = (exec: Raw, sourceId: string): Rows => exec.executeRaw(
  `SELECT COALESCE(sum(octet_length(
    jsonb_build_object('visibility',visibility,'fact_hash',fact_hash,'withdrawn_at',withdrawn_at,'subject',subject)::text)+1),0)+2 AS bytes
    FROM fact_withdrawals WHERE source_id=$1`, [sourceId]);

/** master 5763c09b5c src/core/export-snapshot.ts:23 (the withdrawals and purge tombstones). */
export const exportWithdrawals = (exec: Raw, sourceId: string): Rows => exec.executeRaw(
  `SELECT visibility,fact_hash,withdrawn_at,subject,false AS purged
    FROM fact_withdrawals WHERE source_id=$1
    UNION ALL SELECT visibility,fact_hash,purged_at,subject,true FROM fact_purges WHERE source_id=$1
    ORDER BY visibility,fact_hash,subject`, [sourceId]);

/** master 5763c09b5c src/core/export-snapshot.ts:44 (the pages by id with their tags). */
export const exportPageRows = (exec: Raw, ids: string[]): Rows => exec.executeRaw(
  `WITH export_page AS MATERIALIZED (
    SELECT * FROM pages WHERE id = ANY($1::bigint[])
  ) SELECT p.*,
    COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id=p.id), '[]'::jsonb) AS export_tags
    FROM export_page p WHERE p.deleted_at IS NULL`, [ids]);

/** master 5763c09b5c src/core/export-snapshot.ts:62 (the normalized fence lines). */
export const normalizedLines = (exec: Raw, bodies: string[], timelines: string[]): Rows => exec.executeRaw(
  `SELECT t.i::int AS i,
    (SELECT string_agg(regexp_replace(lower(line),'[[:space:]]+',' ','g'),chr(10) ORDER BY ord)
      FROM unnest(string_to_array(t.body,chr(10))) WITH ORDINALITY AS lines(line,ord)) AS body,
    (SELECT string_agg(regexp_replace(lower(line),'[[:space:]]+',' ','g'),chr(10) ORDER BY ord)
      FROM unnest(string_to_array(t.timeline,chr(10))) WITH ORDINALITY AS lines(line,ord)) AS timeline
    FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t(body, timeline, i)`, [bodies, timelines]);

/** master 5763c09b5c src/core/doctor folder-access check, src/commands/doctor/checks/folder-access.ts:30. */
export const accessPolicySources = (exec: Raw): Rows => exec.executeRaw('SELECT source_id FROM access_policy_state ORDER BY source_id');

// ---------------------------------------------------------------- page body

/** master 5763c09b5c src/core/page-body/read-range.ts:199 (the page head). */
export const pageHead = (exec: Raw, pageId: number): Rows => exec.executeRaw(
  `SELECT id, source_id, slug, body_storage, body_generation, body_bytes, body_lines, truth_bytes,
      body_flags, segmenter_version, knowledge_revision::text AS revision FROM pages WHERE id=$1`, [pageId]);

/** master 5763c09b5c src/core/page-body/read-range.ts:177 (the manifest rows). */
export const manifestRows = (exec: Raw, pageId: number, generation: number | null): Rows => exec.executeRaw(
  `SELECT m.seq, m.occurrence_id, m.region, m.sha256, m.byte_start, m.byte_len,
      m.line_start, m.line_count, m.static_proj_bytes, m.static_proj_lines, jsonb_array_length(m.outline) AS outline_count,
      jsonb_array_length(m.facts_slots) > 0 AS has_facts, m.date_min IS NOT NULL AS has_date, g.generation
    FROM (SELECT COALESCE($2::bigint, (SELECT body_generation FROM pages WHERE id=$1)) AS generation) g
    JOIN page_body_manifest m ON m.page_id=$1 AND m.staging_id IS NULL AND m.gen_from<=g.generation AND (m.gen_to IS NULL OR m.gen_to>g.generation)
    ORDER BY m.seq`, [pageId, generation]);

/** master 5763c09b5c src/core/page-body/read-range.ts:253 (the entry state and protected regions). */
export const manifestMeta = (exec: Raw, pageId: number, occurrenceIds: number[], generation: number): Rows => exec.executeRaw(
  `SELECT occurrence_id, entry_state, protected_regions
      FROM page_body_manifest WHERE page_id=$1 AND occurrence_id=ANY($2::bigint[]) AND staging_id IS NULL AND gen_from<=$3 AND (gen_to IS NULL OR gen_to>$3)`, [pageId, occurrenceIds, generation]);

/** master 5763c09b5c src/core/page-body/read-range.ts:631 (the facts slots and outline). */
export const manifestOutline = (exec: Raw, pageId: number, occurrenceIds: number[], generation: number): Rows => exec.executeRaw(
  `SELECT occurrence_id, facts_slots, outline FROM page_body_manifest
    WHERE page_id=$1 AND occurrence_id=ANY($2::bigint[]) AND staging_id IS NULL AND gen_from<=$3 AND (gen_to IS NULL OR gen_to>$3)`, [pageId, occurrenceIds, generation]);

/** master 5763c09b5c src/core/page-body/segment-blocks.ts:166 (the forced cuts). */
export const forcedCuts = (exec: Raw, pageId: number, generation: number): Rows => exec.executeRaw(
  `SELECT seq FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL
      AND gen_from<=$2 AND (gen_to IS NULL OR gen_to>$2) AND cut_kind='forced'`, [pageId, generation]);

/** master 5763c09b5c src/core/page-body/body-tiling.ts:35 (a segmented version's size). */
export const versionBodyBytes = (exec: Raw, pageId: number, generation: number): Rows => exec.executeRaw(
  `SELECT body_bytes FROM page_versions
    WHERE page_id=$1 AND body_generation=$2 AND body_storage='segmented' AND body_bytes IS NOT NULL ORDER BY id DESC LIMIT 1`, [pageId, generation]);

// ---------------------------------------------------------------- trust tiers

/** master 5763c09b5c src/core/ops/admin.ts:266 (the snapshot tiers). */
export const versionTiers = (exec: Raw, ids: number[]): Rows =>
  exec.executeRaw('SELECT id, trust_tier FROM page_versions WHERE id = ANY($1::bigint[])', [ids]);

/** master 5763c09b5c src/core/ops/admin.ts:313 (the type and tier of the replacing write). */
export const versionWriters = (exec: Raw, ids: number[]): Rows => exec.executeRaw(
  `SELECT pv.id, COALESCE(nx.type, p.type) AS type, CASE WHEN nx.id IS NULL THEN p.trust_tier ELSE nx.trust_tier END AS tier
       FROM page_versions pv JOIN pages p ON p.id = pv.page_id
       LEFT JOIN LATERAL (SELECT n.id, n.type, n.trust_tier FROM page_versions n WHERE n.page_id = pv.page_id AND n.id > pv.id ORDER BY n.id LIMIT 1) nx ON true
      WHERE pv.id = ANY($1::bigint[])`, [ids]);

/** master 5763c09b5c src/core/search/transcript-quote.ts:111 (pageTypesById). */
export const pageTypes = (exec: Raw, ids: number[]): Rows =>
  exec.executeRaw('SELECT id, type FROM pages WHERE id = ANY($1::bigint[])', [[...new Set(ids.map(Number))]]);

// ---------------------------------------------------------------- withdrawal discovery (src/core/facts/withdrawal-discovery.ts)

/** master 5763c09b5c src/core/facts/withdrawal-discovery.ts:26 (sample slugs). */
export const sampleSlugs = (exec: Raw, sourceId: string, ids: number[]): Rows =>
  exec.executeRaw('SELECT slug FROM pages WHERE source_id=$1 AND id=ANY($2::int[]) ORDER BY slug LIMIT 20', [sourceId, ids]);

/** master 5763c09b5c src/core/facts/withdrawal-discovery.ts:81 (split fence slots). */
export const splitFenceSlots = (exec: Raw, sourceId: string, subjects: string[] | null, after: [number, string, number], batch: number): Rows => exec.executeRaw(
  `SELECT m.page_id,p.slug,m.region,
        (s->>'open_start')::bigint::text AS open_start,sum((s->>'end')::bigint-(s->>'start')::bigint)::text AS bytes
      FROM page_body_manifest m JOIN pages p ON p.id=m.page_id CROSS JOIN LATERAL jsonb_array_elements(m.facts_slots) s
      WHERE p.source_id=$1 AND p.body_storage='segmented' AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.facts_slots<>'[]'::jsonb AND s ? 'open_start'
        AND ($2::text[] IS NULL OR p.slug=ANY($2::text[])) AND (m.page_id,m.region,(s->>'open_start')::bigint)>($3::int,$4::text,$5::bigint)
      GROUP BY m.page_id,p.slug,m.region,(s->>'open_start')::bigint ORDER BY m.page_id,m.region,(s->>'open_start')::bigint LIMIT $6`, [sourceId, subjects, after[0], after[1], after[2], batch]);

/** master 5763c09b5c src/core/facts/withdrawal-discovery.ts:117 (claim keys). */
export const claimKeys = (exec: Raw, sourceId: string, claimsJson: string): Rows => exec.executeRaw(
  `WITH w AS (
      SELECT w.visibility,w.fact_hash,COALESCE(w.subject,'*') AS subject,gbrain_fact_normalize(COALESCE(w.claim,
        (SELECT f.fact FROM facts f WHERE f.source_id=$1 AND f.visibility=w.visibility AND gbrain_fact_fingerprint(f.fact)=w.fact_hash LIMIT 1),
        (SELECT f.fact FROM facts f WHERE f.source_id=$1 AND f.visibility=w.visibility AND gbrain_fact_fingerprint_v1(f.fact)=w.fact_hash LIMIT 1))) AS norm
      FROM jsonb_to_recordset($2::text::jsonb) w(visibility text,fact_hash text,subject text,claim text)
    ) SELECT * FROM w`, [sourceId, claimsJson]);

/** master 5763c09b5c src/core/facts/withdrawal-discovery.ts:144 (claim matches). */
export const claimMatches = (exec: Raw, incomingJson: string, keysJson: string): Rows => exec.executeRaw(
  `SELECT DISTINCT i.id,i.ambiguous
      FROM jsonb_to_recordset($1::text::jsonb) i(id integer,slug text,claim text,visibility text,ambiguous boolean)
      JOIN jsonb_to_recordset($2::text::jsonb) w(visibility text,fact_hash text,subject text)
        ON (i.visibility IS NULL OR i.visibility=w.visibility) AND (w.subject='*' OR w.subject=i.slug)
          AND w.fact_hash IN (gbrain_fact_fingerprint(i.claim),gbrain_fact_fingerprint_v1(i.claim))`, [incomingJson, keysJson]);

/** master 5763c09b5c src/core/facts/withdrawal-discovery.ts:205 (target pages). */
export const targetPages = (exec: Raw, sourceId: string, ids: number[]): Rows =>
  exec.executeRaw('SELECT slug,id AS page_id,knowledge_revision AS revision FROM pages WHERE source_id=$1 AND id=ANY($2::int[])', [sourceId, ids]);

// ---------------------------------------------------------------- queue health

/** master 5763c09b5c src/commands/doctor/checks/queue-jobs.ts:79 (stalled-forever active jobs). */
export const queueStalled = (exec: Raw): Rows => exec.executeRaw(
  `SELECT id, name, started_at::text AS started_at, count(*) OVER ()::int AS total
           FROM minion_jobs
          WHERE status = 'active'
            AND started_at IS NOT NULL
            AND started_at < now() - interval '1 hour'
          ORDER BY started_at ASC
          LIMIT 5`);
/** master 5763c09b5c src/commands/doctor/checks/queue-jobs.ts:92 (waiting depth over the threshold). */
export const queueDepth = (exec: Raw, threshold: number): Rows => exec.executeRaw(
  `SELECT name, queue, count(*)::int AS depth
           FROM minion_jobs
          WHERE status = 'waiting'
          GROUP BY name, queue
         HAVING count(*) > $1
          ORDER BY depth DESC
          LIMIT 5`, [threshold]);
/** master 5763c09b5c src/commands/doctor/checks/queue-jobs.ts:103 (watchdog kills). */
export const queueRssKills = (exec: Raw): Rows => exec.executeRaw(
  `SELECT count(*)::int AS cnt
         FROM minion_jobs
        WHERE status IN ('dead', 'failed')
          AND finished_at > now() - interval '24 hours'
          AND error_text = 'aborted: watchdog'`);
/** master 5763c09b5c src/commands/doctor/checks/queue-jobs.ts:112 (prompt_too_long by dream phase). */
export const queuePromptTooLong = (exec: Raw): Rows => exec.executeRaw(
  `SELECT CASE WHEN key LIKE 'dream:patterns:%' THEN 'patterns'
                   WHEN key LIKE 'dream:synth%' THEN 'synthesize'
                   ELSE 'other' END AS phase,
              count(*)::int AS cnt
         FROM (SELECT COALESCE(idempotency_key, data->>'__released_idempotency_key') AS key
                 FROM minion_jobs
                WHERE name = 'subagent'
                  AND status = 'dead'
                  AND finished_at > now() - interval '24 hours'
                  AND error_text LIKE 'prompt_too_long:%') dead
        GROUP BY 1`);
/** master 5763c09b5c src/commands/doctor/checks/queue-jobs.ts:134 (old embed backfill). */
export const queueOldBackfill = (exec: Raw, oldWaitingHours: number): Rows => exec.executeRaw(
  `SELECT name,
              queue,
              count(*)::int AS depth,
              EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS oldest_age_seconds
         FROM minion_jobs
        WHERE status = 'waiting'
          AND name = 'embed-backfill'
        GROUP BY name, queue
       HAVING min(created_at) < now() - ($1::text::interval)
        ORDER BY oldest_age_seconds DESC`, [`${oldWaitingHours} hours`]);
/** master 5763c09b5c src/commands/doctor/checks/queue-jobs.ts:175 (waiting by queue). */
export const queueWaiting = (exec: Raw): Rows => exec.executeRaw(
  `SELECT queue,
              count(*)::int AS depth,
              EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS oldest_age_seconds
         FROM minion_jobs
        WHERE status = 'waiting'
        GROUP BY queue`);
/** master 5763c09b5c src/commands/doctor/checks/queue-jobs.ts:251 (divergence). */
export const queueDivergence = (exec: Raw): Rows => exec.executeRaw(
  `SELECT w.name,
                COALESCE(i.intake, '0') AS intake,
                COALESCE(c.completed, '0') AS completed,
                w.waiting
           FROM (SELECT name, count(*)::text AS waiting FROM minion_jobs
                  WHERE status = 'waiting' GROUP BY name) w
           LEFT JOIN (SELECT name, count(*)::text AS intake FROM minion_jobs
                  WHERE created_at > now() - interval '24 hours' GROUP BY name) i ON i.name = w.name
           LEFT JOIN (SELECT name, count(*)::text AS completed FROM minion_jobs
                  WHERE finished_at > now() - interval '24 hours' AND status = 'completed'
                  GROUP BY name) c ON c.name = w.name`);
/** master 5763c09b5c src/commands/doctor/checks/queue-jobs.ts:281 (TTL cancellations). */
export const queueTtlCancelled = (exec: Raw, prefix: string): Rows => exec.executeRaw(
  `SELECT name, count(*)::text AS count FROM minion_jobs
          WHERE status = 'cancelled' AND error_text LIKE $1
            AND finished_at > now() - interval '24 hours'
          GROUP BY name`, [`${prefix}%`]);
/** master 5763c09b5c src/commands/doctor/checks/queue-jobs.ts:406 (wedge counts per queue). */
export const queueWedgeCounts = (exec: Raw): Rows => exec.executeRaw(
  `SELECT queue,
         count(*) FILTER (WHERE status = 'active' AND lock_until > now()) AS active_healthy,
         count(*) FILTER (WHERE status = 'waiting') AS waiting,
         EXTRACT(EPOCH FROM (now() - max(updated_at) FILTER (WHERE status = 'completed'))) / 60
           AS mins_since_completion
       FROM minion_jobs
       WHERE queue NOT LIKE 'dream-inline-%'
       GROUP BY queue`);
/** master 5763c09b5c src/commands/doctor/checks/queue-jobs.ts:583 (private queue health). */
export const queuePrivateHealth = (exec: Raw): Rows => exec.executeRaw(
  `SELECT queue,
         min(data->>'source_id') AS source_id,
         count(*) FILTER (WHERE status = 'active' AND lock_until > now()) AS active_healthy,
         count(*) FILTER (WHERE status IN ('waiting','delayed')) AS waiting,
         count(*) FILTER (WHERE status = 'paused') AS paused,
         EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status IN ('waiting','delayed')))) / 60
           AS oldest_waiting_minutes,
         EXTRACT(EPOCH FROM min(created_at)) * 1000 AS birth_epoch_ms
       FROM minion_jobs
       WHERE queue LIKE 'dream-inline-%'
       GROUP BY queue
       ORDER BY queue`);
/** master 5763c09b5c src/core/minions/supervisor.ts:295 (wedge signals of one queue). */
export const queueWedgeSignals = (exec: Raw, queue: string, handlerNames: string[]): Rows => exec.executeRaw(
  `SELECT
       count(*) FILTER (WHERE status = 'active' AND lock_until < now())::text AS stalled,
       count(*) FILTER (WHERE status = 'active' AND lock_until > now())::text AS active_healthy,
       count(*) FILTER (WHERE status = 'waiting')::text AS waiting,
       count(*) FILTER (WHERE (status = 'waiting'
                          OR (status = 'delayed' AND delay_until <= now()))
                         AND name = ANY($2::text[]))::text AS waiting_claimable,
       max(updated_at) FILTER (WHERE status = 'completed')::text AS last_completed,
       max(updated_at) FILTER (WHERE status = 'completed'
                               AND name = ANY($2::text[]))::text AS last_completed_claimable
     FROM minion_jobs
     WHERE queue = $1`, [queue, handlerNames]);
/** master 5763c09b5c src/core/minions/supervisor.ts:414 (oldest waiting age). */
export const queueOldestWaiting = (exec: Raw, queue: string): Rows => exec.executeRaw(
  `SELECT EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS age
       FROM minion_jobs
      WHERE queue = $1 AND status = 'waiting'`, [queue]);
/** master 5763c09b5c src/core/advisor/collect-stalled-jobs.ts:23 (stuck active jobs). */
export const queueStuck = (exec: Raw): Rows => exec.executeRaw(
  `SELECT name, count(*)::int AS n
           FROM minion_jobs
          WHERE status = 'active'
            AND (lock_until < now() OR stalled_counter >= 2)
          GROUP BY name
          ORDER BY n DESC`);
