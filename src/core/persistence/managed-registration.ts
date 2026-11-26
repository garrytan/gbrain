/**
 * The process's own host registration on a multi-user Rust brain (lane LM slice 3, gate C1; host-fence.ts,
 * host-registration.ts).
 *
 * Every protected write and every managed lease names the host that makes it, and a multi-user store refuses a protected
 * call with no host fence (`lease_lost` / `fence_missing`). The persistence consumer of a resident process registers
 * (consumer-election.ts), but a one-shot source lifecycle command, a refresh, a resume, a sync pass or writer
 * administration reaches its first managed lock with no consumer started, and a registration kept by another process
 * is not readable here. So the process that is about to take a managed lock, or that starts its persistence consumer
 * on such a brain, first registers itself: it takes a lease of its own (`process:<host>:<pid>:<nonce>`, unique to the
 * process, so a crashed predecessor's lease never delays it and it never borrows another process's token or forces a
 * second consumer), waits until the lease is acquired, renews it while the process lives, and releases it when its
 * engine disconnects. Without a registration the caller refuses `lease_lost` / `fence_missing`; nothing runs unfenced.
 *
 * On every other engine, and on a Rust brain with multi-user mode off, it does nothing.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { hostRegistrationOf, type HostRegistration } from './host-fence.ts';
import { rustMultiuserEngine, startHostRegistration, type HostRegistrationHandle } from './host-registration.ts';
import { hostIdFor } from './identity.ts';
import { managedRoot } from './managed-operations.ts';

/** How long a command waits for its registration to be acquired before it refuses. */
export const REGISTRATION_WAIT_MS = 5_000;

const registering = new WeakMap<object, Promise<HostRegistration | null>>();

/**
 * The registration of `engine`'s process: the one a consumer already set, else a new one of its own. Null when `engine`
 * is not a multi-user Rust brain, or when no registration could be taken within `waitMs` (the caller then refuses).
 * `writerId` names the kind of process in the lease's holder record.
 */
export function ensureProcessRegistration(engine: BrainEngine | object, writerId: string,
  opts: { waitMs?: number; everyMs?: number; ttlMs?: number } = {}): Promise<HostRegistration | null> {
  const root = managedRoot(engine);
  if (!rustMultiuserEngine(root)) return Promise.resolve(null);
  const existing = hostRegistrationOf(root);
  if (existing) return Promise.resolve(existing);
  const pending = registering.get(root);
  if (pending) return pending;
  const started = (async (): Promise<HostRegistration | null> => {
    const hostId = hostIdFor(root);
    const nonce = randomUUID();
    const handle: HostRegistrationHandle = startHostRegistration(root, {
      hostId, leaseName: `process:${hostId}:${process.pid}:${nonce}`,
      origin: { host_id: hostId, incarnation: nonce, writer_id: `local_process:${writerId}` },
      ...(opts.everyMs !== undefined ? { everyMs: opts.everyMs } : {}), ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    });
    const lifecycle = root as { registerBeforeDisconnect?: (stop: () => Promise<void>) => unknown };
    lifecycle.registerBeforeDisconnect?.(() => handle.stop());
    const deadline = Date.now() + (opts.waitMs ?? REGISTRATION_WAIT_MS);
    for (;;) {
      await handle.renew();
      const registered = hostRegistrationOf(root);
      if (registered) return registered;
      if (Date.now() >= deadline) { await handle.stop(); return null; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })().finally(() => { registering.delete(root); });
  registering.set(root, started);
  return started;
}
