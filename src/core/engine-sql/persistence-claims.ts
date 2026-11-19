/**
 * Write-claim statements: one SQL implementation for both engines (Rust engine persistence, write journal lane).
 *
 * The statements `src/core/persistence/journal.ts`, `authority.ts` and `consumer.ts` sent through `executeRaw` around
 * admission and the claim: the source membership read, the topology-change probe, the claim check
 * (`hasClaimableWrite`), the lease renewal and the expired-claim release. As in `persistence-journal.ts`, the text is
 * written out in full so this module imports no persistence code; `test/persistence-journal-statements.test.ts`
 * checks each copy against the fragments the journal builds it from. Decisions stay with the callers.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { QueryOpts, SqlExecutor } from './executor.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

/** `PERSISTENCE_PROTOCOL_PREDICATE` (protocol.ts): declares protocol 2 for the statement; always true. */
export const PROTOCOL_PREDICATE_SQL = "set_config('gbrain.persistence_protocol','2',true)='2'";

/**
 * `foregroundPrioritySql()` (journal.ts) with no environment override: the brain config row, on unless `0`/`false`.
 * `foregroundPriorityText` adds the override the caller read from the environment.
 */
export const FOREGROUND_PRIORITY_CONFIG_SQL = "NOT EXISTS (SELECT 1 FROM config WHERE key='sync.foreground_priority' AND lower(trim(value)) IN ('0','false'))";

/** The three texts the `foreground_priority` switch can take. */
const PRIORITY_SQL = { on: 'true', off: 'false', config: FOREGROUND_PRIORITY_CONFIG_SQL } as const;

function priorityKey(priority: boolean | null | undefined): keyof typeof PRIORITY_SQL {
  return priority === true ? 'on' : priority === false ? 'off' : 'config';
}

/** The `foreground_priority` switch as SQL: the environment override when the caller has one, otherwise the config row. */
export function foregroundPriorityText(priority: boolean | null | undefined): string {
  return PRIORITY_SQL[priorityKey(priority)];
}

/**
 * `claimableWriteSql(priority)` (journal.ts) with no lane roots: the rows `claimNextWrite` may claim. `hostId` and
 * `excludeRoots` bind as $1 and $2, the text the journal writes.
 */
export function claimableWriteFragment(priority: boolean | null | undefined, hostId: string, excludeRoots: string[]): SqlFragment {
  const p = trustedSql(PRIORITY_SQL[priorityKey(priority)]);
  return sqlFragment`(r.state='queued' OR (r.state='deferred' AND (r.deferred_refresh_id IS NOT NULL OR r.deferred_import_from IS NOT NULL)
        AND (r.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=r.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (r.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=r.source_id AND COALESCE(imported.last_commit,'')<>r.deferred_import_from)))) AND (r.worktree_id IS NULL OR (w.owner_host_id=${hostId}::uuid AND w.state='active'))
      AND (r.worktree_id IS NULL OR NOT EXISTS (SELECT 1 FROM persistence_worktree_refreshes fence WHERE fence.worktree_id=r.worktree_id
        AND fence.state IN ('fenced','merged','recovery_required')))
      AND NOT (COALESCE(r.worktree_id::text,'db:'||r.source_incarnation::text)=ANY(${excludeRoots}::text[]))
      AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=r.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_effects mirror WHERE mirror.worktree_id=r.worktree_id
        AND mirror.kind='withdrawal-mirror' AND mirror.state IN ('queued','running')
        AND (NOT (mirror.data ? 'targets') OR mirror.data->'targets' @> jsonb_build_array(jsonb_build_object('slug',r.slug))))
      AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=r.worktree_id AND blocked.recovery IS NOT NULL)
      AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=now())
      AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE r.worktree_id IS NOT NULL AND earlier.worktree_id=r.worktree_id AND earlier.sequence<r.sequence
        AND earlier.state IN ('queued','running','recovering') AND NOT ((${p}) AND NOT COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%'
  AND (earlier.state='queued' OR (earlier.state='running' AND earlier.intent ? 'lane'
    AND earlier.worktree_id::text=ANY('{}'::text[])))
  AND earlier.recovery IS NULL AND COALESCE(earlier.intent->>'kind','') LIKE 'managed_sync_%' AND NOT (earlier.source_id=r.source_id AND (earlier.slug=r.slug
  OR earlier.page_id=r.page_id OR earlier.intent->'renameFrom'->>'slug'=r.slug))))
      AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE r.worktree_id IS NULL AND earlier.worktree_id IS NULL AND earlier.source_incarnation=r.source_incarnation
        AND earlier.sequence<r.sequence
        AND earlier.state IN ('queued','running','recovering') AND NOT ((${p}) AND NOT COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%'
  AND (earlier.state='queued' OR (earlier.state='running' AND earlier.intent ? 'lane'
    AND earlier.worktree_id::text=ANY('{}'::text[])))
  AND earlier.recovery IS NULL AND COALESCE(earlier.intent->>'kind','') LIKE 'managed_sync_%' AND NOT (earlier.source_id=r.source_id AND (earlier.slug=r.slug
  OR earlier.page_id=r.page_id OR earlier.intent->'renameFrom'->>'slug'=r.slug))))
      AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE r.worktree_id IS NOT NULL AND earlier.worktree_id=r.worktree_id AND earlier.sequence<r.sequence AND (earlier.state='deferred' AND (earlier.deferred_refresh_id IS NOT NULL OR earlier.deferred_import_from IS NOT NULL)
        AND (earlier.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=earlier.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (earlier.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=earlier.source_id AND COALESCE(imported.last_commit,'')<>earlier.deferred_import_from))))
      AND NOT ((${p}) AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' AND EXISTS (SELECT 1 FROM persistence_requests ahead
        WHERE ahead.worktree_id=r.worktree_id AND ahead.sequence>r.sequence AND ahead.state IN ('running','recovering') AND NOT COALESCE(ahead.intent->>'kind','') LIKE 'managed_sync_%'))`;
}

