import { describe, expect, test } from 'bun:test';
import { parseInlineCitationTimelineEntries } from '../src/core/timeline-citations.ts';

describe('inline citation summaries keep inline code', () => {
  test('code span text survives, backticks dropped', () => {
    const body = '- Report archived as `HVAC/Report 083026.csv` (SHA-256 `ceedfbca`). [Source: ingest, 2026-08-30]\n';
    const out = parseInlineCitationTimelineEntries(body);
    expect(out.map((e) => e.summary)).toEqual(['Report archived as HVAC/Report 083026.csv (SHA-256 ceedfbca).']);
  });

  test('citation inside code still does not count', () => {
    const body = 'Use `[Source: x, 2026-08-30]` literally.\n';
    expect(parseInlineCitationTimelineEntries(body)).toEqual([]);
  });
});
