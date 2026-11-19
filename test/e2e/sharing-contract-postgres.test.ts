/**
 * GST-3189: the sharing-contract matrix on PostgreSQL, as the same fixed sample the pull-request PGLite file reads (every
 * scenario and caller, four read paths). Keyless. Matrix and pinned cells: test/helpers/sharing-contract.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { SCENARIOS, SAMPLE_PATHS, type EngineFactory, badKeys, expectedBadKeys, expectedCellCount, installKeylessEmbeddings, runScenario } from '../helpers/sharing-contract.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';

const postgresEngine: EngineFactory = () => isolatedPersistencePostgres(requirePostgresTestDatabase());

const restore = installKeylessEmbeddings();
afterAll(restore);
let cells = 0;
let bad = 0;

for (const s of SCENARIOS) {
  describe('sharing contract on Postgres (sample): ' + s.name, () => {
    test('only the pinned cells break the contract', async () => {
      const r = await runScenario(s, postgresEngine, SAMPLE_PATHS);
      expect(r.cells.length).toBe(expectedCellCount(s, SAMPLE_PATHS));
      cells += r.cells.length;
      const found = badKeys(r.cells);
      bad += found.length;
      const pinned = expectedBadKeys(s.name, SAMPLE_PATHS);
      expect(found).toEqual(pinned);
      if (pinned.length) expect((r.archiveRescope as { code?: string } | null)?.code).toBe('archive_rescope_pending');
    }, 180_000);
  });
}
