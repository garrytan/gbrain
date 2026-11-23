/**
 * An empty `sourceIds` list names no scope, on a real PGLite primary (test/helpers/shadow-source-scope-parity.ts).
 *
 * Protects: the shadow privacy guard does not pause on a read with `sourceIds: []` because the primary answers it with the
 * same rows as the read with no scope at all (getPage, listPages, getLinks, getBacklinks, getTags, searchKeyword) on a
 * brain with rows in two sources; and listFactsByEntity, which takes one source by position, stays scoped to it.
 * Regression it catches: a primary that reads an empty list as "nothing" (the test then sees no rows), which would make
 * the guard's "unscoped" reading wrong and let a Rust row through unchecked.
 * Not covered elsewhere: test/rust-engine-shadow-privacy.test.ts classifies hand-written rows; this reads a real primary.
 * Postgres twin: test/e2e/shadow-empty-source-scope.test.ts.
 */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { expectEmptySourceIdsReadsAsUnscoped } from './helpers/shadow-source-scope-parity.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

describe('the primary reads an empty sourceIds list as unscoped (PGLite)', () => {
  test('every read the guard treats that way returns the unscoped rows, and the guard and child do not pause', async () => {
    await expectEmptySourceIdsReadsAsUnscoped(engine);
  }, 60_000);
});
