/**
 * #10359: generic claim_metric and a null claim_period make the claim-conflict
 * lane pair different measurements. The extractor prompt must tell the model to
 * keep one metric per scope and to copy a stated window into period.
 */
import { describe, expect, test } from 'bun:test';
import { buildExtractorSystem } from '../src/core/facts/extract.ts';

describe('extractor prompt claim scope (#10359)', () => {
  for (const admitsLow of [true, false]) {
    test(`admitsLow=${admitsLow}: one metric per scope and a stated window goes in period`, () => {
      const prompt = buildExtractorSystem(admitsLow);
      expect(prompt).toMatch(/metric names ONE quantity for one\s+scope/);
      expect(prompt).toMatch(/copy that window into period/);
    });
  }
});