/** `hasClaimableWrite`: whether `claimNextWrite` would find a row now. */
export function hasClaimableWriteFragment(priority: boolean | null | undefined, hostId: string, excludeRoots: string[]): SqlFragment {
  return sqlFragment`SELECT EXISTS (SELECT 1 FROM persistence_requests r
      LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id WHERE ${claimableWriteFragment(priority, hostId, excludeRoots)} LIMIT 1) AS claimable`;
}

/** `renewWriteClaim` (the protocol predicate written out, see `PROTOCOL_PREDICATE_SQL`): extends the lease of a claim still held under its token, with the phase when one is given. */
export const RENEW_CLAIM_SQL = `UPDATE persistence_requests SET
    claim_expires_at=now()+($3::double precision*interval '1 millisecond'),updated_at=now(),claim_phase=COALESCE($4::text::jsonb,claim_phase)
    WHERE id=$1::uuid AND execution_token=$2::uuid AND state='running' AND set_config('gbrain.persistence_protocol','2',true)='2' RETURNING id`;

/** The consumer's `expired_claims` statement (the protocol predicate and `EXPIRED_PREPARING_CHARGE_SQL('r')` written out): $1 = host id, $2 = charge a preparing claim, $3 = dead claim owners. */
export const EXPIRE_CLAIMS_SQL = `WITH expired AS (
        SELECT r.id FROM persistence_requests r WHERE r.state='running' AND r.recovery IS NULL
        AND r.publication_started=false AND set_config('gbrain.persistence_protocol','2',true)='2'
        AND (r.claim_expires_at<now() OR r.claim_phase->>'token'=r.execution_token::text
          AND concat_ws(':',r.claim_phase->'owner'->>'pid',r.claim_phase->'owner'->>'nonce',r.claim_phase->'owner'->>'start')=ANY($3::text[]))
        AND (r.worktree_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktrees w WHERE w.id=r.worktree_id AND w.owner_host_id=$1::uuid))
        ORDER BY r.sequence LIMIT 100 FOR UPDATE OF r SKIP LOCKED)
        UPDATE persistence_requests r SET state='queued',execution_token=NULL,claim_expires_at=NULL,
          preparation_attempts=r.preparation_attempts+CASE WHEN $2::boolean THEN CASE WHEN r.claim_phase->>'phase'='preparing' AND r.claim_phase->>'token'=r.execution_token::text THEN 1 ELSE 0 END ELSE 0 END
        FROM expired WHERE r.id=expired.id`;

/** One source's membership: its incarnation and whether it is archived. */
export interface SourceMembership { incarnation: string; archived: boolean }

