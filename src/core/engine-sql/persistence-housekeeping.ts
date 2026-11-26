/**
 * Housekeeping statements: one SQL implementation for both engines (Rust engine persistence, write journal lane).
 *
 * The statements the consumer's housekeeping sent through `executeRaw` after a write: the host's housekeeping turn
 * (`housekeeping-turn.ts`), the receipt budget and compaction listing (`compaction-pass.ts`, `journal.ts`), the
 * `repair receipt-compaction` window, candidates and kept-failure count (`repair/receipt-compaction.ts`), the
 * true-up reads (`receipt-true-up.ts`), the capacity forecast reads (`capacity-forecast.ts`) and the projection queue
 * reads (`page-body/projection.ts`, `page-state/projections.ts`). As in `persistence-journal.ts`, the text is written out
 * in full so this module imports no persistence code; `test/persistence-journal-statements.test.ts` checks each copy
 * against the fragments the callers build it from. Decisions and arithmetic stay with the callers.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';

/**
 * `compactWriteReceiptsDetailed`'s listing (`UNRESOLVED_CALLER_REFUSAL_SQL('r')`, `OPEN_SYNC_CURSOR_EXCLUSION('r')` and
 * `NEWEST_SYNC_RECEIPT_EXCLUSION('r')` written out): $1 retention days. At most 100 rows, oldest first.
 */
export const COMPACTABLE_RECEIPTS_SQL = `SELECT * FROM persistence_requests r
    WHERE state IN ('committed','conflict','failed','cancelled') AND recovery IS NULL AND NOT compacted
    AND completed_at < now()-($1::double precision*interval '1 day')
    AND NOT EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.state<>'committed')
    AND NOT COALESCE((((r.state='failed' AND (r.error_code='writer_coordinator_required'
  OR (r.error_code='storage_error' AND r.error_message LIKE 'Publication failed (P0001)%'))) OR (r.state='conflict' AND r.error_code='source_changed'))
  AND r.operation IN ('put_page','add_timeline_entry','remember') AND NOT (r.operation='put_page' AND r.intent ? 'kind')
  AND NOT EXISTS (SELECT 1 FROM persistence_requests c WHERE (c.source_id=r.source_id AND c.slug=r.slug AND c.sequence>r.sequence AND (
    (c.digest=r.digest AND c.state IN ('committed','failed','queued','running','recovering'))
    OR (c.state IN ('committed','queued','running','recovering') AND (c.operation IN ('delete_page','purge_page') OR r.operation='put_page'))
    OR (r.slug='__managed_sync_checkpoint__' AND r.operation='submit_job' AND c.state='committed' AND c.operation='submit_job'
      AND COALESCE((SELECT k.intent->>'kind' FROM persistence_requests k WHERE k.id=r.id),'managed_sync_checkpoint')='managed_sync_checkpoint'
      AND COALESCE(c.intent->>'kind','managed_sync_checkpoint')='managed_sync_checkpoint')
    OR (r.operation='put_page' AND c.state='failed' AND c.operation='put_page' AND COALESCE(NOT (c.intent ? 'kind'), false))
    OR (r.operation='submit_job' AND c.operation='submit_job' AND c.state='committed' AND COALESCE(c.intent ? 'retryOf', false)
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
          SELECT 1 FROM lineage WHERE request_id=k.request_id))))))), false)
    AND NOT (r.intent ? 'runId' AND EXISTS (SELECT 1 FROM op_checkpoints c
      WHERE c.op='managed-sync' AND c.completed_keys->0->>'runId'=r.intent->>'runId' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'))
    AND NOT (r.intent ? 'passId' AND EXISTS (SELECT 1 FROM op_checkpoints p
      WHERE p.op='managed-sync-pass' AND p.completed_keys->0->'telemetry'->>'pass_id'=r.intent->>'passId' AND p.completed_keys->0->'telemetry'->>'outcome'='open'))
    AND NOT (r.state='committed' AND r.worktree_id IS NOT NULL AND (r.intent ? 'runId' OR r.intent ? 'passId')
      AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' AND r.id=(SELECT n.id FROM persistence_requests n WHERE n.worktree_id=r.worktree_id
        AND n.state='committed' AND COALESCE(n.intent->>'kind','') LIKE 'managed_sync_%' ORDER BY n.completed_at DESC, n.sequence DESC LIMIT 1))
    ORDER BY sequence LIMIT 100`;

export function listCompactableReceipts<R = Record<string, unknown>>(exec: LegacyUnscopedRead, retentionDays: number): Promise<R[]> {
  return exec.executeRaw<R>(COMPACTABLE_RECEIPTS_SQL, [retentionDays]);
}

// ---------------------------------------------------------------------------------------------------------------------
// The capacity forecast's reads (capacity-forecast.ts). The arithmetic stays in the forecast.

