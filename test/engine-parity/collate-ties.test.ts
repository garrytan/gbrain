/**
 * BrainEngine parity — a list cut by a limit picks the same rows on every engine when the sort key ties.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listPages sorted created_desc and listJunkEntityHubs return the same rows, in the same order, on every
 *    engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1, where both reads
 *    run on the store). On a tie the newest page id wins for created_desc and the lowest page id wins for hubs, as the
 *    Rust store sorts.
 *  - Regression: the statements ordered only by created_at or by an edge count, so rows with one value came back in
 *    whatever order the sort met them and a limit could cut a different set on Postgres than on PGLite or the store.
 *  - Why existing coverage misses it: the cases wrote pages in separate statements, so created_at never tied, and gave
 *    each hub a different edge count.
 *  - Seam: none. Pages and links go through the engine writers; one transaction gives every page one created_at on
 *    the SQL engines.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const note = (title: string) => ({ type: 'note' as const, title, compiled_truth: `body of ${title}`, timeline: '' });

/** Slugs whose insert order is neither byte nor reverse-byte order. */
const SLUGS = ['tie/m', 'tie/c', 'tie/x', 'tie/a', 'tie/q', 'tie/f', 'tie/z', 'tie/b', 'tie/k', 'tie/d', 'tie/w', 'tie/h'];

describe('a limit over tied sort keys cuts the same rows on every engine', () => {
  parityTest('listPages created_desc breaks a created_at tie by the newest page id', {
    methods: ['transaction', 'putPage', 'listPages'],
  }, async (engine) => {
    await engine.transaction(async (tx) => {
      for (const slug of SLUGS) await tx.putPage(slug, note(slug));
    });
    const listed = (await engine.listPages({ sort: 'created_desc', limit: 5 })).map(p => p.slug);
    expect(listed).toEqual([...SLUGS].reverse().slice(0, 5));
    return listed;
  });

  parityTest('listJunkEntityHubs breaks an edge-count tie by the lowest page id', {
    methods: ['putPage', 'addLink', 'listJunkEntityHubs'],
  }, async (engine) => {
    await engine.putPage('src/one', note('one'));
    await engine.putPage('src/two', note('two'));
    for (const slug of SLUGS) await engine.putPage(slug, note(slug));
    // Links go in last page first, so the edge rows do not arrive in page id order.
    for (const slug of [...SLUGS].reverse()) {
      await engine.addLink('src/one', slug, `to ${slug}`, 'mentions', 'manual');
      await engine.addLink('src/two', slug, `to ${slug}`, 'mentions', 'manual');
    }
    const hubs = (await engine.listJunkEntityHubs({ edgeThreshold: 1, maxChunks: 1000, limit: 7 }))
      .filter(h => h.slug.startsWith('tie/'))
      .map(h => h.slug);
    expect(hubs).toEqual(SLUGS.slice(0, 5));
    return hubs;
  });
});
