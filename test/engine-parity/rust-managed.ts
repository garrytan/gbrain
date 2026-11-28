/**
 * Managed mode on a Rust test brain (lane LM).
 *
 * Every Rust brain, single-host and multi-user, now reports `managed_persistence`: store-capabilities.ts `HELD_FOR_CALLERS`
 * and `MULTIUSER_WITHHELD` are empty (slices 2 and 3), so a managed write on a user's Rust brain is served. The lift below
 * is kept so the managed suites run unchanged, and it still matters on an engine whose capability set lacks the capability:
 *  - `liftManagedHold(engine)` adds `managed_persistence` to that Rust engine's capability set (and its served owner's)
 *    when it is missing; on an engine that already reports it, nothing changes.
 *  - `GBRAIN_TEST_RUST_MANAGED=1` lifts it on every engine the parity Rust arm opens (rust-arm.ts), reports the capability
 *    in the arm table (arm-capabilities.ts), and pins the Rust arm's counts in rust-managed-tally.tsv, apart from the
 *    ordinary arm's rust-tally.tsv. A case that still refuses in that mode counts as stopped, never as equal.
 */
import type { Capability } from '../../src/core/engine-capabilities.ts';
import { servedCapabilities } from '../../src/core/rust-engine/store-capabilities.ts';
import { RUST_MANAGED_FLAG, rustManagedRequested } from './arm-capabilities.ts';
import { servedOwnerOf } from './rust-arm.ts';

export { RUST_MANAGED_FLAG, rustManagedRequested };

/** Lifts the managed_persistence hold on one Rust engine instance; throws on any other engine. Returns the engine. */
export function liftManagedHold<E extends object>(engine: E): E {
  const kind = (engine as { kind?: string }).kind;
  const caps = (engine as { capabilities?: Set<Capability> }).capabilities;
  if (kind !== 'rust' || !(caps instanceof Set)) throw new Error(`liftManagedHold: only a Rust engine holds managed_persistence back (got ${kind ?? 'no engine kind'})`);
  // Slices 2 and 3 lifted the hold: single-host and multi-user Rust engines already report the capability, so the lift
  // changes nothing there. It still adds it on an engine whose set lacks it, which only a test does.
  if (servedCapabilities().has('managed_persistence') && caps.has('managed_persistence')) return engine;
  caps.add('managed_persistence');
  // A served arm engine's members run on its owner engine, whose own set decides the hold there: lift it on both.
  const owner = servedOwnerOf(engine) as { capabilities?: Set<Capability> } | undefined;
  if (owner?.capabilities instanceof Set) owner.capabilities.add('managed_persistence');
  return engine;
}

/** `liftManagedHold` when the lifted-hold test mode is on, else the engine unchanged. */
export function liftManagedHoldWhenRequested<E extends object>(engine: E, env: Record<string, string | undefined> = process.env): E {
  return rustManagedRequested(env) ? liftManagedHold(engine) : engine;
}
