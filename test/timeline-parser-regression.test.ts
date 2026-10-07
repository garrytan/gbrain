import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { extractLinksFromFile, extractTimelineFromContent } from '../src/commands/extract.ts';
import { extractEntityRefs, extractPageLinks, parseTimelineEntries } from '../src/core/link-extraction.ts';
import { stripCodeBlocks } from '../src/core/markdown-code.ts';
import { parseInlineCitationTimelineEntries } from '../src/core/timeline-citations.ts';
import { emailCitation, timelineLine } from '../src/core/output/scaffold.ts';

describe('timeline prefix compatibility', () => {
  test('keeps optional bullets, whitespace, date spellings, and separator runs', () => {
    for (const prefix of ['', ' \t', '-', ' \t-\t ', '\u00a0-\u3000']) {
      for (const date of ['**2024-02-29**', '2024年2月29日', '**2024年02月29日**', '2024年2月29', '**2024年2月29**']) {
        for (const separator of ['|', '-', '--', '–', '—', '|–—']) {
          for (const ending of ['', '\r']) {
            const input = `${prefix}${date} ${separator} Notes — Event${ending}`;
            expect(parseTimelineEntries(input)).toEqual([{
              date: '2024-02-29',
              summary: separator.includes('|') ? 'Event' : 'Notes — Event',
              detail: '',
              source: separator.includes('|') ? 'Notes' : 'markdown',
            }]);
          }
        }
      }
    }
  });

  test('keeps invalid calendar dates and unsupported ASCII shapes rejected', () => {
    for (const date of ['**2026-02-29**', '**1900-02-29**', '**2026-13-01**', '**2026-01-00**', '2026年2月30日', '**2026年0月1日**', '2026年1月32日', '2024-02-29', '**2024-2-29**']) {
      expect(parseTimelineEntries(` \t- ${date} | Event`)).toEqual([]);
    }
    expect(parseTimelineEntries(' \t- **2024-02-29** |   ')).toEqual([]);
  });

  test('bounds adversarial whitespace in a child process and reports 1x/2x/4x scaling', () => {
    const parserUrl = new URL('../src/core/link-extraction.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--eval', `
      import { deepStrictEqual } from 'node:assert';
      import { parseTimelineEntries } from ${JSON.stringify(parserUrl)};
      parseTimelineEntries('not-a-date');
      const diagnostics = [];
      for (const spaces of [4_000, 8_000, 16_000]) {
        const input = ' '.repeat(spaces) + 'not-a-date';
        const started = performance.now();
        deepStrictEqual(parseTimelineEntries(input), []);
        diagnostics.push({ spaces, ms: performance.now() - started });
      }
      console.log(JSON.stringify({ diagnostics }));
      const whitespace = ' '.repeat(1_000_000);
      for (const suffix of ['', 'not-a-date', '- not-a-date']) {
        deepStrictEqual(parseTimelineEntries(whitespace + suffix), []);
      }
      for (const date of ['**2024-02-29**', '2024年2月29日']) {
        for (const bullet of ['', '- ']) {
          deepStrictEqual(parseTimelineEntries(whitespace + bullet + date + ' | Event'), [
            { date: '2024-02-29', summary: 'Event', detail: '', source: 'markdown' },
          ]);
        }
      }
      console.log('bounded timeline cases passed');
    `], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
    console.log(child.stdout);
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.signal, child.stderr).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('bounded timeline cases passed');
  }, 30_000);
});