/** A claim renewal: request `id`, its claim `token`, the new lease and, optionally, the phase to record (claim-phase.ts `claimPhaseStamp`). */
export interface ClaimRenewal { id: string; token: string; leaseMs: number; phaseJson: string | null }

/** An expired-claim release: this consumer's host id, whether a claim that expired while preparing counts an attempt, and the dead owners. */
export interface ClaimExpiry { hostId: string; charge: boolean; deadOwners: string[] }

/** Source `sourceId`'s membership, or null; `lock` reads it FOR SHARE (admission holds it until the transaction ends). */
export async function readSourceMembership(exec: SqlExecutor, sourceId: string, opts: { lock?: boolean } = {}): Promise<SourceMembership | null> {
  const sql = opts.lock ? 'SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE' : 'SELECT incarnation,archived FROM sources WHERE id=$1';
  const [row] = await exec.executeRaw<SourceMembership>(sql, [sourceId]);
  return row ?? null;
}

/** A `persistence_topology_changes` row: one source lifecycle change (remove, purge, clone, deactivate) of a local writer. */
export interface TopologyChange {
  id:string; principal_id:string; request_id:string; digest:string; operation:string; source_id:string;
  source_incarnation:string|null; worktree_ids:string[]; state:'recovering'|'committed'|'failed';
  recovery:Record<string,unknown>|null; recovery_bytes:number; intent_bytes:number; terminal_bytes:number; outcome:Record<string,unknown>|null;
}

/** The columns `insertTopologyChange` writes; the omitted byte columns take the table defaults' values (0). */
export interface TopologyChangeInsert {
  principalId: string; requestId: string; digest: string; operation: string; sourceId: string;
  sourceIncarnation: string | null; worktreeIds: string[]; state: TopologyChange['state'];
  recovery?: Record<string, unknown> | null; recoveryBytes?: number; intentBytes?: number; terminalBytes: number;
  outcome: Record<string, unknown> | null;
}

/** The lifecycle receipt row of (principal, request id) (topology-receipts.ts priorTopologyChange). */
export const TOPOLOGY_CHANGE_SQL = 'SELECT * FROM persistence_topology_changes WHERE principal_id=$1::uuid AND request_id=$2::uuid';

/** The lifecycle receipt insert (topology-receipts.ts recordTopologyChange and admitTopologyRetire). */
export const INSERT_TOPOLOGY_CHANGE_SQL = `INSERT INTO persistence_topology_changes
    (principal_id,request_id,digest,operation,source_id,source_incarnation,worktree_ids,state,recovery,recovery_bytes,terminal_bytes,outcome,intent_bytes)
    VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid[],$8,$9::text::jsonb,$10,$11,$12::text::jsonb,$13) RETURNING *`;

/** The topology change local writer `principalId` recorded under `requestId`, or null. */
export async function readTopologyChange(exec: LegacyUnscopedRead, principalId: string, requestId: string): Promise<TopologyChange | null> {
  const [row] = await exec.executeRaw<TopologyChange>(TOPOLOGY_CHANGE_SQL, [principalId, requestId]);
  return row ?? null;
}

/** Records one topology change and returns the stored row; (principal, request id) is unique, so a reused id refuses. */
export async function insertTopologyChange(exec: SqlExecutor, row: TopologyChangeInsert): Promise<TopologyChange> {
  const [inserted] = await exec.executeRaw<TopologyChange>(INSERT_TOPOLOGY_CHANGE_SQL, [row.principalId, row.requestId, row.digest, row.operation,
    row.sourceId, row.sourceIncarnation, row.worktreeIds, row.state, row.recovery ? JSON.stringify(row.recovery) : null, row.recoveryBytes ?? 0,
    row.terminalBytes, row.outcome ? JSON.stringify(row.outcome) : null, row.intentBytes ?? 0]);
  return inserted!;
}

/** The first of `requestIds` a topology change of local writer `principalId` already used (a lifecycle id), as `[{ request_id }]`, or []. */
export function findTopologyChanges(exec: LegacyUnscopedRead, principalId: string, requestIds: string[]): Promise<Array<{ request_id: string }>> {
  return exec.executeRaw<{ request_id: string }>('SELECT request_id FROM persistence_topology_changes WHERE principal_id=$1::uuid AND request_id=ANY($2::uuid[]) LIMIT 1',
    [principalId, requestIds]);
}

