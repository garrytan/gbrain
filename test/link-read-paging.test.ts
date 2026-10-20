/**
 * #6876 — get_links / get_backlinks return at most 500 rows per call (or
 * `limit`), continue with a cursor bound to the listing, filter link_type and
 * the temporal policy in SQL before the cap, merge federated sources and
 * identity members by link id before the cap, and bound edge context.
 * Regression: the ops returning every edge of a hub (no LIMIT, JS filters).
 * Scenarios shared with the Postgres twin (test/e2e/link-read-paging-postgres.test.ts).
 */
import { afterAll, beforeAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { registerLinkPagingTests, seedLinkPagingFixture } from './helpers/link-paging-scenarios.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedLinkPagingFixture(engine);
}, 120_000);

afterAll(async () => { if (engine) await engine.disconnect(); }, 60_000);

registerLinkPagingTests(() => engine);
