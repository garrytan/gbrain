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

/** The same switch as a fragment, for statements that splice it beside `claimableWriteFragment`. */
export function foregroundPriorityFragment(priority: boolean | null | undefined): ReturnType<typeof trustedSql> {
  return trustedSql(PRIORITY_SQL[priorityKey(priority)]);
}

/**
 * `claimableWriteSql(priority, lanes)` (journal.ts): the rows `claimNextWrite` may claim. `hostId` and `excludeRoots`
 * bind as $1 and $2, the text the journal writes; with no `laneRoots` the lane list is the empty literal, as there.
 */
export function claimableWriteFragment(priority: boolean | null | undefined, hostId: string | null, excludeRoots: string[], laneRoots?: string[]): SqlFragment {
  const p = trustedSql(PRIORITY_SQL[priorityKey(priority)]);
  const lanes = laneRoots === undefined ? sqlFragment`'{}'::text[]` : sqlFragment`${laneRoots}::text[]`;
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
    AND earlier.worktree_id::text=ANY(${lanes})))
  AND earlier.recovery IS NULL AND COALESCE(earlier.intent->>'kind','') LIKE 'managed_sync_%' AND NOT (earlier.source_id=r.source_id AND (earlier.slug=r.slug
  OR earlier.page_id=r.page_id OR earlier.intent->'renameFrom'->>'slug'=r.slug))))
      AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE r.worktree_id IS NULL AND earlier.worktree_id IS NULL AND earlier.source_incarnation=r.source_incarnation
        AND earlier.sequence<r.sequence
        AND earlier.state IN ('queued','running','recovering') AND NOT ((${p}) AND NOT COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%'
  AND (earlier.state='queued' OR (earlier.state='running' AND earlier.intent ? 'lane'
    AND earlier.worktree_id::text=ANY(${lanes})))
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

/**
 * `releaseUnpublishedClaim` (journal.ts; the protocol predicate written out): returns a claim that never began to publish
 * to queued under its token. $3 = the blocked reason; $4 = charge one preparation attempt (and keep the claim phase).
 */
export const RELEASE_CLAIM_SQL = `UPDATE persistence_requests SET state='queued',execution_token=NULL,claim_expires_at=NULL,
    blocked_reason=$3,updated_at=now(),preparation_attempts=preparation_attempts+CASE WHEN $4::boolean THEN 1 ELSE 0 END,
    claim_phase=CASE WHEN $4::boolean THEN claim_phase END
    WHERE id=$1::uuid AND execution_token=$2::uuid
    AND state='running' AND recovery IS NULL AND publication_started=false AND set_config('gbrain.persistence_protocol','2',true)='2'`;

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

/** A release of an unpublished claim: request `id`, its claim `token`, the blocked reason, and whether it counts a preparation attempt. */
export interface ClaimRelease { id: string; token: string | null; reason: string; charge: boolean }

/** An expired-claim release: this consumer's host id, whether a claim that expired while preparing counts an attempt, and the dead owners. */
export interface ClaimExpiry { hostId: string; charge: boolean; deadOwners: string[] }

/**
 * Source `sourceId`'s membership, or null; `lock` reads it FOR SHARE (admission holds it until the transaction ends),
 * and `'update'` FOR UPDATE (a policy change that compares and replaces the source's policy epoch).
 */
export async function readSourceMembership(exec: SqlExecutor, sourceId: string, opts: { lock?: boolean | 'update' } = {}): Promise<SourceMembership | null> {
  const sql = opts.lock === 'update' ? 'SELECT incarnation,archived FROM sources WHERE id=$1 FOR UPDATE'
    : opts.lock ? 'SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE' : 'SELECT incarnation,archived FROM sources WHERE id=$1';
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

/**
 * The digest a topology change with request id `requestId` recorded for source `sourceId`, whichever principal wrote
 * it, or null: the `sources add` replay read (source-default-search.ts acceptedChoice).
 */
export async function readTopologyChangeDigest(exec: LegacyUnscopedRead, requestId: string, sourceId: string): Promise<string | null> {
  const [prior] = await exec.executeRaw<{ digest: string }>('SELECT digest FROM persistence_topology_changes WHERE request_id = $1::uuid AND source_id = $2', [requestId, sourceId]);
  return prior ? prior.digest : null;
}

/** The first of `requestIds` a topology change of local writer `principalId` already used (a lifecycle id), as `[{ request_id }]`, or []. */
export function findTopologyChanges(exec: LegacyUnscopedRead, principalId: string, requestIds: string[]): Promise<Array<{ request_id: string }>> {
  return exec.executeRaw<{ request_id: string }>('SELECT request_id FROM persistence_topology_changes WHERE principal_id=$1::uuid AND request_id=ANY($2::uuid[]) LIMIT 1',
    [principalId, requestIds]);
}

/**
 * The topology recovery scan (topology-recovery.ts recoverSourceTopologies): the changes with a recovery record whose
 * worktree host `hostId` owns, after cursor `after` (a change id, or null), in id order, at most `limit`.
 */
export const TOPOLOGY_RECOVERIES_SQL = `SELECT c.* FROM persistence_topology_changes c
    JOIN persistence_worktrees w ON w.id=(c.recovery->>'worktreeId')::uuid
    WHERE c.recovery IS NOT NULL AND w.owner_host_id=$1::uuid AND ($2::uuid IS NULL OR c.id>$2::uuid)
    ORDER BY c.id LIMIT $3`;
export function listTopologyRecoveries(exec: LegacyUnscopedRead, hostId: string, after: string | null, limit: number): Promise<TopologyChange[]> {
  return exec.executeRaw<TopologyChange>(TOPOLOGY_RECOVERIES_SQL, [hostId, after, limit]);
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

/**
 * Returns a claim that never began to publish to queued. `exec` is the engine itself (its own `executeRaw`, or
 * `executeRawDirect` on the Postgres direct lane), so the statement reaches the connection it reached before.
 */
export async function releaseUnpublishedClaim(exec: { executeRaw(sql: string, params?: unknown[]): Promise<unknown> }, release: ClaimRelease): Promise<void> {
  await exec.executeRaw(RELEASE_CLAIM_SQL, [release.id, release.token, release.reason, release.charge]);
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

// ---------------------------------------------------------------------------------------------------------------------
// The FIFO head read (persistence/journal.ts claimNextWrite).

/** The FIFO head statement's text between the places the claim-first condition goes (see `claimHeadText`). */
const CLAIM_HEAD = [
`WITH waiting AS MATERIALIZED (SELECT f.worktree_id, max(f.sequence) AS last
        FROM (SELECT f.worktree_id, f.sequence FROM persistence_requests f
    WHERE TRUE AND (f.state IN ('queued','running','recovering') OR (f.state='deferred' AND (f.deferred_refresh_id IS NOT NULL OR f.deferred_import_from IS NOT NULL)
        AND (f.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=f.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (f.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=f.source_id AND COALESCE(imported.last_commit,'')<>f.deferred_import_from)))) AND (f.state<>'running' OR (NOT f.publication_started
      AND f.claim_phase->'owner'->>'nonce' IS DISTINCT FROM $5::text))
    AND f.recovery IS NULL AND NOT COALESCE(f.intent->>'kind','') LIKE 'managed_sync_%'
    AND NOT EXISTS (SELECT 1 FROM persistence_requests named WHERE named.worktree_id=f.worktree_id AND named.sequence<f.sequence
      AND named.state IN ('queued','running','recovering') AND COALESCE(named.intent->>'kind','') LIKE 'managed_sync_%' AND (named.source_id=f.source_id AND (named.slug=f.slug
  OR named.page_id=f.page_id OR named.intent->'renameFrom'->>'slug'=f.slug)))
    AND NOT EXISTS (SELECT 1 FROM persistence_requests ahead WHERE ahead.worktree_id=f.worktree_id AND ahead.sequence<f.sequence
      AND (ahead.state='queued' OR (ahead.state='deferred' AND (ahead.deferred_refresh_id IS NOT NULL OR ahead.deferred_import_from IS NOT NULL)
        AND (ahead.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=ahead.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (ahead.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=ahead.source_id AND COALESCE(imported.last_commit,'')<>ahead.deferred_import_from)))) AND NOT COALESCE(ahead.intent->>'kind','') LIKE 'managed_sync_%'
      AND EXISTS (SELECT 1 FROM persistence_requests named WHERE named.worktree_id=ahead.worktree_id AND named.sequence<ahead.sequence
        AND named.state IN ('queued','running','recovering') AND COALESCE(named.intent->>'kind','') LIKE 'managed_sync_%' AND (named.source_id=ahead.source_id AND (named.slug=ahead.slug
  OR named.page_id=ahead.page_id OR named.intent->'renameFrom'->>'slug'=ahead.slug))))
    AND NOT EXISTS (SELECT 1 FROM persistence_requests c WHERE c.sequence>COALESCE(($6::text::jsonb->>f.worktree_id::text)::bigint,0) AND c.worktree_id=f.worktree_id
      AND c.state='committed' AND NOT COALESCE(c.intent->>'kind','') LIKE 'managed_sync_%')) f GROUP BY f.worktree_id)
      SELECT r.* FROM persistence_requests r
      LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id
      WHERE (r.state='queued' OR (r.state='deferred' AND (r.deferred_refresh_id IS NOT NULL OR r.deferred_import_from IS NOT NULL)
        AND (r.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=r.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (r.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=r.source_id AND COALESCE(imported.last_commit,'')<>r.deferred_import_from)))) AND (r.worktree_id IS NULL OR (w.owner_host_id=$1::uuid AND w.state='active'))
      AND (r.worktree_id IS NULL OR NOT EXISTS (SELECT 1 FROM persistence_worktree_refreshes fence WHERE fence.worktree_id=r.worktree_id
        AND fence.state IN ('fenced','merged','recovery_required')))
      AND NOT (COALESCE(r.worktree_id::text,'db:'||r.source_incarnation::text)=ANY($2::text[]))
      AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=r.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_effects mirror WHERE mirror.worktree_id=r.worktree_id
        AND mirror.kind='withdrawal-mirror' AND mirror.state IN ('queued','running')
        AND (NOT (mirror.data ? 'targets') OR mirror.data->'targets' @> jsonb_build_array(jsonb_build_object('slug',r.slug))))
      AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=r.worktree_id AND blocked.recovery IS NOT NULL)
      AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=now())
      AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE r.worktree_id IS NOT NULL AND earlier.worktree_id=r.worktree_id AND earlier.sequence<r.sequence
        AND earlier.state IN ('queued','running','recovering') AND NOT ((((`,
`) AND NOT (COALESCE(r.worktree_id::text,'db:'||r.source_incarnation::text)=ANY($3::text[])))) AND NOT COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%'
  AND (earlier.state='queued' OR (earlier.state='running' AND earlier.intent ? 'lane'
    AND earlier.worktree_id::text=ANY($4::text[])))
  AND earlier.recovery IS NULL AND COALESCE(earlier.intent->>'kind','') LIKE 'managed_sync_%' AND NOT (earlier.source_id=r.source_id AND (earlier.slug=r.slug
  OR earlier.page_id=r.page_id OR earlier.intent->'renameFrom'->>'slug'=r.slug))))
      AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE r.worktree_id IS NULL AND earlier.worktree_id IS NULL AND earlier.source_incarnation=r.source_incarnation
        AND earlier.sequence<r.sequence
        AND earlier.state IN ('queued','running','recovering') AND NOT ((((`,
`) AND NOT (COALESCE(r.worktree_id::text,'db:'||r.source_incarnation::text)=ANY($3::text[])))) AND NOT COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%'
  AND (earlier.state='queued' OR (earlier.state='running' AND earlier.intent ? 'lane'
    AND earlier.worktree_id::text=ANY($4::text[])))
  AND earlier.recovery IS NULL AND COALESCE(earlier.intent->>'kind','') LIKE 'managed_sync_%' AND NOT (earlier.source_id=r.source_id AND (earlier.slug=r.slug
  OR earlier.page_id=r.page_id OR earlier.intent->'renameFrom'->>'slug'=r.slug))))
      AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE r.worktree_id IS NOT NULL AND earlier.worktree_id=r.worktree_id AND earlier.sequence<r.sequence AND (earlier.state='deferred' AND (earlier.deferred_refresh_id IS NOT NULL OR earlier.deferred_import_from IS NOT NULL)
        AND (earlier.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=earlier.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (earlier.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=earlier.source_id AND COALESCE(imported.last_commit,'')<>earlier.deferred_import_from))))
      AND NOT ((((`,
`) AND NOT (COALESCE(r.worktree_id::text,'db:'||r.source_incarnation::text)=ANY($3::text[])))) AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' AND EXISTS (SELECT 1 FROM persistence_requests ahead
        WHERE ahead.worktree_id=r.worktree_id AND ahead.sequence>r.sequence AND ahead.state IN ('running','recovering') AND NOT COALESCE(ahead.intent->>'kind','') LIKE 'managed_sync_%'))
        -- On a root whose lane groups run in this process only a foreground write is claimed (beside them).
        AND NOT (r.worktree_id::text=ANY($4::text[]) AND (COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' OR NOT ((`,
`) AND NOT (COALESCE(r.worktree_id::text,'db:'||r.source_incarnation::text)=ANY($3::text[])))))
        AND NOT (COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' AND (`,
`) AND NOT (COALESCE(r.worktree_id::text,'db:'||r.source_incarnation::text)=ANY($3::text[])) AND EXISTS (SELECT 1 FROM waiting g WHERE g.worktree_id=r.worktree_id AND g.last>r.sequence))
      ORDER BY `,
`(((`,
`) AND NOT (COALESCE(r.worktree_id::text,'db:'||r.source_incarnation::text)=ANY($3::text[]))) AND NOT COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%') DESC, r.sequence LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
] as const;

/**
 * #6712 PR 2 (Garry, 2026-10-16, via GBRA-40): while a source's drain lease is live, only the lease holder publishes that
 * source's managed-sync requests. A non-resident consumer (a short-lived command such as `put` or `remember`, waiting on its
 * own write) ranks a sync row whose source's lease another process holds after every other row and claims it only when that
 * holder is provably dead (a killed same-host sync whose TTL has not lapsed yet), so it never publishes a live drainer's pages
 * or breaks up its lane groups. With no live lease nothing changes: a crashed drainer's rows still drain through any consumer.
 * The holder is read only when the head row is a sync row, so a foreground write's claim costs no extra statement.
 *
 * The ordering term ($7 the sync lock id prefix, $8 pid, $9 host) goes first in such a consumer's claim order.
 */
const CLAIM_HEAD_LEASE_HELD = `EXISTS (SELECT 1 FROM gbrain_cycle_locks l WHERE COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' AND l.id=$7::text||r.source_id
  AND l.ttl_expires_at>now() AND NOT (l.holder_pid=$8::integer AND l.holder_host IS NOT DISTINCT FROM $9::text)), `;

/** What the FIFO head read (`claimNextWrite`) selects by; journal.ts documents each input. */
export interface ClaimHeadSpec {
  /** $1: this consumer's host id (a uuid). */
  hostId: string;
  /** $2: root keys this consumer does not claim from. */
  excludeRoots: string[];
  /** $3: roots where the claim is plain FIFO (this consumer owes the sync side a turn). */
  fifoRoots: string[];
  /** $4: worktrees whose lane groups run in this process. */
  laneRoots: string[];
  /** $5: this process's consumer nonce. */
  nonce: string;
  /** $6: per worktree id, the newest request sequence when this process last claimed a sync head there. */
  syncSeen: Record<string, string>;
  /** The `foreground_priority` environment override, or null for the brain config row. */
  priority: boolean | null;
  /** A non-resident consumer ranks a sync row whose drain lease another live process holds last: $7 the sync lock id prefix, $8 pid, $9 host. Null for a resident consumer. */
  leaseHolder: { lockPrefix: string; pid: number; host: string } | null;
}

/**
 * The FIFO head statement journal.ts `claimNextWrite` sent through executeRaw, for one `foreground_priority` value and
 * consumer kind: the claimable test, the lane and sync-wait conditions and the claim order, `LIMIT 1 FOR UPDATE OF r
 * SKIP LOCKED`. The claim-first condition (the switch, unless the row's root is in $3) is spliced where it goes.
 */
export function claimHeadText(priority: boolean | null | undefined, leaseHolder: boolean): string {
  const p = PRIORITY_SQL[priorityKey(priority)];
  const lease = leaseHolder ? CLAIM_HEAD_LEASE_HELD : '';
  return `${CLAIM_HEAD[0]}${p}${CLAIM_HEAD[1]}${p}${CLAIM_HEAD[2]}${p}${CLAIM_HEAD[3]}${p}${CLAIM_HEAD[4]}${p}${CLAIM_HEAD[5]}${lease}${CLAIM_HEAD[6]}${p}${CLAIM_HEAD[7]}`;
}

/** The FIFO head read's text and parameters for one spec (plan tests run EXPLAIN on exactly this). */
export function claimHeadStatement(spec: ClaimHeadSpec): { sql: string; params: unknown[] } {
  const holder = spec.leaseHolder;
  const params: unknown[] = [spec.hostId, spec.excludeRoots, spec.fifoRoots, spec.laneRoots, spec.nonce, JSON.stringify(spec.syncSeen)];
  if (holder) params.push(holder.lockPrefix, holder.pid, holder.host);
  return { sql: claimHeadText(spec.priority, holder !== null), params };
}

/** The request `claimNextWrite` claims next, locked until the claim's transaction ends, or null. */
export async function selectClaimableWrite<R = Record<string, unknown>>(exec: LegacyUnscopedRead, spec: ClaimHeadSpec): Promise<R | null> {
  const { sql, params } = claimHeadStatement(spec);
  const [row] = await exec.executeRaw<R>(sql, params);
  return row ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The lane head claim (persistence/journal.ts claimNextLaneHead) and the owner's reclaim of a write it released
// (reclaimReleasedWrite): the three statements those two functions sent through executeRaw, text unchanged.

/**
 * The lane head read (#5984), the text `claimNextLaneHead` sent around the `foreground_priority` condition (see
 * `laneHeadText`): the head of the next admitted group of lane $3 on worktree $2 for host $1, `LIMIT 1 FOR UPDATE OF r
 * SKIP LOCKED`. $4 = the newest request sequence when this process last claimed a head of the run, $5 = this process's
 * consumer nonce.
 */
const LANE_HEAD = [
`SELECT r.* FROM persistence_requests r
      JOIN persistence_worktrees w ON w.id=r.worktree_id
      WHERE r.worktree_id=$2::uuid AND r.state='queued' AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=now()) AND r.intent->>'lane'=$3 AND r.intent->>'group'=r.request_id::text
        AND w.owner_host_id=$1::uuid AND w.state='active' AND NOT EXISTS (SELECT 1 FROM persistence_worktree_refreshes fence WHERE fence.worktree_id=r.worktree_id
        AND fence.state IN ('fenced','merged','recovery_required'))
        AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=r.worktree_id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_effects mirror WHERE mirror.worktree_id=r.worktree_id
          AND mirror.kind='withdrawal-mirror' AND mirror.state IN ('queued','running'))
        AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=r.worktree_id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier WHERE earlier.worktree_id=r.worktree_id AND earlier.sequence<r.sequence
          AND (earlier.state IN ('queued','recovering') OR (earlier.state='deferred' AND (earlier.deferred_refresh_id IS NOT NULL OR earlier.deferred_import_from IS NOT NULL)
        AND (earlier.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=earlier.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (earlier.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=earlier.source_id AND COALESCE(imported.last_commit,'')<>earlier.deferred_import_from))) OR (earlier.state='running' AND COALESCE(earlier.intent->>'lane','')<>$3)))
        -- #5984 Phase 4.5: no new lane head while a foreground write that may go first waits (a claimed one publishes
        -- beside the lanes), except one head after each foreground commit since this run's last head claim.
        AND NOT ((`,
`) AND r.worktree_id IN (SELECT f.worktree_id FROM (SELECT f.worktree_id, f.sequence FROM persistence_requests f
    WHERE f.worktree_id=$2::uuid AND (f.state IN ('queued','running','recovering') OR (f.state='deferred' AND (f.deferred_refresh_id IS NOT NULL OR f.deferred_import_from IS NOT NULL)
        AND (f.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=f.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (f.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=f.source_id AND COALESCE(imported.last_commit,'')<>f.deferred_import_from)))) AND (f.state<>'running' OR (NOT f.publication_started
      AND f.claim_phase->'owner'->>'nonce' IS DISTINCT FROM $5::text))
    AND f.recovery IS NULL AND NOT COALESCE(f.intent->>'kind','') LIKE 'managed_sync_%'
    AND NOT EXISTS (SELECT 1 FROM persistence_requests named WHERE named.worktree_id=f.worktree_id AND named.sequence<f.sequence
      AND named.state IN ('queued','running','recovering') AND COALESCE(named.intent->>'kind','') LIKE 'managed_sync_%' AND (named.source_id=f.source_id AND (named.slug=f.slug
  OR named.page_id=f.page_id OR named.intent->'renameFrom'->>'slug'=f.slug)))
    AND NOT EXISTS (SELECT 1 FROM persistence_requests ahead WHERE ahead.worktree_id=f.worktree_id AND ahead.sequence<f.sequence
      AND (ahead.state='queued' OR (ahead.state='deferred' AND (ahead.deferred_refresh_id IS NOT NULL OR ahead.deferred_import_from IS NOT NULL)
        AND (ahead.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=ahead.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (ahead.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=ahead.source_id AND COALESCE(imported.last_commit,'')<>ahead.deferred_import_from)))) AND NOT COALESCE(ahead.intent->>'kind','') LIKE 'managed_sync_%'
      AND EXISTS (SELECT 1 FROM persistence_requests named WHERE named.worktree_id=ahead.worktree_id AND named.sequence<ahead.sequence
        AND named.state IN ('queued','running','recovering') AND COALESCE(named.intent->>'kind','') LIKE 'managed_sync_%' AND (named.source_id=ahead.source_id AND (named.slug=ahead.slug
  OR named.page_id=ahead.page_id OR named.intent->'renameFrom'->>'slug'=ahead.slug))))
    AND NOT EXISTS (SELECT 1 FROM persistence_requests c WHERE c.sequence>COALESCE($4::bigint,0) AND c.worktree_id=f.worktree_id
      AND c.state='committed' AND NOT COALESCE(c.intent->>'kind','') LIKE 'managed_sync_%')) f))
      ORDER BY r.sequence LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
] as const;

