/**
 * Doctor terminal write failure reads: the four statements `src/core/persistence/terminal-failures.ts` ran through its
 * deadline-bound `executeRaw` (the grouped aggregate behind `readTerminalFailureSummary`, one batch of the drill-down
 * `readTerminalFailures`, and the two open-pass blocker reads of `readCheckpointBlockerMap`), moved here with the same
 * text and parameters. PGLite and Postgres run these exact statements. They splice nothing: the two big ones are the text
 * the readers composed from the `terminal-classify.ts` builders, written out, and test/doctor-terminal-sql.test.ts pins
 * each against that composition.
 *
 * The Rust engine answers (rust/docs/store/cli-reads-doctor-terminal.md):
 *  - served from its store: the aggregate and the batch, which read the request journal (`persistence_requests` rows and
 *    their extra columns); the classification columns the SQL computes are ported rule by rule, with the strings they
 *    test passed in from the TypeScript constants;
 *  - empty, no writer: the two open-pass blocker reads need `persistence_source_bindings` and the managed-sync pass
 *    row, which only `executeRaw` writes, so no such row exists on a Rust brain.
 */
export interface TerminalReadOpts { timeoutMs?: number; signal?: AbortSignal }
/** A read that takes the statement bound the terminal reader sets (Postgres applies it; the other engines run to the end). */
export type EngineTerminalRead = <R = Record<string, unknown>>(sql: string, params?: unknown[], opts?: TerminalReadOpts) => Promise<R[]>;

/** The members of this file. Each replaced a statement the terminal reader ran through its deadline bound, so src/core/statement-deadline.ts keeps that bound on them (BOUNDED_TYPED_READS). */
export const DOCTOR_TERMINAL_MEMBERS: readonly string[] = ['readTerminalFailureGroups', 'listTerminalFailureBatch', 'listOpenPassCheckpointBlockers', 'listWorktreeBlockerRequests'];

/** The columns every terminal read selects once per receipt. */
export interface TerminalKeyColumns {
  source_id: string; state: string; error_code: string | null; origin: string | null; reason: string | null; cause: string | null; operation: string; intent_kind?: string | null;
  has_recovery: boolean; blocked_reason: string | null; compacted: boolean; knock_on: boolean; routed_message: string | null; build: string | null;
}
/** One group of the aggregate (`set` 0), or a source's total row (`set` 1, key columns null). `oldest_age` is a bigint: a number or the text a driver gives. */
export type TerminalGroupRow = TerminalKeyColumns & {
  set: number; resolved: boolean | null; rows: number; in_window: number; n_24h: number; oldest: string | null; oldest_age: number | string | null;
  distinct_slugs: number; distinct_intents: number; recovery_ids: string[] | null; recovery_slugs: string[] | null;
  d2: number; d3: number; d4: number; d5: number; d6: number; d7: number; d8: number;
};
/** One receipt of the drill-down, with the later request that made it moot. */
export type TerminalBatchRow = TerminalKeyColumns & {
  request_id: string; sequence: string; slug: string; error_detail: Record<string, unknown> | null; ended_at: string; admitted_at: string; later_state: string | null; same_intent: boolean | null;
};
/** The arguments of the aggregate: the base set's span and the window in days, and the source filter (null reads every non-archived source). */
export interface TerminalGroupsQuery { spanDays: number; windowDays: number; sourceIds: readonly string[] | null }
/** The arguments of one batch: the source, the window in days, the `sequence` cursor (null starts at the newest) and the batch size. */
export interface TerminalBatchQuery { sourceId: string; windowDays: number; before: string | null; limit: number }
/** A source whose open pass has its checkpoint request admitted: the worktree and the checkpoint's request id. */
export interface OpenPassCheckpoint { source_id: string; worktree_id: string; checkpoint: string }
/** A request that blocks a pass checkpoint: a recovery row, or a pending sync page or checkpoint of the worktree. */
export interface WorktreeBlockerRequest { request_id: string; slug: string; state: string; code: string | null; recovery: boolean }

