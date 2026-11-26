/**
 * Test helper: a lease-fenced writer on a multi-user Rust brain (lane L5; rust/crates/gbrain-store/src/leases.rs,
 * src/core/persistence/host-fence.ts). A test takes a host lease, registers it on the engine so every protected call
 * (cycle locks, job and write claims, effects) carries it as its fence, and can take the lease over to see the old
 * holder's writes refused at commit with `lease_lost`.
 *
 *   const host = await registerHostLease(engine, 'consumer:h1');
 *   const lock = await lockCycleUnderFence(engine, 'gbrain-sync:default');   // a cycle-lock row written under host.fence
 *   await host.takeOver();                                                   // a new epoch; the old fence is stale
 *   await lock.refresh();                                                    // rejects lease_lost / epoch_moved
 *
 * The helper only drives public members (`rustLeases`, `setHostRegistration`, `tryAcquireDbLock`); it writes no raw key.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { tryAcquireDbLock } from '../../src/core/db-lock.ts';
import { clearHostRegistration, setHostRegistration, type HostRegistration } from '../../src/core/persistence/host-fence.ts';
import { rustLeases, type LeaseToken, type WriteOrigin } from '../../src/core/rust-engine/store-members/leases.ts';

export interface HostLease {
  /** The fence protected calls on the engine carry now. */
  readonly fence: LeaseToken;
  /** Releases this lease and takes it under another holder at a new epoch; this holder's fence is then stale. */
  takeOver(): Promise<LeaseToken>;
  /** Removes the registration from the engine (the lease stays as it is). */
  unregister(): void;
}

type LeaseEngine = BrainEngine | { openStore(member: string): { brain: never } };

const origin = (holder: string): WriteOrigin => ({ host_id: `${holder}-host`, incarnation: `${holder}-incarnation`, writer_id: 'local_cli:test' });

/** Takes lease `name` (60 s) and registers it on `engine` as its host fence. Throws when another holder has it live. */
export async function registerHostLease(engine: LeaseEngine, name: string, holder = 'a'): Promise<HostLease> {
  const leases = rustLeases(engine as never);
  const fence = await leases.acquire(name, origin(holder), 60_000);
  if (!fence) throw new Error(`registerHostLease: another holder has ${name} live`);
  const registration: HostRegistration = { hostId: `${holder}-host`, origin: origin(holder), fence };
  setHostRegistration(engine, registration);
  return {
    fence,
    async takeOver() {
      await leases.release(fence);
      const next = await leases.acquire(name, origin(`${holder}-successor`), 60_000);
      if (!next) throw new Error(`registerHostLease: ${name} could not be taken over`);
      return next;
    },
    unregister() { clearHostRegistration(engine, registration); },
  };
}

/** Takes cycle lock `lockId` on `engine` under the engine's registered fence; the handle keeps that fence. */
export async function lockCycleUnderFence(engine: BrainEngine, lockId: string, ttlMinutes = 30) {
  const handle = await tryAcquireDbLock(engine, lockId, ttlMinutes);
  if (!handle) throw new Error(`lockCycleUnderFence: ${lockId} is held`);
  return handle;
}
