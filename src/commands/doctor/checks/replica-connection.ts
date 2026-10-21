/**
 * `replica_connection`: when a Postgres brain has `replica_database_url`, the
 * replica answers, is a standby (pg_is_in_recovery), and how long ago it
 * replayed its last transaction. Reads fall back to the primary when the
 * replica fails, so an unreachable replica is a warning, not an outage.
 */
import type { ConnectionManager } from '../../../core/connection-manager.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const PROBE_TIMEOUT_MS = 5_000;

interface ReplicaProbe { in_recovery: boolean; replay_age_s: number | null }

async function probeReplica(manager: ConnectionManager): Promise<ReplicaProbe> {
  const pool = manager.replica();
  if (!pool) throw new Error('the replica is cooling down after a failed read');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${PROBE_TIMEOUT_MS / 1000}s`)), PROBE_TIMEOUT_MS); });
  try {
    const rows = await Promise.race([
      pool.unsafe(`SELECT pg_is_in_recovery() AS in_recovery,
        EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::float8 AS replay_age_s`),
      timeout,
    ]) as unknown as ReplicaProbe[];
    return rows[0] ?? { in_recovery: false, replay_age_s: null };
  } finally {
    clearTimeout(timer);
  }
}

async function runReplicaConnection(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const manager = (connectedEngine(ctx) as { connectionManager?: ConnectionManager | null }).connectionManager;
  const host = manager?.describeMode().replica_host;
  if (!manager || !host) return checks;
  try {
    const probe = await probeReplica(manager);
    if (!probe.in_recovery) {
      checks.push({
        name: 'replica_connection', status: 'warn',
        message: `replica_database_url (${host}) is not a standby (pg_is_in_recovery is false). Reads go to it as if it were a replica of database_url; point it at a read replica of the primary, or remove it with: gbrain config set replica_database_url ""`,
        details: { host, in_recovery: false },
      });
    } else {
      const age = probe.replay_age_s === null ? 'no transaction replayed yet' : `last transaction replayed ${probe.replay_age_s.toFixed(1)}s ago`;
      checks.push({
        name: 'replica_connection', status: 'ok',
        message: `Read replica ${host} answers (${age}; an idle primary also makes this grow).`,
        details: { host, in_recovery: true, replay_age_s: probe.replay_age_s },
      });
    }
  } catch (e) {
    checks.push({
      name: 'replica_connection', status: 'warn',
      message: `Read replica ${host} did not answer (${e instanceof Error ? e.message : String(e)}); reads use the primary until it does. Check replica_database_url or GBRAIN_REPLICA_DATABASE_URL.`,
      details: { host, reachable: false },
    });
  }
  return checks;
}

export const replicaConnectionEntry: DoctorEntry = {
  name: 'replica_connection',
  emits: ['replica_connection'],
  run: runReplicaConnection,
};