const READ_TERMINAL_FAILURE_GROUPS_SQL = `WITH base AS (
      SELECT r.id, r.request_id::text AS request_id, r.source_id, r.slug, r.digest, r.sequence, r.operation, r.intent->>'kind' AS intent_kind, r.state, r.error_code,
        r.error_detail->>'origin' AS origin, COALESCE(r.error_detail->>'reason', CASE WHEN r.error_detail->>'origin'='owner_exception' AND r.error_detail->>'errno' IN ('42P01','42703') THEN 'schema_missing' END) AS reason, r.error_detail->>'cause' AS cause,
        r.recovery IS NOT NULL AS has_recovery, r.blocked_reason, r.compacted, (COALESCE((r.state IN ('cancelled','failed','conflict') AND r.recovery IS NULL AND NOT COALESCE(r.publication_started,false)
    AND (r.error_detail->>'origin' = 'sync_knock_on'
      OR (r.state='cancelled' AND r.error_code='cancelled' AND (r.error_message IN ('An earlier page of the same sync did not commit; this page was not published and is re-frozen after that failure is resolved.','An earlier page of the same sync did not commit after lock_timeout on its lane group; this page was not published and is re-frozen on the next sync pass.','An earlier page of the same sync did not commit after statement_timeout on its lane group; this page was not published and is re-frozen on the next sync pass.','An earlier page of the same bulk sync group failed; this page was not published and is re-frozen after that failure is resolved.')
        OR r.error_message LIKE 'Its predecessor request % was never admitted; this page was not published and is re-frozen on the next sync pass.' OR r.error_message LIKE 'The first page of its group (request %) was cancelled because its predecessor request % was never admitted; this page was not published and is re-frozen on the next sync pass.'))
      OR (r.state IN ('conflict','failed') AND r.error_code='revision_conflict' AND r.error_message='An earlier page of this sync did not commit.'))), false) AND CASE WHEN r.error_detail->>'origin' = 'sync_knock_on' THEN (r.intent->>'kind' IS NULL OR r.intent->>'kind' IN ('managed_sync_import','managed_sync_delete')) ELSE COALESCE(r.intent->>'kind' IN ('managed_sync_import','managed_sync_delete'), false) END) AS knock_on,
        CASE
    WHEN r.error_code='source_changed' AND r.error_detail->>'reason' IS NULL THEN left(r.error_message, 500)
    WHEN r.error_code IN ('storage_error','writer_coordinator_required') AND r.error_detail IS NULL AND r.error_message LIKE 'Publication failed (P0001)%' THEN 'Publication failed (P0001)'
    WHEN r.error_code='storage_error' AND r.error_message ~* 'ECONN|ETIMEDOUT|EPIPE|connection.*closed|CONNECTION_ENDED' THEN 'connection closed' END AS routed_message, COALESCE(r.error_detail->'attempt'->>'consumer_version', r.admitter_version) AS build, COALESCE(r.completed_at, r.updated_at) AS ended_at
      FROM persistence_requests r JOIN sources s ON s.id=r.source_id AND s.archived IS NOT TRUE
      WHERE ((r.recovery IS NOT NULL AND r.state IN ('committed','recovering','failed','conflict','cancelled')) OR (r.state IN ('failed','conflict','cancelled') AND COALESCE(r.completed_at, r.updated_at) > now()-($1::int*interval '1 day')))
        AND ($2::text[] IS NULL OR r.source_id=ANY($2::text[]))
    ), resolved AS (
      SELECT r.id FROM base r WHERE NOT r.has_recovery AND EXISTS (SELECT 1 FROM persistence_requests c WHERE (c.source_id=r.source_id AND c.slug=r.slug AND c.sequence>r.sequence AND (
    (c.digest=r.digest AND c.state IN ('committed','failed','queued','running','recovering'))
    OR (c.state IN ('committed','queued','running','recovering') AND (c.operation IN ('delete_page','purge_page') OR r.operation='put_page'))
    OR (r.slug='__managed_sync_checkpoint__' AND r.operation='submit_job' AND c.state='committed' AND c.operation='submit_job'
      AND COALESCE((SELECT k.intent->>'kind' FROM persistence_requests k WHERE k.id=r.id),'managed_sync_checkpoint')='managed_sync_checkpoint'
      AND COALESCE(c.intent->>'kind','managed_sync_checkpoint')='managed_sync_checkpoint')
    OR (r.operation='put_page' AND c.state='failed' AND c.operation='put_page' AND COALESCE(NOT (c.intent ? 'kind'), false))
    OR (r.operation='submit_job' AND c.operation='submit_job' AND c.state='committed' AND r.intent_kind IN ('connector_v2_import','connector_v2_delete','connector_v2_checkpoint') AND COALESCE(c.intent ? 'retryOf', false)
      AND EXISTS (SELECT 1 FROM persistence_requests k, persistence_requests cc WHERE k.id=r.id AND cc.sequence=c.sequence
        AND k.intent->>'kind' IN ('connector_v2_import','connector_v2_delete','connector_v2_checkpoint')
        AND cc.intent->>'kind'=k.intent->>'kind' AND cc.principal_kind=k.principal_kind AND cc.principal_id=k.principal_id
        AND cc.source_incarnation=k.source_incarnation
        AND EXISTS (WITH RECURSIVE lineage(request_id, sequence, intent, depth) AS (
            SELECT cc.request_id, cc.sequence, cc.intent, 0
            UNION ALL
            SELECT p.request_id, p.sequence, p.intent, l.depth+1 FROM lineage l JOIN persistence_requests p
              ON p.principal_kind=k.principal_kind AND p.principal_id=k.principal_id
              AND p.request_id=CASE WHEN l.intent->>'retryOf' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (l.intent->>'retryOf')::uuid END
            WHERE l.depth<32 AND p.sequence<l.sequence AND p.source_id=k.source_id
              AND p.source_incarnation=k.source_incarnation AND p.operation=k.operation AND p.slug=k.slug AND p.intent->>'kind'=k.intent->>'kind')
          SELECT 1 FROM lineage WHERE request_id=k.request_id))))))
    ), tagged AS (
      SELECT b.*, (x.id IS NOT NULL OR (NOT b.has_recovery AND b.error_code='sync_pass_superseded')) AS resolved, (b.has_recovery OR b.ended_at > now()-($3::int*interval '1 day')) AS in_window, COALESCE((b.knock_on AND NOT b.has_recovery AND COALESCE(b.build ~ '^\\d+\\.\\d+\\.\\d+(\\.\\d+)?$' AND string_to_array(b.build || CASE WHEN b.build ~ '^\\d+\\.\\d+\\.\\d+$' THEN '.0' ELSE '' END, '.')::int[] < '{0,60,216,0}'::int[], false)) OR (NOT b.has_recovery AND NOT b.knock_on AND b.routed_message = 'Publication failed (P0001)' AND b.origin IS NULL AND b.error_code IN ('storage_error','writer_coordinator_required')) OR (NOT b.has_recovery AND NOT b.knock_on AND b.origin IS NULL AND b.error_code = 'fence_unrenderable' AND COALESCE(b.build ~ '^\\d+\\.\\d+\\.\\d+(\\.\\d+)?$' AND string_to_array(b.build || CASE WHEN b.build ~ '^\\d+\\.\\d+\\.\\d+$' THEN '.0' ELSE '' END, '.')::int[] < '{0,60,218,0}'::int[], false)) OR (NOT b.has_recovery AND NOT b.knock_on AND b.error_code = 'revision_conflict' AND (b.origin IS NOT DISTINCT FROM 'grandfather_retired' OR b.intent_kind IS NOT DISTINCT FROM 'managed_grandfather')), false) AS historical_build
      FROM base b LEFT JOIN resolved x ON x.id=b.id
    )
    SELECT GROUPING(state) AS set, source_id, state, error_code, origin, reason, cause, operation, intent_kind, has_recovery, blocked_reason, compacted, knock_on, routed_message, build, resolved,
      count(*) FILTER (WHERE in_window)::int AS rows, count(*) FILTER (WHERE in_window)::int AS in_window,
      count(*) FILTER (WHERE state IN ('failed','conflict','cancelled') AND ended_at > now()-interval '1 day')::int AS n_24h,
      count(*) FILTER (WHERE state IN ('failed','conflict','cancelled') AND ended_at <= now()-interval '1 day' AND ended_at > now()-interval '2 day')::int AS d2,
      count(*) FILTER (WHERE state IN ('failed','conflict','cancelled') AND ended_at <= now()-interval '2 day' AND ended_at > now()-interval '3 day')::int AS d3,
      count(*) FILTER (WHERE state IN ('failed','conflict','cancelled') AND ended_at <= now()-interval '3 day' AND ended_at > now()-interval '4 day')::int AS d4,
      count(*) FILTER (WHERE state IN ('failed','conflict','cancelled') AND ended_at <= now()-interval '4 day' AND ended_at > now()-interval '5 day')::int AS d5,
      count(*) FILTER (WHERE state IN ('failed','conflict','cancelled') AND ended_at <= now()-interval '5 day' AND ended_at > now()-interval '6 day')::int AS d6,
      count(*) FILTER (WHERE state IN ('failed','conflict','cancelled') AND ended_at <= now()-interval '6 day' AND ended_at > now()-interval '7 day')::int AS d7,
      count(*) FILTER (WHERE state IN ('failed','conflict','cancelled') AND ended_at <= now()-interval '7 day' AND ended_at > now()-interval '8 day')::int AS d8,
      to_char(min(ended_at) FILTER (WHERE in_window) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS oldest,
      floor(EXTRACT(EPOCH FROM now()-min(ended_at) FILTER (WHERE in_window)))::bigint AS oldest_age,
      count(DISTINCT slug) FILTER (WHERE in_window AND NOT resolved AND NOT has_recovery AND NOT historical_build)::int AS distinct_slugs,
      count(DISTINCT digest) FILTER (WHERE in_window AND NOT resolved AND NOT has_recovery AND NOT historical_build)::int AS distinct_intents,
      (array_agg(request_id ORDER BY sequence) FILTER (WHERE has_recovery))[1:20] AS recovery_ids,
      (array_agg(slug ORDER BY sequence) FILTER (WHERE has_recovery))[1:20] AS recovery_slugs
    FROM tagged
    GROUP BY GROUPING SETS ((source_id, state, error_code, origin, reason, cause, operation, intent_kind, has_recovery, blocked_reason, compacted, knock_on, routed_message, build, resolved), (source_id))
    -- Every group key, text by byte: a source's blockers, defects and tied categories list the same way on every engine and locale.
    ORDER BY source_id COLLATE "C", 1, state COLLATE "C", error_code COLLATE "C", origin COLLATE "C", reason COLLATE "C", cause COLLATE "C", operation COLLATE "C",
      intent_kind COLLATE "C", has_recovery, blocked_reason COLLATE "C", compacted, knock_on, routed_message COLLATE "C", build COLLATE "C", resolved`;

