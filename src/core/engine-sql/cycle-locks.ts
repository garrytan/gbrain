/**
 * Cycle locks: the `gbrain_cycle_locks` lease rows, SQL once for both engines.
 *
 * One row per lock id (`gbrain-cycle`, `gbrain-sync:<source>`, `gbrain-fs:<root digest>`, elections, ...) holds a
 * TTL lease with a holder pid, host and an `acquisition_token` UUID. The token is the fence: every renewal, release
 * and delete names it, so a holder whose lease was taken over never touches the new holder's row. The statement
 * text is the text `db-lock.ts` ran on PGLite (positional parameters); Postgres ran the same statements as tagged
 * templates, so the two engines now share one copy. Only the transport differs and stays with each engine:
 *
 *   acquire / release / delete   Postgres runs them through `retryReadOnlyAutocommit` on the transaction pool
 *                                (a pooler that inherited a read-only default), PGLite on its database handle.
 *   renew                        Postgres routes it to the direct session pool (`executeRawDirect`, #1794) so a
 *                                pooler exhaustion cannot kill the heartbeat; the caller's AbortSignal cancels the
 *                                statement. PGLite never forwarded the signal.
 *   reads                        unscoped pool reads on master (no retry wrapper), so they take `LegacyUnscopedRead`.
 *
 * The caller owns identity and policy: it supplies the pid, host, token, TTL and steal grace, and decides what a
 * snapshot means (`db-lock.ts`). Nothing here reads the clock of the calling process: every timestamp is the
 * database's `NOW()`.
 */
import type { BrainEngine, CycleLockFilter, CycleLockRow } from '../engine.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import type { QueryOpts, SqlExecutor } from './executor.ts';
import { LEASE_BEACON_QUEUE } from '../minions/protected-names.ts';

/** `INSERT ... ON CONFLICT`: take a free lock, or steal an expired one whose holder has not refreshed within the grace. */
const ACQUIRE_SQL = `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at, acquisition_token)
       VALUES ($1, $2, $3, NOW(), NOW() + $4::interval, NOW(), $6::uuid)
       ON CONFLICT (id) DO UPDATE
         SET id = EXCLUDED.id,
             holder_pid = $2,
             holder_host = $3,
             acquired_at = NOW(),
             acquisition_token = $6::uuid,
             ttl_expires_at = NOW() + $4::interval,
             last_refreshed_at = NOW()
         WHERE gbrain_cycle_locks.ttl_expires_at < NOW()
           AND (gbrain_cycle_locks.last_refreshed_at IS NULL
                OR gbrain_cycle_locks.last_refreshed_at < NOW() - $5 * INTERVAL '1 second')
       RETURNING id, extract(epoch from acquired_at)::text AS fence`;

const REFRESH_SQL = `UPDATE gbrain_cycle_locks
              SET ttl_expires_at = NOW() + $1::interval,
                  last_refreshed_at = NOW()
            WHERE id = $2 AND holder_pid = $3 AND acquisition_token = $4::uuid
            RETURNING id`;

const RELEASE_SQL = `DELETE FROM gbrain_cycle_locks WHERE id = $1 AND holder_pid = $2 AND acquisition_token = $3::uuid`;

const DELETE_SQL = `DELETE FROM gbrain_cycle_locks
        WHERE id = $1 AND holder_pid = $2 AND acquisition_token = $3::uuid
       RETURNING id`;

const DELETE_IF_STALE_SQL = `DELETE FROM gbrain_cycle_locks
        WHERE id = $1
          AND holder_pid = $2
          AND acquisition_token = $4::uuid
          AND last_refreshed_at IS NOT NULL
          AND last_refreshed_at < NOW() - $3 * INTERVAL '1 second'
       RETURNING id, last_refreshed_at`;

/**
 * The lock reads: one column list (`db_now` is the database clock the derived ages compare against, #7614), written out
 * per statement because a composed string may not carry `$n` placeholders (check-engine-sql-dynamic).
 */
