/**
 * Cat 40 Hard F4: date honesty in search rows. `effective_date` stays the one
 * date field; lean rows keep `effective_date_source`, and every search/query
 * reply with dated rows carries one model-visible line that labels the date
 * by its source (document, event or fallback date) and says it is never a
 * contract's effective or validity date.
 *
 * Authoring gate: (1) agents read `effective_date` as a contract's effective
 * date; the label is the model-visible contract that it is not; (2) fails if
 * lean rows drop `effective_date_source`, if a source is mislabeled (a
 * fallback import date called a document date), or if the line leaves the
 * MCP content; (3) no test covered row-date labels; (4) no seam.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { dateLabelLine, effectiveDateLabel } from '../src/core/search/date-labels.ts';
import { withEnv } from './helpers/with-env.ts';
import { seedPage } from './helpers/keyword-paging-fixture.ts';

const REMOTE = { remote: true, transport: 'http' as const, sourceId: 'default' };
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedPage(engine, 'contracts/widget-co-amendment', 'Amendment for widget-co: the new price is effective 2026-06-01.', { frontmatter: { date: '2026-05-10' } });
  await seedPage(engine, 'meetings/widget-co-review', 'Review meeting about the widget-co amendment.', { type: 'meeting', frontmatter: { event_date: '2026-05-12' } });
  await seedPage(engine, 'notes/widget-co-undated', 'Undated note on the widget-co amendment.');
}, 120_000);

afterAll(async () => { await engine?.disconnect(); });

describe('labels by source', () => {
  test('each source maps to document, event or fallback date', () => {
    for (const s of ['date', 'published', 'filename']) expect(effectiveDateLabel(s)).toBe('document date');
    expect(effectiveDateLabel('event_date')).toBe('event date');
    for (const s of ['created', 'fallback']) expect(effectiveDateLabel(s)).toStartWith('fallback (page created/imported');
    expect(effectiveDateLabel(null)).toBe('date of unrecorded origin');
  });

  test('the line names only the sources present and never claims contractual validity', () => {
    const line = dateLabelLine([
      { effective_date: '2026-05-10', effective_date_source: 'date' },
      { effective_date: '2026-01-02', effective_date_source: 'fallback' },
    ])!;
    expect(line).toBe("[gbrain dates] effective_date by effective_date_source: date = document date; fallback = fallback (page created/imported, not from its text). Never a contract's effective or validity date (read the text).");
    expect(dateLabelLine([{ effective_date: null }, { slug: 'x' }])).toBeNull();
    expect(dateLabelLine([{ effective_date: '2026-05-10' }])).toContain('no source = date of unrecorded origin');
  });
});

describe('over MCP (model-visible content only)', () => {
  for (const name of ['search', 'query'] as const) {
    test(`${name}: lean rows keep effective_date_source and the date line labels each one`, async () => {
      const res = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, name,
        { query: 'widget-co amendment', ...(name === 'query' ? { expand: false } : {}) }, REMOTE));
      expect(res.isError).toBeUndefined();
      const rows = JSON.parse(res.content[0].text) as Array<{ slug: string; effective_date: string | null; effective_date_source?: string }>;
      const bySlug = new Map(rows.map(r => [r.slug, r]));
      expect(bySlug.get('contracts/widget-co-amendment')).toMatchObject({ effective_date: '2026-05-10', effective_date_source: 'date' });
      expect(bySlug.get('meetings/widget-co-review')).toMatchObject({ effective_date: '2026-05-12', effective_date_source: 'event_date' });
      const line = res.content.map(c => c.text).find(t => t.startsWith('[gbrain dates] '));
      expect(line).toBeDefined();
      expect(line).toContain('date = document date');
      expect(line).toContain('event_date = event date');
      expect(line).toContain("Never a contract's effective or validity date");
      expect(line).toContain('fallback = fallback (page created/imported');
    });
  }
});
