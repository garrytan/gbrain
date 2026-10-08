/**
 * A set of cycle leases held as one (#6242).
 *
 * A source-scoped cycle that also runs brain-wide phases holds its source
 * lease (`gbrain-cycle:<source>`) and, when it can get it, the shared
 * maintenance lease (`gbrain-cycle`). `acquireLeaseSet` takes the required
 * ids, then the optional ones, without waiting, in that fixed order with
 * duplicates dropped. A busy required lease or any acquire that throws
 * releases everything taken so far, so a failed attempt never strands a row;
 * a busy optional lease is reported and the set holds what it has. The
 * combined handle refreshes every lease in order and reports false at the
 * first one it no longer owns (a fenced refresh), and releases every lease
 * even when one release throws, rethrowing the first failure.
 *
 * When the maintenance lease is busy the cycle runs its source phases and
 * reports each brain-wide phase with `maintenanceLockBusySkip`.
 */
import type { Action } from '../agent-output.ts';
import type { CyclePhase, PhaseResult } from '../cycle.ts';
import type { LockSnapshot } from '../db-lock.ts';
import { PHASE_SCOPE } from './phase-scope.ts';

export const MAINTENANCE_LEASE_ID = 'gbrain-cycle';
export const MAINTENANCE_LOCK_BUSY = 'maintenance_lock_busy';

export interface Lease {
  refresh: () => Promise<boolean>;
  release: () => Promise<void>;
}

export type LeaseSetResult =
  | { status: 'acquired'; lease: Lease; busyOptional: string | null }
  | { status: 'busy'; busyId: string };

/** Combine held leases into one: refresh in order (false on first loss), release in reverse, every one. */
export function combineLeases(leases: readonly Lease[]): Lease {
  return {
    refresh: async () => {
      for (const lease of leases) {
        if (!(await lease.refresh())) return false;
      }
      return true;
    },
    release: async () => {
      let first: unknown;
      let failed = false;
      for (const lease of [...leases].reverse()) {
        try {
          await lease.release();
        } catch (e) {
          if (!failed) { first = e; failed = true; }
        }
      }
      if (failed) throw first;
    },
  };
}

export async function acquireLeaseSet(
  required: readonly string[],
  acquire: (id: string) => Promise<Lease | null>,
  optional: readonly string[] = [],
): Promise<LeaseSetResult> {
  const held: Lease[] = [];
  const rollback = async () => {
    await combineLeases(held).release().catch((e: unknown) => {
      console.error(`[cycle] lease rollback release failed: ${e instanceof Error ? e.message : String(e)} — a row may remain in gbrain_cycle_locks until TTL expiry`);
    });
  };
  const take = async (id: string): Promise<Lease | null> => {
    try {
      return await acquire(id);
    } catch (e) {
      await rollback();
      throw e;
    }
  };
  const requiredIds = new Set(required);
  for (const id of requiredIds) {
    const lease = await take(id);
    if (lease === null) {
      await rollback();
      return { status: 'busy', busyId: id };
    }
    held.push(lease);
  }
  for (const id of new Set(optional)) {
    if (requiredIds.has(id)) continue;
    const lease = await take(id);
    if (lease === null) return { status: 'acquired', lease: combineLeases(held), busyOptional: id };
    held.push(lease);
  }
  return { status: 'acquired', lease: combineLeases(held), busyOptional: null };
}

/** The skipped result for a brain-wide phase whose maintenance lease another cycle holds. */
export function maintenanceLockBusySkip(phase: CyclePhase, holder: LockSnapshot | null): PhaseResult {
  const fix: Action = {
    argv: ['gbrain', 'dream', '--phase', phase],
    consent: ['paid'],
    actor: 'agent',
    why: `Runs ${phase} once ${MAINTENANCE_LEASE_ID} is free (the holder usually runs it itself); LLM-backed phases spend, so ask the user first.`,
    verify: { argv: ['gbrain', 'status', '--section', 'locks', '--json'] },
    requires_exclusive: false,
  };
  const by = holder ? ` by pid ${holder.holder_pid} on ${holder.holder_host}` : '';
  return {
    phase,
    status: 'skipped',
    duration_ms: 0,
    summary: `skipped: brain-wide maintenance lease ${MAINTENANCE_LEASE_ID} is held${by}; source phases ran`,
    details: {
      reason: MAINTENANCE_LOCK_BUSY,
      code: MAINTENANCE_LOCK_BUSY,
      phase_scope: PHASE_SCOPE[phase],
      lock_id: MAINTENANCE_LEASE_ID,
      ...(holder ? { lock_holder: { id: holder.id, holder_pid: holder.holder_pid, holder_host: holder.holder_host, age_ms: holder.age_ms } } : {}),
      why: 'Another cycle, usually autopilot maintenance, holds the brain-wide lease, so this phase would have run twice at once.',
      fix,
    },
  };
}
