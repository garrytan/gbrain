import { describe, expect, test } from 'bun:test';
import { fixContent, lintContent, runLintCore } from '../src/commands/lint.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FM = '---\ntitle: Formatting\ntype: source\ncreated: 2026-10-12\n---\n\n';
const EXPORT = '**Source:** ChatGPT Export\n\n';
const issues = (body: string, rule: string) => lintContent(FM + body, 'test.md', {
  contentSanity: { disabled: true },
}).filter(i => i.rule === rule);

describe('date formats versus unfilled dates', () => {
  test.each([
    'One file per day: memory/YYYY-MM-DD.md',
    'Filename: YYYY-MM-DD-song-title.logicx',
    'Naming convention: YYYY-MM-DD-description',
    'Log file: update-notify-YYYY-MM-DD.log',
    'Date format: YYYY-MM-DD',
    'Date format: **YYYY-MM-DD**',
    'Use dates in YYYY-MM-DD format.',
    'ISO 8601 (YYYY-MM-DD)',
    'Use YYYY-MM-DD for dates.',
    'Dates are formatted as YYYY-MM-DD.',
    'Render absolute dates as plain YYYY-MM-DD.',
    'Citation template: [Source: user statement, YYYY-MM-DD]',
    "Remove the date argument and the '**YYYY-MM-DD** |' prefix.",
    'Include dates (YYYY-MM-DD for chronological sorting), then a description.',
  ])('accepts a documented format: %s', body => {
    expect(issues(body, 'placeholder-date')).toEqual([]);
  });

  test('checks each occurrence, preserving real dates on a line containing an example', () => {
    expect(issues('Use YYYY-MM-DD for dates; the event happened YYYY-MM-DD.', 'placeholder-date'))
      .toMatchObject([{ line: 7, fixable: false }]);
    expect(issues('File memory/YYYY-MM-DD.md; date: 2026-XX-XX', 'placeholder-date')).toHaveLength(1);
  });

  test.each([
    'The event happened YYYY-MM-DD.',
    '[Source: user statement, YYYY-MM-DD]',
    '- YYYY-MM-DD | Meeting with a colleague',
    'Date: 2026-XX-XX',
    'Date: XX-XX',
    '- **YYYY-MM-DD** | An undated timeline entry',
  ])('retains a real placeholder finding: %s', body => {
    expect(issues(body, 'placeholder-date')).toHaveLength(1);
  });

  test('frontmatter dates are checked even when quoted or surrounded by format words', () => {
    for (const value of ['YYYY-MM-DD', '"YYYY-MM-DD"', '"date format: YYYY-MM-DD"']) {
      expect(lintContent(FM.replace('2026-10-12', value), 'test.md')
        .filter(i => i.rule === 'placeholder-date')).toMatchObject([{ line: 4 }]);
    }
  });
});

