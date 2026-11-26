/**
 * The host registration a full persistence consumer keeps on a Rust brain in multi-user mode (lane L5,
 * docs/designs/rust-engine/multi-user-server.md "Hosts and fencing"; host-fence.ts holds what callers read).
 *
 * `startHostRegistration` takes the lease `consumer:<host_id>` (a forced consumer: `consumer:<host_id>:forced:<nonce>`)
 * and keeps it: it renews every `everyMs` (default 10 s) well inside the 60 s lease; when a renewal finds the lease lost
 * (this host slept past it, or another process took it over) it takes the lease again under a new epoch, so the writes
 * it began under the old epoch stay refused; while another live process holds the name it retries each tick, never
 * waiting on a lock and never raising a busy error. `stop` releases the lease and clears the registration.
 *
 * On any other engine, and on a Rust brain with multi-user mode off, it does nothing and `fenceFor` answers null.
 */
import type { BrainEngine } from '../engine.ts';
import { rustLeases, type LeaseToken, type RustLeases, type WriteOrigin } from '../rust-engine/store-members/leases.ts';
import { clearHostRegistration, HOST_FENCE_TTL_MS, hostLeaseName, setHostRegistration, type HostRegistration } from './host-fence.ts';

/** True for a Rust engine whose open store runs in multi-user mode (I-0). */
export function rustMultiuserEngine(engine: object): boolean {
  const e = engine as { kind?: unknown; openStoreIfOpen?: (member: string) => { multiuser?: unknown } | null };
  if (e.kind !== 'rust' || typeof e.openStoreIfOpen !== 'function') return false;
  try { return e.openStoreIfOpen('consumer_election')?.multiuser === true; } catch { return false; }
}

export interface HostRegistrationHandle {
  /** Renews now (or registers when unregistered). Never rejects. */
  renew(): Promise<void>;
  /** The current fence, or null while unregistered. */
  readonly fence: LeaseToken | null;
  /** Stops renewing, releases the lease and clears the registration. */
  stop(): Promise<void>;
}

export interface HostRegistrationOpts {
  hostId: string;
  /** This process: `incarnation` is its per-process nonce, `writer_id` names the consumer kind. */
  origin: WriteOrigin;
  /** Set for a forced consumer (it registers under its own name beside the elected one). */
  forcedNonce?: string;
  /**
   * The lease name itself, for a process that registers on its own (managed-registration.ts): unique to the process, so a
   * crashed predecessor's live lease never delays it and two processes never contend for one name.
   */
  leaseName?: string;
  everyMs?: number;
  ttlMs?: number;
  /** Receives each failure (default: one stderr line per failure streak). */
  onError?: (error: unknown) => void;
  /** Test seam: the lease members (default: the engine's). */
  leases?: RustLeases;
}

const INERT: HostRegistrationHandle = { renew: async () => {}, get fence() { return null; }, stop: async () => {} };

/** Starts the registration of `engine`'s full consumer for its host; inert unless the engine is multi-user Rust. */
export function startHostRegistration(engine: BrainEngine | object, opts: HostRegistrationOpts): HostRegistrationHandle {
  if (!opts.leases && !rustMultiuserEngine(engine)) return INERT;
  const leases = opts.leases ?? rustLeases(engine as { openStore(member: string): { brain: never } });
  const name = opts.leaseName ?? hostLeaseName(opts.hostId, opts.forcedNonce);
  const ttlMs = opts.ttlMs ?? HOST_FENCE_TTL_MS;
  let current: HostRegistration | null = null;
  let stopped = false;
  let streak = 0;
  let inFlight: Promise<void> | undefined;
  const report = (error: unknown) => {
    if (opts.onError) { opts.onError(error); return; }
    if (streak++ > 0) return;
    const message = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 200) : String(error);
    process.stderr.write(`[persistence] phase=host_registration reason=renewal_failed message="${message}"; protected writes from this process refuse lease_lost until it registers again; fix: gbrain engine status --json\n`);
  };
  const register = async (): Promise<void> => {
    const fence = await leases.acquire(name, opts.origin, ttlMs);
    if (stopped) { if (fence) await leases.release(fence).catch(() => undefined); return; }
    if (!fence) return; // another live process holds the name: retry next tick
    const next: HostRegistration = { hostId: opts.hostId, origin: opts.origin, fence };
    if (current) clearHostRegistration(engine, current);
    current = next;
    setHostRegistration(engine, next);
  };
  const once = async (): Promise<void> => {
    try {
      if (!current) { await register(); streak = 0; return; }
      try {
        await leases.renew(current.fence, ttlMs);
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'lease_lost') throw error;
        // Lost (expired while away, or taken over): drop the old fence at once, then register under a new epoch.
        clearHostRegistration(engine, current);
        current = null;
        await register();
      }
      streak = 0;
    } catch (error) {
      if (!stopped) report(error);
    }
  };
  const renew = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    const attempt = once().finally(() => { if (inFlight === attempt) inFlight = undefined; });
    inFlight = attempt;
    return attempt;
  };
  const cadence = setInterval(() => { void renew(); }, opts.everyMs ?? 10_000);
  cadence.unref?.();
  void renew();
  return {
    renew,
    get fence() { return current?.fence ?? null; },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(cadence);
      await inFlight;
      const held = current;
      current = null;
      if (held) {
        clearHostRegistration(engine, held);
        await leases.release(held.fence).catch(() => undefined);
      }
    },
  };
}