/** Whether a claim would find a row now (read-only: no lock and no claim); `priority` is the switch's environment override. */
export async function hasClaimableWrite(exec: LegacyUnscopedRead, hostId: string, excludeRoots: string[], opts: { priority?: boolean | null } & QueryOpts = {}): Promise<boolean> {
  const { priority, ...query } = opts;
  const { text, params } = renderFragment(hasClaimableWriteFragment(priority, hostId, excludeRoots));
  const [row] = await exec.executeRaw<{ claimable: boolean }>(text, params, query);
  return row?.claimable === true;
}

/** Extends a claim's lease; true while request `id` is still running under `token`. */
export async function renewWriteClaim(exec: SqlExecutor, renewal: ClaimRenewal, opts?: QueryOpts): Promise<boolean> {
  const rows = await exec.executeRaw(RENEW_CLAIM_SQL, [renewal.id, renewal.token, renewal.leaseMs, renewal.phaseJson], opts);
  return rows.length === 1;
}

/** Returns expired claims (and claims of dead owners) to queued, at most 100 per call. */
export async function expireStaleWriteClaims(exec: SqlExecutor, expiry: ClaimExpiry, opts?: QueryOpts): Promise<void> {
  await exec.executeRaw(EXPIRE_CLAIMS_SQL, [expiry.hostId, expiry.charge, expiry.deadOwners], opts);
}

// ---------------------------------------------------------------------------------------------------------------------
// Consumer rows: the heartbeat's renewal, delete and worktree stamp, and the two row reads (persistence/consumer-heartbeat.ts).

/**
 * What this binary's consumer can drain: `refresh_barrier_1` (v292) claims writes deferred behind a worktree refresh,
 * `refresh_barrier_import_1` (v294) writes held for an import.
 */
export const CONSUMER_CAPABILITIES = ['refresh_barrier_1', 'refresh_barrier_import_1'] as const;

/** Every consumer row of a host, oldest first, with its liveness ages read on the database clock: $1 host id. */
export const LIST_HOST_CONSUMERS_SQL = `SELECT host_id::text AS host_id,pid,nonce,pid_ns,kind,mode,started_at::text AS started_at,renewed_at::text AS renewed_at,restart_required,root_barrier_age_ms,pool,
  host_json_path,persistence_home,minted_under,version,boot_id,process_start,(EXTRACT(EPOCH FROM (now()-renewed_at))*1000)::bigint::text AS renewed_age_ms,
  (EXTRACT(EPOCH FROM (now()-started_at))*1000)::bigint::text AS age_ms FROM persistence_consumers WHERE host_id=$1::uuid ORDER BY started_at,pid`;
/** The live full consumers of a host other than the caller: $1 host, $2 kinds, $3 pid, $4 nonce, $5 live window (ms). */
export const PROBE_LIVE_CONSUMERS_SQL = `SELECT host_id::text AS host_id,pid,nonce,pid_ns,kind,mode,started_at::text AS started_at,renewed_at::text AS renewed_at,restart_required,root_barrier_age_ms,pool,
  host_json_path,persistence_home,minted_under,version,boot_id,process_start,(EXTRACT(EPOCH FROM (now()-renewed_at))*1000)::bigint::text AS renewed_age_ms,
  (EXTRACT(EPOCH FROM (now()-started_at))*1000)::bigint::text AS age_ms FROM persistence_consumers
    WHERE host_id=$1::uuid AND mode IN ('full','promoted') AND kind=ANY($2::text[]) AND NOT (pid=$3::integer AND nonce=$4)
      AND renewed_at > now() - ($5::integer * interval '1 millisecond') AND NOT restart_required
    ORDER BY started_at,pid`;
