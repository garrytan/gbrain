/**
 * Managed mode on a Rust test brain, with the user-facing hold kept (lane LM, slice 1).
 *
 * The Rust engine holds `managed_persistence` back (src/core/rust-engine/store-capabilities.ts `HELD_FOR_CALLERS`), so
 * every managed write on a user's Rust brain refuses `engine_capability_missing`. The members that serve a managed write
 * exist; the hold only keeps them from being reached. A test lifts the hold on ONE engine instance, never in the source:
 *  - `liftManagedHold(engine)` adds `managed_persistence` to that Rust engine's capability set. Nothing else changes, and
 *    `servedCapabilities()` still withholds it, so a new engine (and every user's engine) keeps refusing.
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
  // The hold is a real hold: the lift is only ever this one in-memory set, and the source still withholds the capability.
  if (servedCapabilities().has('managed_persistence')) throw new Error('liftManagedHold: the Rust engine already reports managed_persistence; remove the lift');
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