const SELECT_BY_ID_SQL = `SELECT id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at, acquisition_token, now() AS db_now FROM gbrain_cycle_locks WHERE id = $1`;
const SELECT_BY_IDS_SQL = `SELECT id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at, acquisition_token, now() AS db_now FROM gbrain_cycle_locks WHERE id = ANY($1::text[])`;
const SELECT_STALE_SQL = `SELECT id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at, acquisition_token, now() AS db_now FROM gbrain_cycle_locks WHERE ttl_expires_at < NOW() ORDER BY acquired_at`;
const SELECT_ALL_SQL = `SELECT id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at, acquisition_token, now() AS db_now FROM gbrain_cycle_locks ORDER BY acquired_at`;

export async function acquireCycleLock(exec: SqlExecutor, lockId: string, opts: {
  holderPid: number;
  holderHost: string;
  acquisitionToken: string;
  ttlMinutes: number;
  stealGraceSeconds: number;
}): Promise<{ id: string; fence: string } | null> {
  const { rows } = await exec.query<{ id: string; fence: string }>(ACQUIRE_SQL, [
    lockId, opts.holderPid, opts.holderHost, `${opts.ttlMinutes} minutes`, opts.stealGraceSeconds, opts.acquisitionToken,
  ]);
  if (rows.length === 0) return null;
  // Diagnostics only (#6028): the token is the fence; the epoch text is never compared.
  return { id: rows[0].id, fence: String(rows[0].fence) };
}

export async function refreshCycleLock(exec: SqlExecutor, lockId: string, opts: {
  holderPid: number;
  acquisitionToken: string;
  ttlMinutes: number;
}, queryOpts?: QueryOpts): Promise<boolean> {
  const { rows } = await exec.query<{ id: string }>(REFRESH_SQL, [
    `${opts.ttlMinutes} minutes`, lockId, opts.holderPid, opts.acquisitionToken,
  ], queryOpts);
  return rows.length > 0;
}

export async function releaseCycleLock(exec: SqlExecutor, lockId: string, opts: {
  holderPid: number;
  acquisitionToken: string;
}): Promise<boolean> {
  const { affectedRows } = await exec.query(RELEASE_SQL, [lockId, opts.holderPid, opts.acquisitionToken]);
  return affectedRows > 0;
}

export async function readCycleLocks(exec: LegacyUnscopedRead, filter: CycleLockFilter): Promise<CycleLockRow[]> {
  switch (filter.by) {
    case 'id':
      return (await exec.query<CycleLockRow>(SELECT_BY_ID_SQL, [filter.lockId])).rows;
    case 'ids':
      return (await exec.query<CycleLockRow>(SELECT_BY_IDS_SQL, [[...filter.lockIds]])).rows;
    case 'stale':
      return (await exec.query<CycleLockRow>(SELECT_STALE_SQL)).rows;
    case 'all':
      return (await exec.query<CycleLockRow>(SELECT_ALL_SQL)).rows;
    default:
      return assertNever(filter);
  }
}

export async function deleteCycleLock(exec: SqlExecutor, lockId: string, opts: {
  holderPid: number;
  acquisitionToken: string;
}): Promise<boolean> {
  const { rows } = await exec.query<{ id: string }>(DELETE_SQL, [lockId, opts.holderPid, opts.acquisitionToken]);
  return rows.length > 0;
}

export async function deleteCycleLockIfStale(exec: SqlExecutor, lockId: string, opts: {
  holderPid: number;
  acquisitionToken: string;
  maxAgeSeconds: number;
}): Promise<{ deleted: boolean; lastRefreshedAt: Date | null }> {
  const { rows } = await exec.query<{ id: string; last_refreshed_at: Date | string | null }>(DELETE_IF_STALE_SQL, [
    lockId, opts.holderPid, opts.maxAgeSeconds, opts.acquisitionToken,
  ]);
  if (rows.length === 0) return { deleted: false, lastRefreshedAt: null };
  const lr = rows[0].last_refreshed_at;
  return { deleted: true, lastRefreshedAt: lr == null ? null : (lr instanceof Date ? lr : new Date(lr)) };
}

