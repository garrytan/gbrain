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
import { consumerIdentity, consumerProvablyDead, type ConsumerProcessIdentity } from './consumer-heartbeat.ts';

/**
 * The holder origin of this process: `incarnation` is its nonce, and `writer_id` carries the process markers
 * (`<kind>@<pid>/<pid namespace>/<boot id>/<start>`) so another process of this machine can prove it dead from the lease
 * record alone, as #6650 does for heartbeat rows.
 */
export function processOrigin(hostId: string, kind: string, self: ConsumerProcessIdentity = consumerIdentity()): WriteOrigin {
  const mark = (v: string | null | undefined) => (v ?? '').replace(/[/@\0]/g, '_');
  return { host_id: hostId, incarnation: self.nonce, writer_id: `${kind}@${self.pid}/${mark(self.pid_ns)}/${mark(self.boot_id)}/${mark(self.start)}` };
}

/** The process markers a holder origin carries (`processOrigin`), or null for an origin without them. */
export function originProcess(origin: WriteOrigin): { pid: number; nonce: string; pid_ns: string | null; boot_id: string | null; start: string | null } | null {
  const at = origin.writer_id.lastIndexOf('@');
  if (at < 0) return null;
  const [pid, pidNs, bootId, start] = origin.writer_id.slice(at + 1).split('/');
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  const or = (v: string | undefined) => (v ? v : null);
  return { pid: n, nonce: origin.incarnation, pid_ns: or(pidNs), boot_id: or(bootId), start: or(start) };
}

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
  /** The first registration attempt's fence: null when another live holder has the lease (or the call failed). */
  readonly first: Promise<LeaseToken | null>;
  /** Stops renewing, releases the lease and clears the registration. */
  stop(): Promise<void>;
}

export interface HostRegistrationOpts {
  hostId: string;
  /** This process: `incarnation` is its per-process nonce, `writer_id` names the consumer kind. */
  origin: WriteOrigin;
  /** Set for a forced consumer (it registers under its own name beside the elected one). */
  forcedNonce?: string;
  everyMs?: number;
  ttlMs?: number;
  /** Receives each failure (default: one stderr line per failure streak). */
  onError?: (error: unknown) => void;
  /** Called once when a registration this handle held is lost and could not be taken again (another holder has it). */
  onLost?: () => void;
  /** This process's markers, to tell a dead holder from a live one (default `consumerIdentity()`; a test seam). */
  self?: ConsumerProcessIdentity;
  /** Test seam: the lease members (default: the engine's). */
  leases?: RustLeases;
}

const INERT: HostRegistrationHandle = { renew: async () => {}, get fence() { return null; }, first: Promise.resolve(null), stop: async () => {} };

/** Starts the registration of `engine`'s full consumer for its host; inert unless the engine is multi-user Rust. */
export function startHostRegistration(engine: BrainEngine | object, opts: HostRegistrationOpts): HostRegistrationHandle {
  if (!opts.leases && !rustMultiuserEngine(engine)) return INERT;
  const leases = opts.leases ?? rustLeases(engine as { openStore(member: string): { brain: never } });
  const name = hostLeaseName(opts.hostId, opts.forcedNonce);
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
    let fence = await leases.acquire(name, opts.origin, ttlMs);
    if (!fence) {
      // Another holder's lease reads live. A process of this machine that is provably gone (it exited without
      // releasing) is taken over at once, at the epoch read; anything else waits for the lease to lapse.
      const held = await leases.read(name);
      const proc = held && held.holder.host_id === opts.hostId ? originProcess(held.holder) : null;
      if (held && proc && consumerProvablyDead(proc, opts.self ?? consumerIdentity())) {
        fence = await leases.takeOver(name, held.epoch, opts.origin, ttlMs);
      }
    }
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
        if (!current && !stopped) opts.onLost?.();
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
  const first = renew().then(() => current?.fence ?? null);
  return {
    renew,
    get fence() { return current?.fence ?? null; },
    first,
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
