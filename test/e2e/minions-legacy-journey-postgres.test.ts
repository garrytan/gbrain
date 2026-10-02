/**
 * #5157 restored-operation journey on real Postgres (DX-O15(a),
 * DX-O3(f)(g)); the PGLite run is `test/minions-legacy-journey.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { runLegacyJourney, runUnsupportedRowRecovery } from '../helpers/legacy-journey.ts';


const suite = hasDatabase() ? describe : describe.skip;
suite('Postgres legacy job recovery journey (#5157)', () => {
  beforeAll(async () => { await setupDB(); }, 120_000);
  afterAll(async () => { await teardownDB(); });
  beforeEach(async () => { await getEngine().executeRaw('DELETE FROM minion_jobs'); });

  test('/ingest 409 -> printed commands verbatim -> 202, worker runs, search finds the memory', async () => {
    const { commands } = await runLegacyJourney(getEngine());
    expect(commands).toHaveLength(6);
  }, 120_000);

  test('an unsupported non-NULL row needs its own printed cancel before a worker starts', async () => {
    expect(await runUnsupportedRowRecovery(getEngine())).toHaveLength(3);
  }, 120_000);
});
