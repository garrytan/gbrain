/**
 * GBRA-156: one housekeeping turn per host for one-shot commands.
 *
 * A one-shot command (`gbrain put`, `gbrain remember`, any shared operation the CLI runs once and exits) starts a full
 * consumer to publish its own write. The consumer's housekeeping (recovery and expired-claim scans, dead-owner and topology
 * recovery, compaction and queue upkeep, the resident projection pass) is not what that write waits on. Many brains have no
 * resident process, so these commands are also the only thing that runs it: it is rationed, not removed, and it runs after
 * the reply (consumer.ts `runOneShotHousekeeping`, from the consumer's shutdown). The turn is granted at most once per
 * `GBRAIN_ONESHOT_HOUSEKEEPING_INTERVAL_MS` (default 5 minutes) across this host's processes, judged from the last turn that
 * finished, and never while a resident full consumer on the host is live, because that one already runs the same scans.
 * The op_checkpoints row (op `consumer-housekeeping`, fingerprint the host id) holds the state: `["leased"]` while a
 * process holds the turn (a lease of HOUSEKEEPING_LEASE_MS, so a turn cut short by an exit or an abort is free again
 * after it) and `["done"]` once one finished, `updated_at` stamping either. The scans a waiting write may be blocked
 * behind still run at once (consumer.ts `sweepAllowed`).
 */
import type { SqlEngine } from './model.ts';
import { CONSUMER_LIVE_MS, RESIDENT_CONSUMER_KINDS } from './consumer-heartbeat.ts';

export const HOUSEKEEPING_TURN_OP = 'consumer-housekeeping';
export const HOUSEKEEPING_INTERVAL_MS_DEFAULT = 300_000;
export const HOUSEKEEPING_LEASE_MS = 60_000;

export function housekeepingIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.GBRAIN_ONESHOT_HOUSEKEEPING_INTERVAL_MS;
  const value = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : HOUSEKEEPING_INTERVAL_MS_DEFAULT;
}

/**
 * Claims the host's housekeeping turn: true when the last finished turn is older than `intervalMs`, no other process holds
 * an unexpired lease on it, and no resident full consumer of the host is live.
 */
export async function claimHousekeepingTurn(engine: SqlEngine, hostId: string, intervalMs: number, signal?: AbortSignal): Promise<boolean> {
  const [row] = await engine.executeRaw<{ claimed: boolean }>(`WITH claim AS (
      INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
      SELECT $1::text, $2::text, '["leased"]'::jsonb, now() WHERE NOT EXISTS (SELECT 1 FROM persistence_consumers WHERE host_id=$2::text::uuid
        AND kind=ANY($4::text[]) AND mode IN ('full','promoted') AND renewed_at > now() - ($5::integer * interval '1 millisecond'))
      ON CONFLICT (op, fingerprint) DO UPDATE SET updated_at=now(), completed_keys='["leased"]'::jsonb
      WHERE op_checkpoints.updated_at <= now() - (CASE WHEN op_checkpoints.completed_keys='["done"]'::jsonb THEN $3::bigint ELSE $6::bigint END
        * interval '1 millisecond') RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM claim) AS claimed`, [HOUSEKEEPING_TURN_OP, hostId, intervalMs, [...RESIDENT_CONSUMER_KINDS], CONSUMER_LIVE_MS, HOUSEKEEPING_LEASE_MS], { signal });
  return row?.claimed === true;
}

/** Marks the host's leased turn finished: the next one is due `intervalMs` from now. */
export async function completeHousekeepingTurn(engine: SqlEngine, hostId: string): Promise<void> {
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys='["done"]'::jsonb, updated_at=now()
    WHERE op=$1 AND fingerprint=$2 AND completed_keys='["leased"]'::jsonb`, [HOUSEKEEPING_TURN_OP, hostId]);
}
