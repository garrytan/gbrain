/** #6184: an HTML comment next to an inline citation is markup, never a timeline summary. */
import { describe, expect, test } from 'bun:test';
import { parseInlineCitationTimelineEntries, stripHtmlComments } from '../src/core/timeline-citations.ts';
import { renderMaterializedBullet } from '../src/core/persistence/canonical-projections.ts';

describe('#6184 inline-citation timeline parsing', () => {
  test('a comment-only line after a citation is a paragraph boundary, not the summary', () => {
    expect(parseInlineCitationTimelineEntries('[Source: Slack import, 2026-10-04]\n<!-- AUTO:slack END -->')).toEqual([]);
  });

  test('an inline comment after the citation is stripped from the summary', () => {
    expect(parseInlineCitationTimelineEntries('- Talked with alice-example about the launch. [Source: Slack import, 2026-10-04] <!-- AUTO:slack END -->'))
      .toEqual([{ date: '2026-10-04', source: 'Slack import', summary: 'Talked with alice-example about the launch.' }]);
  });

  test('a materialized marker line after a cited sentence is not part of it', () => {
    expect(parseInlineCitationTimelineEntries('Met alice-example. [Source: Slack import, 2026-10-04]\n<!-- gbrain:materialized v1 aa7e494fedca -->'))
      .toEqual([{ date: '2026-10-04', source: 'Slack import', summary: 'Met alice-example.' }]);
  });

  test('a comment before the cited text and a dangling marker never reach the summary', () => {
    expect(parseInlineCitationTimelineEntries('<!-- AUTO:slack BEGIN --> Shipped the beta. [Source: Slack import, 2026-10-05]'))
      .toEqual([{ date: '2026-10-05', source: 'Slack import', summary: 'Shipped the beta.' }]);
    expect(parseInlineCitationTimelineEntries('Shipped the beta. [Source: Slack import, 2026-10-05] -->').map(e => e.summary)).toEqual(['Shipped the beta.']);
  });
});

describe('#6184 write-back guard', () => {
  test('a row whose summary, source or detail carries comment markup is never rendered into the page', () => {
    expect(renderMaterializedBullet({ date: '2026-10-04', source: 'Slack import', summary: '<!-- AUTO:slack END -->' }, 'notes/x')).toBeNull();
    expect(renderMaterializedBullet({ date: '2026-10-04', source: 'Slack import', summary: 'Talked with alice-example. <!-- AUTO:slack END -->' }, 'notes/x')).toBeNull();
    expect(renderMaterializedBullet({ date: '2026-10-04', source: '<!-- x -->', summary: 'ok' }, 'notes/x')).toBeNull();
    expect(renderMaterializedBullet({ date: '2026-10-04', source: 'Slack import', summary: 'ok', detail: 'trailing -->' }, 'notes/x')).toBeNull();
    expect(renderMaterializedBullet({ date: '2026-10-04', source: 'Slack import', summary: 'Talked with alice-example.' }, 'notes/x')).not.toBeNull();
  });
});

describe('#6184 comment handling stays linear (security review: a remote put_page body must not stall the parser)', () => {
  test('lines of empty comment runs that end in text parse in milliseconds', () => {
    const body = `Met alice-example. [Source: Slack import, 2026-10-04]\n${Array.from({ length: 20 }, () => `${'<!---->'.repeat(40)}x`).join('\n')}`;
    const started = performance.now();
    const entries = parseInlineCitationTimelineEntries(body);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(entries.map(e => e.date)).toEqual(['2026-10-04']);
  }, 60_000);

  test('many unclosed comment openers strip in linear time with the same result as before', () => {
    const opened = `${'<!--'.repeat(60_000)} tail`;
    const started = performance.now();
    const stripped = stripHtmlComments(opened);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(stripped.trim()).toBe('tail');
    expect(stripHtmlComments('a <!-- x --> b <!-- y')).toBe('a   b   y');
    expect(stripHtmlComments('<!---->a<!-->b-->c')).toBe(' a c');
    expect(stripHtmlComments('a --> b <!-- c --> d')).toBe('a   b   d');
  }, 60_000);

  test('a line that opens and closes with comment markup is still a boundary, as before', () => {
    expect(parseInlineCitationTimelineEntries('[Source: Slack import, 2026-10-04]\n  <!-- a -->  <!-- b -->  ')).toEqual([]);
    expect(parseInlineCitationTimelineEntries('Met alice-example. [Source: Slack import, 2026-10-04]\n<!-- a --> more -->'))
      .toEqual([{ date: '2026-10-04', source: 'Slack import', summary: 'Met alice-example.' }]);
  });
});
