/**
 * PR #6274 (wave 15 P2.10): the extractor prompt keeps `$` ⇒ USD (the right
 * default for this product's corpus; `find_trajectory` compares series by
 * `(metric, unit, period)`, so nulling every bare `$` would split them) and
 * adds two explicit non-USD examples plus the rule to preserve a stated
 * currency and never convert. Prompt-shape pin only; model behaviour is the
 * eval suite's job.
 *
 * Contributed by @jordanschwartz-js (PR #6274 raised the currency question
 * and supplied the non-USD example shape).
 */
import { describe, expect, test } from 'bun:test';
import { buildExtractorSystem } from '../src/core/facts/extract.ts';

describe('extractor prompt currency guidance (#6274)', () => {
  for (const admitsLow of [true, false]) {
    test(`admitsLow=${admitsLow}: bare $ stays USD, explicit EUR/CAD examples present, stated currency preserved and never converted`, () => {
      const prompt = buildExtractorSystem(admitsLow);
      expect(prompt).toContain('"MRR: $50K (Jan 2026)" → metric=mrr, value=50000, unit=USD, period=monthly');
      expect(prompt).toContain('"Seed round: €620K" → metric=fundraise, value=620000, unit=EUR, period=null');
      expect(prompt).toContain('"CAD 2.75M committed" → metric=fundraise, value=2750000, unit=CAD, period=null');
      expect(prompt).toMatch(/preserve the stated currency/i);
      expect(prompt).toMatch(/never convert/i);
    });
  }
});
