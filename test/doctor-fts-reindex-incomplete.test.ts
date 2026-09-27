/**
 * fts_reindex_incomplete doctor check (#4795).
 *
 * `gbrain reindex-search-vector` stamps `fts.reindex_in_progress` (= target
 * language) in the config table before flipping the trigger functions and
 * clears it only after both backfills finish. While the marker is set the
 * brain's keyword index is split across two tokenizers, so doctor must
 * FAIL (exit 1) and name the resume command; healthy brains push nothing.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { ftsReindexIncompleteCheck } from '../src/commands/doctor/checks/fts-reindex.ts';

function engineWith(config: Record<string, string>): BrainEngine {
  return {
    getConfig: async (key: string) => config[key] ?? null,
  } as unknown as BrainEngine;
}

describe('ftsReindexIncompleteCheck', () => {
  test('marker set → fail naming the language and the resume command', async () => {
    const check = await ftsReindexIncompleteCheck(engineWith({ 'fts.reindex_in_progress': 'dutch' }));
    expect(check).not.toBeNull();
    expect(check!.name).toBe('fts_reindex_incomplete');
    expect(check!.status).toBe('fail');
    expect(check!.message).toContain('dutch');
    expect(check!.message).toContain('GBRAIN_FTS_LANGUAGE=dutch gbrain reindex-search-vector --yes');
  });

  test('marker absent → null (nothing pushed)', async () => {
    expect(await ftsReindexIncompleteCheck(engineWith({}))).toBeNull();
  });
});
