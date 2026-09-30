/** #5732 on Postgres: source deletes drop their binding; orphan bindings are reported and repaired. */
import { afterAll, beforeAll, beforeEach, describe } from 'bun:test';
import { getConn, getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { sourceBindingsSuite } from '../helpers/source-bindings-suite.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;

describeE2E('source bindings (Postgres)', () => {
  beforeAll(async () => { await setupDB(); });
  afterAll(async () => { await teardownDB(); });
  beforeEach(async () => {
    await getConn().unsafe(`DELETE FROM persistence_effects; DELETE FROM persistence_requests; DELETE FROM persistence_source_bindings;
      DELETE FROM persistence_worktrees w WHERE NOT EXISTS (SELECT 1 FROM persistence_host_bindings h WHERE h.worktree_id = w.id);
      DELETE FROM sources WHERE id <> 'default'`);
  });
  sourceBindingsSuite('Postgres', () => getEngine());
});
