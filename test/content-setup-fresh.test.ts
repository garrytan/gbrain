/**
 * `readFreshContentDatabase` (engine-sql/content-setup.ts): `gbrain init` reads it right after it connects and before
 * `initSchema`, to tell a database it is creating from one that already holds a brain.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: a connected database with no schema reads fresh; the same database after `initSchema` does not.
 * 2. Fails when: the typed member answers from the wrong tables, or the wrong way round, so init treats an existing
 *    brain as new (it would set fresh-install defaults over the user's) or a new one as existing.
 * 3. Existing coverage: test/rust-init-db-only.serial.test.ts runs a fresh and a repeated `gbrain init` end to end on
 *    three engines; this pins the PGLite member itself, which no parity brain can reach before its schema.
 * 4. Seams: none. An in-memory PGLite engine, connected without the test PGLite snapshot (GBRAIN_PGLITE_SNAPSHOT
 *    restores a built schema on connect, so the database would never be seen before its schema).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await withEnv({ GBRAIN_PGLITE_SNAPSHOT: undefined }, () => engine.connect({}));
});
afterAll(async () => { await engine.disconnect(); });

test('a database with no schema is fresh, and the same database after initSchema is not', async () => {
  expect(await engine.readFreshContentDatabase()).toBe(true);
  await engine.initSchema();
  expect(await engine.readFreshContentDatabase()).toBe(false);
}, 60_000);
