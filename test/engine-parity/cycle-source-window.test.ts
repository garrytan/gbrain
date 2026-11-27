/**
 * BrainEngine parity: the changed-page window of a per-source cycle (`listSourceChangedPages`,
 * src/core/cycle/source-window.ts) walks a source's live pages in (updated_at, slug) order, a window at a time, and
 * resumes after the cursor the previous cycle stamped.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1) the windows list every
 *    live page of the source once, in write order, skip a deleted page and pages of another source, and every window
 *    but the last hands back a cursor at its last page; the last one hands back the listing instant with an empty slug.
 *  - Regression: the window read the listing instant, the source's stamped cursor, the pages after it and an instant
 *    comparison through raw SQL, so on a Rust brain the cycle's extract phases stopped on the raw_sql refusal for every
 *    source with no sync (a connector source, a source with sync off or no checkout).
 *  - Why existing coverage misses it: test/engine-parity/collate-belief-cycle-walks.test.ts seeds a shared updated_at
 *    with raw SQL, so its Rust arm stops before the window runs; test/sync-disabled-cycle-window.test.ts runs PGLite only.
 *  - Seam: none. Pages are written through putPage, the cursor is stamped through updateSourceConfig (as the cycle does).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { listSourceChangedPages, sourceWindow } from '../../src/core/cycle/source-window.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SLUGS = ['notes/w-1', 'notes/w-2', 'notes/w-3', 'notes/w-4', 'notes/w-5'];
const ISO_MICROS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;

async function put(engine: BrainEngine, slug: string, sourceId = 'default'): Promise<void> {
  await engine.putPage(slug, { type: 'note' as never, title: slug, compiled_truth: `${slug} body.`, timeline: '', frontmatter: {} }, { sourceId });
  // Distinct write times, so the order is the write order on every engine.
  await Bun.sleep(5);
}

describe('engine parity: the per-source cycle window', () => {
  parityTest('listSourceChangedPages walks every live page of the source in write order, two at a time, through a stamped cursor', {
    methods: ['readCycleListingInstant', 'listSourceChangedPagesAfter', 'readSourceState', 'updateSourceConfig'],
    timeout: 90_000,
  }, async (engine) => {
    await engine.insertSource({ id: 'other-example', name: 'other-example', local_path: null, config: {} });
    for (const slug of SLUGS) await put(engine, slug);
    await put(engine, 'notes/elsewhere', 'other-example');
    await engine.softDeletePage('notes/w-3', { sourceId: 'default' });
    const limit = sourceWindow.pageLimit;
    sourceWindow.pageLimit = 2;
    try {
      const windows: Array<{ slugs: string[]; resumes: boolean; cursorShape: boolean }> = [];
      let since: string | null = null;
      for (let i = 0; i < 5; i++) {
        const window = await listSourceChangedPages(engine, 'default', since);
        const next = window.next;
        windows.push({ slugs: window.slugs, resumes: !!next?.slug, cursorShape: next !== undefined && ISO_MICROS.test(next.at) });
        if (!next?.slug) break;
        expect(next.slug).toBe(window.slugs[window.slugs.length - 1]!);
        await engine.updateSourceConfig('default', { last_source_cycle_window_at: next.at, last_source_cycle_window_slug: next.slug });
        since = next.at;
      }
      expect(windows).toEqual([
        { slugs: ['notes/w-1', 'notes/w-2'], resumes: true, cursorShape: true },
        { slugs: ['notes/w-4', 'notes/w-5'], resumes: false, cursorShape: true },
      ]);
      return windows;
    } finally {
      sourceWindow.pageLimit = limit;
    }
  });
});
