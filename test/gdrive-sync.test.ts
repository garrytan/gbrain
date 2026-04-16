import { describe, test, expect } from 'bun:test';
import {
  buildDocPage,
  buildSectionPage,
  buildTabPage,
  csvToMarkdownTable,
  parseCSVRow,
  extractSlideText,
  extractTextContent,
  autoTag,
  hashContent,
  extractDateFromHeading,
  splitDocSections,
  docsApiToText,
} from '../scripts/gdrive-sync.mjs';

// ---------------------------------------------------------------------------
// csvToMarkdownTable
// ---------------------------------------------------------------------------

describe('csvToMarkdownTable', () => {
  test('converts simple CSV to markdown table', () => {
    const csv = 'Name,Status,ARR\nAcme Corp,Active,120000\nBeta Inc,Trial,0';
    const table = csvToMarkdownTable(csv);
    expect(table).toContain('| Name | Status | ARR |');
    expect(table).toContain('| --- | --- | --- |');
    expect(table).toContain('| Acme Corp | Active | 120000 |');
    expect(table).toContain('| Beta Inc | Trial | 0 |');
  });

  test('handles quoted fields with commas', () => {
    const csv = 'Name,Notes\n"Acme, Inc","Good deal, close in Q2"';
    const table = csvToMarkdownTable(csv);
    expect(table).toContain('Acme, Inc');
    expect(table).toContain('Good deal, close in Q2');
  });

  test('escapes pipe characters in cell values', () => {
    const csv = 'Formula\na | b';
    const table = csvToMarkdownTable(csv);
    expect(table).toContain('a \\| b');
  });

  test('returns empty-sheet placeholder for empty input', () => {
    expect(csvToMarkdownTable('')).toBe('_Empty sheet_');
    expect(csvToMarkdownTable('   ')).toBe('_Empty sheet_');
  });

  test('handles single-row CSV (header only)', () => {
    const csv = 'Name,Status';
    const table = csvToMarkdownTable(csv);
    expect(table).toContain('| Name | Status |');
    expect(table).toContain('| --- | --- |');
    // No data rows beyond the header
    const lines = table.trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// parseCSVRow
// ---------------------------------------------------------------------------

describe('parseCSVRow', () => {
  test('splits simple comma-separated row', () => {
    expect(parseCSVRow('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  test('handles quoted fields', () => {
    expect(parseCSVRow('"hello, world",foo')).toEqual(['hello, world', 'foo']);
  });

  test('handles escaped quotes inside quoted fields', () => {
    expect(parseCSVRow('"say ""hi""",bar')).toEqual(['say "hi"', 'bar']);
  });

  test('handles empty fields', () => {
    expect(parseCSVRow('a,,c')).toEqual(['a', '', 'c']);
  });

  test('trailing comma gives empty last field', () => {
    expect(parseCSVRow('a,b,')).toEqual(['a', 'b', '']);
  });
});

// ---------------------------------------------------------------------------
// extractTextContent
// ---------------------------------------------------------------------------

describe('extractTextContent', () => {
  test('returns empty string for null input', () => {
    expect(extractTextContent(null)).toBe('');
    expect(extractTextContent(undefined)).toBe('');
  });

  test('extracts text from textRun elements', () => {
    const textObj = {
      textElements: [
        { textRun: { content: 'Hello ' } },
        { textRun: { content: 'world' } },
      ],
    };
    expect(extractTextContent(textObj)).toBe('Hello world');
  });

  test('replaces vertical tabs with newlines', () => {
    const textObj = {
      textElements: [
        { textRun: { content: 'Line 1\u000bLine 2' } },
      ],
    };
    expect(extractTextContent(textObj)).toBe('Line 1\nLine 2');
  });

  test('handles paragraphMarker elements (no content)', () => {
    const textObj = {
      textElements: [
        { textRun: { content: 'Title' } },
        { paragraphMarker: {} },
        { textRun: { content: ' body' } },
      ],
    };
    expect(extractTextContent(textObj)).toBe('Title body');
  });
});

// ---------------------------------------------------------------------------
// extractSlideText
// ---------------------------------------------------------------------------

describe('extractSlideText', () => {
  test('extracts text from shape elements', () => {
    const slide = {
      pageElements: [
        {
          shape: {
            text: {
              textElements: [{ textRun: { content: 'Slide title' } }],
            },
          },
        },
        {
          shape: {
            text: {
              textElements: [{ textRun: { content: 'Bullet point one' } }],
            },
          },
        },
      ],
    };
    const texts = extractSlideText(slide);
    expect(texts).toContain('Slide title');
    expect(texts).toContain('Bullet point one');
  });

  test('skips empty shapes', () => {
    const slide = {
      pageElements: [
        { shape: { text: { textElements: [] } } },
        {
          shape: {
            text: {
              textElements: [{ textRun: { content: 'Real content' } }],
            },
          },
        },
      ],
    };
    const texts = extractSlideText(slide);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe('Real content');
  });

  test('extracts text from table cells', () => {
    const slide = {
      pageElements: [
        {
          table: {
            tableRows: [
              {
                tableCells: [
                  { text: { textElements: [{ textRun: { content: 'Col A' } }] } },
                  { text: { textElements: [{ textRun: { content: 'Col B' } }] } },
                ],
              },
              {
                tableCells: [
                  { text: { textElements: [{ textRun: { content: 'Val 1' } }] } },
                  { text: { textElements: [{ textRun: { content: 'Val 2' } }] } },
                ],
              },
            ],
          },
        },
      ],
    };
    const texts = extractSlideText(slide);
    expect(texts.length).toBeGreaterThan(0);
    // Table should produce markdown-ish output with column headers
    const combined = texts.join('\n');
    expect(combined).toContain('Col A');
    expect(combined).toContain('Col B');
  });

  test('returns empty array for slide with no elements', () => {
    expect(extractSlideText({ pageElements: [] })).toEqual([]);
    expect(extractSlideText({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// autoTag
// ---------------------------------------------------------------------------

const MIME_DOCS   = 'application/vnd.google-apps.document';
const MIME_SHEETS = 'application/vnd.google-apps.spreadsheet';
const MIME_SLIDES = 'application/vnd.google-apps.presentation';

describe('autoTag', () => {
  test('always includes file type tag', () => {
    expect(autoTag('Untitled', MIME_DOCS)).toContain('doc');
    expect(autoTag('Untitled', MIME_SHEETS)).toContain('sheet');
    expect(autoTag('Untitled', MIME_SLIDES)).toContain('slide');
  });

  test('detects standup from title', () => {
    expect(autoTag('Daily Standup Notes', MIME_DOCS)).toContain('standup');
    expect(autoTag('Stand-up 2026-04-15', MIME_DOCS)).toContain('standup');
  });

  test('detects meeting/sync from title', () => {
    expect(autoTag('Kaigo <> Acme Meeting Notes', MIME_DOCS)).toContain('meeting');
    expect(autoTag('Weekly Sync Notes', MIME_DOCS)).toContain('meeting');
  });

  test('detects GTM from title', () => {
    expect(autoTag('GTM Strategy Q2', MIME_DOCS)).toContain('gtm');
    expect(autoTag('Go-to-Market Planning', MIME_DOCS)).toContain('gtm');
  });

  test('detects sales and prospect from title', () => {
    expect(autoTag('Sales Pipeline Review', MIME_SHEETS)).toContain('sales');
    expect(autoTag('Prospect Outreach Tracker', MIME_SHEETS)).toContain('sales');
  });

  test('produces no duplicate tags', () => {
    const tags = autoTag('GTM Sync Meeting', MIME_DOCS);
    expect(tags.length).toBe(new Set(tags).size);
  });

  test('returns only file type for generic title', () => {
    const tags = autoTag('Untitled Document', MIME_DOCS);
    expect(tags).toEqual(['doc']);
  });
});

// ---------------------------------------------------------------------------
// buildDocPage
// ---------------------------------------------------------------------------

describe('buildDocPage', () => {
  const baseFile = {
    id: 'abc123',
    name: 'Kaigo Q1 Board Meeting Notes',
    mimeType: MIME_DOCS,
    modifiedTime: '2026-04-10T14:00:00.000Z',
    webViewLink: 'https://docs.google.com/document/d/abc123/edit',
    description: '',
  };

  test('produces valid YAML frontmatter', () => {
    const md = buildDocPage(baseFile, 'Some meeting content here.');
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('title: "Kaigo Q1 Board Meeting Notes"');
    expect(md).toContain('type: doc');
    expect(md).toContain('date: 2026-04-10');
    expect(md).toContain('source: google-drive');
    expect(md).toContain('source_id: abc123');
    expect(md).toContain('source_url: "https://docs.google.com/document/d/abc123/edit"');
    expect(md).toContain('tags:');
    expect(md).toContain('---\n');
  });

  test('includes Drive link in body', () => {
    const md = buildDocPage(baseFile, 'Content');
    expect(md).toContain('[Open in Google Drive]');
    expect(md).toContain('https://docs.google.com/document/d/abc123/edit');
  });

  test('includes document content', () => {
    const md = buildDocPage(baseFile, 'Meeting agenda:\n1. Financials\n2. Hiring');
    expect(md).toContain('Meeting agenda:');
    expect(md).toContain('1. Financials');
  });

  test('falls back to placeholder when content is empty', () => {
    const md = buildDocPage(baseFile, '');
    expect(md).toContain('_No text content extracted._');
  });

  test('escapes double quotes in title', () => {
    const file = { ...baseFile, name: 'Notes: "Q1 Review"' };
    const md = buildDocPage(file, 'content');
    // Should not break YAML parsing
    expect(md).toContain('title: "Notes: \\"Q1 Review\\""');
  });

  test('uses fallback Drive URL when webViewLink is missing', () => {
    const file = { ...baseFile, webViewLink: undefined };
    const md = buildDocPage(file, 'content');
    expect(md).toContain('https://drive.google.com/file/d/abc123');
  });

  test('includes optional description in frontmatter', () => {
    const file = { ...baseFile, description: 'Board deck for Q1 2026' };
    const md = buildDocPage(file, 'content');
    expect(md).toContain('description: "Board deck for Q1 2026"');
  });

  test('sets correct type for Sheets', () => {
    const file = { ...baseFile, mimeType: MIME_SHEETS };
    const md = buildDocPage(file, '| A | B |\n| --- | --- |');
    expect(md).toContain('type: sheet');
  });

  test('sets correct type for Slides', () => {
    const file = { ...baseFile, mimeType: MIME_SLIDES };
    const md = buildDocPage(file, '## Slide 1\n\nIntro');
    expect(md).toContain('type: slide');
  });
});

// ---------------------------------------------------------------------------
// hashContent
// ---------------------------------------------------------------------------

describe('hashContent', () => {
  test('returns a string', () => {
    expect(typeof hashContent('hello')).toBe('string');
  });

  test('same input → same hash', () => {
    expect(hashContent('meeting notes')).toBe(hashContent('meeting notes'));
  });

  test('different input → different hash', () => {
    expect(hashContent('old content')).not.toBe(hashContent('new content'));
  });

  test('empty string has a stable hash', () => {
    const h = hashContent('');
    expect(h).toBe(hashContent(''));
  });

  test('detects single-character change', () => {
    const a = hashContent('Acme Corp status: active');
    const b = hashContent('Acme Corp status: Active'); // capital A
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// extractDateFromHeading
// ---------------------------------------------------------------------------

describe('extractDateFromHeading', () => {
  test('extracts ISO date', () => {
    expect(extractDateFromHeading('2026-04-15')).toBe('2026-04-15');
    expect(extractDateFromHeading('2026-04-15 — Acme Corp check-in')).toBe('2026-04-15');
  });

  test('extracts numeric date M/D/YYYY', () => {
    expect(extractDateFromHeading('4/15/2026')).toBe('2026-04-15');
    expect(extractDateFromHeading('4/5/2026 standup')).toBe('2026-04-05');
  });

  test('extracts numeric date M/D/YY', () => {
    expect(extractDateFromHeading('4/15/26')).toBe('2026-04-15');
  });

  test('extracts month-name date', () => {
    expect(extractDateFromHeading('April 15, 2026')).toBe('2026-04-15');
    expect(extractDateFromHeading('April 15')).toBe(`${new Date().getFullYear()}-04-15`);
    expect(extractDateFromHeading('Apr 5, 2026')).toBe('2026-04-05');
  });

  test('returns null when no date found', () => {
    expect(extractDateFromHeading('Weekly standup notes')).toBeNull();
    expect(extractDateFromHeading('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// splitDocSections
// ---------------------------------------------------------------------------

const MEETING_NOTES_DOC = `Title line ignored

## 2026-04-15 — Acme Corp check-in

Discussed pricing.
Next steps: send proposal.

## 2026-04-10 — Beta Inc intro

First call. Great fit.

## April 5, 2026

Short entry.
`;

describe('splitDocSections', () => {
  test('splits on ## headings', () => {
    const sections = splitDocSections(MEETING_NOTES_DOC);
    expect(sections).toHaveLength(3);
  });

  test('extracts heading text', () => {
    const sections = splitDocSections(MEETING_NOTES_DOC);
    expect(sections[0].heading).toBe('2026-04-15 — Acme Corp check-in');
    expect(sections[1].heading).toBe('2026-04-10 — Beta Inc intro');
  });

  test('extracts date from heading', () => {
    const sections = splitDocSections(MEETING_NOTES_DOC);
    expect(sections[0].date).toBe('2026-04-15');
    expect(sections[1].date).toBe('2026-04-10');
    expect(sections[2].date).toBe(`${new Date().getFullYear()}-04-05`);
  });

  test('generates slug from heading', () => {
    const sections = splitDocSections(MEETING_NOTES_DOC);
    expect(sections[0].slug).toBe('2026-04-15-acme-corp-check-in');
    expect(sections[1].slug).toBe('2026-04-10-beta-inc-intro');
  });

  test('captures section content', () => {
    const sections = splitDocSections(MEETING_NOTES_DOC);
    expect(sections[0].content).toContain('Discussed pricing');
    expect(sections[0].content).toContain('Next steps');
    expect(sections[1].content).toContain('First call');
  });

  test('discards content before first ## heading', () => {
    const sections = splitDocSections(MEETING_NOTES_DOC);
    // "Title line ignored" should not appear in any section
    for (const s of sections) {
      expect(s.content).not.toContain('Title line ignored');
    }
  });

  test('deduplicates identical heading slugs', () => {
    const text = `## Standup\nContent A\n## Standup\nContent B\n`;
    const sections = splitDocSections(text);
    expect(sections[0].slug).toBe('standup');
    expect(sections[1].slug).toBe('standup-2');
  });

  test('returns single section with empty slug when no ## headings', () => {
    const text = 'Just some notes without headings.\nAnother line.';
    const sections = splitDocSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0].slug).toBe('');
    expect(sections[0].heading).toBe('');
    expect(sections[0].content).toContain('Just some notes');
  });

  test('new section prepended at top appears first in result', () => {
    const text = `## 2026-04-16 — New entry\nBrand new.\n## 2026-04-15 — Old entry\nOld.\n`;
    const sections = splitDocSections(text);
    expect(sections[0].date).toBe('2026-04-16');
    expect(sections[1].date).toBe('2026-04-15');
  });
});

// ---------------------------------------------------------------------------
// buildSectionPage
// ---------------------------------------------------------------------------

describe('buildSectionPage', () => {
  const baseFile = {
    id: 'abc123',
    name: 'Client Meeting Notes',
    mimeType: MIME_DOCS,
    modifiedTime: '2026-04-10T14:00:00.000Z',
    webViewLink: 'https://docs.google.com/document/d/abc123/edit',
    description: '',
  };

  const section = {
    heading: '2026-04-15 — Acme Corp check-in',
    slug: '2026-04-15-acme-corp-check-in',
    date: '2026-04-15',
    content: 'Discussed pricing.\nNext steps: send proposal.\n',
  };

  test('title combines doc name and section heading', () => {
    const md = buildSectionPage(baseFile, section);
    expect(md).toContain('title: "Client Meeting Notes — 2026-04-15 — Acme Corp check-in"');
  });

  test('uses section date in frontmatter', () => {
    const md = buildSectionPage(baseFile, section);
    expect(md).toContain('date: 2026-04-15');
  });

  test('includes parent_doc frontmatter field', () => {
    const md = buildSectionPage(baseFile, section);
    expect(md).toContain('parent_doc: "Client Meeting Notes"');
  });

  test('includes Drive link back to source doc', () => {
    const md = buildSectionPage(baseFile, section);
    expect(md).toContain('https://docs.google.com/document/d/abc123/edit');
  });

  test('includes section content', () => {
    const md = buildSectionPage(baseFile, section);
    expect(md).toContain('Discussed pricing.');
    expect(md).toContain('Next steps: send proposal.');
  });

  test('falls back to doc modifiedTime when section has no date', () => {
    const s = { ...section, date: null };
    const md = buildSectionPage(baseFile, s);
    expect(md).toContain('date: 2026-04-10');
  });

  test('whole-doc section (no heading) uses doc title as page title', () => {
    const s = { heading: '', slug: '', date: null, content: 'Some content.' };
    const md = buildSectionPage(baseFile, s);
    expect(md).toContain('title: "Client Meeting Notes"');
  });
});

// ---------------------------------------------------------------------------
// buildTabPage
// ---------------------------------------------------------------------------

describe('buildTabPage', () => {
  const baseFile = {
    id: 'sheet123',
    name: 'Pipeline Tracker',
    mimeType: MIME_SHEETS,
    modifiedTime: '2026-04-12T10:00:00.000Z',
    webViewLink: 'https://docs.google.com/spreadsheets/d/sheet123/edit',
    description: '',
  };

  const tab = {
    name: 'Active Pipeline',
    slug: 'active-pipeline',
    content: '| Company | Stage | ARR |\n| --- | --- | --- |\n| Acme | Proposal | 50000 |',
  };

  test('title combines sheet name and tab name', () => {
    const md = buildTabPage(baseFile, tab);
    expect(md).toContain('title: "Pipeline Tracker — Active Pipeline"');
  });

  test('includes tab frontmatter field', () => {
    const md = buildTabPage(baseFile, tab);
    expect(md).toContain('tab: "Active Pipeline"');
  });

  test('includes parent_doc frontmatter field', () => {
    const md = buildTabPage(baseFile, tab);
    expect(md).toContain('parent_doc: "Pipeline Tracker"');
  });

  test('sets type to sheet', () => {
    const md = buildTabPage(baseFile, tab);
    expect(md).toContain('type: sheet');
  });

  test('includes table content', () => {
    const md = buildTabPage(baseFile, tab);
    expect(md).toContain('| Acme | Proposal | 50000 |');
  });

  test('falls back to empty-tab placeholder', () => {
    const emptyTab = { ...tab, content: '' };
    const md = buildTabPage(baseFile, emptyTab);
    expect(md).toContain('_Empty tab._');
  });
});

// ---------------------------------------------------------------------------
// docsApiToText
// ---------------------------------------------------------------------------

/** Helper: build a minimal Docs API paragraph element */
function para(text: string, style = 'NORMAL_TEXT') {
  return {
    paragraph: {
      elements: [{ textRun: { content: text + '\n' } }],
      paragraphStyle: { namedStyleType: style },
    },
  };
}

describe('docsApiToText', () => {
  test('converts normal paragraphs to plain text', () => {
    const content = [para('First paragraph'), para('Second paragraph')];
    const text = docsApiToText(content);
    expect(text).toContain('First paragraph');
    expect(text).toContain('Second paragraph');
  });

  test('converts HEADING_2 to ## marker', () => {
    const content = [para('April 15 standup', 'HEADING_2'), para('Some notes')];
    const text = docsApiToText(content);
    expect(text).toContain('## April 15 standup');
  });

  test('converts HEADING_1 to # marker', () => {
    const content = [para('Doc Title', 'HEADING_1')];
    const text = docsApiToText(content);
    expect(text).toContain('# Doc Title');
  });

  test('converts HEADING_3 to ### marker', () => {
    const content = [para('Subsection', 'HEADING_3')];
    const text = docsApiToText(content);
    expect(text).toContain('### Subsection');
  });

  test('collapses higher heading levels to ####', () => {
    const content = [para('Deep heading', 'HEADING_6')];
    const text = docsApiToText(content);
    expect(text).toContain('#### Deep heading');
  });

  test('preserves blank lines for empty paragraphs', () => {
    const blank = { paragraph: { elements: [{ textRun: { content: '\n' } }], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } } };
    const content = [para('Before'), blank, para('After')];
    const text = docsApiToText(content);
    expect(text).toContain('Before');
    expect(text).toContain('After');
  });

  test('converts table to markdown table', () => {
    const tableEl = {
      table: {
        tableRows: [
          {
            tableCells: [
              { content: [para('Name')] },
              { content: [para('Status')] },
            ],
          },
          {
            tableCells: [
              { content: [para('Acme Corp')] },
              { content: [para('Active')] },
            ],
          },
        ],
      },
    };
    const text = docsApiToText([tableEl]);
    expect(text).toContain('| Name | Status |');
    expect(text).toContain('| --- | --- |');
    expect(text).toContain('| Acme Corp | Active |');
  });

  test('returns empty string for empty content array', () => {
    expect(docsApiToText([])).toBe('');
    expect(docsApiToText(null as any)).toBe('');
  });

  test('## headings survive the round-trip through splitDocSections', () => {
    const content = [
      para('Doc Title', 'HEADING_1'),
      para('2026-04-15 — Acme call', 'HEADING_2'),
      para('Discussed pricing.'),
      para('2026-04-10 — Beta intro', 'HEADING_2'),
      para('First call.'),
    ];
    const text = docsApiToText(content);
    const sections = splitDocSections(text);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe('2026-04-15 — Acme call');
    expect(sections[0].date).toBe('2026-04-15');
    expect(sections[1].heading).toBe('2026-04-10 — Beta intro');
  });
});

// ---------------------------------------------------------------------------
// buildSectionPage — tab-aware variant
// ---------------------------------------------------------------------------

describe('buildSectionPage with tabName', () => {
  const baseFile = {
    id: 'abc123',
    name: 'Client Meeting Notes',
    mimeType: 'application/vnd.google-apps.document',
    modifiedTime: '2026-04-10T14:00:00.000Z',
    webViewLink: 'https://docs.google.com/document/d/abc123/edit',
    description: '',
  };

  const section = {
    heading: '2026-04-15 — Acme Corp check-in',
    slug: '2026-04-15-acme-corp-check-in',
    date: '2026-04-15',
    content: 'Discussed pricing.',
  };

  test('title includes doc, tab, and section when all present', () => {
    const md = buildSectionPage(baseFile, section, 'Standup Notes');
    expect(md).toContain('title: "Client Meeting Notes — Standup Notes — 2026-04-15 — Acme Corp check-in"');
  });

  test('includes tab frontmatter field', () => {
    const md = buildSectionPage(baseFile, section, 'Standup Notes');
    expect(md).toContain('tab: "Standup Notes"');
  });

  test('body attribution line includes tab name', () => {
    const md = buildSectionPage(baseFile, section, 'Standup Notes');
    expect(md).toContain('**Tab:** Standup Notes');
  });

  test('no tab frontmatter when tabName is null', () => {
    const md = buildSectionPage(baseFile, section, null);
    expect(md).not.toContain('tab:');
  });

  test('whole-tab page (no section heading) uses tab name as title', () => {
    const s = { heading: '', slug: '', date: null, content: 'Notes here.' };
    const md = buildSectionPage(baseFile, s, 'GTM Notes');
    expect(md).toContain('title: "Client Meeting Notes — GTM Notes"');
  });
});
