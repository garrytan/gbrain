import { describe, expect, test } from 'bun:test';
import { locateQuote } from '../src/core/cycle/extract-atoms.ts';

describe('extract_atoms quote provenance with Markdown differences (#8371)', () => {
  test('locates quotes when only line markers, quote marks, or separator dashes differ', () => {
    const cases = [
      {
        page: '## Decision\n> We will ship the release on Friday, not Monday.',
        quote: 'Decision We will ship the release on Friday, not Monday.',
        span: 'Decision\n> We will ship the release on Friday, not Monday.',
      },
      {
        page: 'The owner said "testing is done" in the review.',
        quote: 'The owner said testing is done in the review.',
        span: 'The owner said "testing is done" in the review.',
      },
      {
        page: 'Cost: 40 hours - approved by finance.',
        quote: 'Cost: 40 hours approved by finance.',
        span: 'Cost: 40 hours - approved by finance.',
      },
    ];

    for (const { page, quote, span } of cases) {
      const location = locateQuote(page, quote);
      expect(location).not.toBeNull();
      expect(page.slice(location!.start, location!.end)).toBe(span);
    }
  });

  test('still rejects changed wording', () => {
    expect(locateQuote('The cost was approved by finance.', 'The cost was authorized by finance.')).toBeNull();
  });
});