/** What the lane head read selects by; journal.ts `claimNextLaneHead` documents each input. */
export interface LaneHeadSpec {
  /** $1: this consumer's host id (a uuid). */
  hostId: string;
  /** $2: the worktree whose lane runs here (a uuid). */
  worktreeId: string;
  /** $3: the lane run. */
  run: string;
  /** $4: the newest request sequence when this process last claimed a head of the run, or null. */
  seenSequence: string | null;
  /** $5: this process's consumer nonce. */
  nonce: string;
  /** The `foreground_priority` environment override, or null for the brain config row. */
  priority: boolean | null;
  /** The caller's host fence on a multi-user Rust brain; the SQL engines ignore it. */
  fence?: LeaseToken;
}

/** The lane head read for one `foreground_priority` value. */
export function laneHeadText(priority: boolean | null | undefined): string {
  return `${LANE_HEAD[0]}${PRIORITY_SQL[priorityKey(priority)]}${LANE_HEAD[1]}`;
}

/** The lane head read's text and parameters for one spec. */
export function laneHeadStatement(spec: LaneHeadSpec): { sql: string; params: unknown[] } {
  return { sql: laneHeadText(spec.priority), params: [spec.hostId, spec.worktreeId, spec.run, spec.seenSequence, spec.nonce] };
}

