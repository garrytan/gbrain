/**
 * GST-1209 Postgres arm of test/helpers/segmented-publish-tiling-cases.ts: the race runs on separate pool connections,
 * so the sweep and the preparation commit independently as they do on a live brain.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { defineSegmentedPublishTilingCases } from '../helpers/segmented-publish-tiling-cases.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

(hasDatabase() ? describe : describe.skip)('segmented publish tiling [postgres]', () => {
  let engine: PostgresEngine;
  beforeAll(async () => { engine = await setupDB(); }, 120_000);
  afterAll(async () => { await teardownDB(); });
  defineSegmentedPublishTilingCases({ getEngine: () => engine });
});