for (const [label, eol] of [['LF', '\n'], ['CRLF', '\r\n']] as const) {
  describe(`code masking with ${label}`, () => {
    for (const closed of [true, false]) {
      test(`preserves every newline and UTF-16 offset in ${closed ? 'closed' : 'unclosed'} fences`, () => {
        const before = `Before 🧪 [Visible](people/visible)${eol}`;
        const code = ['```md', '示例 🧪 [Hidden](people/hidden)', 'Fake. [Source: fixture, 2024-02-29]', ...(closed ? ['```'] : [])].join(eol);
        const after = closed ? `${eol}After [[people/after]]` : '';
        const input = before + code + after;
        const masked = stripCodeBlocks(input);
        expect(masked.length).toBe(input.length);
        expect([...masked.matchAll(/[\r\n]/g)].map(m => [m.index, m[0]]))
          .toEqual([...input.matchAll(/[\r\n]/g)].map(m => [m.index, m[0]]));
        for (let i = 0; i < input.length; i++) {
          const hidden = i >= before.length && i < before.length + code.length;
          expect(masked[i]).toBe(hidden && input[i] !== '\r' && input[i] !== '\n' ? ' ' : input[i]);
        }
      });
    }

    test('keeps adjacent real citations separate across a closed fence', () => {
      const separateLines = [
        'Before. [Source: before memo, 2024-02-27]',
        '```md',
        'Fake. [Source: hidden memo, 2024-02-28]',
        '```',
        'After. [Source: after memo, 2024-02-29]',
      ].join(eol);
      const expected = [
        { date: '2024-02-27', source: 'before memo', summary: 'Before.' },
        { date: '2024-02-29', source: 'after memo', summary: 'After.' },
      ];
      const adjoiningProse = [
        'Before. [Source: before memo, 2024-02-27]```md',
        'Fake. [Source: hidden memo, 2024-02-28]',
        '```After. [Source: after memo, 2024-02-29]',
      ].join(eol);
      for (const content of [separateLines, adjoiningProse]) {
        expect(parseInlineCitationTimelineEntries(content)).toEqual(expected);
        expect(parseTimelineEntries(content)).toEqual(expected.map(entry => ({ ...entry, detail: `Source: ${entry.source}` })));
        expect(extractTimelineFromContent(content, 'notes/example')).toEqual(expected.map(entry => ({ ...entry, slug: 'notes/example' })));
      }
    });

    test('hides unclosed fences and inline citations without losing real citations', () => {
      const content = [
        'Real. `Fake. [Source: inline memo, 2024-02-28]` [Source: real memo, 2024-02-27]',
        '```md',
        'Hidden. [Source: hidden memo, 2024-02-29]',
      ].join(eol);
      const expected = [{ date: '2024-02-27', source: 'real memo', summary: 'Real.' }];
      expect(parseInlineCitationTimelineEntries(content)).toEqual(expected);
      expect(parseTimelineEntries(content)).toEqual(expected.map(entry => ({ ...entry, detail: 'Source: real memo' })));
      expect(extractTimelineFromContent(content, 'notes/example')).toEqual(expected.map(entry => ({ ...entry, slug: 'notes/example' })));
    });

    test('hides code references and keeps real link offsets in both extract paths', async () => {
      const content = [
        '🧪 [Before](../people/before.md)',
        '`[Inline](../people/inline.md)`',
        '```md',
        '[Hidden](../people/hidden.md) [[people/hidden-wiki]]',
        '```',
        '[[people/after]]',
        '```',
        '[Unclosed](../people/unclosed.md)',
      ].join(eol);
      const slugs = new Set(['people/before', 'people/inline', 'people/hidden', 'people/hidden-wiki', 'people/after', 'people/unclosed']);
      expect(extractEntityRefs(content).map(({ slug, index }) => ({ slug, index }))).toEqual([
        { slug: 'people/before', index: content.indexOf('[Before]') },
        { slug: 'people/after', index: content.indexOf('[[people/after]]') },
      ]);
      const fsLinks = await extractLinksFromFile(content, 'notes/example.md', slugs);
      expect(fsLinks.map(link => link.to_slug).sort()).toEqual(['people/after', 'people/before']);
      const dbLinks = await extractPageLinks('notes/example', content, {}, 'note', {
        resolve: async name => slugs.has(name) ? name : null,
      });
      expect(dbLinks.candidates.map(link => link.targetSlug).sort()).toEqual(['people/after', 'people/before']);
    });
  });
}

test('inline masking preserves bare CR and the existing unmatched/multiline backtick behavior', () => {
  const inline = '`示例 🧪`';
  expect(stripCodeBlocks(`Before ${inline} after`)).toBe(`Before ${' '.repeat(inline.length)} after`);
  expect(stripCodeBlocks('before `a\rb` after')).toBe('before   \r   after');
  for (const input of ['before `unclosed', '`first\nsecond`', '`first\r\nsecond`']) {
    expect(stripCodeBlocks(input)).toBe(input);
  }
});

