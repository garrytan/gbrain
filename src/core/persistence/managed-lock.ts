/**
 * The one seam through which managed mode takes a lock (lane LM slice 3; docs/designs/rust-engine/multi-user-server.md
 * "I-5, managed mode"; plan decisions 1-3).
 *
 * `managedLock(engine, kind, id, { path, waitMs, signal })` is `acquireNativeLock(path)` everywhere except on a Rust store
 * in multi-user mode, where it is a double guard in one fixed order: the I-5 lease `managed:<kind>:<id>` first, the owner
 * host's native lock second, and a release in the reverse order (native first, then the lease).
 *
 * - The lease fences store writes across hosts and processes. Its holder is the operation's own host registration
 *   (managed-registration.ts); a process with none refuses `lease_lost` / `fence_missing` and nothing runs unfenced. It
 *   lives 60 s and is renewed every 10 s while held. A renewal that finds the lease lost marks the handle `lost`
 *   for good (nothing re-acquires into the old work), and every protected write transaction of the process then refuses
 *   `lease_lost` (managed-operations.ts) until the holder releases.
 * - The native lock stays, because a lease cannot stop a paused process from touching files it already holds a path
 *   to: it is the non-expiring guard of the checkout files on the owner host. A paused writer therefore still blocks a
 *   same-host successor's file work until it exits, which is a safety property and not a lease bug.
 * - A wait polls the lease within the caller's own deadline and ends with null (the caller's existing busy answer:
 *   `write_pending` and the like). There is no busy error, no file lock and no process mutex in the store.
 *
 * Elsewhere (PGLite, Postgres, a Rust store with multi-user off, a Rust engine with no store here) the call returns the
 * native handle itself, so those engines behave exactly as before. A caller passes its engine; there is no engine-less
 * route to a managed lock, so a multi-user store is never left with a native-only lock by a missing argument.
 */
import type { BrainEngine } from '../engine.ts';
import { rustLeases, type LeaseToken } from '../rust-engine/store-members/leases.ts';
import { storeErrorCode } from '../rust-engine/store-errors.ts';
import { rustMultiuserFromEnv } from '../rust-engine/multiuser-switch.ts';
import { acquireNativeLock, tryAcquireNativeLock, type NativeLockHandle } from './native-lock.ts';
import { hostRegistrationOf } from './host-fence.ts';
import { rustMultiuserEngine } from './host-registration.ts';
import { ensureProcessRegistration } from './managed-registration.ts';
import { leaseLostError, managedRoot, multiuserRustEngineOpen, registerManagedOperation, type ManagedOperation } from './managed-operations.ts';
import type { LeaseLostReason } from '../rust-engine/store-errors.ts';

export type ManagedKind = 'topology' | 'worktree' | 'refresh';

/** How long a managed lease lives without a renewal (ms), how often a holder renews it, and how often a waiter polls. */
export const MANAGED_LEASE_TTL_MS = 60_000;
export const MANAGED_RENEW_EVERY_MS = 10_000;
export const MANAGED_POLL_MS = 25;

/** A native lock handle that may carry managed lease state: a handle of a multi-user Rust store always does. */
export interface ManagedLockHandle extends NativeLockHandle {
  /** True once a renewal found a lease lost. A lost handle must stop; its protected writes refuse `lease_lost`. */
  readonly lost?: boolean;
  /** The managed lease tokens this handle holds (empty off a multi-user store). */
  readonly tokens?: readonly LeaseToken[];
  /** The host fence the operation was started under (null off a multi-user store). */
  readonly hostFence?: LeaseToken | null;
}

export interface ManagedLockOptions {
  /** The native lock's absolute path (the owner host's guard of the files this lock protects). */
  path: string;
  /** Zero tries once. */
  waitMs: number;
  signal?: AbortSignal;
  /** Test seam for the lease timing. */
  timing?: { ttlMs?: number; renewMs?: number; pollMs?: number; registrationWaitMs?: number };
}

/** The lease name of a managed lock. */
export const managedLeaseName = (kind: ManagedKind, id: string): string => `managed:${kind}:${id}`;

/** True when `engine` is a Rust engine whose open store runs in multi-user mode: managed locks are double guards there. */
export function managedLeasesApply(engine: BrainEngine | object | undefined): boolean {
  return engine !== undefined && rustMultiuserEngine(managedRoot(engine));
}

/**
 * The engine to hand `acquireWorktree` by a caller that never passed one: it selects the multi-user lease and nothing else.
 * Any other engine is withheld, because an engine also lets the lock re-stamp a drifted filesystem device (ownership.ts
 * lockWorktree), and those callers refused the drift before slice 3 and must keep refusing it.
 */
export function leaseEngine(engine: BrainEngine | undefined): BrainEngine | undefined {
  return engine !== undefined && managedLeasesApply(engine) ? engine : undefined;
}

/**
 * A read-only liveness probe of a native lock: takes it for an instant and releases it, so it holds no authority and takes
 * no lease. It answers only whether some process of THIS host holds the lock (a managed operation keeps its native lock
 * for as long as it holds its lease, so the answer is the same under the double guard). The probes are the only raw
 * native-lock acquisitions managed mode keeps (test/managed-lock-callers.test.ts lists them).
 */
export function probeNativeLock(path: string): Promise<NativeLockHandle | null> { return tryAcquireNativeLock(path); }

/** The `.catch` of a refresh lock acquisition that treats an unreadable native lock as busy but never hides a lost fence. */
export function nativeLockFailureAsBusy(error: unknown): null {
  if ((error as { code?: unknown } | null)?.code === 'lease_lost') throw error;
  return null;
}

