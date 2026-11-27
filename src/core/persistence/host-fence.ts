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
 * time. On a multi-user store a protected call with no fence (no host registered: a one-shot command, a served caller)
 * is not refused for it: the store takes an implicit lease for each claim it takes, and refuses `lease_lost` /
 * `held_by_another` only a finish of a claim a registered holder's live lease owns. On every other engine and with the
 * mode off, `fenceFor` answers null and the call is exactly what it was.
 *
 * Registrations are per engine object: each holder (a consumer, a job worker) adds its own and removes only its own
 * when it stops, so two holders in one process never clear each other's.
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

/** Every live registration of an engine object, oldest first: a consumer and a job worker in one process each own one. */
const registrations = new WeakMap<object, HostRegistration[]>();

/** The lease name of a host's registration; `forcedNonce` names a forced extra consumer's own registration. */
export function hostLeaseName(hostId: string, forcedNonce?: string): string {
  return forcedNonce ? `consumer:${hostId}:forced:${forcedNonce}` : `consumer:${hostId}`;
}

/** Adds `registration` to `engine`'s registrations (the holder that took the lease calls this). */
export function setHostRegistration(engine: object, registration: HostRegistration): void {
  const list = registrations.get(engine) ?? [];
  if (!list.includes(registration)) list.push(registration);
  registrations.set(engine, list);
}

/** Removes `registration` from `engine`'s registrations; every other holder's stays. */
export function clearHostRegistration(engine: object, registration: HostRegistration): void {
  const list = registrations.get(engine);
  if (!list) return;
  const left = list.filter(r => r !== registration);
  if (left.length) registrations.set(engine, left); else registrations.delete(engine);
}

/**
 * The registration a protected call on `engine` carries: the oldest one the engine object itself holds, else its
 * prototype's (a transaction-bound clone answers for its parent). A holder that must finish a claim under the fence it
 * took it with keeps that fence itself (MinionQueue, the cycle-lock handle) instead of asking again.
 */
export function hostRegistrationOf(engine: object): HostRegistration | null {
  for (let at: object | null = engine; at; at = Object.getPrototypeOf(at)) {
    const found = registrations.get(at)?.[0];
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

/**
 * The claim an effect's install reads its claim row under: the execution token it was claimed with and the registered
 * fence (none on a plain brain). On a multi-user Rust brain the read, inside the install's own transaction, checks the
 * host fence and the claim epoch; every other engine ignores it. Null token (no claim): nothing to check.
 */
export function effectInstallClaim(engine: object, effect: { execution_token: string | null }): { token: string; fence?: LeaseToken } | undefined {
  return effect.execution_token ? { token: effect.execution_token, ...claimFenceOpts(engine, effect.execution_token) } : undefined;
}

/**
 * The fence each write or effect claim was stamped under, by its execution token (a fresh UUID per claim). Every later
 * write on that claim carries the same fence, or none when the claim was stamped with none (an implicit lease), never
 * whichever registration is current when it runs: a registration that appears, or is taken again under a new epoch,
 * after the stamp cannot finish the claim under the wrong epoch.
 */
const claimFences = new Map<string, LeaseToken | null>();
const MAX_BOUND_CLAIMS = 16_384;

/** Records the fence (or none) claim `token` was stamped under. */
export function bindClaimFence(token: string, fence: LeaseToken | null): void {
  claimFences.delete(token);
  claimFences.set(token, fence);
  for (const oldest of claimFences.keys()) {
    if (claimFences.size <= MAX_BOUND_CLAIMS) break;
    claimFences.delete(oldest);
  }
}

/** Binds every claim in `tokens` to `fence` (the stamp that took them together). */
export function bindClaimFences(tokens: readonly (string | null | undefined)[], fence: LeaseToken | null): void {
  for (const token of tokens) if (token) bindClaimFence(token, fence);
}

/**
 * `{ fence }` for a write on claims taken together (a group's members, one coalesced Git claim): the fence the first
 * bound member was stamped under; none of them bound uses the engine's, as `claimFenceOpts` does.
 */
export function claimBatchFenceOpts(engine: object, tokens: readonly (string | null | undefined)[]): { fence?: LeaseToken } {
  return claimFenceOpts(engine, tokens.find(token => token && claimFences.has(token)) ?? null);
}

/**
 * `items` split by the fence their claim was stamped under (`tokenOf` names each item's execution token), so one write
 * never carries a fence for a claim another stamp took. Items whose claims share a fence stay together, in order.
 */
export function claimFenceGroups<T>(engine: object, items: readonly T[], tokenOf: (item: T) => string | null | undefined): Array<{ opts: { fence?: LeaseToken }; items: T[] }> {
  const groups: Array<{ opts: { fence?: LeaseToken }; items: T[] }> = [];
  for (const item of items) {
    const opts = claimFenceOpts(engine, tokenOf(item));
    const group = groups.find(g => g.opts.fence === opts.fence || (g.opts.fence && opts.fence && JSON.stringify(g.opts.fence) === JSON.stringify(opts.fence)));
    if (group) group.items.push(item); else groups.push({ opts, items: [item] });
  }
  return groups;
}

/** `{ fence }` for a write on claim `token`: the fence it was stamped under; a claim stamped elsewhere uses the engine's. */
export function claimFenceOpts(engine: object, token: string | null | undefined): { fence?: LeaseToken } {
  if (token && claimFences.has(token)) {
    const fence = claimFences.get(token);
    return fence ? { fence } : {};
  }
  return fenceOpts(engine);
}