const LIST_TERMINAL_FAILURE_BATCH_SQL = `SELECT r.request_id::text AS request_id, r.sequence::text AS sequence, r.source_id, r.slug, r.operation, r.intent_kind, r.state, r.error_code, r.error_detail,
          r.error_detail->>'origin' AS origin, r.error_detail->>'reason' AS reason, r.error_detail->>'cause' AS cause,
          r.recovery IS NOT NULL AS has_recovery, r.blocked_reason, r.compacted, (COALESCE((r.state IN ('cancelled','failed','conflict') AND r.recovery IS NULL AND NOT COALESCE(r.publication_started,false)
    AND (r.error_detail->>'origin' = 'sync_knock_on'
      OR (r.state='cancelled' AND r.error_code='cancelled' AND (r.error_message IN ('An earlier page of the same sync did not commit; this page was not published and is re-frozen after that failure is resolved.','An earlier page of the same sync did not commit after lock_timeout on its lane group; this page was not published and is re-frozen on the next sync pass.','An earlier page of the same sync did not commit after statement_timeout on its lane group; this page was not published and is re-frozen on the next sync pass.','An earlier page of the same bulk sync group failed; this page was not published and is re-frozen after that failure is resolved.')
        OR r.error_message LIKE 'Its predecessor request % was never admitted; this page was not published and is re-frozen on the next sync pass.' OR r.error_message LIKE 'The first page of its group (request %) was cancelled because its predecessor request % was never admitted; this page was not published and is re-frozen on the next sync pass.'))
      OR (r.state IN ('conflict','failed') AND r.error_code='revision_conflict' AND r.error_message='An earlier page of this sync did not commit.'))), false) AND CASE WHEN r.error_detail->>'origin' = 'sync_knock_on' THEN (r.intent->>'kind' IS NULL OR r.intent->>'kind' IN ('managed_sync_import','managed_sync_delete')) ELSE COALESCE(r.intent->>'kind' IN ('managed_sync_import','managed_sync_delete'), false) END) AS knock_on, CASE
    WHEN r.error_code='source_changed' AND r.error_detail->>'reason' IS NULL THEN left(r.error_message, 500)
    WHEN r.error_code IN ('storage_error','writer_coordinator_required') AND r.error_detail IS NULL AND r.error_message LIKE 'Publication failed (P0001)%' THEN 'Publication failed (P0001)'
    WHEN r.error_code='storage_error' AND r.error_message ~* 'ECONN|ETIMEDOUT|EPIPE|connection.*closed|CONNECTION_ENDED' THEN 'connection closed' END AS routed_message, COALESCE(r.error_detail->'attempt'->>'consumer_version', r.admitter_version) AS build,
          to_char(COALESCE(r.completed_at, r.updated_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ended_at, to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS admitted_at,
          later.state AS later_state, later.same_intent
        FROM (SELECT p.*, p.intent->>'kind' AS intent_kind FROM persistence_requests p
          WHERE p.source_id=$1 AND ((p.recovery IS NOT NULL AND p.state IN ('committed','recovering','failed','conflict','cancelled')) OR (p.state IN ('failed','conflict','cancelled') AND COALESCE(p.completed_at, p.updated_at) > now()-($2::int*interval '1 day')))
            AND ($3::bigint IS NULL OR p.sequence < $3::bigint)
          ORDER BY p.sequence DESC LIMIT $4) r
        LEFT JOIN LATERAL (SELECT c.state, c.digest=r.digest AS same_intent FROM persistence_requests c WHERE (c.source_id=r.source_id AND c.slug=r.slug AND c.sequence>r.sequence AND (
    (c.digest=r.digest AND c.state IN ('committed','failed','queued','running','recovering'))
    OR (c.state IN ('committed','queued','running','recovering') AND (c.operation IN ('delete_page','purge_page') OR r.operation='put_page'))
    OR (r.slug='__managed_sync_checkpoint__' AND r.operation='submit_job' AND c.state='committed' AND c.operation='submit_job'
      AND COALESCE((SELECT k.intent->>'kind' FROM persistence_requests k WHERE k.id=r.id),'managed_sync_checkpoint')='managed_sync_checkpoint'
      AND COALESCE(c.intent->>'kind','managed_sync_checkpoint')='managed_sync_checkpoint')
    OR (r.operation='put_page' AND c.state='failed' AND c.operation='put_page' AND COALESCE(NOT (c.intent ? 'kind'), false))
    OR (r.operation='submit_job' AND c.operation='submit_job' AND c.state='committed' AND r.intent_kind IN ('connector_v2_import','connector_v2_delete','connector_v2_checkpoint') AND COALESCE(c.intent ? 'retryOf', false)
      AND EXISTS (SELECT 1 FROM persistence_requests k, persistence_requests cc WHERE k.id=r.id AND cc.sequence=c.sequence
        AND k.intent->>'kind' IN ('connector_v2_import','connector_v2_delete','connector_v2_checkpoint')
        AND cc.intent->>'kind'=k.intent->>'kind' AND cc.principal_kind=k.principal_kind AND cc.principal_id=k.principal_id
        AND cc.source_incarnation=k.source_incarnation
        AND EXISTS (WITH RECURSIVE lineage(request_id, sequence, intent, depth) AS (
            SELECT cc.request_id, cc.sequence, cc.intent, 0
            UNION ALL
            SELECT p.request_id, p.sequence, p.intent, l.depth+1 FROM lineage l JOIN persistence_requests p
              ON p.principal_kind=k.principal_kind AND p.principal_id=k.principal_id
              AND p.request_id=CASE WHEN l.intent->>'retryOf' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (l.intent->>'retryOf')::uuid END
            WHERE l.depth<32 AND p.sequence<l.sequence AND p.source_id=k.source_id
              AND p.source_incarnation=k.source_incarnation AND p.operation=k.operation AND p.slug=k.slug AND p.intent->>'kind'=k.intent->>'kind')
          SELECT 1 FROM lineage WHERE request_id=k.request_id)))))
          ORDER BY (c.digest=r.digest AND c.state='committed') DESC, (c.digest=r.digest) DESC, c.sequence LIMIT 1) later ON r.recovery IS NULL
        ORDER BY r.sequence DESC`;

