/**
 * The job worker's own host registration on a Rust brain in multi-user mode (lane L5; persistence/host-fence.ts).
 *
 * The persistence consumer registers its host with the lease `consumer:<host_id>`. A job worker process that runs no
 * consumer has no registration, and every protected job call (claim, renew, complete, fail, the releases, the stall
 * sweep) refuses `lease_lost` / `fence_missing` on a multi-user store without one. So the worker takes its own
 * lease, `jobs:<host_id>:<pid>:<nonce>` (unique to the process, so two workers never contend for it), when it starts,
 * renews it every 10 s, and releases it when it stops. The token goes in with `setHostRegistration`, where `fenceOpts`
 * finds it; the queue passes it to every protected call.
 *
 * A worker whose lease expired (paused, cut off) fails the renewal with `lease_lost`, takes the lease again under a new
 * epoch, and from then on carries the new fence. The jobs it claimed under the old epoch can no longer be finished
 * with it: their claims expire and another worker claims them, which is the point.
 *
 * Nothing happens unless the engine is a Rust engine whose store runs in multi-user mode, and nothing is registered
 * twice: a process that already has a registration (a consumer in the same process) uses that one.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { clearHostRegistration, HOST_FENCE_TTL_MS, hostRegistrationOf, setHostRegistration, type HostRegistration } from '../persistence/host-fence.ts';
import { hostIdFor } from '../persistence/identity.ts';
import { leasesOn, type RustLeases } from '../rust-engine/store-members/leases.ts';
import type { RustStore } from '../rust-engine/store.ts';
import { storeErrorCode } from '../rust-engine/store-errors.ts';

/** How often the registration is renewed (ms): the lease lives six renewals. */
export const WORKER_FENCE_RENEW_MS = 10_000;

export interface WorkerFence {
  /** Stops renewing, clears the registration and releases the lease. Never rejects. */
  stop(): Promise<void>;
}

/** The store of a Rust engine in multi-user mode, or null for every other engine. */
function multiuserStore(engine: BrainEngine): RustStore | null {
  const open = (engine as { openStoreIfOpen?: (member: string) => RustStore | null }).openStoreIfOpen;
  if (engine.kind !== 'rust' || typeof open !== 'function') return null;
  const store = open.call(engine, 'worker-fence');
  return store?.multiuser ? store : null;
}

/**
 * Registers the worker on `engine` when it needs a fence; null when it does not (not Rust, not multi-user, or already
 * registered). `workerId` names the writer in the lease's holder record.
 */
export async function startWorkerFence(engine: BrainEngine, workerId: string,
  timing: { renewMs?: number; ttlMs?: number } = {}): Promise<WorkerFence | null> {
  const store = multiuserStore(engine);
  if (!store || hostRegistrationOf(engine)) return null;
  const leases: RustLeases = leasesOn(store.brain);
  const hostId = hostIdFor(engine);
  const nonce = randomUUID();
  const name = `jobs:${hostId}:${process.pid}:${nonce}`;
  const ttlMs = timing.ttlMs ?? HOST_FENCE_TTL_MS;
  const origin = { host_id: hostId, incarnation: nonce, writer_id: `job_worker:${workerId}` };
  let current: HostRegistration | null = null;
  const register = async (): Promise<void> => {
    const fence = await leases.acquire(name, origin, ttlMs);
    if (!fence) return;
    const next: HostRegistration = { hostId, origin, fence };
    if (current) clearHostRegistration(engine, current);
    current = next;
    setHostRegistration(engine, next);
  };
  await register();
  if (!current) return null;
  let renewing: Promise<void> | undefined;
  const renew = async (): Promise<void> => {
    const held = current;
    if (!held) return;
    try {
      await leases.renew(held.fence, ttlMs);
    } catch (error) {
      // The lease moved or expired: take it again under a new epoch. Any other failure waits for the next tick.
      if (storeErrorCode(error) === 'lease_lost') await register().catch(() => undefined);
    }
  };
  const timer = setInterval(() => { if (!renewing) renewing = renew().finally(() => { renewing = undefined; }); }, timing.renewMs ?? WORKER_FENCE_RENEW_MS);
  timer.unref?.();
  return {
    async stop() {
      clearInterval(timer);
      await renewing;
      const held = current;
      current = null;
      if (!held) return;
      clearHostRegistration(engine, held);
      await leases.release(held.fence).catch(() => undefined);
    },
  };
}
