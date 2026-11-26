/**
 * Host registration and its fence for the multi-user Rust build (lane L5; docs/designs/rust-engine/multi-user-server.md,
 * "Hosts and fencing"; rust/crates/gbrain-store/src/leases.rs).
 *
 * On a Rust brain in multi-user mode, the full persistence consumer of a host registers once: it takes the lease
 * `consumer:<host_id>` (a forced extra consumer on the same host takes `consumer:<host_id>:forced:<nonce>`, so the
 * forced escape hatch keeps working). The lease's token is the host's fence. The heartbeat renews it; a host whose lease
 * expired (asleep, cut off) cannot renew the old epoch and registers again under a new one, so every write it began
 * under the old epoch is refused at commit with `lease_lost`.
 *
 * Every protected entry point (job claims and their results, write claims and publication, effect claims and results,
 * the drain lease holder, the cycle lock) takes the fence explicitly, as `fence` in its options, read here at call
 * time. On a multi-user store a protected call with no fence refuses `lease_lost` / `fence_missing`; on every other
 * engine and with the mode off, `fenceFor` answers null and the call is exactly what it was.
 *
 * The registration is per engine object and per process: one consumer per engine, one host registration per consumer.
 * It is set only by the consumer that took the lease and cleared when that consumer stops; nothing else writes it.
 */
import type { LeaseToken, WriteOrigin } from '../rust-engine/store-members/leases.ts';

/** How long a host registration lives without a renewal (ms): the consumer heartbeat renews it every 10 s. */
export const HOST_FENCE_TTL_MS = 60_000;

/** What a registered consumer holds. Immutable: a new registration is a new object. */
export interface HostRegistration {
  readonly hostId: string;
  readonly origin: WriteOrigin;
  readonly fence: LeaseToken;
}

const registrations = new WeakMap<object, HostRegistration>();

/** The lease name of a host's registration; `forcedNonce` names a forced extra consumer's own registration. */
export function hostLeaseName(hostId: string, forcedNonce?: string): string {
  return forcedNonce ? `consumer:${hostId}:forced:${forcedNonce}` : `consumer:${hostId}`;
}

/** Records `registration` as `engine`'s host registration (the consumer that took the lease calls this). */
export function setHostRegistration(engine: object, registration: HostRegistration): void {
  registrations.set(engine, registration);
}

/** Clears `engine`'s registration when it is still `registration` (a newer one is kept). */
export function clearHostRegistration(engine: object, registration: HostRegistration): void {
  if (registrations.get(engine) === registration) registrations.delete(engine);
}

/** The host registration of `engine`, or null. A transaction-bound clone reads its parent's (prototype chain). */
export function hostRegistrationOf(engine: object): HostRegistration | null {
  for (let at: object | null = engine; at; at = Object.getPrototypeOf(at)) {
    const found = registrations.get(at);
    if (found) return found;
  }
  // A wrapper of the engine (a recording proxy, a scoped view) keeps no registration of its own: it reads the engine's.
  const root = engineRootOf(engine);
  return root !== engine ? hostRegistrationOf(root) : null;
}

/** The engine object a wrapper or a transaction-bound clone stands for (a Rust engine answers `_engineRoot`), else `engine`. */
export function engineRootOf(engine: object): object {
  const at = engine as { _engineRoot?: () => object };
  if (typeof at._engineRoot !== 'function') return engine;
  try { return at._engineRoot() ?? engine; } catch { return engine; }
}

/** The fence a protected call on `engine` carries: the registration's lease, or null (off, or not registered). */
export function fenceFor(engine: object): LeaseToken | null {
  return hostRegistrationOf(engine)?.fence ?? null;
}

/** `{ fence }` for a protected call's options, or `{}` when there is none, so an unfenced call's arguments are unchanged. */
export function fenceOpts(engine: object): { fence?: LeaseToken } {
  const fence = fenceFor(engine);
  return fence ? { fence } : {};
}

/** `opts` with the registered fence added, or `opts` itself when there is none (so an unfenced call's options are unchanged). */
export function withFence<T extends object | undefined>(engine: object, opts: T): T | (NonNullable<T> & { fence: LeaseToken }) {
  const fence = fenceFor(engine);
  return fence ? { ...opts, fence } as NonNullable<T> & { fence: LeaseToken } : opts;
}