/**
 * #7442: the fence on a lease row: the row with this token, unexpired, `FOR KEY SHARE`. KEY SHARE lets the holder's
 * own renewal (an UPDATE of non-key columns) through while a fenced transaction is open; a takeover (its upsert writes
 * the key) and every DELETE wait for it. `db-lock.ts` `fenceLockRow` runs the same text.
 */
export const ASSERT_LEASE_SQL = 'SELECT 1 FROM gbrain_cycle_locks WHERE id=$1 AND acquisition_token=$2::uuid AND ttl_expires_at > now() FOR KEY SHARE';

/**
 * Whether the lease `lockId` is still held under `acquisitionToken`, holding the fence for the rest of the transaction.
 * Issues its statement synchronously (no await before it), so a pipelined caller keeps its statement order.
 */
export function assertCycleLease(exec: Pick<BrainEngine, 'executeRaw'>, lockId: string, acquisitionToken: string): Promise<boolean> {
  return exec.executeRaw(ASSERT_LEASE_SQL, [lockId, acquisitionToken]).then(rows => rows.length > 0);
}

// ---------------------------------------------------------------- the drain lease's holder record
// `src/core/persistence/sync-lease.ts`: one `gbrain-drain-lease` minion row per drain lease, keyed by the lease token,
// carrying the holder's kind, id and version under `data.drain_lease_beacon`. No worker serves the queue.

/** The beacon (`data->'drain_lease_beacon'`) of the holder record carrying `lockToken`, or null. */
export async function readDrainLeaseBeacon(exec: LegacyUnscopedRead, lockToken: string): Promise<Record<string, unknown> | null> {
  const [row] = await exec.executeRaw<{ meta: Record<string, unknown> | string | null }>(
    "SELECT data->'drain_lease_beacon' AS meta FROM minion_jobs WHERE queue=$1 AND lock_token=$2", [LEASE_BEACON_QUEUE, lockToken]);
  return typeof row?.meta === 'string' ? JSON.parse(row.meta) : row?.meta ?? null;
}

/** What a drain lease's holder record carries: the source, the lease token, the beacon and the lease's TTL in minutes. */
export interface DrainLeaseHolderRecord { sourceId: string; lockToken: string; beacon: { kind: string; id: string | null; version: string }; ttlMinutes: number; /** The caller's host fence on a multi-user Rust brain; the SQL engines ignore it. */ fence?: import('./lease-token.ts').LeaseToken }

/**
 * Writes the holder record of a drain lease, in one statement: the source's former `sync` holder records go first (the
 * insert reads the delete's count), then the new row: active, application authority, one attempt, `max_stalled` 0,
 * removed on completion or failure, locked by the lease token until the TTL ahead.
 */
export async function writeDrainLeaseHolder(exec: SqlExecutor, record: DrainLeaseHolderRecord): Promise<void> {
  await exec.executeRaw(`WITH gone AS (DELETE FROM minion_jobs WHERE queue=$1 AND name='sync' AND data->>'sourceId'=$5 RETURNING 1)
    INSERT INTO minion_jobs(name,queue,status,submission_authority,data,max_attempts,max_stalled,lock_token,lock_until,started_at,remove_on_complete,remove_on_fail)
    SELECT 'sync',$1,'active','{"version":1,"kind":"application"}'::jsonb,$2::text::jsonb,1,0,$3,now()+make_interval(mins => $4),now(),true,true FROM (SELECT count(*) FROM gone) g`,
    [LEASE_BEACON_QUEUE, JSON.stringify({ sourceId: record.sourceId, drain_lease_beacon: record.beacon }), record.lockToken, record.ttlMinutes, record.sourceId]);
}

