/**
 * The capabilities the Rust engine reports (engine-capabilities.ts): one whose every member in the Rust member table
 * (members.ts) is served from the store. A capability with a member still refusing is not reported, so a caller that
 * asks for it (`hasCapability`) is told no instead of meeting the refusal halfway through its work. A capability in
 * REQUIRES is also withheld until every capability it needs is reported: the write journal's members are served, but an
 * owner runs a write through transactions (claimNextWrite, compactReceipt and trueUpRequests refuse without them), so a
 * Rust serve that reported persistence_journal would open a persistence socket that answers owner_unavailable.
 */
import type { Capability, EngineCapabilities } from '../engine-capabilities.ts';
import { RUST_ENGINE_MEMBERS } from './members.ts';
import { STORE_MEMBERS } from './store-members/index.ts';

const REQUIRES: Partial<Record<Capability, readonly Capability[]>> = {
  persistence_journal: ['transactions'],
};

export function servedCapabilities(): EngineCapabilities {
  const refusing = new Set<string>();
  const present = new Set<string>();
  for (const [member, cls] of Object.entries(RUST_ENGINE_MEMBERS)) {
    if (cls === 'implemented') continue;
    present.add(cls);
    if (!(member in STORE_MEMBERS)) refusing.add(cls);
  }
  const served = new Set([...present].filter((c) => !refusing.has(c)) as Capability[]);
  for (const [cap, needs] of Object.entries(REQUIRES) as [Capability, readonly Capability[]][]) {
    if (needs.some((need) => !served.has(need))) served.delete(cap);
  }
  return served;
}
