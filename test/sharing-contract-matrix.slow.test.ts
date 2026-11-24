/**
 * GST-3189: the whole sharing-contract matrix (14 scenarios, 7 callers, 9 items, 10 read paths: 11,392 cells) on PGLite.
 * Slow lane: it takes about three minutes, so pull requests run the sample in test/sharing-contract-sample.test.ts and
 * this file runs in the full CI run and nightly. Keyless. Matrix and pinned cells: test/helpers/sharing-contract.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { SCENARIOS, pgliteEngine, badKeys, expectedBadKeys, expectedCellCount, installKeylessEmbeddings, runScenario } from './helpers/sharing-contract.ts';

const restore = installKeylessEmbeddings();
afterAll(restore);
let cells = 0;
let bad = 0;

for (const s of SCENARIOS) {
  describe('sharing contract (whole matrix): ' + s.name, () => {
    test('only the pinned cells break the contract', async () => {
      const r = await runScenario(s, pgliteEngine);
      expect(r.cells.length).toBe(expectedCellCount(s));
      cells += r.cells.length;
      const found = badKeys(r.cells);
      bad += found.length;
      const pinned = expectedBadKeys(s.name);
      expect(found).toEqual(pinned);
      if (pinned.length) expect((r.archiveRescope as { code?: string } | null)?.code).toBe('archive_rescope_pending');
    }, 300_000);
  });
}

test('the whole matrix ran: 11,392 cells, 24 of them pinned', () => {
  expect(cells).toBe(11_392);
  expect(bad).toBe(24);
});
