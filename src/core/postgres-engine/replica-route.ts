/**
 * Picks the connection for one Postgres read seam (`withScopedReadTransaction`,
 * `jitOffRead`): the read replica when the caller is a non-mutating read op
 * (src/core/replica-reads.ts) outside any transaction, otherwise the primary.
 * A replica that cannot answer never fails the read: it is retried on the
 * primary, and a replica that dropped the connection sits out a cooldown.
 */
import type postgres from '#postgres';
import { isRetryableConnError } from '../retry-matcher.ts';
import { isNetworkUnreachableError } from '../connection-manager.ts';
import { replicaReadsAllowed } from '../replica-reads.ts';
import { warnOncePerProcess } from '../utils.ts';
import type { SqlExecutor } from '../engine-sql/executor.ts';

type Sql = ReturnType<typeof postgres>;

export const REPLICA_COOLDOWN_MS = 30_000;

/** SQLSTATE a hot standby raises when WAL replay cancels a running query. */
const RECOVERY_CONFLICT = '40001';

export interface ReplicaSource {
  replica(): Sql | null;
  markReplicaDown(cooldownMs: number): void;
}

/** True when the replica, not the query, failed: the read is worth repeating on the primary. */
export function isReplicaFallbackError(err: unknown): boolean {
  return isRecoveryConflict(err) || isRetryableConnError(err) || isNetworkUnreachableError(err);
}

function isRecoveryConflict(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === RECOVERY_CONFLICT;
}

/** An executor whose every statement goes through `routeRead`; for the engine's `LegacyUnscopedRead` reads, which run on the pool. */
export function routedReadExecutor(executorOn: (conn: Sql) => SqlExecutor, primary: () => Sql, source: ReplicaSource | null, inTransaction: boolean): SqlExecutor {
  const route = <T>(read: (exec: SqlExecutor) => Promise<T>) => routeRead(primary, source, inTransaction, conn => read(executorOn(conn)));
  const base = executorOn(primary());
  return {
    dialect: base.dialect,
    capabilities: base.capabilities,
    query: (sql, params, opts) => route(exec => exec.query(sql, params, opts)),
    run: (fragment, opts) => route(exec => exec.run(fragment, opts)),
    executeRaw: (sql, params, opts) => route(exec => exec.executeRaw(sql, params, opts)),
    unsafe: (sql, params) => route(exec => exec.unsafe(sql, params)),
    transaction: fn => route(exec => exec.transaction(fn)),
  };
}

/** Runs `read` on the replica when this read may use it, else on the primary. */
export async function routeRead<T>(primary: () => Sql, source: ReplicaSource | null, inTransaction: boolean, read: (conn: Sql) => Promise<T>): Promise<T> {
  const replica = inTransaction || !replicaReadsAllowed() ? null : source?.replica() ?? null;
  if (!replica) return read(primary());
  try {
    return await read(replica);
  } catch (err) {
    if (!isReplicaFallbackError(err)) throw err;
    if (!isRecoveryConflict(err)) {
      source!.markReplicaDown(REPLICA_COOLDOWN_MS);
      const code = (err as { code?: unknown } | null)?.code;
      warnOncePerProcess('replica_read_fallback',
        `[gbrain] read replica unavailable (${typeof code === 'string' ? code : 'connection error'}); reading from the primary for ${REPLICA_COOLDOWN_MS / 1000}s. Run \`gbrain doctor\` to check replica_connection.`);
    }
    return read(primary());
  }
}
