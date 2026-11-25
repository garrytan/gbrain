/**
 * The Rust engine's readGuestSourceRow member (store-members/cli-reads-import.ts). The store has no guest_sources
 * table and answers "not a guest" for every source, so a source whose config says guest refuses instead: otherwise
 * the guest write guards in guests/admission.ts would pass a write that the guest rules restrict.
 */
import { describe, expect, test } from 'bun:test';
import { readGuestSourceRow } from '../src/core/rust-engine/store-members/cli-reads-import.ts';
import type { StoreBrain } from '../src/core/rust-engine/store.ts';

function fakeBrain(guestIds: string[]): StoreBrain {
  return {
    isOpen: true,
    async open() {}, async close() {},
    async listGuestSourceIds(ids: string[]) { return ids.filter(id => guestIds.includes(id)); },
    async readGuestSourceRow() { return { hidden: false, source_id: null, writers: null, trust_ceiling: null }; },
  } as unknown as StoreBrain;
}

describe('readGuestSourceRow on the Rust store', () => {
  test('an ordinary source answers not-a-guest', async () => {
    expect(await readGuestSourceRow(fakeBrain(['other']), 'notes')).toEqual({ hidden: false, source_id: null, writers: null, trust_ceiling: null });
  });

  test('a source whose config says guest refuses with engine_capability_missing', async () => {
    const refused = await readGuestSourceRow(fakeBrain(['guests']), 'guests').catch((e: unknown) => e);
    expect((refused as { code?: string }).code).toBe('engine_capability_missing');
  });
});
