import { describe, expect, test } from 'bun:test';
import { isConversationParserCandidate } from '../src/commands/doctor.ts';

describe('doctor conversation parser candidate filter', () => {
  test('excludes normalized meeting summaries with a raw_source pointer', () => {
    expect(isConversationParserCandidate({
      type: 'meeting',
      frontmatter: {
        raw_source: 'meetings/raw/reliable/2026-07-16-agy.md',
        attribution: 'reliable',
      },
    } as any)).toBe(false);
  });

  test('keeps raw turn-oriented conversation pages', () => {
    expect(isConversationParserCandidate({
      type: 'conversation',
      frontmatter: { timezone: 'Asia/Makassar' },
    } as any)).toBe(true);
  });
});