/** The forecast's 7-day window and its principal-index walk step. */
export const CAPACITY_WINDOW_DAYS = 7;
export const CAPACITY_WALK_STEP = 1000;

export const CAPACITY_COUNTERS_SQL = "SELECT key,lifetime_ids::text,terminal_bytes::text FROM persistence_counters WHERE key='brain' OR key LIKE 'principal:%' ORDER BY key COLLATE \"C\"";

/** One principal's window by UTC day (`COMPACTED_RECEIPT_BYTES_SQL('w','e')` written out): $1 kind, $2 id, $3 window days, $4 walk step. */
export const CAPACITY_PRINCIPAL_DAYS_SQL = `WITH RECURSIVE walk(lo,oldest,n) AS (
      SELECT min(sequence),min(created_at),count(*) FROM (SELECT sequence,created_at FROM persistence_requests
        WHERE principal_kind=$1 AND principal_id=$2 ORDER BY sequence DESC LIMIT $4) s
      UNION ALL
      SELECT c.lo,c.oldest,c.n FROM walk w CROSS JOIN LATERAL (SELECT min(sequence) AS lo,min(created_at) AS oldest,count(*) AS n FROM (SELECT sequence,created_at
        FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND sequence<w.lo ORDER BY sequence DESC LIMIT $4) s) c
      WHERE w.n=$4 AND w.oldest>now()-($3::double precision*interval '1 day') AND c.n>0),
    w AS (SELECT * FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND sequence>=(SELECT min(lo) FROM walk)
      AND created_at>now()-($3::double precision*interval '1 day')),
    e AS (SELECT request_id,SUM(octet_length(data::text)+octet_length(kind)+1024) AS bytes FROM persistence_effects WHERE request_id IN (SELECT id FROM w) GROUP BY request_id)
    SELECT to_char(w.created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
      count(*)::text AS ids,COALESCE(SUM(w.terminal_reservation),0)::text AS gross,COALESCE(SUM(LEAST(w.terminal_reservation,octet_length(w.authority::text)+COALESCE(octet_length(w.outcome::text),0)
  +COALESCE(octet_length(w.error_detail::text),0)+COALESCE(octet_length(w.client_request_id),0)+COALESCE(e.bytes,0)+1024)),0)::text AS net,
      count(*) FILTER (WHERE w.created_at>now()-interval '1 day')::text AS recent_ids,
      COALESCE(SUM(w.terminal_reservation) FILTER (WHERE w.created_at>now()-interval '1 day'),0)::text AS recent_gross,
      COALESCE(SUM(LEAST(w.terminal_reservation,octet_length(w.authority::text)+COALESCE(octet_length(w.outcome::text),0)
  +COALESCE(octet_length(w.error_detail::text),0)+COALESCE(octet_length(w.client_request_id),0)+COALESCE(e.bytes,0)+1024)) FILTER (WHERE w.created_at>now()-interval '1 day'),0)::text AS recent_net
    FROM w LEFT JOIN e ON e.request_id=w.id GROUP BY 1`;

/** Local-writer topology changes in the window, by UTC day: $1 window days. */
export const CAPACITY_TOPOLOGY_SQL = `SELECT 'principal:local_cli:'||principal_id::text AS scope,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
      count(*)::text AS ids,COALESCE(SUM(terminal_bytes),0)::text AS gross,COALESCE(SUM(terminal_bytes),0)::text AS net,
      count(*) FILTER (WHERE created_at>now()-interval '1 day')::text AS recent_ids,
      COALESCE(SUM(terminal_bytes) FILTER (WHERE created_at>now()-interval '1 day'),0)::text AS recent_gross,
      COALESCE(SUM(terminal_bytes) FILTER (WHERE created_at>now()-interval '1 day'),0)::text AS recent_net
    FROM persistence_topology_changes WHERE created_at>now()-($1::double precision*interval '1 day') GROUP BY 1,2`;

export const CAPACITY_HISTORY_SQL = `SELECT
      (SELECT EXTRACT(EPOCH FROM now()-created_at)/86400 FROM persistence_requests ORDER BY sequence LIMIT 1)::float8 AS age_days,
      (SELECT id::text FROM persistence_requests ORDER BY sequence LIMIT 1) AS first_id,
      (SELECT EXTRACT(EPOCH FROM now()-min(completed_at))/86400 FROM persistence_requests
        WHERE recovery IS NULL AND NOT compacted AND state IN ('committed','conflict','failed','cancelled'))::float8 AS compaction_age_days`;

