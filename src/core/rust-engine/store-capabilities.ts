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
 * member table. Reporting `persistence_journal` would start a persistence listener and route CLI writes to an owner that
 * refuses them partway with owner_unavailable (rust-engine/owner-ipc/client.ts `rustOwnerServesPersistence`). A
 * capability leaves this table when its last blocking caller is typed.
 */
export const HELD_FOR_CALLERS: Partial<Record<Capability, readonly string[]>> = {
  persistence_journal: [
    'segmentedGateEvidence (persistence/writer-versions.ts): the segmented-storage gate evidence answers no writer here',
    'queuePublicationEffects (persistence/effect-journal.ts): the publication effects insert, where a forwarded put stops',
  ],
};

/** Capabilities withheld until every capability they need is reported. */
export const CAPABILITY_REQUIRES: Partial<Record<Capability, readonly Capability[]>> = {
  persistence_journal: ['transactions'],
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