/** Renews the holder record carrying `lockToken`: `lock_until` the TTL ahead, `updated_at` now. */
export async function refreshDrainLeaseHolder(exec: SqlExecutor, lockToken: string, ttlMinutes: number): Promise<void> {
  await exec.executeRaw(`UPDATE minion_jobs SET lock_until=now()+make_interval(mins => $3),updated_at=now() WHERE queue=$1 AND lock_token=$2`,
    [LEASE_BEACON_QUEUE, lockToken, ttlMinutes]);
}

/** Deletes the holder record carrying `lockToken` (the lease's release). */
export async function releaseDrainLeaseHolder(exec: SqlExecutor, lockToken: string): Promise<void> {
  await exec.executeRaw('DELETE FROM minion_jobs WHERE queue=$1 AND lock_token=$2', [LEASE_BEACON_QUEUE, lockToken]);
}

function assertNever(value: never): never {
  throw new Error(`engine-sql cycle-locks: unhandled filter ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------- page embedding leases

/**
 * Page embedding leases (`embed-page:<page id>` rows, page-embedding-lease.ts owns the policy): the statements the
 * lease always sent through `executeRaw`, now one copy for both engines. Each runs on the engine's own pool, or on the
 * transaction a holder renews inside, as before. Unlike the cycle locks above, the lease fences on its token alone
 * and takes over an expired row with no steal grace.
 */
const PAGE_EMBEDDING_LEASE_TAKE_SQL = `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at, acquisition_token)
     VALUES ($1, $2, $3, now(), now() + make_interval(mins => $4::int), now(), $5::uuid)
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id, holder_pid = EXCLUDED.holder_pid, holder_host = EXCLUDED.holder_host, acquired_at = now(),
       ttl_expires_at = EXCLUDED.ttl_expires_at, last_refreshed_at = now(), acquisition_token = EXCLUDED.acquisition_token
     WHERE gbrain_cycle_locks.ttl_expires_at < now()
     RETURNING id`;

const PAGE_EMBEDDING_LEASE_RENEW_SQL = `UPDATE gbrain_cycle_locks SET ttl_expires_at = now() + make_interval(mins => $3::int), last_refreshed_at = now()
      WHERE id = $1 AND acquisition_token = $2::uuid RETURNING id`;

/** Deletes this holder's row and every expired `embed-page:` row (a crashed holder's). */
const PAGE_EMBEDDING_LEASE_RELEASE_SQL = `DELETE FROM gbrain_cycle_locks
        WHERE (id = $1 AND acquisition_token = $2::uuid) OR (id LIKE 'embed-page:%' AND ttl_expires_at < now())`;

/** Takes the lease when it is free or expired; false while another holder's unexpired row stands. */
export async function takePageEmbeddingLease(exec: SqlExecutor, leaseId: string, opts: {
  holderPid: number;
  holderHost: string;
  acquisitionToken: string;
  ttlMinutes: number;
}): Promise<boolean> {
  const { rows } = await exec.query<{ id: string }>(PAGE_EMBEDDING_LEASE_TAKE_SQL, [leaseId, opts.holderPid, opts.holderHost, opts.ttlMinutes, opts.acquisitionToken]);
  return rows.length > 0;
}

/** Pushes the lease's expiry out by `ttlMinutes` when the row still carries this token; false when the lease was lost. */
export async function renewPageEmbeddingLease(exec: SqlExecutor, leaseId: string, opts: {
  acquisitionToken: string;
  ttlMinutes: number;
}): Promise<boolean> {
  const { rows } = await exec.query<{ id: string }>(PAGE_EMBEDDING_LEASE_RENEW_SQL, [leaseId, opts.acquisitionToken, opts.ttlMinutes]);
  return rows.length > 0;
}

/** Releases this holder's lease and deletes every expired page embedding lease. */
export async function releasePageEmbeddingLease(exec: SqlExecutor, leaseId: string, opts: { acquisitionToken: string }): Promise<void> {
  await exec.query(PAGE_EMBEDDING_LEASE_RELEASE_SQL, [leaseId, opts.acquisitionToken]);
}
