/**
 * Postgres twin of test/shadow-empty-source-scope.test.ts: an empty `sourceIds` list names no scope.
 *
 * Protects: on a Postgres primary with rows in two sources, getPage, listPages, getLinks, getBacklinks, getTags and
 * searchKeyword with `sourceIds: []` return exactly the rows of the unscoped read, so the shadow privacy guard's reading of an
 * empty list as "no scope" matches the primary and the guard and child do not pause; listFactsByEntity stays scoped to its one source.
 * Regression it catches: a Postgres read path that treats an empty list as "nothing".
 * Needs DATABASE_URL (GBRAIN_TEST_ALLOW_DATABASE_URL=1); skips without it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { expectEmptySourceIdsReadsAsUnscoped } from '../helpers/shadow-source-scope-parity.ts';
import { hasDatabase } from './helpers.ts';

const d = hasDatabase() ? describe : describe.skip;
let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let engine: PostgresEngine;
let close: () => Promise<void>;

d('the primary reads an empty sourceIds list as unscoped (Postgres)', () => {
  beforeAll(async () => { template = await persistencePostgresTemplate(process.env.DATABASE_URL!); }, 120_000);
  afterAll(async () => { await template.dispose(); });
  beforeEach(async () => { ({ engine, close } = await template.clone()); }, 60_000);
  afterEach(async () => { await close(); });

  test('every read the guard treats that way returns the unscoped rows, and the guard and child do not pause', async () => {
    await expectEmptySourceIdsReadsAsUnscoped(engine);
  }, 120_000);
});
