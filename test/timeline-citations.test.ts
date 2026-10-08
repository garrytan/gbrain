/** #6184: an HTML comment next to an inline citation is markup, never a timeline summary. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { parseInlineCitationTimelineEntries, stripHtmlComments, supersededInlineCitationEntries } from '../src/core/timeline-citations.ts';
import { parseTimelineEntries } from '../src/core/link-extraction.ts';
import { extractTimelineFromContent, hasExtractorDetail, retractRemovedTimelineEntries } from '../src/core/timeline-extract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
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

describe('#6226 multi-source citations and emphasis', () => {
  const cases: Array<[string, string, Array<{ date: string; source: string; summary: string }>]> = [
    ['two sources, two dates', '- **Widget-co:** per Alice, builds widgets. [Source: meeting transcript, 2026-10-06; Gmail "Intro", 2026-09-28]', [
      { date: '2026-10-06', source: 'meeting transcript', summary: 'Widget-co: per Alice, builds widgets.' },
      { date: '2026-09-28', source: 'Gmail "Intro"', summary: 'Widget-co: per Alice, builds widgets.' }]],
    ['a ; before any date stays inside one source', 'Agreed terms. [Source: call; follow-up email, 2026-05-10]', [
      { date: '2026-05-10', source: 'call; follow-up email', summary: 'Agreed terms.' }]],
    ['an invalid date drops only its own source', 'Signed. [Source: memo, 2026-02-30; board deck, 2026-03-01]', [
      { date: '2026-03-01', source: 'board deck', summary: 'Signed.' }]],
    ['an empty source is dropped, its siblings kept', 'Met. [Source: , 2026-04-01; notes, 2026-04-02]', [
      { date: '2026-04-02', source: 'notes', summary: 'Met.' }]],
    ['the same source and date twice files once', 'Met. [Source: notes, 2026-04-02; notes, 2026-04-02]', [
      { date: '2026-04-02', source: 'notes', summary: 'Met.' }]],
    ['underscore, star and nested emphasis unwrap', '__Label:__ an *important* **note (*really*)** here [Source: call, 2026-01-02]', [
      { date: '2026-01-02', source: 'call', summary: 'Label: an important note (really) here' }]],
    ['snake_case, a*b*c and spaced stars are not emphasis', 'Set max_retry_count and a*b*c; 2 * 3 * 4 [Source: call, 2026-01-02]', [
      { date: '2026-01-02', source: 'call', summary: 'Set max_retry_count and a*b*c; 2 * 3 * 4' }]],
    ['a single-source citation is unchanged', 'Shipped the beta. [Source: Slack import, 2026-10-05]', [
      { date: '2026-10-05', source: 'Slack import', summary: 'Shipped the beta.' }]],
  ];
  for (const [name, text, expected] of cases) {
    test(name, () => {
      expect(parseInlineCitationTimelineEntries(text)).toEqual(expected);
      expect(parseTimelineEntries(text).map(e => ({ date: e.date, source: e.source, summary: e.summary }))).toEqual(expected);
      expect(extractTimelineFromContent(text, 'notes/x').map(e => ({ date: e.date, source: e.source, summary: e.summary }))).toEqual(expected);
    });
  }

  test('emphasis unwrapping stays linear on adversarial input', () => {
    const inputs = ['**a'.repeat(50_000), '*x '.repeat(50_000), '__a_'.repeat(50_000), '_'.repeat(150_000)];
    for (const input of inputs) {
      const started = performance.now();
      parseInlineCitationTimelineEntries(`${input} [Source: s, 2026-01-02]`);
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });

  test('the older reading of a citation is reported only where the current reading replaces it', () => {
    expect(supersededInlineCitationEntries('- **Widget-co:** per Alice. [Source: meeting transcript, 2026-10-06; Gmail "Intro", 2026-09-28]'))
      .toEqual([{ date: '2026-09-28', source: 'meeting transcript, 2026-10-06; Gmail "Intro"', summary: 'Widget-co:** per Alice.' }]);
    expect(supersededInlineCitationEntries('Shipped the beta. [Source: Slack import, 2026-10-05]')).toEqual([]);
  });

  test('extractor-written detail is empty or names the source; anything else is someone\'s own', () => {
    expect(hasExtractorDetail({ source: 'call', detail: '' })).toBe(true);
    expect(hasExtractorDetail({ source: 'call', detail: 'Source: call' })).toBe(true);
    expect(hasExtractorDetail({ source: 'call', detail: 'confirmed by phone' })).toBe(false);
  });
});

describe('#6226 timeline retraction retires the older reading on unmanaged brains', () => {
  const text = '- **Widget-co:** per Alice. [Source: meeting transcript, 2026-10-06; Gmail "Intro", 2026-09-28]';
  const old = { date: '2026-09-28', source: 'meeting transcript, 2026-10-06; Gmail "Intro"', summary: 'Widget-co:** per Alice.' };
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
  afterAll(async () => { await engine.disconnect(); }, 60_000);
  beforeEach(async () => { await resetPgliteState(engine); });

  const retract = async (detail: string) => {
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice', compiled_truth: text, timeline: '' });
    await engine.addTimelineEntry('people/alice-example', { ...old, detail });
    await engine.addTimelineEntry('people/alice-example', { date: '2026-10-06', source: 'meeting transcript', summary: 'Widget-co: per Alice.', detail: 'Source: meeting transcript' });
    const retired = await retractRemovedTimelineEntries(engine, 'people/alice-example', 'default', text);
    const left = await engine.executeRaw<{ source: string }>('SELECT source FROM timeline_entries ORDER BY source');
    return { retired: retired.map(r => r.source), left: left.map(r => r.source) };
  };

  test('an old row with extractor detail is retracted; the current row stays', async () => {
    expect(await retract(`Source: ${old.source}`)).toEqual({ retired: [old.source], left: ['meeting transcript'] });
  });

  test('an old row someone gave its own detail stays (T3)', async () => {
    expect(await retract('confirmed by phone')).toEqual({ retired: [], left: ['meeting transcript', old.source] });
  });
});
