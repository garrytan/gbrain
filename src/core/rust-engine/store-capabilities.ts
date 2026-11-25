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
 * `managed_persistence` is held: until the managed-persistence program on the Rust engine is done, a Rust brain refuses managed
 * mode with the typed refusal (capability managed_persistence). A worktree-bound write (a source with a claimed checkout) is
 * refused by name at its admission (persistence/journal.ts `admitWrite`) and writes no request row, and the first page write to a
 * rooted source refuses `claimWorktree` the same way (persistence/unbound-source.ts). A write with no worktree and a grouped
 * admission of such writes are served. The members that serve a bound write exist and stay in the
 * member table; this hold keeps them from being reached until the program lands.
 */
export const HELD_FOR_CALLERS: Partial<Record<Capability, readonly string[]>> = {
  managed_persistence: [
    'compareFileTarget (persistence/page-prepare.ts): a bound write compares its canonical file against the import hold; typed here, held with the rest of managed mode',
    'guardOwnership (persistence/ownership.ts): a bound write locks its worktree row; typed here, held with the rest of managed mode',
    'publication recovery (persistence/coordinator.ts): a bound write marks publication started and locks its source row; typed here, held with the rest of managed mode',
    'withTopologyLocks (persistence/topology-locks.ts): topology recovery takes its locks through executeRaw',
  ],
};

/** Capabilities withheld until every capability they need is reported. */
export const CAPABILITY_REQUIRES: Partial<Record<Capability, readonly Capability[]>> = {
  persistence_journal: ['transactions'],
  // A managed worktree's writes go through the write journal; without it a worktree could be claimed but never written.
  managed_persistence: ['persistence_journal', 'transactions'],
};

/**
 * Capabilities that come from the open store, never from this static set: `serialized_transactions` (an explicit
 * transaction holds the store's whole writer) is a promise the store makes when it opens (`Store::serialized_transactions`,
 * the open result's `serialized_transactions`). RustEngine adds it from that answer on every open, reopen and takeover
 * (`applyStoreGuarantees` in rust-engine.ts) and withholds it when the answer is false or absent.
 */
export const STORE_GUARANTEES: readonly Capability[] = ['serialized_transactions'];

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
