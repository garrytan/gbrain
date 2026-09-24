// Postgres parity for the `dream --drain --window` in-batch checkpoint.
// Same scenario as test/cycle/extract-atoms-window-checkpoint.test.ts
// (PGLite), driven through the production drain wiring: real cycle lock,
// discovery, backlog count and completion receipts.

import { afterAll, beforeAll, beforeEach, describe, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertWindowCheckpointScenario } from '../helpers/extract-atoms-window-scenario.ts';

const describeDb = hasDatabase() ? describe : describe.skip;
describeDb('Postgres dream --drain --window in-batch checkpoint', () => {
  let engine: PostgresEngine;
  beforeAll(async () => { engine = await setupDB(); }, 60000);
  afterAll(async () => { await teardownDB(); });
  beforeEach(async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('TRUNCATE pages CASCADE');
    await engine.executeRaw('DELETE FROM extract_atoms_page_state');
  });

  test('stops between items, keeps persisted atoms, defers the rest', async () => {
    await assertWindowCheckpointScenario(engine);
  });
});
