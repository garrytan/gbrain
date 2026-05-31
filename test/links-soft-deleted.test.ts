import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

/**
 * Regression tests for the soft-delete filter in getLinks / getBacklinks.
 *
 * Sibling of #1021 / PR #1033 (which fixed the same class of bug in orphans):
 * read-side link queries did not honor pages.deleted_at, so during the 72h
 * soft-delete recovery window a deleted endpoint still surfaced links to/from
 * that page even though the page itself was hidden from get_page / search.
 *
 * Hard purge (purgeDeletedPages) cascades via the FK and is unaffected; these
 * tests only cover the soft-delete window.
 */
describe('links visibility honors soft-delete (engine-injected)', () => {
  let engine: PGLiteEngine;

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterEach(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  async function seedPair() {
    await engine.putPage('people/alice', {
      type: 'person',
      title: 'Alice',
      compiled_truth: 'Alice mentions Bob.',
      timeline: '',
    });
    await engine.putPage('people/bob', {
      type: 'person',
      title: 'Bob',
      compiled_truth: 'Bob.',
      timeline: '',
    });
    await engine.addLink('people/alice', 'people/bob', 'mentioned', 'references', 'markdown');
  }

  test('getBacklinks hides links from soft-deleted source page', async () => {
    await seedPair();

    // Sanity: link is visible while both pages are active.
    const before = await engine.getBacklinks('people/bob');
    expect(before.map(l => l.from_slug)).toEqual(['people/alice']);

    // Soft-delete the *from* page; its outgoing link should disappear from
    // bob's backlinks even though the row still exists in the links table
    // (recovery window contract).
    await engine.softDeletePage('people/alice');
    const after = await engine.getBacklinks('people/bob');
    expect(after).toEqual([]);
  });

  test('getBacklinks hides links targeting soft-deleted page (defense-in-depth)', async () => {
    await seedPair();

    // Soft-deleting the *to* page should also remove the row from queries that
    // pivot on it. This mirrors the get_page contract: a soft-deleted page is
    // not addressable until restored or 72h passes.
    await engine.softDeletePage('people/bob');
    const result = await engine.getBacklinks('people/bob');
    expect(result).toEqual([]);
  });

  test('getLinks hides outbound row when target page is soft-deleted', async () => {
    await seedPair();

    const before = await engine.getLinks('people/alice');
    expect(before.map(l => l.to_slug)).toEqual(['people/bob']);

    await engine.softDeletePage('people/bob');
    const after = await engine.getLinks('people/alice');
    expect(after).toEqual([]);
  });

  test('getLinks hides outbound row when source page itself is soft-deleted', async () => {
    await seedPair();

    await engine.softDeletePage('people/alice');
    const result = await engine.getLinks('people/alice');
    expect(result).toEqual([]);
  });

  test('restorePage brings the link row back into view', async () => {
    await seedPair();
    await engine.softDeletePage('people/alice');
    expect(await engine.getBacklinks('people/bob')).toEqual([]);

    const restored = await engine.restorePage('people/alice');
    expect(restored).toBe(true);

    const after = await engine.getBacklinks('people/bob');
    expect(after.map(l => l.from_slug)).toEqual(['people/alice']);
  });
});