/** Purges the host's lapsed rows (not the caller's), then inserts or renews the caller's row with CONSUMER_CAPABILITIES. */
export const RENEW_CONSUMER_SQL = `WITH purged AS (
    DELETE FROM persistence_consumers WHERE host_id=$1::uuid AND renewed_at < now() - ($14::integer * interval '1 millisecond') AND NOT (pid=$2::integer AND nonce=$3))
  INSERT INTO persistence_consumers(host_id,pid,nonce,pid_ns,kind,mode,restart_required,root_barrier_age_ms,pool,host_json_path,persistence_home,minted_under,version,boot_id,process_start,segment_reader,capabilities)
  VALUES($1::uuid,$2::integer,$3,$4,$5,$6,$7::boolean,$8::integer,$9::text::jsonb,$10,$11,$12::text::jsonb,$13,$15,$16,true,ARRAY['refresh_barrier_1','refresh_barrier_import_1']::text[])
  ON CONFLICT (host_id,pid,nonce) DO UPDATE SET renewed_at=now(),mode=EXCLUDED.mode,restart_required=EXCLUDED.restart_required,
    root_barrier_age_ms=EXCLUDED.root_barrier_age_ms,pool=EXCLUDED.pool,version=EXCLUDED.version,segment_reader=EXCLUDED.segment_reader,capabilities=EXCLUDED.capabilities`;
export const DELETE_CONSUMER_SQL = 'DELETE FROM persistence_consumers WHERE host_id=$1::uuid AND pid=$2::integer AND nonce=$3';
/** GBRA-248: stamps the host's worktrees with the time it stopped; rows another transaction holds are skipped, in id order. */
export const STAMP_WORKTREE_HEARTBEATS_SQL = `UPDATE persistence_worktrees SET heartbeat_at=now() WHERE id IN
        (SELECT id FROM persistence_worktrees WHERE owner_host_id=$1::uuid ORDER BY id FOR UPDATE SKIP LOCKED)`;

/** A consumer row as the two reads return it: `pool` and `minted_under` as the driver gives them, ages as text. */
export interface ConsumerRowRead {
  host_id: string; pid: number; nonce: string; pid_ns: string | null; kind: string; mode: string; started_at: string; renewed_at: string;
  restart_required: boolean; root_barrier_age_ms: number | null; pool: unknown; host_json_path: string; persistence_home: string;
  minted_under: unknown; version: string; boot_id?: string | null; process_start?: string | null; renewed_age_ms: string; age_ms: string;
}
/** The live-owner probe's filter. */
export interface ConsumerProbe { hostId: string; kinds: readonly string[]; pid: number; nonce: string; liveMs: number }
/** One heartbeat renewal: the row the caller owns, with its report. `pool` and `mintedUnder` are JSON text or null. */
export interface ConsumerRenewal {
  hostId: string; pid: number; nonce: string; pidNs: string | null; kind: string; mode: string; restartRequired: boolean; rootBarrierAgeMs: number | null;
  pool: string | null; hostJsonPath: string; persistenceHome: string; mintedUnder: string | null; version: string; purgeMs: number;
  bootId: string | null; processStart: string | null;
}
/** The row a stopping consumer deletes. */
export interface ConsumerRowKey { hostId: string; pid: number; nonce: string }

export function listHostConsumerRows(exec: LegacyUnscopedRead, hostId: string, opts?: QueryOpts): Promise<ConsumerRowRead[]> {
  return exec.executeRaw<ConsumerRowRead>(LIST_HOST_CONSUMERS_SQL, [hostId], opts);
}

export function probeLiveConsumerRows(exec: LegacyUnscopedRead, probe: ConsumerProbe, opts?: QueryOpts): Promise<ConsumerRowRead[]> {
  return exec.executeRaw<ConsumerRowRead>(PROBE_LIVE_CONSUMERS_SQL, [probe.hostId, [...probe.kinds], probe.pid, probe.nonce, probe.liveMs], opts);
}

export async function renewConsumerRow(exec: SqlExecutor, r: ConsumerRenewal, opts?: QueryOpts): Promise<void> {
  await exec.executeRaw(RENEW_CONSUMER_SQL, [r.hostId, r.pid, r.nonce, r.pidNs, r.kind, r.mode, r.restartRequired, r.rootBarrierAgeMs,
    r.pool, r.hostJsonPath, r.persistenceHome, r.mintedUnder, r.version, r.purgeMs, r.bootId, r.processStart], opts);
}

export async function deleteConsumerRow(exec: SqlExecutor, key: ConsumerRowKey, opts?: QueryOpts): Promise<void> {
  await exec.executeRaw(DELETE_CONSUMER_SQL, [key.hostId, key.pid, key.nonce], opts);
}

export async function stampWorktreeHeartbeats(exec: SqlExecutor, hostId: string, opts?: QueryOpts): Promise<void> {
  await exec.executeRaw(STAMP_WORKTREE_HEARTBEATS_SQL, [hostId], opts);
}
