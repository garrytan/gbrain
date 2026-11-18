/**
 * The capabilities the Rust engine reports (engine-capabilities.ts): one whose every member in the Rust member table
 * (members.ts) is served from the store. A capability with a member still refusing is not reported, so a caller that
 * asks for it (`hasCapability`) is told no instead of meeting the refusal halfway through its work.
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
    'admitWrite (persistence/journal.ts): admission counts, inserts and counter updates',
    'currentWriteTrust (persistence/context.ts): reads the transaction trust settings',
    'withCoordinatedWrite (persistence/context.ts): sets the write context; to become the setWriteContext member',
    'listWriterVersions, recentWriterVersions, segmentedGateEvidence (persistence/writer-versions.ts): writer version reads',
  ],
};

export function servedCapabilities(): EngineCapabilities {
  const refusing = new Set<string>(Object.keys(HELD_FOR_CALLERS));
  const present = new Set<string>();
  for (const [member, cls] of Object.entries(RUST_ENGINE_MEMBERS)) {
    if (cls === 'implemented') continue;
    present.add(cls);
    if (!(member in STORE_MEMBERS)) refusing.add(cls);
  }
  return new Set([...present].filter((c) => !refusing.has(c)) as Capability[]);
}
