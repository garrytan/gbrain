/**
 * BrainEngine parity: a keyword query of thousands of operands (review finding 4 of PR 9730).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: searchKeyword and searchKeywordPages answer a query made of thousands of repeated terms and stopwords
 *    ('quokka the ' x N) with the chunk it matches, on every arm. PGLite parses and runs it (the English stopword drops out
 *    of the tsquery but still counts as an operand while the tree is built).
 *  - Regression: the Rust keyword engine walked that tree recursively on the caller's thread, so a long enough query
 *    overflowed the stack and aborted the process. It now walks it on a deep stack and refuses a query past 131,072 items
 *    with `stack depth limit exceeded` (rust/crates/gbrain-store/src/keyword/tsearch.rs unit tests cover the refusal and
 *    a 1 MiB caller stack). PGLite 0.5.16 runs out of its 2 MB stack somewhere past 3,500 repeats and then answers an empty
 *    result with no error (4,000 repeats failed and 4,500 passed in one run, so its limit is not a fixed number); no Rust
 *    answer can match that. On macOS arm64 the same empty result already shows at 3,000 repeats (the darwin-arm64 addon smoke job),
 *    so the parity case uses 1,000 repeats (2,000 operands), well under both limits seen so far.
 *  - Why existing coverage misses it: the search tests run queries of a few words.
 *  - Seam: none (typed methods only).
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

async function seed(engine: BrainEngine): Promise<void> {
  await seedPage(engine, {
    slug: 'notes/quokka',
    input: { type: 'note', title: 'Quokka Notes', compiled_truth: 'quokka here', timeline: '' },
    chunks: [chunk(0, 'quokka here')],
  });
  await seedPage(engine, {
    slug: 'notes/other',
    input: { type: 'note', title: 'Other Notes', compiled_truth: 'nothing relevant', timeline: '' },
    chunks: [chunk(0, 'nothing relevant')],
  });
}

describe('a keyword query of thousands of operands', () => {
  parityTest(
    'searchKeyword and searchKeywordPages match the chunk a 1,000-repeat query names',
    { methods: ['searchKeyword', 'searchKeywordPages'] },
    async (engine) => {
      await seed(engine);
      const query = 'quokka the '.repeat(1000);
      const chunks = await engine.searchKeyword(query, { limit: 10 });
      const pages = await engine.searchKeywordPages(query, undefined, { limit: 10 });
      const out = { chunks: chunks.map((r) => r.slug), pages: pages.map((r) => r.slug) };
      expect(out).toEqual({ chunks: ['notes/quokka'], pages: ['notes/quokka'] });
      return out;
    },
  );
});
