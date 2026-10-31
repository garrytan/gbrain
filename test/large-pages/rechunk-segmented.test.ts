/**
 * The re-chunk of segmented pages sealed at an older segmented chunker on PGLite (Wave B PR 4, lane recall).
 *
 * 1. Protects: `gbrain reindex --segmented` previews without writing, applies by re-staging only changed segments
 *    under a body flip that keeps occurrences, knowledge revision and vectors of unchanged texts, and stamps the page
 *    at SEGMENTED_CHUNKER_VERSION; a later write keeps an old page listed; migrations never re-chunk.
 * 2. Fails when: the preview writes, the apply loses a vector it could reuse or leaves the needle split, a seal after
 *    an append stamps an old page as current, or a schema replay or the markdown reindex touches segmented chunks.
 * 3. Postgres arm: test/e2e/rechunk-segmented-postgres.test.ts; shared cases: test/helpers/rechunk-segmented-cases.ts.
 * 4. Embeddings come from a counting fake transport; nothing paid runs.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { defineRechunkSegmentedCases } from '../helpers/rechunk-segmented-cases.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('reindex --segmented [pglite]', () => {
  defineRechunkSegmentedCases({ getEngine: () => engine });
});
