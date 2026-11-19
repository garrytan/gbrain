/**
 * GST-3189: the whole sharing-contract matrix (13 scenarios, 7 callers, 9 items, 10 read paths: 10,624 cells) on PGLite.
 * Slow lane: it takes about three minutes, so pull requests run the sample in test/sharing-contract-sample.test.ts and
 * this file runs in the full CI run and nightly. Keyless. Matrix and pinned cells: test/helpers/sharing-contract.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { SCENARIOS, pgliteEngine, badKeys, expectedBadKeys, installKeylessEmbeddings, runScenario } from './helpers/sharing-contract.ts';

const restore = installKeylessEmbeddings();
afterAll(restore);
let cells = 0;
let bad = 0;

for (const s of SCENARIOS) {
  describe('sharing contract (whole matrix): ' + s.name, () => {
    test('only the pinned cells break the contract', async () => {
      const r = await runScenario(s, pgliteEngine);
      cells += r.cells.length;
      const found = badKeys(r.cells);
      bad += found.length;
      const pinned = expectedBadKeys(s.name);
      expect(found).toEqual(pinned);
      if (pinned.length) expect((r.archiveRescope as { code?: string } | null)?.code).toBe('archive_rescope_pending');
    }, 300_000);
  });
}

test('the whole matrix ran: 10,624 cells, 24 of them pinned', () => {
  expect(cells).toBe(10_624);
  expect(bad).toBe(24);
});
