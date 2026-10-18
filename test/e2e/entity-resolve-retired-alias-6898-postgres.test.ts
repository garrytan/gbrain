/**
 * #6898 on Postgres: the retired-alias fixture and cases from
 * test/helpers/retired-alias-6898.ts against a real Postgres brain (pg_trgm
 * fuzzy arm, JSONB frontmatter predicates, page_aliases). The PGLite twin is
 * test/entity-resolve-retired-alias-6898.test.ts. Runs only when
 * DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { seedRetiredAliasBrain, retiredAliasCases } from '../helpers/retired-alias-6898.ts';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

(hasDatabase() ? describe : describe.skip)('#6898 retired alias pages on Postgres', () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    await setupDB();
    engine = await getEngine();
    await seedRetiredAliasBrain(engine);
  }, 120_000);
  afterAll(async () => { await teardownDB(); });

  retiredAliasCases(() => engine);
});
