/**
 * #6876 — Postgres twin of test/link-read-paging.test.ts: the keyset page
 * SQL (link_type, links.id bounds, the temporal policy before LIMIT, the
 * bounded context CASE) binds and plans on real Postgres the same as PGLite.
 *
 * DATABASE_URL-gated: self-skips without a real Postgres.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { registerLinkPagingTests, seedLinkPagingFixture } from '../helpers/link-paging-scenarios.ts';

const describePg = hasDatabase() ? describe : describe.skip;

describePg('#6876 link read paging — Postgres', () => {
  beforeAll(async () => {
    await setupDB();
    await seedLinkPagingFixture(getEngine());
  }, 120_000);

  afterAll(async () => { await teardownDB(); }, 30_000);

  registerLinkPagingTests(getEngine);
});
