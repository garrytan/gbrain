/**
 * Tripwire for a known gap: on a Rust brain no whole managed sync runs, so the parity arms cover the managed sync's
 * freshness stamp only as a step (test/engine-parity/sync-stamp.test.ts), not inside a whole managed sync.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a Rust brain is never managed today. Its `readManagedModeRows` member answers one row with
 *    `enabled: false` (rust-engine/store-members/persistence.ts), and managed-mode.ts builds a Rust brain's persistence
 *    row as not enabled whatever the store says, so `activeManagedBrainId` refuses with `writer_coordinator_required`
 *    and `performManagedSync` stops before discovery.
 *  - Regression: none yet. This file fails by itself the day Rust managed mode turns on. The change that turns it on
 *    must add a whole managed sync case on the Rust arm (a first sync, then a no-change sync that answers `up_to_date`
 *    and moves `last_sync_at`) to sync-stamp.test.ts, and remove this file.
 *  - Why existing coverage misses it: the managed sync suites run PGLite and Postgres only, and the parity arms do not
 *    activate managed persistence on Rust.
 *  - Seam: a stand-in Rust engine (`kind: 'rust'`) whose members answer as a managed store would; no addon is loaded.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { readManagedMode, readPersistenceBrain } from '../src/core/persistence/managed-mode.ts';
import { activeManagedBrainId } from '../src/core/persistence/sync-authority.ts';
import { readManagedModeRows } from '../src/core/rust-engine/store-members/persistence.ts';

const TURNED_ON = 'Rust managed mode turned on: add a whole managed sync case on the Rust arm to '
  + 'test/engine-parity/sync-stamp.test.ts and remove this tripwire';
const BRAIN_ID = '00000000-0000-4000-8000-000000000001';

/** A Rust engine whose store would report a managed brain, if anything read that answer. */
function managedLookingRustEngine(): BrainEngine {
  return {
    kind: 'rust',
    readPersistenceBrainId: async () => BRAIN_ID,
    readManagedModeRows: async () => [{ enabled: true }],
  } as unknown as BrainEngine;
}

describe('a Rust brain is never managed, so no whole managed sync runs on it (known gap)', () => {
  test('the Rust store member answers one unmanaged row', async () => {
    const rows = await (readManagedModeRows as (...args: unknown[]) => Promise<Array<{ enabled: unknown }>>)(undefined);
    expect(rows, TURNED_ON).toEqual([{ enabled: false }]);
  });

  test('managed-mode.ts reads a Rust brain\'s persistence row as not enabled', async () => {
    const engine = managedLookingRustEngine();
    expect((await readPersistenceBrain(engine)).enabled, TURNED_ON).toBe(false);
    const refused = await activeManagedBrainId(engine).then(() => 'active', (e: { code?: string }) => e.code ?? String(e));
    expect(refused, TURNED_ON).toBe('writer_coordinator_required');
  });

  test('readManagedMode follows the store member on a Rust brain', async () => {
    // The managed-mode read itself trusts the member; only the member's answer keeps a Rust brain unmanaged.
    expect(await readManagedMode(managedLookingRustEngine())).toBe(true);
  });
});