/** The request the lane head claim takes next, locked until its transaction ends, or null. */
export async function selectClaimableLaneHead<R = Record<string, unknown>>(exec: LegacyUnscopedRead, spec: LaneHeadSpec): Promise<R | null> {
  const { sql, params } = laneHeadStatement(spec);
  const [row] = await exec.executeRaw<R>(sql, params);
  return row ?? null;
}

/**
 * The lane head's claim stamp: running under a token with its lease and first phase, returning the row with the newest
 * request sequence as `seen_sequence`. $1 id, $2 token, $3 lease ms, $4 the claim phase.
 */
export const LANE_HEAD_STAMP_SQL = `UPDATE persistence_requests SET state='running',
      execution_token=$2::uuid,claim_expires_at=now()+($3::double precision*interval '1 millisecond'),
      updated_at=now(),blocked_reason=NULL,claim_phase=$4::text::jsonb WHERE id=$1::uuid RETURNING *,(SELECT max(sequence) FROM persistence_requests)::text AS seen_sequence`;

/** A lane head claim stamp: request `id`, its new claim `token`, the lease and the phase to record. */
export interface LaneHeadStamp { id: string; token: string; leaseMs: number; phaseJson: string; fence?: LeaseToken }

/** Stamps the lane head claim; the claimed row with `seen_sequence`, or null when no request has the id. */
export async function stampLaneHeadClaim<R = Record<string, unknown>>(exec: SqlExecutor, stamp: LaneHeadStamp): Promise<R | null> {
  const [claimed] = await exec.executeRaw<R>(LANE_HEAD_STAMP_SQL, [stamp.id, stamp.token, stamp.leaseMs, stamp.phaseJson]);
  return claimed ?? null;
}

