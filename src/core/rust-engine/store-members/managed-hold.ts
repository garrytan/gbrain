/**
 * The managed_persistence hold on the store members that serve managed mode (store-capabilities.ts HELD_FOR_CALLERS).
 *
 * The managed-mode stores (gitDurabilityStore, gitEffectStore, topologyStore, manualLinkStore) and
 * claimCoalescedGitEffects replaced statements their callers sent through executeRaw. While this engine does not report
 * `managed_persistence` (every user's Rust brain), each call refuses exactly as that executeRaw did: the same
 * `engine_capability_missing` naming executeRaw and raw_sql, at the same point (the call, not the store's creation), so
 * nothing ran and no caller sees a different answer than before these members existed. A test engine with the hold
 * lifted (test/engine-parity/rust-managed.ts) reports the capability and the calls are served.
 */
import { capabilityMissing } from '../errors.ts';
import { RECEIPT_STOP_OWNERS } from '../receipt-stops.ts';

/** Whether `engine` serves managed mode (the hold is lifted on it). */
export function managedServed(engine: unknown): boolean {
  const caps = (engine as { capabilities?: ReadonlySet<string> }).capabilities;
  return caps?.has('managed_persistence') === true;
}

/** The refusal executeRaw answers on this engine. */
export function heldRefusal(): Error {
  return capabilityMissing('raw_sql', 'executeRaw', 'none', RECEIPT_STOP_OWNERS.executeRaw);
}

/** `store` as `engine` may use it: every method refuses as executeRaw did while the hold is on. */
export function heldStore<S extends object>(engine: unknown, store: S): S {
  if (managedServed(engine)) return store;
  const held = {} as Record<string, unknown>;
  for (const key of Object.keys(store)) held[key] = () => Promise.reject(heldRefusal());
  return held as S;
}