/** What compaction would free per principal, and the legacy under-reserved receipts (`COMPACTED_RECEIPT_BYTES_SQL('r','e')` written out). */
export const CAPACITY_RECLAIM_SQL = `WITH r AS (SELECT * FROM persistence_requests
      WHERE recovery IS NULL AND NOT compacted AND state IN ('committed','conflict','failed','cancelled')),
    e AS (SELECT request_id,SUM(octet_length(data::text)+octet_length(kind)+1024) AS bytes,
      bool_or(state IN ('queued','running')) AS unfinished FROM persistence_effects WHERE request_id IN (SELECT id FROM r) GROUP BY request_id)
    SELECT 'principal:'||r.principal_kind||':'||r.principal_id AS scope,
      COALESCE(SUM(r.terminal_reservation-LEAST(r.terminal_reservation,octet_length(r.authority::text)+COALESCE(octet_length(r.outcome::text),0)
  +COALESCE(octet_length(r.error_detail::text),0)+COALESCE(octet_length(r.client_request_id),0)+COALESCE(e.bytes,0)+1024)) FILTER (WHERE NOT COALESCE(e.unfinished,false)),0)::text AS bytes,
      count(*) FILTER (WHERE COALESCE(octet_length(r.intent::text),0)+octet_length(r.authority::text)>r.terminal_reservation)::text AS under
    FROM r LEFT JOIN e ON e.request_id=r.id GROUP BY 1`;

export const CAPACITY_TABLE_BYTES_SQL = "SELECT pg_total_relation_size('persistence_requests')::text AS bytes";

/** One day of one scope's window; every count and byte sum is text. */
export interface CapacityDayRow { scope: string; day: string; ids: string; gross: string; net: string; recent_ids: string; recent_gross: string; recent_net: string }

/** What the capacity forecast computes from. `reclaim` is [] and `tableBytes` null in a light read. */
export interface CapacityForecastInputs {
  counters: Array<{ key: string; lifetime_ids: string; terminal_bytes: string }>;
  days: CapacityDayRow[];
  history: { age_days: number | null; compaction_age_days: number | null; first_id: string | null } | null;
  reclaim: Array<{ scope: string; bytes: string; under: string }>;
  tableBytes: number | null;
}

/**
 * The forecast's reads, issued together (GBRA-133: one round trip for the lot). The principal walks wait only for the
 * counters. The table size is null when the read fails.
 */
export async function readCapacityForecastInputs(exec: LegacyUnscopedRead, opts: { light?: boolean } = {}): Promise<CapacityForecastInputs> {
  const counterRead = exec.executeRaw<{ key: string; lifetime_ids: string; terminal_bytes: string }>(CAPACITY_COUNTERS_SQL);
  const principals = counterRead.then(rows => Promise.all(rows.filter(counter => counter.key !== 'brain').map(async counter => {
    const [, kind, ...rest] = counter.key.split(':');
    const id = rest.join(':');
    if (!kind || !id) return [];
    const days = await exec.executeRaw<Omit<CapacityDayRow, 'scope'>>(CAPACITY_PRINCIPAL_DAYS_SQL, [kind, id, CAPACITY_WINDOW_DAYS, CAPACITY_WALK_STEP]);
    return days.map(day => ({ ...day, scope: counter.key }));
  })));
  const topology = exec.executeRaw<CapacityDayRow>(CAPACITY_TOPOLOGY_SQL, [CAPACITY_WINDOW_DAYS]);
  const history = exec.executeRaw<NonNullable<CapacityForecastInputs['history']>>(CAPACITY_HISTORY_SQL);
  const reclaim = opts.light ? Promise.resolve([]) : exec.executeRaw<{ scope: string; bytes: string; under: string }>(CAPACITY_RECLAIM_SQL);
  const tableBytes = opts.light ? Promise.resolve(null) : exec.executeRaw<{ bytes: string }>(CAPACITY_TABLE_BYTES_SQL).then(r => Number(r[0]?.bytes), () => null);
  const [counters, principalRows, topologyRows, [historyRow], reclaimRows, bytes] = await Promise.all([counterRead, principals, topology, history, reclaim, tableBytes]);
  return { counters, days: [...principalRows.flat(), ...topologyRows], history: historyRow ?? null, reclaim: reclaimRows,
    tableBytes: bytes !== null && Number.isFinite(bytes) ? bytes : null };
}

/** `deleteProjectionJob`: $1 source incarnation, $2 slug, $3 revision. */
export const DELETE_PROJECTION_JOB_SQL = 'DELETE FROM page_projection_jobs WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid';
/** A queued job by its key and the revision it was queued at. */
export interface ProjectionJobRef { sourceIncarnation: string; slug: string; revision: string }

/** Deletes the job when it is still queued at `job.revision`. */
export async function deleteProjectionJob(exec: SqlExecutor, job: ProjectionJobRef): Promise<void> {
  await exec.executeRaw(DELETE_PROJECTION_JOB_SQL, [job.sourceIncarnation, job.slug, job.revision]);
}
