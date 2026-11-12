/**
 * #8371 / #8373 — an atom's source quote that differs from the source only by
 * Markdown block markers ('## ', '> '), quotation marks or a spaced dash says
 * the source's exact words. It must locate (provenance kept, offsets into the
 * ORIGINAL text) instead of being stamped quote_unverified as a paraphrase.
 * Changed wording still fails closed.
 */
import { describe, test, expect } from 'bun:test';
import { locateQuote } from '../../src/core/cycle/extract-atoms.ts';

function span(content: string, quote: string): string | null {
  const loc = locateQuote(content, quote);
  return loc ? content.slice(loc.start, loc.end) : null;
}

describe('locateQuote tolerates Markdown and punctuation the model drops (#8371)', () => {
  test('a heading and a blockquote marker', () => {
    const content = '## Decision\n> We will ship on Friday.';
    expect(span(content, 'Decision We will ship on Friday.')).toBe('Decision\n> We will ship on Friday.');
  });

  test('nested blockquote markers and a deeper heading', () => {
    const content = 'intro\n### Plan\n> > Keep the cap at forty hours.';
    expect(span(content, 'Plan Keep the cap at forty hours.')).toBe('Plan\n> > Keep the cap at forty hours.');
  });

  test('inner quotation marks, straight and curly', () => {
    expect(span('She said "done" today.', 'She said done today.')).toBe('She said "done" today.');
    expect(span('She said “done” today.', 'She said done today.')).toBe('She said “done” today.');
    expect(span("He called it 'final' twice.", 'He called it final twice.')).toBe("He called it 'final' twice.");
  });

  test('a spaced dash, plain or em', () => {
    expect(span('Cost: 40 hours - approved.', 'Cost: 40 hours approved.')).toBe('Cost: 40 hours - approved.');
    expect(span('Cost: 40 hours — approved.', 'Cost: 40 hours approved.')).toBe('Cost: 40 hours — approved.');
  });

  test('apostrophes inside words and unspaced dashes still count', () => {
    expect(span("We don't ship on Mondays.", 'We dont ship on Mondays.')).toBeNull();
    expect(span('The budget is 40-50 hours.', 'The budget is 4050 hours.')).toBeNull();
  });

  test('a sign, a range or a comparison next to a number is meaning, not markup', () => {
    expect(span('Net margin: − 12% this quarter.', 'Net margin: 12% this quarter.')).toBeNull();
    expect(span('Net margin: - 12% this quarter.', 'Net margin: 12% this quarter.')).toBeNull();
    expect(span('Shipping in 10 - 20 days.', 'Shipping in 10 20 days.')).toBeNull();
    expect(span('We saw 5% churn.', '>5% churn.')).toBeNull();
  });

  test('changed wording still fails closed', () => {
    expect(span('## Decision\n> We will ship on Friday.', 'Decision We will not ship on Friday.')).toBeNull();
    expect(span('She said "done" today.', 'She said finished today.')).toBeNull();
  });
});
