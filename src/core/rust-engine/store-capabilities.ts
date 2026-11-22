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
 * `managed_persistence` is held: a worktree-bound write (a source with a claimed checkout) still reaches raw SQL while
 * it is prepared, published and recovered, so on this engine its admission refuses by name (persistence/journal.ts
 * `admitWrite`) and writes no request row. A write with no worktree and a grouped admission of such writes are served,
 * a remote write that queues a mention-links effect included (its effect and a finished batch's re-arm are typed
 * members, rust/docs/store/remote-links.md).
 */
export const HELD_FOR_CALLERS: Partial<Record<Capability, readonly string[]>> = {
  managed_persistence: [
    'compareFileTarget (persistence/page-prepare.ts): a bound write compares its canonical file against the import hold through executeRaw',
    'guardOwnership (persistence/ownership.ts): a bound write locks its worktree row FOR SHARE through executeRaw',
    'publication recovery (persistence/coordinator.ts): a bound write marks publication started and locks its source row through executeRaw',
    'withTopologyLocks (persistence/topology-locks.ts): topology recovery takes its locks through executeRaw',
  ],
};

/** Capabilities withheld until every capability they need is reported. */
export const CAPABILITY_REQUIRES: Partial<Record<Capability, readonly Capability[]>> = {
  persistence_journal: ['transactions'],
  // A managed worktree's writes go through the write journal; without it a worktree could be claimed but never written.
  managed_persistence: ['persistence_journal', 'transactions'],
};

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