const LIST_OPEN_PASS_CHECKPOINT_BLOCKERS_SQL = `SELECT s.id AS source_id, b.worktree_id::text AS worktree_id, r.request_id::text AS checkpoint
    FROM sources s JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
    JOIN op_checkpoints p ON p.op=$1 AND p.fingerprint=s.id||':'||s.incarnation::text AND p.completed_keys->0->'telemetry'->>'outcome'='open'
    JOIN persistence_requests r ON r.worktree_id=b.worktree_id AND r.state IN ('queued','running','recovering')
      AND r.intent->>'kind'='managed_sync_checkpoint' AND r.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id'
    WHERE s.archived IS NOT TRUE AND ($2::text[] IS NULL OR s.id=ANY($2::text[]))`;

const LIST_WORKTREE_BLOCKER_REQUESTS_SQL = `SELECT DISTINCT ON (request_id) request_id, slug, state, code, recovery FROM (
        (SELECT r.request_id::text AS request_id, r.slug, r.state, r.error_code AS code, true AS recovery, r.sequence FROM persistence_requests r
          WHERE r.worktree_id=$1::uuid AND r.recovery IS NOT NULL ORDER BY r.sequence LIMIT 20)
        UNION ALL (SELECT r.request_id::text, r.slug, r.state, r.error_code, false, r.sequence FROM persistence_requests r
          WHERE r.worktree_id=$1::uuid AND r.state IN ('queued','running','recovering') AND r.request_id::text<>$2
            AND r.intent->>'kind' IN ('managed_sync_import','managed_sync_delete','managed_sync_checkpoint') ORDER BY r.sequence LIMIT 20)) blockers
      ORDER BY request_id, recovery DESC`;

