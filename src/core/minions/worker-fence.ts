/**
 * The job worker's own host registration on a Rust brain in multi-user mode (lane L5; persistence/host-fence.ts).
 *
 * The persistence consumer registers its host with the lease `consumer:<host_id>`. A job worker process that runs no
 * consumer has no registration. A protected job call with no fence is not refused on a multi-user store (the store
 * takes an implicit lease for the claim), but it cannot finish a claim a registered holder's live lease owns
 * (`lease_lost` / `held_by_another`), and a worker is such a holder: it takes its own
 * lease, `jobs:<host_id>:<pid>:<nonce>` (unique to the process, so two workers never contend for it), when it starts,
 * renews it every 10 s, and releases it when it stops. The token goes in with `setHostRegistration`, where `fenceOpts`
 * finds it; the queue passes it to every protected call.
 *
 * A worker whose lease expired (paused, cut off) fails the renewal with `lease_lost`, takes the lease again under a new
 * epoch, and from then on carries the new fence. The jobs it claimed under the old epoch can no longer be finished
 * with it: their claims expire and another worker claims them, which is the point.
 *
 * Nothing happens unless the engine is a Rust engine whose store runs in multi-user mode. Every worker takes and owns its
 * own lease: it never borrows the registration of a consumer or of another worker in the same process (review G11), so
 * stopping one never clears another's, and `fence()` is the registration the worker's own queue claims under.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { LeaseToken } from '../engine-sql/lease-token.ts';
import { clearHostRegistration, HOST_FENCE_TTL_MS, setHostRegistration, type HostRegistration } from '../persistence/host-fence.ts';
import { hostIdFor } from '../persistence/identity.ts';
import { leasesOn, type RustLeases } from '../rust-engine/store-members/leases.ts';
import type { RustStore } from '../rust-engine/store.ts';
import { storeErrorCode } from '../rust-engine/store-errors.ts';

/** How often the registration is renewed (ms): the lease lives six renewals. */
export const WORKER_FENCE_RENEW_MS = 10_000;

export interface WorkerFence {
  /** The worker's own current fence (a new object after it took its lease again under a new epoch); null once stopped. */
  fence(): LeaseToken | null;
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
 * Registers the worker on `engine` when it needs a fence; null when it does not (not Rust, or not multi-user).
 * `workerId` names the writer in the lease's holder record.
 */
export async function startWorkerFence(engine: BrainEngine, workerId: string,
  timing: { renewMs?: number; ttlMs?: number } = {}): Promise<WorkerFence | null> {
  const store = multiuserStore(engine);
  if (!store) return null;
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
    fence: () => current?.fence ?? null,
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
