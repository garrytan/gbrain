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
import type { QueryOpts, SqlExecutor } from './executor.ts';
import type { ProjectionScanCursor } from '../page-state/projection-window.ts';
import { joinFragments, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

// ---------------------------------------------------------------------------------------------------------------------
// The host's housekeeping turn (housekeeping-turn.ts).

/** `claimHousekeepingTurn`: $1 op, $2 host id, $3 interval ms, $4 resident consumer kinds, $5 consumer live ms, $6 lease ms. */
export const CLAIM_HOUSEKEEPING_TURN_SQL = `WITH claim AS (
      INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
      SELECT $1::text, $2::text, '["leased"]'::jsonb, now() WHERE NOT EXISTS (SELECT 1 FROM persistence_consumers WHERE host_id=$2::text::uuid
        AND kind=ANY($4::text[]) AND mode IN ('full','promoted') AND renewed_at > now() - ($5::integer * interval '1 millisecond'))
      ON CONFLICT (op, fingerprint) DO UPDATE SET updated_at=now(), completed_keys='["leased"]'::jsonb
      WHERE op_checkpoints.updated_at <= now() - (CASE WHEN op_checkpoints.completed_keys='["done"]'::jsonb THEN $3::bigint ELSE $6::bigint END
        * interval '1 millisecond') RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM claim) AS claimed`;

/** `completeHousekeepingTurn`: $1 op, $2 host id. */
export const COMPLETE_HOUSEKEEPING_TURN_SQL = `UPDATE op_checkpoints SET completed_keys='["done"]'::jsonb, updated_at=now()
    WHERE op=$1 AND fingerprint=$2 AND completed_keys='["leased"]'::jsonb`;

/** A turn claim: the checkpoint op, this host, the interval after a finished turn, the lease, and which live consumers block it. */
export interface HousekeepingTurnClaim {
  op: string; hostId: string; intervalMs: number; leaseMs: number; consumerKinds: readonly string[]; consumerLiveMs: number;
}

/** True when this host's turn was free and is now leased to the caller. */
export async function claimHousekeepingTurn(exec: SqlExecutor, claim: HousekeepingTurnClaim, opts?: QueryOpts): Promise<boolean> {
  const [row] = await exec.executeRaw<{ claimed: boolean }>(CLAIM_HOUSEKEEPING_TURN_SQL,
    [claim.op, claim.hostId, claim.intervalMs, [...claim.consumerKinds], claim.consumerLiveMs, claim.leaseMs], opts);
  return row?.claimed === true;
}

/** Marks the host's leased turn finished. */
export async function completeHousekeepingTurn(exec: SqlExecutor, turn: { op: string; hostId: string }, opts?: QueryOpts): Promise<void> {
  await exec.executeRaw(COMPLETE_HOUSEKEEPING_TURN_SQL, [turn.op, turn.hostId], opts);
}

// ---------------------------------------------------------------------------------------------------------------------
// Receipts: the budget, the compaction listing and the true-up reads.

/** `housekeepReceipts`' state read: $1 retention config key, $2 floor days. */
export const RECEIPT_BUDGET_SQL = `SELECT (SELECT value FROM config WHERE key=$1) AS retention,(SELECT terminal_bytes::text FROM persistence_counters WHERE key='brain') AS used,
      to_char((now()-($2::double precision*interval '1 day')) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff`;

/** The explicit retention setting (null when unset), the brain's reserved terminal bytes (null with no counter) and now minus `floorDays`. */
export interface ReceiptBudget { retention: string | null; used: string | null; cutoff: string }

export async function readReceiptBudget(exec: LegacyUnscopedRead, retentionKey: string, floorDays: number): Promise<ReceiptBudget> {
  const [row] = await exec.executeRaw<ReceiptBudget>(RECEIPT_BUDGET_SQL, [retentionKey, floorDays]);
  return row!;
}

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
// `gbrain repair receipt-compaction`'s reads (repair/receipt-compaction.ts).

/** The window `--older-than` names: $1 hours. The cutoff is a UTC ISO time with microseconds; max_sequence is null on an empty journal. */
export const RECEIPT_COMPACTION_WINDOW_SQL = `SELECT to_char((now()-($1::double precision*interval '1 hour')) AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff,(SELECT max(sequence)::text FROM persistence_requests) AS max_sequence`;

export interface ReceiptCompactionWindow { cutoff: string; max_sequence: string | null }

export async function readReceiptCompactionWindow(exec: LegacyUnscopedRead, hours: number): Promise<ReceiptCompactionWindow> {
  const [row] = await exec.executeRaw<ReceiptCompactionWindow>(RECEIPT_COMPACTION_WINDOW_SQL, [hours]);
  return row!;
}

/**
 * The receipts a compaction would take (`OPEN_SYNC_CURSOR_EXCLUSION('r')` written out): $1 states, $2 the cutoff, $3
 * the newest sequence the preview saw. The newest committed managed-sync receipt of each worktree is kept. Oldest first.
 */
export const RECEIPT_COMPACTION_CANDIDATES_SQL = `SELECT r.id,r.request_id,r.sequence::text,r.source_id,r.principal_kind,r.principal_id,r.state,r.terminal_reservation::text
    FROM persistence_requests r
    WHERE r.state=ANY($1::text[]) AND r.recovery IS NULL AND NOT r.compacted AND r.completed_at < $2::timestamptz AND r.sequence <= $3::bigint
      AND NOT EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.state<>'committed')
      AND NOT (r.intent ? 'runId' AND EXISTS (SELECT 1 FROM op_checkpoints c
      WHERE c.op='managed-sync' AND c.completed_keys->0->>'runId'=r.intent->>'runId' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'))
    AND NOT (r.intent ? 'passId' AND EXISTS (SELECT 1 FROM op_checkpoints p
      WHERE p.op='managed-sync-pass' AND p.completed_keys->0->'telemetry'->>'pass_id'=r.intent->>'passId' AND p.completed_keys->0->'telemetry'->>'outcome'='open'))
      AND r.id NOT IN (SELECT DISTINCT ON (worktree_id) id FROM persistence_requests WHERE state='committed' AND worktree_id IS NOT NULL
        AND COALESCE(intent->>'kind','') LIKE 'managed_sync_%' ORDER BY worktree_id,completed_at DESC,sequence DESC)
    ORDER BY r.sequence`;

export interface ReceiptCompactionCandidate {
  id: string; request_id: string; sequence: string; source_id: string | null; principal_kind: string; principal_id: string;
  state: string; terminal_reservation: string;
}

export function listReceiptCompactionCandidates(exec: LegacyUnscopedRead, states: readonly string[], cutoff: string,
  maxSequence: string): Promise<ReceiptCompactionCandidate[]> {
  return exec.executeRaw<ReceiptCompactionCandidate>(RECEIPT_COMPACTION_CANDIDATES_SQL, [[...states], cutoff, maxSequence]);
}

/** The failed, conflicted and cancelled receipts a committed-only compaction leaves: $1 the cutoff. */
export const KEPT_FAILED_RECEIPTS_SQL = `SELECT count(*)::text AS n FROM persistence_requests
      WHERE state IN ('conflict','failed','cancelled') AND recovery IS NULL AND NOT compacted AND completed_at < $1::timestamptz`;

export async function countKeptFailedReceipts(exec: LegacyUnscopedRead, cutoff: string): Promise<number> {
  const [row] = await exec.executeRaw<{ n: string }>(KEPT_FAILED_RECEIPTS_SQL, [cutoff]);
  return Number(row?.n ?? 0);
}

/**
 * `sweepCompactedReservations`' window: $1 the sequence walked through, $2 rows. ORDER BY names the table's bigint
 * column: a bare `sequence` would sort the text alias ("10" before "9") and the cursor would skip rows.
 */
export const RESERVATIONS_AFTER_SQL = `SELECT id,sequence::text AS sequence,compacted
    FROM persistence_requests WHERE sequence>$1::bigint ORDER BY persistence_requests.sequence LIMIT $2`;

export function listReservationsAfter(exec: LegacyUnscopedRead, after: string, limit: number): Promise<Array<{ id: string; sequence: string; compacted: boolean }>> {
  return exec.executeRaw(RESERVATIONS_AFTER_SQL, [after, limit]);
}

/** `trueUpRequests`' candidates (`EFFECT_BYTES_SQL` and the unsettled states written out): $1 request ids. */
export const TRUE_UP_REQUESTS_SQL = `SELECT r.id,r.intent,r.authority,r.outcome,r.error_message,r.error_detail,r.client_request_id,
      r.terminal_reservation,r.principal_kind,r.principal_id,r.compacted,
      COALESCE((SELECT SUM(octet_length(data::text)+octet_length(kind)+1024) FROM persistence_effects e WHERE e.request_id=r.id),0)::text AS effect_bytes,
      EXISTS(SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.state IN ('queued','running')) AS unfinished
    FROM persistence_requests r WHERE r.id=ANY($1::uuid[]) AND r.state IN ('committed','failed','conflict','cancelled')`;

export function listTrueUpRequests<R = Record<string, unknown>>(exec: LegacyUnscopedRead, ids: readonly string[]): Promise<R[]> {
  return exec.executeRaw<R>(TRUE_UP_REQUESTS_SQL, [[...ids]]);
}

/**
 * `trueUpRequests`' compare-and-set (`EFFECT_BYTES_SQL`, the unsettled states and `TRUE_UP_CLAMP_SQL` written out): $1
 * request ids, $2 the reservations read, $3 what each receipt keeps, $4 the effect bytes each was sized with. A request
 * shrinks only while its reservation and effect bytes are unchanged and no effect is unsettled; the freed bytes leave the
 * brain and principal counters, clamped at zero, and each clamped counter adds one to `persistence.true_up.clamped`.
 */
export const TRUE_UP_RESERVATIONS_SQL = `WITH t AS (SELECT * FROM unnest($1::uuid[],$2::bigint[],$3::bigint[],$4::bigint[]) AS t(id,old,kept,effects)),
      done AS (UPDATE persistence_requests r SET terminal_reservation=t.kept FROM t
        WHERE r.id=t.id AND r.terminal_reservation=t.old
          AND NOT EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.state IN ('queued','running'))
          AND COALESCE((SELECT SUM(octet_length(data::text)+octet_length(kind)+1024) FROM persistence_effects e WHERE e.request_id=r.id),0)=t.effects
        RETURNING r.principal_kind,r.principal_id,t.old-t.kept AS freed),
      d AS (SELECT k.key,SUM(done.freed) AS freed FROM done
        CROSS JOIN LATERAL (VALUES ('brain'),('principal:'||done.principal_kind||':'||done.principal_id)) AS k(key) GROUP BY k.key),
      released AS (UPDATE persistence_counters c SET terminal_bytes=c.terminal_bytes-LEAST(d.freed,c.terminal_bytes) FROM d WHERE c.key=d.key),
      clamped AS (INSERT INTO config(key,value) SELECT 'persistence.true_up.clamped',k.n::text FROM (SELECT count(*) FROM d JOIN persistence_counters c ON c.key=d.key WHERE d.freed>c.terminal_bytes) AS k(n) WHERE k.n>0
      ON CONFLICT (key) DO UPDATE SET value=(CASE WHEN config.value ~ '^[0-9]+$' THEN config.value::bigint ELSE 0 END+EXCLUDED.value::bigint)::text)
      SELECT COALESCE(SUM(freed),0)::text AS freed FROM done`;

/** One request `trueUpRequests` shrinks: the reservation it read, what the receipt keeps and the effect bytes it sized. */
export interface TrueUpReservation { id: string; old: number; kept: number; effects: string }

/** Shrinks each unchanged settled request to what its receipt keeps; returns the bytes given back. */
export async function trueUpReservations(exec: SqlExecutor, rows: readonly TrueUpReservation[]): Promise<number> {
  if (!rows.length) return 0;
  const [freed] = await exec.executeRaw<{ freed: string }>(TRUE_UP_RESERVATIONS_SQL,
    [rows.map(r => r.id), rows.map(r => r.old), rows.map(r => r.kept), rows.map(r => r.effects)]);
  return Number(freed?.freed ?? 0);
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

// ---------------------------------------------------------------------------------------------------------------------
// The projection queue's housekeeping reads (page-body/projection.ts, page-state/projections.ts).

/** `SEGMENTED_JOB_PROBES` (projections.ts): live segmented pages of active sources. */
export const SEGMENTED_JOB_PROBES_SQL = `JOIN sources s ON s.incarnation=j.source_incarnation AND NOT s.archived
    JOIN pages p ON p.source_id=s.id AND p.slug=j.slug AND p.deleted_at IS NULL AND p.body_storage='segmented'`;
/** `SEGMENTED_PROJECTION_CLAIMED_SQL` (projections.ts). */
export const SEGMENTED_PROJECTION_CLAIMED_TEXT = "(split_part(j.reason,':',1)='segmented_projecting' AND j.updated_at>=now()-interval '60 seconds')";
/** `PROJECTION_RETRY_READY_SQL` (projections.ts). */
export const PROJECTION_RETRY_READY_TEXT = "(j.reason IS DISTINCT FROM 'rebuild_failed' OR j.updated_at<now()-interval '30 seconds')"
  + ` AND NOT ${SEGMENTED_PROJECTION_CLAIMED_TEXT}`
  + " AND NOT (split_part(j.reason,':',1)='chunk_replacement_continuing' AND j.updated_at>=now()-interval '60 seconds')";
/** A segmented row no other process holds (the filter when the retry cooldown is off). */
const SEGMENTED_PROJECTION_UNCLAIMED_TEXT = `NOT (split_part(j.reason,':',1)='segmented_projecting' AND j.updated_at>=now()-interval '60 seconds')`;

/** Which segmented queue rows `rebuildPendingSegmentedProjections` takes. */
export interface SegmentedProjectionFilter {
  limit: number; notAfter?: string; reasons?: readonly string[]; exclude?: readonly string[];
  /** false takes a row in its retry cooldown (still not one another process holds). */
  retryCooldown?: boolean;
}

export interface PendingSegmentedProjection { source_id: string; source_incarnation: string; slug: string; revision: string }

export async function listPendingSegmentedProjections(exec: LegacyUnscopedRead, filter: SegmentedProjectionFilter): Promise<PendingSegmentedProjection[]> {
  const filters: SqlFragment[] = [filter.retryCooldown === false
    ? sqlFragment`${trustedSql(SEGMENTED_PROJECTION_UNCLAIMED_TEXT)}` : sqlFragment`${trustedSql(PROJECTION_RETRY_READY_TEXT)}`];
  if (filter.notAfter !== undefined) filters.push(sqlFragment`j.updated_at<=${filter.notAfter}::text::timestamptz`);
  if (filter.reasons) filters.push(sqlFragment`j.reason=ANY(${[...filter.reasons]}::text[])`);
  if (filter.exclude?.length) filters.push(sqlFragment`NOT (j.source_incarnation::text || '/' || j.slug)=ANY(${[...filter.exclude]}::text[])`);
  const { rows } = await exec.run<PendingSegmentedProjection>(sqlFragment`SELECT s.id AS source_id,
      j.source_incarnation::text AS source_incarnation, j.slug, j.revision::text AS revision
    FROM page_projection_jobs j ${trustedSql(SEGMENTED_JOB_PROBES_SQL)}
    WHERE ${joinFragments(filters, ' AND ')} ORDER BY j.updated_at, j.slug COLLATE "C", j.source_incarnation LIMIT ${Math.max(1, filter.limit)}`);
  return rows;
}

/**
 * One row of the resident's window selection; on an empty queue one row of nulls carries the high water. `ord` is an
 * int4 in SQL (row_number() is int8, which the Postgres engine reads as a BigInt), so it is a number on every engine.
 */
export interface ProjectionWindowRow {
  lane: string | null; ord: number | null; source_incarnation: string | null; slug: string | null; revision: string | null; high_water: string | null;
}

/**
 * The resident's bounded selection: `residentWindowCtes` (page-state/projection-window.ts) written out, with its row
 * budgets (100 recent, 400 window) inlined; the recency lane, then the key window from `cursor`.
 */
export function projectionWindowFragment(cursor: Pick<ProjectionScanCursor, 'after' | 'highWater'>, retryCooldown: boolean): SqlFragment {
  // The lane order never reaches output: lane is the literal 'recent' or 'window', which sorts the same in every collation, and the rows feed projection job processing.
  return sqlFragment`WITH ${residentWindowCtesFragment(cursor, retryCooldown)}
    SELECT r.lane,r.ord,r.source_incarnation::text AS source_incarnation,r.slug,r.revision::text AS revision,h.at AS high_water
    FROM high_water h LEFT JOIN (SELECT source_incarnation,slug,revision,updated_at,lane,ord FROM recent
      UNION ALL SELECT source_incarnation,slug,revision,updated_at,lane,ord FROM win) r ON true
    ORDER BY r.lane,r.ord`;
}

/** `SEGMENTED_PROJECTION_CLAIMED_SQL` (projections.ts) as a fragment: a queue row `j` a live segmented claim holds. */
export function segmentedProjectionClaimedFragment(): SqlFragment {
  return sqlFragment`${trustedSql(SEGMENTED_PROJECTION_CLAIMED_TEXT)}`;
}

/** `PROJECTION_RETRY_READY_SQL` (projections.ts) as a fragment: a queue row `j` out of its retry cooldown. */
export function projectionRetryReadyFragment(): SqlFragment {
  return sqlFragment`${trustedSql(PROJECTION_RETRY_READY_TEXT)}`;
}

/**
 * `residentWindowCtes(cursor, params, filter)` (page-state/projection-window.ts) written out: the `mark`, `recent`,
 * `fwd`, `wrap`, `win` and `high_water` CTEs, the filter `PROJECTION_RETRY_READY_TEXT` or TRUE.
 */
export function residentWindowCtesFragment(cursor: Pick<ProjectionScanCursor, 'after' | 'highWater'>, retryCooldown: boolean): SqlFragment {
  const filter = retryCooldown ? trustedSql(PROJECTION_RETRY_READY_TEXT) : trustedSql('TRUE');
  const cols = trustedSql('j.source_incarnation,j.slug,j.revision,j.updated_at,j.reason');
  const inc = cursor.after.source_incarnation;
  const slug = cursor.after.slug;
  return sqlFragment`mark AS (SELECT COALESCE(${cursor.highWater}::text::timestamptz,(SELECT max(updated_at) FROM page_projection_jobs)) AS at),
    recent AS (SELECT ${cols},'recent'::text AS lane,0 AS ord FROM page_projection_jobs j, mark
      WHERE j.updated_at > mark.at - interval '10 minutes' AND ${filter} ORDER BY j.updated_at DESC, j.source_incarnation, j.slug COLLATE "C" LIMIT 100),
    fwd AS (SELECT ${cols} FROM page_projection_jobs j WHERE (j.source_incarnation,j.slug COLLATE "C") > (${inc}::uuid,${slug} COLLATE "C") AND ${filter}
      ORDER BY j.source_incarnation,j.slug COLLATE "C" LIMIT 400),
    wrap AS (SELECT ${cols} FROM page_projection_jobs j WHERE (j.source_incarnation,j.slug COLLATE "C") <= (${inc}::uuid,${slug} COLLATE "C") AND ${filter}
      ORDER BY j.source_incarnation,j.slug COLLATE "C" LIMIT 400),
    win AS (SELECT *,'window'::text AS lane,(row_number() OVER (ORDER BY part,source_incarnation,slug COLLATE "C"))::int AS ord FROM (
      SELECT * FROM ((SELECT *,0 AS part FROM fwd ORDER BY source_incarnation,slug COLLATE "C") UNION ALL (SELECT *,1 AS part FROM wrap ORDER BY source_incarnation,slug COLLATE "C")) u
      ORDER BY part,source_incarnation,slug COLLATE "C" LIMIT 400) w),
    high_water AS (SELECT max(updated_at)::text AS at FROM page_projection_jobs)`;
}

/** Runs `projectionWindowFragment`; on an empty queue it returns one row of nulls that carries the high water. */
export async function selectProjectionWindowJobs(exec: LegacyUnscopedRead, cursor: Pick<ProjectionScanCursor, 'after' | 'highWater'>, retryCooldown: boolean): Promise<ProjectionWindowRow[]> {
  return (await exec.run<ProjectionWindowRow>(projectionWindowFragment(cursor, retryCooldown))).rows;
}

// ---------------------------------------------------------------------------------------------------------------------
// The segmented projector's queue writes (page-body/projection.ts).

/** `claimSegmentedProjection`: $1 source id, $2 slug, $3 the claim. No row when the page has no queued job. */
export const CLAIM_SEGMENTED_PROJECTION_SQL = `WITH claimed AS (UPDATE page_projection_jobs SET reason=$3, updated_at=clock_timestamp()
      WHERE source_incarnation=(SELECT incarnation FROM sources WHERE id=$1) AND slug=$2 AND NOT (split_part(reason,':',1)='segmented_projecting' AND updated_at>=now()-interval '60 seconds') RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM claimed) AS claimed WHERE EXISTS (SELECT 1 FROM claimed) OR EXISTS (SELECT 1 FROM page_projection_jobs WHERE source_incarnation=(SELECT incarnation FROM sources WHERE id=$1) AND slug=$2)`;

/** `renewSegmentedProjectionClaim`: $1 source id, $2 slug, $3 the claim. */
export const RENEW_SEGMENTED_PROJECTION_CLAIM_SQL = `UPDATE page_projection_jobs SET updated_at=clock_timestamp() WHERE source_incarnation=(SELECT incarnation FROM sources WHERE id=$1) AND slug=$2 AND reason=$3 RETURNING 1`;

/** `releaseSegmentedProjectionClaim`: $1 source id, $2 slug, $3 the claim. */
export const RELEASE_SEGMENTED_PROJECTION_CLAIM_SQL = `UPDATE page_projection_jobs SET reason='canonical_change', updated_at=clock_timestamp() WHERE source_incarnation=(SELECT incarnation FROM sources WHERE id=$1) AND slug=$2 AND reason=$3`;

/** `deleteProjectionJob`: $1 source incarnation, $2 slug, $3 revision. */
export const DELETE_PROJECTION_JOB_SQL = 'DELETE FROM page_projection_jobs WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid';

/** `markProjectionRebuildFailed`: $1 source incarnation, $2 slug, $3 revision. */
export const MARK_PROJECTION_REBUILD_FAILED_SQL = `UPDATE page_projection_jobs j SET reason='rebuild_failed', updated_at=now()
        WHERE j.source_incarnation=$1::uuid AND j.slug=$2 AND j.revision=$3::uuid AND NOT (split_part(j.reason,':',1)='segmented_projecting' AND j.updated_at>=now()-interval '60 seconds')`;

/** A page by source and slug, as the projector names it. */
export interface ProjectionPageRef { sourceId: string; slug: string }
/** A queued job by its key and the revision it was queued at. */
export interface ProjectionJobRef { sourceIncarnation: string; slug: string; revision: string }
/** What a claim found: the job is now this build's, another live claim holds it, or the page has no queued job. */
export type SegmentedProjectionClaimOutcome = 'claimed' | 'held' | 'absent';

/** Claims the page's queued job for `claim` (`segmented_projecting:<uuid>`) unless another live claim holds it. */
export async function claimSegmentedProjection(exec: SqlExecutor, ref: ProjectionPageRef, claim: string): Promise<SegmentedProjectionClaimOutcome> {
  const [row] = await exec.executeRaw<{ claimed: boolean }>(CLAIM_SEGMENTED_PROJECTION_SQL, [ref.sourceId, ref.slug, claim]);
  return !row ? 'absent' : row.claimed ? 'claimed' : 'held';
}

/** Moves the claim's time to now; false when the job no longer carries `claim`, changing nothing. */
export async function renewSegmentedProjectionClaim(exec: SqlExecutor, ref: ProjectionPageRef, claim: string): Promise<boolean> {
  return (await exec.executeRaw(RENEW_SEGMENTED_PROJECTION_CLAIM_SQL, [ref.sourceId, ref.slug, claim])).length > 0;
}

/** Puts a job that still carries `claim` back to `canonical_change`. */
export async function releaseSegmentedProjectionClaim(exec: SqlExecutor, ref: ProjectionPageRef, claim: string): Promise<void> {
  await exec.executeRaw(RELEASE_SEGMENTED_PROJECTION_CLAIM_SQL, [ref.sourceId, ref.slug, claim]);
}

/** Deletes the job when it is still queued at `job.revision`. */
export async function deleteProjectionJob(exec: SqlExecutor, job: ProjectionJobRef): Promise<void> {
  await exec.executeRaw(DELETE_PROJECTION_JOB_SQL, [job.sourceIncarnation, job.slug, job.revision]);
}

/** Marks a job still queued at `job.revision` that no live claim holds `rebuild_failed`, starting its retry window. */
export async function markProjectionRebuildFailed(exec: SqlExecutor, job: ProjectionJobRef): Promise<void> {
  await exec.executeRaw(MARK_PROJECTION_REBUILD_FAILED_SQL, [job.sourceIncarnation, job.slug, job.revision]);
}
