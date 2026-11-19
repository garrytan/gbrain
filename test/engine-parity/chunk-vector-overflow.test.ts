/**
 * BrainEngine parity: a chunk whose search vector cannot be stored is refused at write (review finding 6 of PR 9730).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: content_chunks' BEFORE INSERT/UPDATE trigger builds `search_vector` from doc_comment, symbol_name_qualified
 *    and chunk_text, and to_tsvector / `||` raise "string is too long for tsvector" (54000) past 1,048,575 bytes. That error
 *    aborts the whole upsertChunks / sealChunks statement, so nothing of the batch is stored and every stored chunk stays
 *    searchable. The Rust arm must refuse the same writes with the same message and keep the stored chunks.
 *  - Regression: the Rust store stored the oversized text unchecked and rebuilt each chunk's vector at read time, so the
 *    first keyword search that reached the chunk failed, and every later search with it.
 *  - Why existing coverage misses it: test/page-search-vector-overflow.test.ts covers the page trigger only, and the parity
 *    chunk cases write short texts.
 *  - Seam: none (typed methods only). A chunk stored before the check existed (only a Rust store can hold one, SQL refused
 *    it) is covered by the Rust unit tests of keyword/arm.rs and keyword/page_search.rs.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const SLUG = 'notes/vector';
/** ~2 MB of distinct tokens: a ~2.7 MB tsvector, past the 1,048,575-byte cap. */
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
    chunks: (await engine.getChunks(SLUG)).map((c) => c.chunk_text),
    hits: (await engine.searchKeyword('marmot', { limit: 10 })).map((r) => `${r.slug}: ${r.chunk_text}`),
    pages: (await engine.searchKeywordPages('marmot', undefined, { limit: 10 })).map((r) => r.slug),
  };
}

describe('a chunk whose search vector overflows', () => {
  parityTest(
    'upsertChunks and sealChunks refuse it whole and the stored chunks stay searchable',
    { methods: ['sealChunks', 'upsertChunks', 'getChunks', 'searchKeyword', 'searchKeywordPages'] },
    async (engine) => {
      await seedPage(engine, {
        slug: SLUG,
        input: { type: 'note', title: 'Vector', compiled_truth: 'marmot burrow', timeline: '' },
        chunks: [chunk(0, 'marmot burrow ledger')],
      });
      const before = await stored(engine);
      expect(before.hits).toEqual([`${SLUG}: marmot burrow ledger`]);
      const edited = chunk(0, 'marmot burrow edited');
      const attempts: Record<string, string | null> = {
        'upsert, oversized text': await refusal(() => engine.upsertChunks(SLUG, [edited, chunk(1, BIG)])),
        'seal, oversized text': await refusal(() => engine.sealChunks(SLUG, [edited, chunk(1, BIG)])),
        'upsert, oversized doc comment': await refusal(() => engine.upsertChunks(SLUG, [{ ...edited, doc_comment: BIG }])),
        'upsert, oversized symbol name': await refusal(() => engine.upsertChunks(SLUG, [{ ...edited, symbol_name_qualified: BIG }])),
      };
      for (const [name, message] of Object.entries(attempts)) expect({ name, message: message ?? 'was accepted' }).toEqual({ name, message: expect.stringContaining('string is too long for tsvector') });
      const after = await stored(engine);
      expect(after).toEqual(before);
      return { attempts, after };
    },
  );
});
