/**
 * The retrieval reflex's title and slug arm returns its pages in creation
 * order, whatever plan reads them.
 *
 * Protects: with one pointer to give (Codex gets a single fragment) and two
 * names in one turn, the page the reflex injects does not change when the
 * other page is rewritten (its row moves to the end of the table) or when an
 * index gives the planner another way in.
 * Fails when: the arm's query has no ORDER BY, so the first row is whatever the
 * plan happened to read first (heap order for a sequential scan, index order
 * for an index scan). A new index on pages (source_id, type) moved BrainBench's
 * codex push recall from 0.55 to 0.42 this way.
 * Seams: none; in-memory PGLite.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveEntitiesToPointers } from '../src/core/context/retrieval-reflex.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth) VALUES
    ('default', 'people/alice-example', 'person', 'Alice Example', 'first page'),
    ('default', 'people/bob-example', 'person', 'Bob Example', 'second page')`);
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

const firstPointer = async () => (await resolveEntitiesToPointers(engine, 'default',
  [{ display: 'Bob Example', query: 'Bob Example' }, { display: 'Alice Example', query: 'Alice Example' }], { maxPointers: 1 }))?.pointers.map(p => p.slug);

test('with two names in a turn and one pointer, the page created first is injected, before and after it is rewritten', async () => {
  expect(await firstPointer()).toEqual(['people/alice-example']);
  await engine.executeRaw(`UPDATE pages SET compiled_truth = 'first page, edited' WHERE slug = 'people/alice-example'`);
  expect(await firstPointer()).toEqual(['people/alice-example']);
});
