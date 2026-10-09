/**
 * Turning the line grammar on or off converges the graph: the setting and the
 * extraction generation commit together (core/line-grammar-config.ts), every
 * page extracted before the change reads as stale through the one watermark
 * (core/link-extraction-watermark.ts), managed extraction re-derives it, and
 * a page prepared under the old settings is never published as fresh.
 * Managed PGLite brain; the Postgres arm is test/e2e/line-grammar-toggle-postgres.test.ts.
 */
import { expect, test } from 'bun:test';
import { invalidLineGrammarValue, isInternalConfigKey } from '../src/core/line-grammar-config.ts';
import { laterInstant } from '../src/core/link-extraction-watermark.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../src/core/link-extraction.ts';
import { LINK_EXTRACTION_GENERATION_KEY } from '../src/core/line-grammar.ts';
import { concurrentToggleConverges, enableThenDisableConverges, noOpChangesKeepTheGeneration, preparedBeforeChangeStaysStale } from './helpers/line-grammar-toggle-scenarios.ts';

test('enable then disable: each effective change re-extracts and the stated type follows the setting', () => enableThenDisableConverges(), 180_000);
test('no-op changes keep the generation: repeated settings, spellings, unset to the same default, subordinate keys while off', () => noOpChangesKeepTheGeneration(), 120_000);
test('a page prepared before a change is not published or stamped fresh after it', () => preparedBeforeChangeStaysStale(), 120_000);
test('a toggle racing an extraction converges after one more extraction', () => concurrentToggleConverges(), 180_000);

test('validation and internal keys', () => {
  expect(invalidLineGrammarValue('line_grammar.enabled', 'tru')).toContain('true or false');
  for (const v of ['true', 'false', 'on', 'off', '1', '0', 'yes', 'no', ' TRUE ']) expect(invalidLineGrammarValue('line_grammar.enabled', v)).toBeNull();
  expect(isInternalConfigKey(LINK_EXTRACTION_GENERATION_KEY)).toBe(true);
  expect(isInternalConfigKey('line_grammar.enabled')).toBe(false);
});

test('watermark arithmetic keeps microseconds and never moves before the code watermark', () => {
  expect(laterInstant(LINK_EXTRACTOR_VERSION_TS, null)).toBe(LINK_EXTRACTOR_VERSION_TS);
  expect(laterInstant(LINK_EXTRACTOR_VERSION_TS, '2001-01-01T00:00:00Z')).toBe(LINK_EXTRACTOR_VERSION_TS);
  expect(laterInstant('2030-01-01T00:00:00.000100Z', '2030-01-01T00:00:00.000200Z')).toBe('2030-01-01T00:00:00.000200Z');
  expect(laterInstant('2030-01-01T00:00:00.000300Z', '2030-01-01T00:00:00.000200Z')).toBe('2030-01-01T00:00:00.000300Z');
  expect(laterInstant('2030-01-01T00:00:00Z', 'not a date')).toBe('2030-01-01T00:00:00Z');
});
