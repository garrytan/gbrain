/**
 * Pre-v110 brains: page_aliases does not exist — the reflex resolver's other
 * arms must keep working (the alias probes swallow undefined-table).
 *
 * Own FILE, not a test inside retrieval-reflex.test.ts: this test DROPS
 * page_aliases, and "restoring" it via initSchema() is a trap under
 * GBRAIN_PGLITE_SNAPSHOT — the snapshot fast-path short-circuits initSchema,
 * the table never comes back, and every later alias test sharing the engine
 * fails with 42P01. A dedicated file's engine dies with the file.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveEntitiesToPointers } from '../src/core/context/retrieval-reflex.ts';
import { extractCandidates } from '../src/core/context/entity-salience.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('pre-v110 brains (no page_aliases table)', () => {
  test('alias-table absence does not break the slug arm', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('people/alice-example', 'default', 'person', 'Alice Example', 'A founder.', '')`,
      [],
    );
    await engine.executeRaw('DROP TABLE IF EXISTS page_aliases');
    const block = await resolveEntitiesToPointers(engine, 'default', extractCandidates('about Alice Example'), {});
    expect(block).not.toBeNull();
    expect(block!.pointers[0].slug).toBe('people/alice-example');
  });
});
