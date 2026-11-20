/**
 * The capability class of each Rust engine member (src/core/rust-engine/members.ts) against the capabilities the Rust
 * engine reports (store-capabilities.ts servedCapabilities).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a member the Rust store does not serve is classed under a capability the Rust engine does not report.
 *    REPORTED is the floor of reported capabilities: each stays reported, and no refused member is classed under one.
 *  - Regression: thirteen refused edge-contradiction members classed under 'links' made the Rust engine stop reporting
 *    'links'; the catalog probe (store-members/catalog.ts) then said the links tables were absent and doctor printed
 *    "no links table yet" on a brain with links.
 *  - Why existing coverage misses it: servedCapabilities drops a capability with a refusing member by design, so every
 *    other test sees a consistent, smaller set and passes.
 *  - Seam: none. The test reads the member table, the store member table and servedCapabilities; it needs no addon.
 */
import { describe, expect, test } from 'bun:test';
import type { Capability } from '../src/core/engine-capabilities.ts';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';
import { HELD_FOR_CALLERS, servedCapabilities } from '../src/core/rust-engine/store-capabilities.ts';
import { STORE_MEMBERS } from '../src/core/rust-engine/store-members/index.ts';

/** The capabilities the Rust engine reports. A capability joins this list when its last member is served; it leaves
 *  only by a reviewed edit here, never because a refused member was classed under it. */
const REPORTED: readonly Capability[] = [
  'access_control', 'belief_ledger', 'code_edges', 'config', 'dream_verdicts', 'embeddings', 'files', 'graph', 'health',
  'ingest_log', 'keyword_search', 'links', 'ontology', 'page_body', 'raw_data', 'salience', 'schema', 'sources', 'tags',
  'telemetry', 'timeline', 'transactions', 'vector_search',
];

describe('Rust engine capability classes', () => {
  test('no refused member is classed under a capability the Rust engine reports', () => {
    const reported = new Set<string>(REPORTED);
    const offenders = Object.entries(RUST_ENGINE_MEMBERS)
      .filter(([member, cls]) => cls !== 'implemented' && !(member in STORE_MEMBERS) && reported.has(cls))
      .map(([member, cls]) => `${member}: ${cls}`);
    expect(offenders).toEqual([]);
  });

  test('every capability in REPORTED is reported', () => {
    const served = servedCapabilities();
    expect(REPORTED.filter(cap => !served.has(cap))).toEqual([]);
    expect(REPORTED.filter(cap => cap in HELD_FOR_CALLERS)).toEqual([]);
  });
});
