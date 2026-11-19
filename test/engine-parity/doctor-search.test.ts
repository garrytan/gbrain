/**
 * BrainEngine parity: the doctor search-and-knowledge reads of engine-sql/doctor-search.ts, which doctor checks used
 * to run through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts), so a doctor check reads the same finding on each.
 *  - Regression: an engine whose read drifts (or does not serve it) gives a different doctor status, message or health
 *    score per backend; a Rust brain refused every one of these reads with `raw_sql`, so the checks warned.
 *  - Why existing coverage misses it: the doctor check tests run these reads on PGLite only and never compare arms.
 *  - Seam: none. Typed methods only (no executeRaw) and the harness fixtures for sources. Page ids, timestamps and
 *    the order of an unordered read are never compared (rows are sorted, or reduced to what the check uses).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const page = (title: string, extra: Partial<PageInput> = {}): PageInput => ({ type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra });
const put = (engine: BrainEngine, slug: string, extra: Partial<PageInput> = {}, sourceId = 'default') =>
  engine.putPage(slug, page(slug, extra), { sourceId });

describe('doctor search reads', () => {
  parityTest(
    'listOrphanedAliasCounts counts redirects and page aliases whose page row is gone, and reads nothing for a live or soft-deleted target',
    { methods: ['putPage', 'updateSlug', 'deletePage', 'softDeletePage', 'setPageAliases', 'listOrphanedAliasCounts'] },
    async (engine) => {
      const empty = await engine.listOrphanedAliasCounts();
      await put(engine, 'notes/a');
      await engine.updateSlug('notes/a', 'notes/b');
      const live = await engine.listOrphanedAliasCounts();
      await engine.deletePage('notes/b');
      await engine.setPageAliases('people/ghost', 'default', ['ghost one', 'ghost two']);
      await put(engine, 'people/soft');
      await engine.setPageAliases('people/soft', 'default', ['soft one']);
      await engine.softDeletePage('people/soft');
      const rows = await engine.listOrphanedAliasCounts();
      expect({ empty, live, rows }).toEqual({ empty: [], live: [], rows: [{ source_id: 'default', slug_redirects: 1, page_aliases: 2 }] });
      return { empty, live, rows };
    },
  );

  parityTest(
    'readSoftDeletedAliasCounts counts alias rows of both tables whose page is soft-deleted',
    { methods: ['putPage', 'updateSlug', 'softDeletePage', 'setPageAliases', 'readSoftDeletedAliasCounts'] },
    async (engine) => {
      const empty = await engine.readSoftDeletedAliasCounts();
      await put(engine, 'notes/a');
      await put(engine, 'people/jane');
      await put(engine, 'people/live');
      await engine.updateSlug('notes/a', 'notes/b');
      await engine.setPageAliases('people/jane', 'default', ['jane']);
      await engine.setPageAliases('people/live', 'default', ['live one']);
      const before = await engine.readSoftDeletedAliasCounts();
      await engine.softDeletePage('notes/b');
      await engine.softDeletePage('people/jane');
      const after = await engine.readSoftDeletedAliasCounts();
      expect({ empty, before, after }).toEqual({
        empty: { slug_redirects: 0, page_aliases: 0 },
        before: { slug_redirects: 0, page_aliases: 0 },
        after: { slug_redirects: 1, page_aliases: 1 },
      });
      return { empty, before, after };
    },
  );

  parityTest(
    'listPageTypePairs lists each distinct source and type of the live pages, in source then type order',
    { methods: ['putPage', 'softDeletePage', 'listPageTypePairs'] },
    async (engine) => {
      const empty = await engine.listPageTypePairs();
      await put(engine, 'notes/a');
      await put(engine, 'notes/b');
      await put(engine, 'people/jane', { type: 'person' });
      await put(engine, 'people/gone', { type: 'ghost' as never });
      await engine.softDeletePage('people/gone');
      const rows = await engine.listPageTypePairs();
      expect({ empty, rows }).toEqual({ empty: [], rows: [{ source_id: 'default', type: 'note' }, { source_id: 'default', type: 'person' }] });
      return { empty, rows };
    },
  );
});
