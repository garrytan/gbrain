/**
 * #5732: `persistence_source_bindings` has PRIMARY KEY(source_id) and no FK to
 * `sources`, so a source delete that only removes the `sources` row leaves the
 * binding behind. A later source re-added under the same id then reads as
 * claimed and every sync fails with writer_coordinator_required. Every source
 * delete path drops the removed incarnation's binding; the claim check and the
 * doctor join match on incarnation; `orphan_persistence_bindings` reports
 * leftovers and `gbrain repair orphan-bindings` removes them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { sourceBindingsSuite } from './helpers/source-bindings-suite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

sourceBindingsSuite('PGLite', () => engine);
