import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { extractLinksFromFile, extractTimelineFromContent } from '../src/commands/extract.ts';
import { extractEntityRefs, extractPageLinks, parseTimelineEntries } from '../src/core/link-extraction.ts';
import { stripCodeBlocks } from '../src/core/markdown-code.ts';
import { parseInlineCitationTimelineEntries } from '../src/core/timeline-citations.ts';

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
  expect(stripCodeBlocks('before```md\r\n🧪\ra\n')).toBe('before     \r\n  \r \n');
});
