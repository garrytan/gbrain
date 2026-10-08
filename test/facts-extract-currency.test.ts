/**
 * Prompt example grounding, not a claim of model accuracy.
 * A dollar sign alone does not identify which dollar currency a speaker used.
 * These checks inspect the actual prompt both extraction admissions send.
 * Real model outputs require a separate frozen baseline/candidate comparison.
 */
import { describe, expect, test } from 'bun:test';
import { buildExtractorSystem, parseExtractorJson } from '../src/core/facts/extract.ts';

const CURRENCY_CODES = ['USD', 'CAD', 'AUD', 'NZD', 'EUR', 'GBP'];

describe('extractor currency examples', () => {
  for (const admitsLow of [true, false]) {
    test(`currency-labelled examples identify their currency in the input (admitsLow=${admitsLow})`, () => {
      const examples = [...buildExtractorSystem(admitsLow).matchAll(
        /\* "([^"]+)" → metric=([^,\n]+), value=([^,\n]+), unit=([^,\n]+), period=([^\n]+)/g,
      )];
      expect(examples.length).toBeGreaterThanOrEqual(5);
      const monetary = examples.filter(example => CURRENCY_CODES.includes(example[4]!));
      expect(monetary.length).toBeGreaterThanOrEqual(3);
      for (const example of monetary) {
        // No country inference from company names, model defaults or "$".
        expect(example[1]).toMatch(new RegExp(`\\b${example[4]}\\b`));
      }
      const unspecified = examples.filter(example => example[1]!.includes('$') && example[4] === 'null');
      expect(unspecified.length).toBeGreaterThanOrEqual(1);
    });
  }
});

describe('typed currency parser contract', () => {
  test('preserves an unspecified currency alongside the numeric amount and metric', () => {
    const parsed = parseExtractorJson(JSON.stringify({ facts: [{
      fact: 'The speaker committed $375 million to Fund A.', kind: 'fact',
      metric: 'committed_capital', value: 375000000, unit: null, period: null,
    }] }));
    expect(parsed).toHaveLength(1);
    expect(parsed![0]!.metric).toBe('committed_capital');
    expect(parsed![0]!.value).toBe(375000000);
    expect(parsed![0]!.unit).toBeNull();
  });

  test('preserves explicit non-USD currencies and non-currency units', () => {
    const units = ['CAD', 'AUD', 'NZD', 'EUR', 'GBP', 'people', 'pct'];
    const parsed = parseExtractorJson(JSON.stringify({ facts: units.map(unit => ({
      fact: `The source explicitly reports a metric in ${unit}.`, kind: 'fact',
      metric: 'source_metric', value: 12, unit, period: null,
    })) }));
    expect(parsed!.map(fact => fact.unit)).toEqual(units);
  });
});