/**
 * `reclaimReleasedWrite` (#6007; the protocol predicate and `BACKOFF_ELAPSED('persistence_requests')` written out): claims
 * again a request this owner pass released to the queue itself, never before its backoff. $1 id, $2 token, $3 lease ms, $4 phase.
 */
export const RECLAIM_RELEASED_SQL = `UPDATE persistence_requests SET state='running',execution_token=$2::uuid,
    claim_expires_at=now()+($3::double precision*interval '1 millisecond'),updated_at=now(),blocked_reason=NULL,claim_phase=$4::text::jsonb
    WHERE id=$1::uuid AND state='queued' AND recovery IS NULL AND (persistence_requests.next_attempt_at IS NULL OR persistence_requests.next_attempt_at<=now()) AND set_config('gbrain.persistence_protocol','2',true)='2' RETURNING *`;

/** Reclaims request `id` under a fresh `token`: the claimed row, or null when it is not queued, holds a recovery or is still backing off. */
export async function reclaimReleasedWrite<R = Record<string, unknown>>(exec: SqlExecutor, stamp: LaneHeadStamp): Promise<R | null> {
  const [claimed] = await exec.executeRaw<R>(RECLAIM_RELEASED_SQL, [stamp.id, stamp.token, stamp.leaseMs, stamp.phaseJson]);
  return claimed ?? null;
}

