/**
 * The Rust engine's readGuestSourceRow member (store-members/cli-reads-import.ts). On the Rust engine trunk the store
 * keeps guest source rows itself, so the member answers the store's row: a guest source gets its writers and trust
 * ceiling, so the guest write guards in guests/admission.ts see the same row as on PGLite and Postgres.
 */
import { describe, expect, test } from 'bun:test';
import { readGuestSourceRow } from '../src/core/rust-engine/store-members/cli-reads-import.ts';
import type { StoreBrain } from '../src/core/rust-engine/store.ts';

const GUEST_ROW = { hidden: false, source_id: 'guests', writers: ['guest-writer'], trust_ceiling: 'guest' };

function fakeBrain(guestIds: string[]): StoreBrain {
  return {
    isOpen: true,
    async open() {}, async close() {},
    async readGuestSourceRow(sourceId: string) {
      return guestIds.includes(sourceId) ? GUEST_ROW : { hidden: false, source_id: null, writers: null, trust_ceiling: null };
    },
  } as unknown as StoreBrain;
}

describe('readGuestSourceRow on the Rust store', () => {
  test('an ordinary source answers not-a-guest', async () => {
    expect(await readGuestSourceRow(fakeBrain(['other']), 'notes')).toEqual({ hidden: false, source_id: null, writers: null, trust_ceiling: null });
  });

  test('a guest source answers the row the store keeps', async () => {
    expect(await readGuestSourceRow(fakeBrain(['guests']), 'guests')).toEqual(GUEST_ROW);
  });
});