/** True for a Rust engine that reaches its brain over another process's owner socket. */
function isOwnerClient(engine: object): boolean {
  return (engine as { ownerRole?: unknown }).ownerRole === 'client';
}

/** Whether a handle was lost (its lease was taken over, released or expired). False for a native-only handle. */
export function managedLockLost(handle: NativeLockHandle | null | undefined): boolean {
  return (handle as ManagedLockHandle | null | undefined)?.lost === true;
}

const nativeLock = (opts: ManagedLockOptions, waitMs: number): Promise<NativeLockHandle | null> =>
  waitMs > 0 ? acquireNativeLock(opts.path, { timeoutMs: waitMs, ...(opts.signal ? { signal: opts.signal } : {}) }) : tryAcquireNativeLock(opts.path);

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal!.reason); };
  signal?.addEventListener('abort', abort, { once: true });
});

export async function managedLock(engine: BrainEngine | object | undefined, kind: ManagedKind, id: string, opts: ManagedLockOptions): Promise<ManagedLockHandle | null> {
  if (engine === undefined) {
    // A caller with no engine cannot say which brain it guards: while a multi-user Rust brain is open in this process it
    // refuses (no silent native-only fallback); with none open it is the native lock, as before.
    if (multiuserRustEngineOpen(rustMultiuserEngine)) throw leaseLostError(new Error(JSON.stringify({ reason: 'fence_missing', name: managedLeaseName(kind, id), epoch: 0 })));
    return nativeLock(opts, opts.waitMs);
  }
  if (!managedLeasesApply(engine)) {
    // A second process that reaches a multi-user brain over its owner's socket holds no store, so it can take no lease and has no
    // registration: it refuses instead of holding a native lock alone while the owner runs the work (its whole operations run in the owner).
    if (isOwnerClient(engine) && rustMultiuserFromEnv()) throw leaseLostError(new Error(JSON.stringify({ reason: 'fence_missing', name: managedLeaseName(kind, id), epoch: 0 })));
    return nativeLock(opts, opts.waitMs);
  }
  const root = managedRoot(engine);
  const registration = hostRegistrationOf(root) ?? await ensureProcessRegistration(root, `managed_${kind}`, opts.timing?.registrationWaitMs !== undefined ? { waitMs: opts.timing.registrationWaitMs } : {});
  if (!registration) throw leaseLostError(new Error(JSON.stringify({ reason: 'fence_missing', name: managedLeaseName(kind, id), epoch: 0 })));
  const leases = rustLeases(root as { openStore(member: string): { brain: never } });
  const ttlMs = opts.timing?.ttlMs ?? MANAGED_LEASE_TTL_MS;
  const name = managedLeaseName(kind, id);
  const deadline = Date.now() + Math.max(0, opts.waitMs);
  opts.signal?.throwIfAborted();
  let token: LeaseToken | null;
  for (;;) {
    token = await leases.acquire(name, registration.origin, ttlMs);
    if (token) break;
    const remaining = deadline - Date.now();
    if (opts.waitMs <= 0 || remaining <= 0) return null;
    await sleep(Math.min(opts.timing?.pollMs ?? MANAGED_POLL_MS, remaining), opts.signal);
  }
  const held = token;
  let native: NativeLockHandle | null;
  try { native = await nativeLock(opts, Math.max(0, deadline - Date.now())); }
  catch (error) { await leases.release(held).catch(() => undefined); throw error; }
  if (!native) { await leases.release(held).catch(() => undefined); return null; }
  return guarded(root, leases, native, held, registration.fence, { ttlMs, renewMs: opts.timing?.renewMs ?? MANAGED_RENEW_EVERY_MS });
}

/** The double-guard handle: renews the lease while held, marks itself lost for good, releases native then lease. */
function guarded(root: object, leases: ReturnType<typeof rustLeases>, native: NativeLockHandle, token: LeaseToken, hostFence: LeaseToken,
  timing: { ttlMs: number; renewMs: number }): ManagedLockHandle {
  let released = false;
  let lost = false;
  let lostReason: LeaseLostReason | null = null;
  let lastRenewed = Date.now();
  let renewing: Promise<void> | undefined;
  const operation: ManagedOperation = {
    hostFence, tokens: [token],
    get lost() { return lost; }, get lostReason() { return lostReason; }, get released() { return released; },
  };
  const unregister = registerManagedOperation(root, operation);
  const markLost = (reason: LeaseLostReason) => { if (!lost) { lost = true; lostReason = reason; clearInterval(timer); } };
  const renewOnce = async (): Promise<void> => {
    if (released || lost) return;
    try {
      await leases.renew(token, timing.ttlMs);
      lastRenewed = Date.now();
    } catch (error) {
      const code = storeErrorCode(error) ?? (error as { code?: unknown }).code;
      if (code === 'lease_lost') markLost(reasonOf(error));
      // Any other failure waits for the next tick; a holder that could not renew for a whole lease term cannot show it still holds it.
      else if (Date.now() - lastRenewed >= timing.ttlMs) markLost('expired');
    }
  };
  const timer = setInterval(() => { if (!renewing) renewing = renewOnce().finally(() => { renewing = undefined; }); }, timing.renewMs);
  timer.unref?.();
  return {
    get released() { return released; },
    get lost() { return lost; },
    get tokens() { return [token]; },
    get hostFence() { return hostFence; },
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      unregister();
      // A renewal in flight is joined before the lease is released, so a release never races its own renewal.
      await renewing;
      try { await native.release(); }
      finally { await leases.release(token).catch(() => undefined); }
    },
  };
}

function reasonOf(error: unknown): LeaseLostReason {
  const reason = (error as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason as LeaseLostReason : 'epoch_moved';
}