describe('flattened chat summary headings', () => {
  test.each(['Assistant', 'User', 'Human', 'Tool', 'Conversation Memory'])(
    'repairs %s without changing excerpt words or inline markup', role => {
      const excerpt = 'Keep `date: YYYY-MM-DD` and [[concepts/example]] exactly as written.';
      const original = FM + EXPORT + `## Summary\n## ${role} ${excerpt}\n\n## Entities\n\n[[people/example]]\n`;
      const findings = lintContent(original, 'test.md').filter(i => i.rule === 'chat-summary-heading');
      expect(findings).toMatchObject([{ line: 10, fixable: true }]);
      const fixed = fixContent(original);
      expect(fixed).toBe(FM + EXPORT + `## Summary\n\n### ${role}\n\n${excerpt}\n\n## Entities\n\n[[people/example]]\n`);
      expect(lintContent(fixed, 'test.md').filter(i => ['chat-summary-heading', 'empty-section'].includes(i.rule))).toEqual([]);
      expect(fixContent(fixed)).toBe(fixed);
    },
  );

  test.each([
    '## Summary\n\n### Assistant\n\nA correctly nested excerpt.\n',
    '## Summary\n\n## Assistant\n\nA raw transcript turn.\n',
    '## Summary\n\n## Assistant configuration\n\nThis is a real section.\n',
    '## Transcript\n\n## Human Keep this raw transcript unchanged\n',
    '## Example\n\n```markdown\n## Summary\n## Assistant An example of broken formatting\n```\n\nDone.\n',
  ])('leaves ordinary headings, transcripts and code examples alone', body => {
    expect(issues(EXPORT + body, 'chat-summary-heading')).toEqual([]);
    expect(fixContent(FM + EXPORT + body)).toBe(FM + EXPORT + body);
  });

  test('handles CRLF and a blank line after Summary', () => {
    const header = (FM + EXPORT).replaceAll('\n', '\r\n');
    const input = header + '## Summary\r\n\r\n## User Some words\r\n\r\n## Entities\r\n\r\nNone.\r\n';
    expect(fixContent(input)).toBe(header + '## Summary\r\n\r\n### User\r\n\r\nSome words\r\n\r\n## Entities\r\n\r\nNone.\n');
  });

  test('does not rewrite headings in a frontmatter block scalar', () => {
    const input = '---\ntitle: Example\ntype: note\ncreated: 2026-10-12\nexample: |\n## Summary\n## User Example text\n---\n\nA body.\n';
    expect(fixContent(input)).toBe(input);
  });

  test('repairs multiple summaries and preserves an excerpt at EOF', () => {
    const input = FM + EXPORT + '## Summary\n## Human First excerpt\n\n## Summary\n## Assistant Second excerpt';
    expect(fixContent(input)).toBe(FM + EXPORT + '## Summary\n\n### Human\n\nFirst excerpt\n\n## Summary\n\n### Assistant\n\nSecond excerpt\n');
  });

  test('preserves an excerpt truncated mid-code-fence', () => {
    const excerpt = 'An archived reply with an unfinished ```typescript const example = 1;';
    const input = FM + EXPORT + `## Summary\n## Assistant ${excerpt}\n\n## Entities\n\nNone.\n`;
    expect(fixContent(input)).toBe(FM + EXPORT + `## Summary\n\n### Assistant\n\n${excerpt}\n\n## Entities\n\nNone.\n`);
  });

  test('an ordinary empty User permissions section is not inferred to be a chat excerpt', () => {
    const input = FM + '## Summary\n\n## User permissions\n\n## Open questions\n\nTBD.\n';
    expect(fixContent(input)).toBe(input);
    expect(lintContent(input, 'test.md').filter(i => i.rule === 'chat-summary-heading')).toEqual([]);
  });

  test('raw conversation pages keep their content even when it resembles a legacy summary', () => {
    const input = FM.replace('type: source', 'type: conversation') + EXPORT + '## Summary\n## User An original transcript heading\n';
    expect(fixContent(input)).toBe(input);
    expect(lintContent(input, 'test.md').filter(i => i.rule === 'chat-summary-heading')).toEqual([]);
  });

  test('an export marker inside code does not authorize summary repair', () => {
    const input = FM + '```\n' + EXPORT + '```\n\n## Summary\n## User permissions\n';
    expect(fixContent(input)).toBe(input);
  });

  test('commented export markers and headings cannot authorize a repair', () => {
    for (const body of [
      '<!--\n' + EXPORT + '-->\n\n## Summary\n## User permissions\n',
      EXPORT + '<!--\n## Summary\n## Assistant Commented example\n-->\n',
    ]) {
      expect(fixContent(FM + body)).toBe(FM + body);
      expect(issues(body, 'chat-summary-heading')).toEqual([]);
    }
  });

  test('a code example before a genuine export header does not hide the summary', () => {
    const prefix = FM + '```\n' + EXPORT + '```\n\n**Source:** Claude Export\n\n';
    const input = prefix + '## Summary\n## Human An archived excerpt\n';
    expect(issues(input, 'chat-summary-heading')).toHaveLength(1);
    expect(fixContent(input)).toBe(prefix + '## Summary\n\n### Human\n\nAn archived excerpt\n');
  });

  test('the maintenance lint path repairs once and dry-run leaves bytes unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-summary-'));
    const file = join(dir, 'example.md');
    const original = FM + EXPORT + '## Summary\n## Assistant An archived excerpt\n\n## Entities\n\nNone.\n';
    try {
      writeFileSync(file, original);
      const isolated = { target: dir, contentSanity: { disabled: true }, typePack: null };
      await runLintCore({ ...isolated, fix: true, dryRun: true });
      expect(readFileSync(file, 'utf8')).toBe(original);
      const result = await runLintCore({ ...isolated, fix: true });
      expect(result.total_fixed).toBeGreaterThan(0);
      expect(readFileSync(file, 'utf8')).toBe(fixContent(original));
      expect((await runLintCore({ ...isolated, fix: true })).total_fixed).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
