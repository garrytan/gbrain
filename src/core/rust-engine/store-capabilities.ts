/**
 * The capabilities the Rust engine reports (engine-capabilities.ts): one whose every member in the Rust member table
 * (members.ts) is served from the store. A capability with a member still refusing is not reported, so a caller that
 * asks for it (`hasCapability`) is told no instead of meeting the refusal halfway through its work. A capability in
 * CAPABILITY_REQUIRES is also withheld until every capability it needs is reported: the write journal's members are
 * served, but an owner runs each write in a transaction, so a Rust serve that reported persistence_journal without
 * transactions would open a persistence socket that answers owner_unavailable.
 */
import type { Capability, EngineCapabilities } from '../engine-capabilities.ts';
import { RUST_ENGINE_MEMBERS } from './members.ts';
import { STORE_MEMBERS } from './store-members/index.ts';

/**
 * Capabilities held back even when every member is served, each with the callers that still run raw SQL outside the
 * member table. A held `persistence_journal` would start no persistence listener (rust-engine/owner-ipc/client.ts
 * `rustOwnerServesPersistence`). A capability leaves this table when its last blocking caller is typed.
 *
 * `managed_persistence` is served on a single-host Rust brain (lane LM slices 1 and 2): worktree admission, ownership,
 * compareFileTarget, publication and its recovery, the managed Git effects and Git durability, the topology locks and the
 * source lifecycle, the moved-checkout check, managed link edits, the refresh barrier and import holds, grouped
 * admission, the owner recovery scans, the managed clone and managed sync all run on typed members, equal to PGLite and
 * Postgres on all three parity arms (test/engine-parity/managed-*-on-rust.test.ts).
 *
 * A multi-user store withholds it (MULTIUSER_WITHHELD): managed mode coordinates a checkout with native file locks on
 * one host (withTopologyLocks, GBRAIN_HOME/locks), and those do not fence writers on two hosts. Its claims take I-5
 * leases in slice 3; until then a multi-user Rust brain refuses managed mode with the typed refusal, exactly as every
 * Rust brain did before slice 2.
 */
export const HELD_FOR_CALLERS: Partial<Record<Capability, readonly string[]>> = {};

/** Capabilities a multi-user store withholds (see above): managed mode stays single-host until its locks are I-5 leases. */
export const MULTIUSER_WITHHELD: readonly Capability[] = ['managed_persistence'];

/** Capabilities withheld until every capability they need is reported. */
export const CAPABILITY_REQUIRES: Partial<Record<Capability, readonly Capability[]>> = {
  persistence_journal: ['transactions'],
  // A managed worktree's writes go through the write journal; without it a worktree could be claimed but never written.
  managed_persistence: ['persistence_journal', 'transactions'],
};

/** What an engine on `store` reports: `servedCapabilities()`, less MULTIUSER_WITHHELD when the store runs multi-user. */
export function storeCapabilities(store: { readonly multiuser: boolean } | null | undefined): EngineCapabilities {
  const served = servedCapabilities() as Set<Capability>;
  if (store?.multiuser === true) for (const capability of MULTIUSER_WITHHELD) served.delete(capability);
  return served;
}

export function servedCapabilities(): EngineCapabilities {
  const refusing = new Set<string>(Object.keys(HELD_FOR_CALLERS));
  const present = new Set<string>();
  for (const [member, cls] of Object.entries(RUST_ENGINE_MEMBERS)) {
    if (cls === 'implemented') continue;
    present.add(cls);
    if (!(member in STORE_MEMBERS)) refusing.add(cls);
  }
  const served = new Set([...present].filter((c) => !refusing.has(c)) as Capability[]);
  for (const [cap, needs] of Object.entries(CAPABILITY_REQUIRES) as [Capability, readonly Capability[]][]) {
    if (needs.some((need) => !served.has(need))) served.delete(cap);
  }
  return served;
}