/** The terminal receipts of the window and every receipt holding a recovery record, grouped on the columns `classifyTerminal` reads, with the per-source totals row. */
export async function readTerminalFailureGroups(raw: EngineTerminalRead, query: TerminalGroupsQuery, opts?: TerminalReadOpts): Promise<TerminalGroupRow[]> {
  return raw<TerminalGroupRow>(READ_TERMINAL_FAILURE_GROUPS_SQL, [query.spanDays, query.sourceIds ? [...query.sourceIds] : null, query.windowDays], opts);
}

/** One source's terminal receipts and recovery holders, newest first by `sequence`, each with the later request that made it moot. */
export async function listTerminalFailureBatch(raw: EngineTerminalRead, query: TerminalBatchQuery, opts?: TerminalReadOpts): Promise<TerminalBatchRow[]> {
  return raw<TerminalBatchRow>(LIST_TERMINAL_FAILURE_BATCH_SQL, [query.sourceId, query.windowDays, query.before, query.limit], opts);
}

/** Non-archived sources whose open pass (`passOp` row, outcome `open`) has its managed-sync checkpoint request pending. */
export async function listOpenPassCheckpointBlockers(raw: EngineTerminalRead, passOp: string, sourceIds: readonly string[] | null): Promise<OpenPassCheckpoint[]> {
  return raw<OpenPassCheckpoint>(LIST_OPEN_PASS_CHECKPOINT_BLOCKERS_SQL, [passOp, sourceIds ? [...sourceIds] : null]);
}

/** Up to 20 recovery rows of the worktree and up to 20 pending sync page or checkpoint requests other than `checkpoint`, one row per request. */
export async function listWorktreeBlockerRequests(raw: EngineTerminalRead, worktreeId: string, checkpoint: string): Promise<WorktreeBlockerRequest[]> {
  return raw<WorktreeBlockerRequest>(LIST_WORKTREE_BLOCKER_REQUESTS_SQL, [worktreeId, checkpoint]);
}

/** The statements, for the test that pins them to the text their reader composed. */
export const DOCTOR_TERMINAL_STATEMENTS = {
  groups: READ_TERMINAL_FAILURE_GROUPS_SQL, batch: LIST_TERMINAL_FAILURE_BATCH_SQL,
} as const;
