/**
 * GST-3189: the sharing-contract matrix on every pull request, as a fixed sample: every scenario and caller, read through
 * four paths (bare-slug get_page, unscoped list_pages, scoped search, unscoped recall). The whole matrix runs in
 * test/sharing-contract-matrix.slow.test.ts (full CI and nightly). PGLite, keyless. Matrix: test/helpers/sharing-contract.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { SCENARIOS, SAMPLE_PATHS, pgliteEngine, badKeys, expectedBadKeys, expectedCellCount, installKeylessEmbeddings, runScenario } from './helpers/sharing-contract.ts';

const restore = installKeylessEmbeddings();
afterAll(restore);
let cells = 0;
let bad = 0;

for (const s of SCENARIOS) {
  describe('sharing contract (sample): ' + s.name, () => {
    test('only the pinned cells break the contract', async () => {
      const r = await runScenario(s, pgliteEngine, SAMPLE_PATHS);
      expect(r.cells.length).toBe(expectedCellCount(s, SAMPLE_PATHS));
      cells += r.cells.length;
      const found = badKeys(r.cells);
      bad += found.length;
      const pinned = expectedBadKeys(s.name, SAMPLE_PATHS);
      expect(found).toEqual(pinned);
      if (pinned.length) expect((r.archiveRescope as { code?: string } | null)?.code).toBe('archive_rescope_pending');
    }, 120_000);
  });
}