test('fence masking preserves mixed LF, CRLF, and bare CR at exact offsets', () => {
  expect(stripCodeBlocks('before```md\r\n🧪\ra\n```after')).toBe('before     \r\n  \r \n   after');
  expect(stripCodeBlocks('before```md\r\n🧪\ra\n```')).toBe('before     \r\n  \r \n   ');
});

// #5483: a canonical emailCitation() is a Markdown link whose TARGET is the
// Gmail URL, so the citation text strip must take the target with it — the
// leftover `(url)` otherwise became the summary itself, and timeline rows
// cannot be removed once written.
describe('inline citation timeline dates', () => {
  test('a citation dated in years 0001-0099 is kept', () => {
    expect(parseInlineCitationTimelineEntries('Event happened. [Source: chronicle, 0099-01-01]\n')).toEqual([
      { date: '0099-01-01', source: 'chronicle', summary: 'Event happened.' },
    ]);
  });

  test('a calendar-invalid citation date is still dropped', () => {
    expect(parseInlineCitationTimelineEntries('Event happened. [Source: chronicle, 2026-02-30]\n')).toEqual([]);
  });
});

describe('inline citation link targets (#5483)', () => {
  const cite = emailCitation({
    account: 'user@example.com',
    messageId: '18c0ffee12345678',
    subject: 'Quarterly report',
    dateISO: '2026-04-18',
  });
  const expected = { date: '2026-04-18', source: 'email "Quarterly report"' };

  test('a citation alone on its line mints no URL-fragment row', () => {
    for (const content of [
      `# Quarterly report thread\n\n## Alice · 2026-04-18 09:12\n\n${cite}\n\nHere are the numbers.\n`,
      `${cite}\n`,
    ]) {
      expect(parseInlineCitationTimelineEntries(content)).toEqual([]);
      // Both real extract paths agree — the row never reaches the DB either.
      expect(parseTimelineEntries(content)).toEqual([]);
      expect(extractTimelineFromContent(content, 'email/thread')).toEqual([]);
    }
  });

  test('prose around the citation survives; the URL never does', () => {
    expect(parseInlineCitationTimelineEntries(`Here are the numbers. ${cite}`)).toEqual([
      { ...expected, summary: 'Here are the numbers.' },
    ]);
    expect(parseInlineCitationTimelineEntries(`${cite} Here are the numbers.`)).toEqual([
      { ...expected, summary: 'Here are the numbers.' },
    ]);
  });

  test('the canonical timelineLine shape still yields exactly one row', () => {
    const line = timelineLine({ dateISO: '2026-04-18', summary: 'Signed the deal', citation: cite });
    // Both extract paths skip bullet lines in the citation pass (the bullet
    // pass owns them), so the URL never becomes a second row's summary.
    expect(extractTimelineFromContent(line, 'notes/example')).toHaveLength(1);
    expect(parseTimelineEntries(line)).toHaveLength(1);
  });

  test('a URL with nested parens leaves no stray delimiter behind', () => {
    expect(parseInlineCitationTimelineEntries(
      'Read up. [Source: wiki, 2024-02-27](https://en.wikipedia.org/wiki/Foo_(bar))',
    )).toEqual([{ date: '2024-02-27', source: 'wiki', summary: 'Read up.' }]);
  });

  test('prose parentheses after a bare citation are kept', () => {
    expect(parseInlineCitationTimelineEntries(
      'Reviewed (carefully). [Source: memo, 2024-02-27]',
    )).toEqual([{ date: '2024-02-27', source: 'memo', summary: 'Reviewed (carefully).' }]);
  });
});

// #6133: inline spans pair backtick runs of equal length (CommonMark), so a double-backtick span is code.
test('inline masking pairs backtick runs of equal length', () => {
  expect(stripCodeBlocks('a ``2026-XX-XX`` b')).toBe(`a ${' '.repeat(14)} b`);
  expect(stripCodeBlocks('a `` x ` y `` b')).toBe(`a ${' '.repeat(11)} b`);
  expect(stripCodeBlocks('a ``unclosed` run')).toBe('a ``unclosed` run');
  expect(stripCodeBlocks('see \\`not code` here')).toBe('see \\`not code` here');
});
