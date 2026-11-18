/**
 * BrainEngine parity: a page whose search vector cannot be stored is refused at write (review pass 2, finding F1 of PR 9730).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `trg_pages_search_vector` (BEFORE INSERT OR UPDATE OF title, timeline) builds the page's `search_vector`
 *    from the title, and to_tsvector / `||` raise "string is too long for tsvector" (54000) past 1,048,575 bytes. The
 *    error aborts the putPage statement, so the page is not stored and every stored page stays searchable. The Rust arm
 *    must refuse the same writes with the same message, with the state unchanged. (The arm's putPage always writes with
 *    `index: false`; the chunking path is covered by the Rust unit tests.)
 *  - Regression: the Rust store accepted the title and rebuilt the page vector at read time, so the first searchTitles
 *    that reached the page failed, and so did every later one in its scope.
 *  - Why existing coverage misses it: chunk-vector-overflow.test.ts covers the chunk trigger only, and the title cases
 *    write short titles.
 *  - Seam: none (typed methods only). A page stored before the check existed (only a Rust store can hold one) is covered
 *    by the Rust unit tests of keyword/titles.rs.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const SLUG = 'notes/marmot';
const BIG_SLUG = 'notes/big';
/** 200,000 distinct tokens: a ~2.7 MB tsvector, past the 1,048,575-byte cap. */
const BIG = Array.from({ length: 200_000 }, (_, i) => `token${i.toString(36)}`).join(' ');

async function refusal(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function stored(engine: BrainEngine) {
  return {
    big: (await engine.getPage(BIG_SLUG))?.slug ?? null,
    pages: (await engine.listPages({ limit: 50 })).map((p) => p.slug).sort(),
    hits: (await engine.searchTitles('marmot', { limit: 10 })).map((r) => r.slug),
  };
}

describe('a page whose search vector overflows', () => {
  parityTest(
    'putPage refuses it whole and the stored pages stay searchable',
    { methods: ['putPage', 'getPage', 'listPages', 'searchTitles'] },
    async (engine) => {
      await seedPage(engine, {
        slug: SLUG,
        input: { type: 'note', title: 'Marmot burrow', compiled_truth: 'marmot burrow ledger', timeline: '' },
        chunks: [chunk(0, 'marmot burrow ledger')],
      });
      const before = await stored(engine);
      expect(before.hits).toEqual([SLUG]);
      const input = { type: 'note' as const, title: BIG, compiled_truth: 'big body', timeline: '' };
      const attempts: Record<string, string | null> = {
        'insert': await refusal(() => engine.putPage(BIG_SLUG, input)),
        'update to an oversized title': await refusal(() => engine.putPage(SLUG, { ...input, compiled_truth: 'marmot burrow ledger' })),
      };
      for (const [name, message] of Object.entries(attempts)) expect({ name, message: message ?? 'was accepted' }).toEqual({ name, message: expect.stringContaining('string is too long for tsvector') });
      expect((await engine.getPage(SLUG))?.title).toBe('Marmot burrow');
      const after = await stored(engine);
      expect(after).toEqual(before);
      return { attempts, after };
    },
  );

  parityTest(
    'putPage with unchanged values rebuilds the vector with the timeline entries and the page stays searchable',
    { methods: ['putPage', 'addTimelineEntry', 'searchTitles'] },
    async (engine) => {
      // A title that overflows with the entries added is out of reach here: the SQL engines refuse a title past a few KB
      // at their `lower(title)` index before the vector is built. The Rust unit tests of keyword/titles.rs cover that boundary.
      const input = { type: 'note' as const, title: 'Marmot burrow', compiled_truth: 'marmot burrow ledger', timeline: '' };
      await seedPage(engine, { slug: SLUG, input, chunks: [chunk(0, 'marmot burrow ledger')] });
      await engine.addTimelineEntry(SLUG, { date: '2026-01-02', summary: 'pinniped migration', detail: '' });
      const found = async (query: string) => (await engine.searchTitles(query, { limit: 10 })).map((r) => r.slug);
      const before = { title: await found('marmot'), entry: await found('pinniped') };
      await engine.putPage(SLUG, input);
      const after = { title: await found('marmot'), entry: await found('pinniped') };
      expect(after).toEqual({ title: [SLUG], entry: [SLUG] });
      return { before, after };
    },
  );
});