/**
 * `chargeTransientInterruption` (persistence/transient-retry.ts; the protocol predicate written out): counts one transient
 * interruption on a claim still held under its token and schedules the next claim after a bounded exponential backoff.
 * $1 id, $2 token, $3 base ms, $4 ceiling ms.
 */
export const CHARGE_TRANSIENT_SQL = `UPDATE persistence_requests SET transient_interruptions=transient_interruptions+1,
    next_attempt_at=now()+(LEAST($3::double precision*power(2::double precision,LEAST(transient_interruptions,30)),$4::double precision)*interval '1 millisecond'),
    updated_at=now() WHERE id=$1::uuid AND execution_token=$2::uuid AND state='running' AND set_config('gbrain.persistence_protocol','2',true)='2' RETURNING transient_interruptions`;

/** A transient interruption charged to claim `token` of request `id`, with the backoff's base and ceiling. */
export interface TransientCharge { id: string; token: string | null; baseMs: number; maxMs: number; fence?: LeaseToken }

/** The count after the charge, or null when the request is no longer running under the token. */
export async function chargeTransientInterruption(exec: SqlExecutor, charge: TransientCharge): Promise<{ transient_interruptions: number } | null> {
  const [charged] = await exec.executeRaw<{ transient_interruptions: number }>(CHARGE_TRANSIENT_SQL, [charge.id, charge.token, charge.baseMs, charge.maxMs]);
  return charged ?? null;
}
