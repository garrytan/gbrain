/**
 * BrainEngine parity: findByTitleFuzzy splits words as the C.UTF-8 `iswalnum` does (review finding 8 of PR 9730).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: pg_trgm cuts a title into words at every character `iswalnum` rejects. Under C.UTF-8 that makes the
 *    superscript and fraction digits separators (`x²` is the word `x`) and `ª` or Arabic-Indic digits word characters,
 *    which is not Rust's Unicode alphanumeric class. The Rust arm must give the same similarity.
 *  - Regression: trgm.rs used `char::is_alphanumeric` and `to_lowercase`, so `findByTitleFuzzy('x')` scored the title `x²`
 *    0.25 on Rust and 1.0 on Postgres.
 *  - Why existing coverage misses it: the fuzzy cases use ASCII titles; the Rust goldens had no such code point.
 *  - Seam: none (typed methods only).
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

describe('findByTitleFuzzy on titles with non-ASCII digits and letters', () => {
  parityTest(
    'a superscript digit is a separator and a feminine ordinal is a letter',
    { methods: ['findByTitleFuzzy', 'putPage'] },
    async (engine) => {
      const put = (slug: string, title: string) => engine.putPage(slug, { type: 'concept', title, compiled_truth: 'body', timeline: '' });
      await put('concepts/superscript', 'x\u00b2');
      await put('concepts/ordinal', 'ab\u00aa');
      const round = (hit: { slug: string; similarity: number } | null) => hit && { slug: hit.slug, similarity: Math.round(hit.similarity * 1000) / 1000 };
      const x = round(await engine.findByTitleFuzzy('x', undefined, 0.1));
      const ab = round(await engine.findByTitleFuzzy('ab', undefined, 0.1));
      expect(x?.slug).toBe('concepts/superscript');
      return { x, ab };
    },
  );
});
