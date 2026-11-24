/**
 * A legacy token grant write that matches no row refuses (src/core/grants/legacy-token.ts writeTokenGrant).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: when writeAccessTokenGrant updates no row (it answers null), migrateLegacyTokens rejects with the same
 *    TypeError text the raw `RETURNING grant_revision` read gave, and reports no migrated token.
 *  - Regression: the typed writer answers null where the raw read threw, so `Number(null)` turned a lost write into
 *    revision 0 and a "migrated" receipt.
 *  - Why existing coverage misses it: the real callers hold the row FOR UPDATE, so no engine case reaches a missing
 *    row; only a stub engine can.
 *  - Seam: a stub transaction engine with the three members the migration calls.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { migrateLegacyTokens } from '../src/core/grants/legacy-token.ts';

function stubEngine(written: number | null): { engine: BrainEngine; writes: string[] } {
  const writes: string[] = [];
  const tx = {
    lockLegacyAccessTokens: async () => [{ id: '00000000-0000-4000-8000-000000000001', name: 'old', permissions: { sources: ['default'] }, source_grant: null, scopes: ['read'] }],
    readCredentialBindingForUpdate: async () => null,
    writeAccessTokenGrant: async (id: string) => { writes.push(id); return written; },
  };
  const engine = { transaction: async <T>(fn: (t: BrainEngine) => Promise<T>) => fn(tx as unknown as BrainEngine) };
  return { engine: engine as unknown as BrainEngine, writes };
}

describe('legacy token grant write', () => {
  test('a write that updates no row refuses with the old TypeError text', async () => {
    const { engine, writes } = stubEngine(null);
    await expect(migrateLegacyTokens(engine, { dryRun: false })).rejects.toThrow("undefined is not an object (evaluating 'written.grant_revision')");
    expect(writes).toEqual(['00000000-0000-4000-8000-000000000001']);
  });

  test('a write that updates the row migrates it', async () => {
    const { engine } = stubEngine(4);
    const result = await migrateLegacyTokens(engine, { dryRun: false });
    expect(result.migrated.map(m => m.id)).toEqual(['00000000-0000-4000-8000-000000000001']);
  });
});
